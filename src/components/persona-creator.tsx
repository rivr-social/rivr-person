"use client";

/**
 * PersonaCreator — RPG-style character creator for personas.
 *
 * The component is mounted at three URLs and behaves identically across
 * all three:
 * - `/personas/new` — create flow
 * - `/personas/[id]/edit` — edit flow (when `existingPersona` is supplied)
 * - `/settings` — when a persona is the active actor, settings *is* the
 *   persona-edit surface (see `app/settings/page.tsx`)
 *
 * Layout overview (RPG character sheet):
 *
 *   ┌─ Header tabs ──────────────────────────────────────────────┐
 *   │  Stats | Skills | Inventory | Appearance                   │
 *   └────────────────────────────────────────────────────────────┘
 *   ┌─ Identity (always visible) ────────────────────────────────┐
 *   │  Name + Tagline                                            │
 *   └────────────────────────────────────────────────────────────┘
 *   ┌─ Left column ───┬─ Center column ────┬─ Right column ──────┐
 *   │  per-tab info   │  rotating .glb     │  per-tab info       │
 *   │  (e.g. core     │  avatar on a       │  (e.g. operating    │
 *   │  attributes)    │  glowing platform  │  mode picker)       │
 *   └─────────────────┴────────────────────┴─────────────────────┘
 *   ┌─ Derived stats card ───────────────────────────────────────┐
 *   │  Total points · attribute count · skills avg · ...         │
 *   └────────────────────────────────────────────────────────────┘
 *   ┌─ Action row ───────────────────────────────────────────────┐
 *   │  Back        Reset               Confirm / Save            │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Persistence:
 * - Identity (name/username/tagline/bio/pronouns/voiceStyle/language) →
 *   `agents.name` + `agents.metadata`
 * - 2D avatar URL → `agents.image`
 * - 3D `.glb` URL → `metadata.avatar3dUrl`
 * - Platform skill sliders → `metadata.skills` (PERSONA_SKILL_KEYS, 0–100)
 * - Core attributes (RPG-style point pool over EFT_CATEGORIES) →
 *   `metadata.eftAttributes` as `Record<string, number>` clamped 0–N
 * - Operating mode → `metadata.autobotControlMode`
 *
 * Both 2D and 3D avatar uploads route through `/api/upload` (the same
 * pipeline `profile-media-tab` uses). The 3D viewer is the self-hosted
 * `Avatar3DViewer` (three.js); we evaluated `@readyplayerme/visage` but
 * its peer-dep matrix is incompatible with this project's React 19 +
 * three 0.183 + drei 9.122 versions.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Box,
  Check,
  ChevronLeft,
  Image as ImageIcon,
  Loader2,
  Package,
  RotateCcw,
  Sparkles,
  Sword,
  Trash2,
  Upload,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/use-toast";
import { Avatar3DViewer } from "@/components/avatar-3d-viewer";
import {
  EftPicker,
  defaultEftValues,
  defaultCapitalValues,
  defaultAuditValues,
  type EftValues,
  type CapitalValues,
  type AuditValues,
} from "@/components/eft-picker";
import { Ecosocial3dPlot } from "@/components/ecosocial-3d-plot";
import {
  createPersona,
  updatePersona,
  type CreatePersonaInput,
  type UpdatePersonaInput,
} from "@/app/actions/personas";
import type { SerializedAgent } from "@/lib/graph-serializers";
import {
  PERSONA_SKILL_KEYS,
  VOICE_STYLE_OPTIONS,
  type AutobotControlMode,
  type PersonaSkillKey,
  type VoiceStyle,
} from "@/lib/persona-config";

/* ── Constants ── */

/** Maximum size for uploaded `.glb` files (matches profile-media-tab). */
const GLB_MAX_FILE_SIZE = 50 * 1024 * 1024;

/** Accepted file extension for the 3D avatar field. */
const GLB_ACCEPT = ".glb";

/** Upload bucket — `uploads` is the existing user-content bucket. */
const UPLOAD_BUCKET = "uploads";

/** Upload bucket for 2D avatar images. */
const AVATAR_BUCKET = "avatars";

/** Default platform-skill slider value when starting fresh. */
const DEFAULT_SKILL_VALUE = 50;

/** Default operating mode — matches the platform default for new personas. */
const DEFAULT_CONTROL_MODE: AutobotControlMode = "delegated";

/**
 * Per-attribute hard ceiling. Picker values run 0..5 (sunburst rings) but
 * the server-side allowlist clamps to [0, 100], so future scaled values are
 * still accepted without rejection.
 */
const EFT_ATTRIBUTE_MAX_VALUE = 100;

/** Tab keys for the character-sheet header. */
const SHEET_TABS = ["stats", "skills", "inventory", "appearance"] as const;
type SheetTab = (typeof SHEET_TABS)[number];

const SHEET_TAB_LABELS: Record<SheetTab, string> = {
  stats: "Stats",
  skills: "Skills",
  inventory: "Inventory",
  appearance: "Appearance",
};

/**
 * Stats-tab attribute taxonomies are owned by `<EftPicker>`. The persona
 * creator wires three independent picker dials:
 *
 * - 12 Ecological Footprint categories  (`EFT_CATEGORIES`)
 * -  8 Forms of Capital                 (`CAPITAL_CATEGORIES`)
 * -  6 Integral Audit categories        (`AUDIT_CATEGORIES`)
 *
 * The same value objects feed `<Ecosocial3dPlot>`, which overlays all three
 * onto a 6-hextant radar (Biosphere / Sustenance / Sociosphere / Noosphere
 * / Technosphere / Econosphere). This is the live synthesis the user sees
 * as they dial values.
 *
 * Persisted as `metadata.eftAttributes`, `metadata.capitalAttributes`,
 * `metadata.auditAttributes`. Each value is clamped server-side to
 * [0, 100] so picker (0..5) and any future scaled values both validate.
 */

/**
 * Platform-skill metadata: the labels and tooltips shown next to each slider.
 * Keys MUST match `PERSONA_SKILL_KEYS` from the server action so the values
 * land cleanly in `metadata.skills`.
 */
const SKILL_META: Record<PersonaSkillKey, { label: string; description: string }> = {
  federationSavvy: {
    label: "Federation savvy",
    description: "Comfort jumping across instances and posting to peers.",
  },
  technicalDepth: {
    label: "Technical depth",
    description: "Willingness to dig into tools, MCP, and infrastructure.",
  },
  organizing: {
    label: "Organizing",
    description: "Coordination, scheduling, and group governance.",
  },
  publicVoice: {
    label: "Public-facing voice",
    description: "Comfort in long-form public posts vs. private notes.",
  },
  riskTolerance: {
    label: "Risk tolerance",
    description: "How readily this persona takes high-risk actions.",
  },
  creativeOutput: {
    label: "Creative output",
    description: "Writing, generation, and content shaping.",
  },
  conversationalWarmth: {
    label: "Conversational warmth",
    description: "Relational tone in DMs and comments.",
  },
  speed: {
    label: "Speed",
    description: "Fast-twitch (Flash-like) vs. deliberate (Camtron-like).",
  },
};

/** Voice/speaking-style option labels for the dropdown. */
const VOICE_STYLE_LABELS: Record<VoiceStyle, string> = {
  terse: "Terse — concise, direct",
  warm: "Warm — friendly, relational",
  formal: "Formal — measured, professional",
  technical: "Technical — precise, deep",
  playful: "Playful — light, irreverent",
};

/** Operating-mode descriptions shown in the radio cards. */
const CONTROL_MODE_META: Record<
  AutobotControlMode,
  { title: string; description: string }
> = {
  "direct-only": {
    title: "Direct only",
    description: "The agent never acts on its own — every action is initiated by you.",
  },
  "approval-required": {
    title: "Approval required",
    description: "The agent proposes actions; you confirm before anything ships.",
  },
  delegated: {
    title: "Delegated",
    description:
      "The agent acts on your behalf within policy. You review activity after the fact.",
  },
};

const CONTROL_MODE_VALUES: AutobotControlMode[] = [
  "direct-only",
  "approval-required",
  "delegated",
];

/* ── Types ── */

/** Full creator state — captures every field across all tabs. */
interface CreatorState {
  // Identity
  name: string;
  username: string;
  tagline: string;
  bio: string;
  pronouns: string;
  voiceStyle: VoiceStyle | "";
  language: string;
  // Appearance
  image: string;
  avatar3dUrl: string;
  // Core attributes (Stats tab — three picker taxonomies)
  eftAttributes: EftValues;
  capitalAttributes: CapitalValues;
  auditAttributes: AuditValues;
  // Platform skills (PERSONA_SKILL_KEYS sliders, Skills tab)
  skills: Record<PersonaSkillKey, number>;
  // Operating mode
  autobotControlMode: AutobotControlMode;
}

const INITIAL_SKILLS: Record<PersonaSkillKey, number> = PERSONA_SKILL_KEYS.reduce(
  (acc, key) => {
    acc[key] = DEFAULT_SKILL_VALUE;
    return acc;
  },
  {} as Record<PersonaSkillKey, number>,
);

const INITIAL_STATE: CreatorState = {
  name: "",
  username: "",
  tagline: "",
  bio: "",
  pronouns: "",
  voiceStyle: "",
  language: "",
  image: "",
  avatar3dUrl: "",
  eftAttributes: defaultEftValues(),
  capitalAttributes: defaultCapitalValues(),
  auditAttributes: defaultAuditValues(),
  skills: INITIAL_SKILLS,
  autobotControlMode: DEFAULT_CONTROL_MODE,
};

/* ── Helpers ── */

function isVoiceStyle(value: string): value is VoiceStyle {
  return (VOICE_STYLE_OPTIONS as readonly string[]).includes(value);
}

/** Filename helper for upload-result UI. */
function fileNameFromUrl(url: string): string {
  try {
    const pathname = new URL(url, "https://placeholder.local").pathname;
    const last = pathname.split("/").pop() ?? "";
    return last || url;
  } catch {
    return url;
  }
}

/** Sums numeric values across an attribute map (used for derived stats). */
function sumAttributeValues(attributes: Record<string, number>): number {
  let total = 0;
  for (const value of Object.values(attributes)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      total += value;
    }
  }
  return total;
}

/**
 * Read a numeric attribute map from persona metadata, clamped to
 * [0, EFT_ATTRIBUTE_MAX_VALUE]. Falls back to `defaults` for any key not
 * present, and silently drops keys outside the defaults set.
 */
function readAttributeMap<T extends Record<string, number>>(
  raw: unknown,
  defaults: T,
): T {
  const result: Record<string, number> = { ...defaults };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const source = raw as Record<string, unknown>;
    for (const key of Object.keys(defaults)) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        result[key] = Math.max(
          0,
          Math.min(EFT_ATTRIBUTE_MAX_VALUE, Math.round(value)),
        );
      }
    }
  }
  return result as T;
}

/** Average of all platform-skill slider values. */
function averageSkillValue(skills: Record<PersonaSkillKey, number>): number {
  const values = PERSONA_SKILL_KEYS.map((key) => skills[key] ?? 0);
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round(total / values.length);
}

/**
 * Builds initial creator state from an existing persona row. Falls back to
 * `INITIAL_STATE` defaults for any field that isn't present in the persona's
 * metadata. Skill values outside [0, 100] are clamped.
 */
function stateFromExistingPersona(persona: SerializedAgent): CreatorState {
  const metadata =
    persona.metadata && typeof persona.metadata === "object"
      ? (persona.metadata as Record<string, unknown>)
      : {};

  const rawSkills =
    metadata.skills && typeof metadata.skills === "object" && !Array.isArray(metadata.skills)
      ? (metadata.skills as Record<string, unknown>)
      : {};
  const skills: Record<PersonaSkillKey, number> = { ...INITIAL_SKILLS };
  for (const key of PERSONA_SKILL_KEYS) {
    const raw = rawSkills[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      skills[key] = Math.max(0, Math.min(100, Math.round(raw)));
    }
  }

  const eftAttributes = readAttributeMap(metadata.eftAttributes, defaultEftValues());
  const capitalAttributes = readAttributeMap(
    metadata.capitalAttributes,
    defaultCapitalValues(),
  );
  const auditAttributes = readAttributeMap(
    metadata.auditAttributes,
    defaultAuditValues(),
  );

  const rawVoiceStyle = typeof metadata.voiceStyle === "string" ? metadata.voiceStyle : "";
  const voiceStyle: VoiceStyle | "" = isVoiceStyle(rawVoiceStyle) ? rawVoiceStyle : "";

  const rawMode = metadata.autobotControlMode;
  const autobotControlMode: AutobotControlMode =
    rawMode === "direct-only" || rawMode === "approval-required" || rawMode === "delegated"
      ? rawMode
      : DEFAULT_CONTROL_MODE;

  return {
    name: persona.name ?? "",
    username: typeof metadata.username === "string" ? metadata.username : "",
    tagline: typeof metadata.tagline === "string" ? metadata.tagline : "",
    bio:
      typeof metadata.bio === "string"
        ? metadata.bio
        : persona.description ?? "",
    pronouns: typeof metadata.pronouns === "string" ? metadata.pronouns : "",
    voiceStyle,
    language: typeof metadata.language === "string" ? metadata.language : "",
    image: persona.image ?? "",
    avatar3dUrl:
      typeof metadata.avatar3dUrl === "string" ? metadata.avatar3dUrl : "",
    eftAttributes,
    capitalAttributes,
    auditAttributes,
    skills,
    autobotControlMode,
  };
}

/* ── Component ── */

/**
 * Props for `PersonaCreator`.
 *
 * - `existingPersona` — when provided, the form switches to **edit mode**:
 *   pre-fills from the persona's row + metadata, calls `updatePersona` on
 *   submit, and the final button reads "Save".
 * - `headerOverride` — replaces the default header. Settings-mode mounts use
 *   this so the surface reads as a settings page rather than "New persona".
 * - `onSavedRedirectTo` — destination after a successful save/create. Defaults
 *   to `/autobot` (matches the new-persona flow).
 */
export interface PersonaCreatorProps {
  existingPersona?: SerializedAgent;
  headerOverride?: React.ReactNode;
  onSavedRedirectTo?: string;
}

export function PersonaCreator({
  existingPersona,
  headerOverride,
  onSavedRedirectTo,
}: PersonaCreatorProps = {}) {
  const router = useRouter();
  const { toast } = useToast();
  const isEditMode = !!existingPersona;

  const initialState = useMemo<CreatorState>(
    () =>
      existingPersona ? stateFromExistingPersona(existingPersona) : INITIAL_STATE,
    [existingPersona],
  );

  const [state, setState] = useState<CreatorState>(() => initialState);
  const [activeTab, setActiveTab] = useState<SheetTab>("stats");
  const [isSubmitting, startSubmitTransition] = useTransition();
  const [isUploadingGlb, setIsUploadingGlb] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const glbInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Sync state when the source persona changes (e.g. parent prop swap on
  // edit-mode mounts that re-fetch). `initialState` is referentially stable
  // per `existingPersona`.
  useEffect(() => {
    setState(initialState);
  }, [initialState]);

  /* ── Field setters ── */

  const setField = useCallback(
    <K extends keyof CreatorState>(key: K, value: CreatorState[K]) => {
      setState((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const setSkill = useCallback((key: PersonaSkillKey, value: number) => {
    setState((prev) => ({
      ...prev,
      skills: { ...prev.skills, [key]: value },
    }));
  }, []);

  /* ── Core-attribute handlers ──
     The picker emits a fully replaced map for each taxonomy on every
     drag tick, so we just store-and-forward. The exact same state objects
     feed `<Ecosocial3dPlot>`, which gives the live hextant overlay. */

  const setEftAttributes = useCallback((next: EftValues) => {
    setState((prev) => ({ ...prev, eftAttributes: next }));
  }, []);

  const setCapitalAttributes = useCallback((next: CapitalValues) => {
    setState((prev) => ({ ...prev, capitalAttributes: next }));
  }, []);

  const setAuditAttributes = useCallback((next: AuditValues) => {
    setState((prev) => ({ ...prev, auditAttributes: next }));
  }, []);

  /** Clears all three attribute taxonomies to zero. Used by the Stats-tab
   *  "Reset attributes" affordance. */
  const resetAttributes = useCallback(() => {
    setState((prev) => ({
      ...prev,
      eftAttributes: defaultEftValues(),
      capitalAttributes: defaultCapitalValues(),
      auditAttributes: defaultAuditValues(),
    }));
  }, []);

  /* ── Uploads (reuses /api/upload — same path as profile-media-tab) ── */

  const handleGlbUpload = useCallback(
    async (file: File) => {
      if (file.size > GLB_MAX_FILE_SIZE) {
        toast({
          title: "File too large",
          description: "3D model files must be under 50MB.",
          variant: "destructive",
        });
        return;
      }
      setIsUploadingGlb(true);
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("bucket", UPLOAD_BUCKET);
        const response = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          const errorData = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          toast({
            title: "Upload failed",
            description: errorData.error ?? "Could not upload .glb file.",
            variant: "destructive",
          });
          return;
        }
        const data = (await response.json()) as { results: Array<{ url: string }> };
        const url = data.results[0]?.url ?? "";
        if (!url) {
          toast({
            title: "Upload failed",
            description: "Server did not return a URL for the uploaded file.",
            variant: "destructive",
          });
          return;
        }
        setField("avatar3dUrl", url);
        toast({
          title: "3D avatar uploaded",
          description: fileNameFromUrl(url),
        });
      } catch {
        toast({
          title: "Upload failed",
          description: "Network error during file upload.",
          variant: "destructive",
        });
      } finally {
        setIsUploadingGlb(false);
        if (glbInputRef.current) glbInputRef.current.value = "";
      }
    },
    [setField, toast],
  );

  const handleImageUpload = useCallback(
    async (file: File) => {
      setIsUploadingImage(true);
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("bucket", AVATAR_BUCKET);
        const response = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          const errorData = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          toast({
            title: "Upload failed",
            description: errorData.error ?? "Could not upload image.",
            variant: "destructive",
          });
          return;
        }
        const data = (await response.json()) as { results: Array<{ url: string }> };
        const url = data.results[0]?.url ?? "";
        if (url) {
          setField("image", url);
          toast({ title: "Image uploaded" });
        }
      } catch {
        toast({
          title: "Upload failed",
          description: "Network error during image upload.",
          variant: "destructive",
        });
      } finally {
        setIsUploadingImage(false);
        if (imageInputRef.current) imageInputRef.current.value = "";
      }
    },
    [setField, toast],
  );

  /* ── Reset & submit ── */

  const handleReset = useCallback(() => {
    setState(initialState);
    setIsResetDialogOpen(false);
    toast({ title: isEditMode ? "Reverted changes" : "Cleared character" });
  }, [initialState, isEditMode, toast]);

  const handleBack = useCallback(() => {
    router.push("/personas");
  }, [router]);

  const handleSubmit = useCallback(() => {
    const trimmedName = state.name.trim();
    if (!trimmedName) {
      toast({
        title: "Name is required",
        description: "Set a name on the Stats tab to continue.",
        variant: "destructive",
      });
      setActiveTab("stats");
      return;
    }

    const redirectTo = onSavedRedirectTo ?? "/autobot";

    if (isEditMode && existingPersona) {
      // Edit mode: every field is sent so cleared values (e.g. removing a
      // 3D avatar) propagate. `updatePersona` only writes provided fields, so
      // empty strings explicitly clear those fields.
      const updatePayload: UpdatePersonaInput = {
        personaId: existingPersona.id,
        name: trimmedName,
        username: state.username.trim(),
        bio: state.bio.trim(),
        image: state.image.trim(),
        tagline: state.tagline.trim(),
        pronouns: state.pronouns.trim(),
        voiceStyle: state.voiceStyle || "",
        language: state.language.trim(),
        avatar3dUrl: state.avatar3dUrl.trim(),
        skills: { ...state.skills },
        eftAttributes: { ...state.eftAttributes },
        capitalAttributes: { ...state.capitalAttributes },
        auditAttributes: { ...state.auditAttributes },
        autobotControlMode: state.autobotControlMode,
      };

      startSubmitTransition(async () => {
        const result = await updatePersona(updatePayload);
        if (result.success) {
          toast({ title: "Persona updated" });
          router.push(redirectTo);
          router.refresh();
        } else {
          toast({
            title: result.error ?? "Failed to update persona",
            variant: "destructive",
          });
        }
      });
      return;
    }

    const payload: CreatePersonaInput = {
      name: trimmedName,
      username: state.username.trim() || undefined,
      bio: state.bio.trim() || undefined,
      image: state.image.trim() || undefined,
      tagline: state.tagline.trim() || undefined,
      pronouns: state.pronouns.trim() || undefined,
      voiceStyle: state.voiceStyle || undefined,
      language: state.language.trim() || undefined,
      avatar3dUrl: state.avatar3dUrl.trim() || undefined,
      skills: { ...state.skills },
      eftAttributes: { ...state.eftAttributes },
      capitalAttributes: { ...state.capitalAttributes },
      auditAttributes: { ...state.auditAttributes },
      autobotControlMode: state.autobotControlMode,
    };

    startSubmitTransition(async () => {
      const result = await createPersona(payload);
      if (result.success) {
        toast({ title: "Persona created" });
        router.push(redirectTo);
        router.refresh();
      } else {
        toast({
          title: result.error ?? "Failed to create persona",
          variant: "destructive",
        });
      }
    });
  }, [existingPersona, isEditMode, onSavedRedirectTo, router, state, toast]);

  /* ── Derived stats ──
     Picker values are 0..MAX_LEVEL (5 in `eft-picker.tsx`); the totals
     below collapse the three taxonomies into a single "intensity" number
     for the footer card. */

  const eftTotal = sumAttributeValues(state.eftAttributes);
  const capitalTotal = sumAttributeValues(state.capitalAttributes);
  const auditTotal = sumAttributeValues(state.auditAttributes);
  const totalAttributePoints = eftTotal + capitalTotal + auditTotal;
  const skillsAverage = averageSkillValue(state.skills);

  /* ── Render: identity block (always visible) ── */

  const identityBlock = (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Identity</CardTitle>
        <CardDescription className="text-xs">
          Your character&apos;s name and tagline. Bio and pronouns live below.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="persona-name">Name *</Label>
          <Input
            id="persona-name"
            value={state.name}
            onChange={(e) => setField("name", e.target.value)}
            placeholder="Display name"
            maxLength={100}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="persona-tagline">Tagline</Label>
          <Input
            id="persona-tagline"
            value={state.tagline}
            onChange={(e) => setField("tagline", e.target.value)}
            placeholder="One-line description"
            maxLength={140}
          />
        </div>
      </CardContent>
    </Card>
  );

  /* ── Render: 3D avatar centerpiece (mounts once across tabs) ── */

  const centerpiece = (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div
          className="relative flex flex-col items-center justify-center"
          style={{ minHeight: 360 }}
        >
          {state.avatar3dUrl ? (
            <div className="w-full">
              <Avatar3DViewer
                src={state.avatar3dUrl}
                alt={`3D avatar for ${state.name || "persona"}`}
                height={360}
              />
            </div>
          ) : (
            <div className="flex h-[360px] w-full flex-col items-center justify-center gap-3 bg-gradient-to-b from-muted/40 to-muted/10 text-center">
              <Avatar className="h-28 w-28 ring-4 ring-primary/20">
                <AvatarImage src={state.image || undefined} alt={state.name} />
                <AvatarFallback className="text-2xl">
                  {(state.name || "?").substring(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {state.name || "Unnamed character"}
                </p>
                <p className="text-xs text-muted-foreground">
                  No 3D avatar yet — upload one below.
                </p>
              </div>
            </div>
          )}
          {/* Glowing platform — purely decorative; placed below the canvas. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-3 left-1/2 h-3 w-2/3 -translate-x-1/2 rounded-full bg-primary/30 blur-md"
          />
        </div>
        <div className="border-t bg-muted/30 px-4 py-2 text-center">
          <div className="flex items-center justify-center gap-2">
            <span className="text-sm font-semibold">
              {state.name || "Unnamed"}
            </span>
            {state.pronouns && (
              <Badge variant="outline" className="text-[10px]">
                {state.pronouns}
              </Badge>
            )}
          </div>
          {state.tagline && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {state.tagline}
            </p>
          )}
        </div>
        {/* Inline upload affordance — visible on every tab so the user
            never has to hunt for it on Appearance to swap the model. */}
        <div className="flex flex-wrap items-center justify-center gap-2 border-t bg-background px-3 py-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => glbInputRef.current?.click()}
            disabled={isUploadingGlb}
          >
            {isUploadingGlb ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            {state.avatar3dUrl ? "Replace .glb" : "Upload .glb"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => imageInputRef.current?.click()}
            disabled={isUploadingImage}
          >
            {isUploadingImage ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ImageIcon className="mr-2 h-4 w-4" />
            )}
            {state.image ? "Replace image" : "Upload image"}
          </Button>
          {state.avatar3dUrl && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setField("avatar3dUrl", "")}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Remove .glb
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );

  /* ── Render: Stats tab ──
     Hero: the three EftPicker wheels (Capital / Life Essentials / Audit)
     in a single full-width "fire-and-dope" card with glow accents.
     Below: 3-col grid of profile-fields | avatar centerpiece | radar +
     operating-mode card. Dialing the wheels updates `<Ecosocial3dPlot>`
     in real time. */

  const renderStatsHero = () => {
    const anyAttributeSet = totalAttributePoints > 0;
    return (
      <Card className="relative overflow-hidden border-primary/30">
        {/* Decorative glow accents — pulled forward from the bottom stat card. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-10 top-1/2 h-32 w-32 -translate-y-1/2 rounded-full bg-primary/15 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-10 top-1/2 h-32 w-32 -translate-y-1/2 rounded-full bg-pink-500/15 blur-3xl"
        />
        <CardHeader className="relative pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-primary" />
                Core Attributes
              </CardTitle>
              <CardDescription className="text-xs">
                Three lenses on the same character — Forms of Capital,
                Impact on Life Essentials, Integral Audit. Click and drag
                across rings to dial each axis. The radar to the right
                synthesises all three live.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={resetAttributes}
              disabled={!anyAttributeSet}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Reset
            </Button>
          </div>
        </CardHeader>
        <CardContent className="relative">
          <EftPicker
            value={state.eftAttributes}
            onChange={setEftAttributes}
            capitalValue={state.capitalAttributes}
            onCapitalChange={setCapitalAttributes}
            auditValue={state.auditAttributes}
            onAuditChange={setAuditAttributes}
          />
        </CardContent>
      </Card>
    );
  };

  /** Stats-tab left column: identity continued (username, pronouns, bio,
   *  voice, language). Identity row above the tabs already covers name +
   *  tagline. */
  const renderStatsLeft = () => (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Profile</CardTitle>
        <CardDescription className="text-xs">
          Username, voice, language, and a longer-form bio.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="persona-username">Username</Label>
            <Input
              id="persona-username"
              value={state.username}
              onChange={(e) => setField("username", e.target.value)}
              placeholder="optional_username"
              maxLength={40}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="persona-pronouns">Pronouns</Label>
            <Input
              id="persona-pronouns"
              value={state.pronouns}
              onChange={(e) => setField("pronouns", e.target.value)}
              placeholder="they/them"
              maxLength={40}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="persona-bio">Bio</Label>
          <Textarea
            id="persona-bio"
            value={state.bio}
            onChange={(e) => setField("bio", e.target.value)}
            placeholder="A longer description of this persona's purpose, voice, and limits."
            maxLength={500}
            rows={3}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="persona-voice-style">Voice / speaking style</Label>
            <Select
              value={state.voiceStyle}
              onValueChange={(value) => {
                if (isVoiceStyle(value)) setField("voiceStyle", value);
              }}
            >
              <SelectTrigger id="persona-voice-style">
                <SelectValue placeholder="Pick a style" />
              </SelectTrigger>
              <SelectContent>
                {VOICE_STYLE_OPTIONS.map((style) => (
                  <SelectItem key={style} value={style}>
                    {VOICE_STYLE_LABELS[style]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="persona-language">Language</Label>
            <Input
              id="persona-language"
              value={state.language}
              onChange={(e) => setField("language", e.target.value)}
              placeholder="en"
              maxLength={40}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );

  /** Stats-tab right column: ecosocial radar overlay + operating-mode picker.
   *  The radar is the Ecosocial3dPlot — wireframe hextant chart that
   *  updates live as the wheels are dialled. */
  const renderStatsRight = () => (
    <div className="space-y-4">
      <Card className="relative overflow-hidden border-primary/30">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-pink-500/5"
        />
        <CardHeader className="relative pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-pink-400" />
            Ecosocial Synthesis
          </CardTitle>
          <CardDescription className="text-xs">
            All three taxonomies overlaid on a 6-hextant radar — Biosphere,
            Sustenance, Sociosphere, Noosphere, Technosphere, Econosphere.
            Updates as you dial.
          </CardDescription>
        </CardHeader>
        <CardContent className="relative pt-0">
          {totalAttributePoints > 0 ? (
            <Ecosocial3dPlot
              eftValues={state.eftAttributes}
              capitalValues={state.capitalAttributes}
              auditValues={state.auditAttributes}
            />
          ) : (
            <div className="flex h-[320px] flex-col items-center justify-center gap-2 text-center">
              <div className="rounded-full border border-dashed border-primary/30 p-4">
                <Sparkles className="h-6 w-6 text-primary/60" />
              </div>
              <p className="text-xs text-muted-foreground max-w-[220px]">
                Dial any wheel to light up the hextant overlay. Each layer
                renders independently.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Operating Mode</CardTitle>
          <CardDescription className="text-xs">
            How much autonomy this persona&apos;s autobot has.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={state.autobotControlMode}
            onValueChange={(value) => {
              if (CONTROL_MODE_VALUES.includes(value as AutobotControlMode)) {
                setField("autobotControlMode", value as AutobotControlMode);
              }
            }}
            className="grid gap-2"
          >
            {CONTROL_MODE_VALUES.map((mode) => {
              const meta = CONTROL_MODE_META[mode];
              const isSelected = state.autobotControlMode === mode;
              return (
                <label
                  key={mode}
                  htmlFor={`mode-${mode}`}
                  className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
                    isSelected
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/50"
                  }`}
                >
                  <RadioGroupItem
                    id={`mode-${mode}`}
                    value={mode}
                    className="mt-0.5"
                  />
                  <div className="flex-1 space-y-0.5">
                    <div className="text-sm font-medium">{meta.title}</div>
                    <p className="text-xs text-muted-foreground">
                      {meta.description}
                    </p>
                  </div>
                </label>
              );
            })}
          </RadioGroup>
        </CardContent>
      </Card>
    </div>
  );

  /* ── Render: Skills tab — sliders ── */

  const renderSkillsLeft = () => (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Platform Skills</CardTitle>
        <CardDescription className="text-xs">
          Tune behaviour across the platform. Each slider is 0–100; defaults
          sit in the middle. Hover labels for guidance.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <TooltipProvider delayDuration={200}>
          {PERSONA_SKILL_KEYS.slice(0, 4).map((key) => {
            const meta = SKILL_META[key];
            const value = state.skills[key];
            return (
              <div key={key} className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Label
                        htmlFor={`skill-${key}`}
                        className="cursor-help underline-offset-4 hover:underline"
                      >
                        {meta.label}
                      </Label>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      {meta.description}
                    </TooltipContent>
                  </Tooltip>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {value}
                  </span>
                </div>
                <Slider
                  id={`skill-${key}`}
                  value={[value]}
                  min={0}
                  max={100}
                  step={1}
                  onValueChange={(values) => {
                    const next = values[0];
                    if (typeof next === "number") setSkill(key, next);
                  }}
                  aria-label={meta.label}
                />
              </div>
            );
          })}
        </TooltipProvider>
      </CardContent>
    </Card>
  );

  const renderSkillsRight = () => (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">More Skills</CardTitle>
        <CardDescription className="text-xs">
          Voice, creative output, conversational warmth, and tempo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <TooltipProvider delayDuration={200}>
          {PERSONA_SKILL_KEYS.slice(4).map((key) => {
            const meta = SKILL_META[key];
            const value = state.skills[key];
            return (
              <div key={key} className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Label
                        htmlFor={`skill-${key}`}
                        className="cursor-help underline-offset-4 hover:underline"
                      >
                        {meta.label}
                      </Label>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      {meta.description}
                    </TooltipContent>
                  </Tooltip>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {value}
                  </span>
                </div>
                <Slider
                  id={`skill-${key}`}
                  value={[value]}
                  min={0}
                  max={100}
                  step={1}
                  onValueChange={(values) => {
                    const next = values[0];
                    if (typeof next === "number") setSkill(key, next);
                  }}
                  aria-label={meta.label}
                />
              </div>
            );
          })}
        </TooltipProvider>
      </CardContent>
    </Card>
  );

  /* ── Render: Inventory tab — placeholder ── */

  const renderInventory = () => (
    <Card className="border-dashed">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Inventory</CardTitle>
        </div>
        <CardDescription className="text-xs">
          Coming soon — connected files, owned offerings, and deployed agents
          will appear here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Once persona-owned resources land, you&apos;ll see and equip them
          from this tab.
        </p>
      </CardContent>
    </Card>
  );

  /* ── Render: Appearance tab — 2D + 3D upload controls ── */

  const renderAppearanceLeft = () => (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">2D Avatar</CardTitle>
        <CardDescription className="text-xs">
          A small still image used in lists, comments, and feeds.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start gap-3">
          <Avatar className="h-16 w-16">
            <AvatarImage src={state.image || undefined} alt="Persona avatar preview" />
            <AvatarFallback>
              {(state.name || "?").substring(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 space-y-2">
            <Input
              value={state.image}
              onChange={(e) => setField("image", e.target.value)}
              placeholder="https://example.com/avatar.png"
            />
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  if (file) handleImageUpload(file);
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => imageInputRef.current?.click()}
                disabled={isUploadingImage}
              >
                {isUploadingImage ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                Upload image
              </Button>
              {state.image && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setField("image", "")}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Remove
                </Button>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );

  const renderAppearanceRight = () => (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">3D Avatar (.glb)</CardTitle>
        <CardDescription className="text-xs">
          The model rendered in the centerpiece. Up to 50MB.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start gap-3">
          <div className="flex h-16 w-16 items-center justify-center rounded-md border bg-muted">
            <Box
              className={`h-7 w-7 ${
                state.avatar3dUrl ? "text-primary" : "text-muted-foreground/50"
              }`}
            />
          </div>
          <div className="flex-1 space-y-2">
            {state.avatar3dUrl ? (
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                <p className="truncate font-medium">
                  {fileNameFromUrl(state.avatar3dUrl)}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {state.avatar3dUrl}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No 3D avatar attached.
              </p>
            )}
            <input
              ref={glbInputRef}
              type="file"
              accept={GLB_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                if (file) handleGlbUpload(file);
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => glbInputRef.current?.click()}
                disabled={isUploadingGlb}
              >
                {isUploadingGlb ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                {state.avatar3dUrl ? "Replace .glb" : "Upload .glb"}
              </Button>
              {state.avatar3dUrl && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setField("avatar3dUrl", "")}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Remove
                </Button>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );

  /* ── Render: derived stats footer ── */

  const derivedStats = (
    <Card className="bg-muted/20">
      <CardContent className="grid gap-3 p-4 sm:grid-cols-5">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            EFT
          </div>
          <div className="text-lg font-semibold tabular-nums">{eftTotal}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Capital
          </div>
          <div className="text-lg font-semibold tabular-nums">
            {capitalTotal}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Audit
          </div>
          <div className="text-lg font-semibold tabular-nums">{auditTotal}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Skills avg
          </div>
          <div className="text-lg font-semibold tabular-nums">
            {skillsAverage}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Mode
          </div>
          <div className="text-sm font-medium">
            {CONTROL_MODE_META[state.autobotControlMode].title}
          </div>
        </div>
      </CardContent>
    </Card>
  );

  /* ── Render: tab body builder ── */

  const renderTabBody = (tab: SheetTab): React.ReactNode => {
    switch (tab) {
      case "stats":
        return (
          <div className="space-y-4">
            {renderStatsHero()}
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1fr)]">
              <div className="space-y-4">{renderStatsLeft()}</div>
              <div>{centerpiece}</div>
              <div className="space-y-4">{renderStatsRight()}</div>
            </div>
          </div>
        );
      case "skills":
        return (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1fr)]">
            <div className="space-y-4">{renderSkillsLeft()}</div>
            <div>{centerpiece}</div>
            <div className="space-y-4">{renderSkillsRight()}</div>
          </div>
        );
      case "inventory":
        return (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1fr)]">
            <div className="space-y-4">{renderInventory()}</div>
            <div>{centerpiece}</div>
            <div className="space-y-4">
              <Card className="border-dashed">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Sword className="h-4 w-4 text-muted-foreground" />
                    <CardTitle className="text-base">Equipment</CardTitle>
                  </div>
                  <CardDescription className="text-xs">
                    Slots for tools and offerings will land here.
                  </CardDescription>
                </CardHeader>
              </Card>
            </div>
          </div>
        );
      case "appearance":
        return (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1fr)]">
            <div className="space-y-4">{renderAppearanceLeft()}</div>
            <div>{centerpiece}</div>
            <div className="space-y-4">{renderAppearanceRight()}</div>
          </div>
        );
    }
  };

  /*
   * Default header. Settings-mode mounts pass `headerOverride` to replace
   * this block (see `/settings` when persona is active).
   */
  const defaultHeader = (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleBack}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
          aria-label="Back to personas"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Sparkles className="h-5 w-5" />
            {isEditMode
              ? `Edit persona${existingPersona?.name ? ` — ${existingPersona.name}` : ""}`
              : "New persona"}
          </h1>
          <p className="text-xs text-muted-foreground">
            Build out an alternate operating identity — RPG-style.
          </p>
        </div>
      </div>
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4 p-4 pb-24 sm:p-6">
      {headerOverride ?? defaultHeader}

      {identityBlock}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as SheetTab)}>
        <TabsList className="w-full max-w-md">
          {SHEET_TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab} className="flex-1">
              {SHEET_TAB_LABELS[tab]}
            </TabsTrigger>
          ))}
        </TabsList>

        {/*
          Each TabsContent re-renders its left/right columns, but the
          centerpiece JSX is the same `centerpiece` element — three.js
          tear-down/setup still happens because Radix unmounts inactive
          panels. That's acceptable for now; the model URL is unchanged
          across tabs so the load is cached at the network level.
        */}
        {SHEET_TABS.map((tab) => (
          <TabsContent key={tab} value={tab}>
            {renderTabBody(tab)}
          </TabsContent>
        ))}
      </Tabs>

      {derivedStats}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={handleBack}
          disabled={isSubmitting}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setIsResetDialogOpen(true)}
            disabled={isSubmitting}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />{" "}
                {isEditMode ? "Saving..." : "Creating..."}
              </>
            ) : (
              <>
                <Check className="mr-2 h-4 w-4" />{" "}
                {isEditMode ? "Save" : "Confirm"}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Reset confirmation. Reverts to either INITIAL_STATE or the persona's
          loaded state, depending on whether we're creating or editing. */}
      <Dialog open={isResetDialogOpen} onOpenChange={setIsResetDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isEditMode ? "Revert all changes?" : "Clear character sheet?"}
            </DialogTitle>
            <DialogDescription>
              {isEditMode
                ? "Throws away unsaved edits and reloads this persona's saved values."
                : "Resets every field on the sheet — identity, attributes, skills, avatars, and operating mode — back to defaults."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setIsResetDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleReset}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              {isEditMode ? "Revert" : "Clear"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ── Re-exports for tests / future site-builder consumers ── */

/**
 * Shape of the "Core Attributes" map persisted under `metadata.eftAttributes`.
 * Keys are EFT category ids (12 total); values are clamped to [0, 100].
 */
export type EftAttributesValue = Record<string, number>;
