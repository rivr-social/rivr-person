"use client";

/**
 * PersonaCreator component.
 *
 * Multi-step "character creator" flow used by `/personas/new` to scaffold a
 * persona's identity, look (2D + 3D avatar), platform-skill profile, and
 * autobot operating mode in one guided pass.
 *
 * The component is purely presentational/state-managing — persistence happens
 * via the `createPersona` server action when the controller submits the
 * Review step.
 *
 * Key behaviours:
 * - Five sections: Identity → Appearance → Skills → Operating Mode → Review.
 * - 2D image uploads/URL persist into `agents.image`.
 * - 3D `.glb` uploads route through the existing `/api/upload` pipeline (same
 *   one `profile-media-tab` uses) and persist as `metadata.avatar3dUrl`.
 * - Skill sliders are clamped to [0, 100] and persisted as `metadata.skills`
 *   keyed by `PERSONA_SKILL_KEYS`.
 * - Default operating mode is `delegated`, matching the platform default.
 */

import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  ChevronLeft,
  Drama,
  Image as ImageIcon,
  Loader2,
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
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/use-toast";
import { createPersona, type CreatePersonaInput } from "@/app/actions/personas";
import {
  PERSONA_SKILL_KEYS,
  VOICE_STYLE_OPTIONS,
  type AutobotControlMode,
  type PersonaSkillKey,
  type VoiceStyle,
} from "@/lib/persona-config";

/* ── Constants ── */

/** Steps in the character-creator flow, in order. */
const STEPS = ["identity", "appearance", "skills", "operating", "review"] as const;
type Step = (typeof STEPS)[number];

const STEP_LABELS: Record<Step, string> = {
  identity: "Identity",
  appearance: "Appearance",
  skills: "Platform skills",
  operating: "Operating mode",
  review: "Review & create",
};

/** Maximum size for uploaded `.glb` files (matches profile-media-tab). */
const GLB_MAX_FILE_SIZE = 50 * 1024 * 1024;

/** Accepted file extension for the 3D avatar field. */
const GLB_ACCEPT = ".glb";

/** Upload bucket — `uploads` is the existing user-content bucket. */
const UPLOAD_BUCKET = "uploads";

/** Upload bucket for 2D avatar images. */
const AVATAR_BUCKET = "avatars";

/** Default starting value for new skill sliders. */
const DEFAULT_SKILL_VALUE = 50;

/** Default operating mode — matches the platform default for new personas. */
const DEFAULT_CONTROL_MODE: AutobotControlMode = "delegated";

/**
 * Skill metadata: the labels and tooltips shown next to each slider.
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

/** Full creator state — captures every field across all steps. */
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
  // Skills
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

/* ── Component ── */

export function PersonaCreator() {
  const router = useRouter();
  const { toast } = useToast();
  const [state, setState] = useState<CreatorState>(INITIAL_STATE);
  const [stepIndex, setStepIndex] = useState(0);
  const [isSubmitting, startSubmitTransition] = useTransition();
  const [isUploadingGlb, setIsUploadingGlb] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const glbInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const currentStep: Step = STEPS[stepIndex];

  /* ── Step navigation ── */

  const canGoNext = useMemo(() => {
    if (currentStep === "identity") {
      return state.name.trim().length > 0;
    }
    return true;
  }, [currentStep, state.name]);

  const goNext = useCallback(() => {
    if (stepIndex < STEPS.length - 1) {
      setStepIndex((i) => i + 1);
    }
  }, [stepIndex]);

  const goBack = useCallback(() => {
    if (stepIndex > 0) {
      setStepIndex((i) => i - 1);
    }
  }, [stepIndex]);

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

  /* ── Submit ── */

  const handleCreate = useCallback(() => {
    const trimmedName = state.name.trim();
    if (!trimmedName) {
      toast({ title: "Name is required", variant: "destructive" });
      setStepIndex(0);
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
      autobotControlMode: state.autobotControlMode,
    };

    startSubmitTransition(async () => {
      const result = await createPersona(payload);
      if (result.success) {
        toast({ title: "Persona created" });
        router.push("/autobot");
        router.refresh();
      } else {
        toast({
          title: result.error ?? "Failed to create persona",
          variant: "destructive",
        });
      }
    });
  }, [router, state, toast]);

  /* ── Render: stepper header ── */

  const stepper = (
    <div className="flex items-center gap-2 overflow-x-auto pb-2">
      {STEPS.map((step, index) => {
        const isActive = index === stepIndex;
        const isComplete = index < stepIndex;
        return (
          <div key={step} className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                // Allow free movement back; movement forward only past completed steps.
                if (index <= stepIndex) setStepIndex(index);
              }}
              className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors ${
                isActive
                  ? "border-primary bg-primary/10 text-foreground"
                  : isComplete
                    ? "border-primary/40 text-foreground/80 hover:bg-muted"
                    : "border-border text-muted-foreground"
              }`}
              aria-current={isActive ? "step" : undefined}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium ${
                  isComplete
                    ? "bg-primary text-primary-foreground"
                    : isActive
                      ? "bg-primary/20 text-primary"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {isComplete ? <Check className="h-3 w-3" /> : index + 1}
              </span>
              {STEP_LABELS[step]}
            </button>
            {index < STEPS.length - 1 && (
              <span className="h-px w-4 bg-border" aria-hidden="true" />
            )}
          </div>
        );
      })}
    </div>
  );

  /* ── Render: step bodies ── */

  const renderIdentity = () => (
    <Card>
      <CardHeader>
        <CardTitle>Identity</CardTitle>
        <CardDescription>
          Who is this persona? Name and the basics that make them recognizable.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="persona-name">Name *</Label>
            <Input
              id="persona-name"
              value={state.name}
              onChange={(e) => setField("name", e.target.value)}
              placeholder="Display name"
              maxLength={100}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="persona-username">Username</Label>
            <Input
              id="persona-username"
              value={state.username}
              onChange={(e) => setField("username", e.target.value)}
              placeholder="optional_username"
              maxLength={40}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="persona-tagline">Tagline</Label>
          <Input
            id="persona-tagline"
            value={state.tagline}
            onChange={(e) => setField("tagline", e.target.value)}
            placeholder="One-line description, e.g. 'Rapid-response federation scout'"
            maxLength={140}
          />
          <p className="text-xs text-muted-foreground">
            Shown alongside the persona name. Up to 140 characters.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="persona-bio">Bio</Label>
          <Textarea
            id="persona-bio"
            value={state.bio}
            onChange={(e) => setField("bio", e.target.value)}
            placeholder="A longer-form description of this persona's purpose, voice, and limits."
            maxLength={500}
            rows={4}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="persona-pronouns">Pronouns</Label>
            <Input
              id="persona-pronouns"
              value={state.pronouns}
              onChange={(e) => setField("pronouns", e.target.value)}
              placeholder="they/them"
              maxLength={40}
            />
          </div>
          <div className="space-y-2">
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
          <div className="space-y-2">
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

  const renderAppearance = () => (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>
          Pick a 2D avatar and (optionally) attach a 3D `.glb` model. The 3D
          avatar is stored alongside the persona for richer surfaces later.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 2D avatar */}
        <div className="space-y-3">
          <Label>2D avatar</Label>
          <div className="flex items-start gap-4">
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
        </div>

        {/* 3D avatar */}
        <div className="space-y-3">
          <Label>3D avatar (.glb)</Label>
          <div className="flex items-start gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-md border bg-muted">
              {state.avatar3dUrl ? (
                <Box className="h-7 w-7 text-primary" />
              ) : (
                <Box className="h-7 w-7 text-muted-foreground/50" />
              )}
            </div>
            <div className="flex-1 space-y-2">
              {state.avatar3dUrl ? (
                <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {fileNameFromUrl(state.avatar3dUrl)}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {state.avatar3dUrl}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setField("avatar3dUrl", "")}
                  >
                    <Trash2 className="mr-1 h-4 w-4" />
                    Remove
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No 3D avatar attached. Upload a .glb file to enable richer
                  avatar surfaces. (Max 50MB.)
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
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );

  const renderSkills = () => (
    <Card>
      <CardHeader>
        <CardTitle>Platform skills</CardTitle>
        <CardDescription>
          Tune how this persona behaves across the platform. Each slider is
          0–100; defaults sit in the middle. Hover the labels for guidance.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <TooltipProvider delayDuration={200}>
          {PERSONA_SKILL_KEYS.map((key) => {
            const meta = SKILL_META[key];
            const value = state.skills[key];
            return (
              <div key={key} className="space-y-2">
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
                <p className="text-xs text-muted-foreground">{meta.description}</p>
              </div>
            );
          })}
        </TooltipProvider>
      </CardContent>
    </Card>
  );

  const renderOperating = () => (
    <Card>
      <CardHeader>
        <CardTitle>Operating mode</CardTitle>
        <CardDescription>
          How much autonomy does this persona's autobot have? You can change
          this any time from the persona&apos;s autobot pane.
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
          className="grid gap-3 sm:grid-cols-3"
        >
          {CONTROL_MODE_VALUES.map((mode) => {
            const meta = CONTROL_MODE_META[mode];
            const isSelected = state.autobotControlMode === mode;
            return (
              <label
                key={mode}
                htmlFor={`mode-${mode}`}
                className={`flex h-full cursor-pointer flex-col gap-2 rounded-md border p-4 transition-colors ${
                  isSelected
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted/50"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{meta.title}</span>
                  <RadioGroupItem id={`mode-${mode}`} value={mode} />
                </div>
                <p className="text-xs text-muted-foreground">{meta.description}</p>
              </label>
            );
          })}
        </RadioGroup>
      </CardContent>
    </Card>
  );

  const renderReview = () => (
    <Card>
      <CardHeader>
        <CardTitle>Review &amp; create</CardTitle>
        <CardDescription>
          Confirm the persona looks right. You can step back to adjust anything.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Identity summary */}
        <div className="flex items-start gap-4">
          <Avatar className="h-14 w-14">
            <AvatarImage src={state.image || undefined} alt={state.name} />
            <AvatarFallback>
              {(state.name || "?").substring(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold">
                {state.name || "(unnamed persona)"}
              </span>
              {state.username && (
                <span className="text-xs text-muted-foreground">@{state.username}</span>
              )}
              {state.pronouns && (
                <Badge variant="outline" className="text-xs">
                  {state.pronouns}
                </Badge>
              )}
            </div>
            {state.tagline && (
              <p className="mt-1 text-sm text-muted-foreground">{state.tagline}</p>
            )}
            {state.bio && (
              <p className="mt-2 text-sm whitespace-pre-wrap">{state.bio}</p>
            )}
          </div>
        </div>

        {/* Appearance summary */}
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-md border p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <ImageIcon className="h-3.5 w-3.5" /> 2D avatar
            </div>
            <p className="break-all text-xs text-muted-foreground">
              {state.image || "Not set"}
            </p>
          </div>
          <div className="rounded-md border p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Box className="h-3.5 w-3.5" /> 3D avatar (.glb)
            </div>
            <p className="break-all text-xs text-muted-foreground">
              {state.avatar3dUrl || "Not set"}
            </p>
          </div>
        </div>

        {/* Voice + language */}
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Voice style
            </div>
            <div className="mt-1">{state.voiceStyle || "Not set"}</div>
          </div>
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Language
            </div>
            <div className="mt-1">{state.language || "Not set"}</div>
          </div>
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Operating mode
            </div>
            <div className="mt-1">
              {CONTROL_MODE_META[state.autobotControlMode].title}
            </div>
          </div>
        </div>

        {/* Skills summary */}
        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Platform skills
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {PERSONA_SKILL_KEYS.map((key) => (
              <div
                key={key}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <span className="text-xs">{SKILL_META[key].label}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {state.skills[key]}
                </span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );

  /* ── Render ── */

  let body: React.ReactNode;
  switch (currentStep) {
    case "identity":
      body = renderIdentity();
      break;
    case "appearance":
      body = renderAppearance();
      break;
    case "skills":
      body = renderSkills();
      break;
    case "operating":
      body = renderOperating();
      break;
    case "review":
      body = renderReview();
      break;
  }

  const isLastStep = currentStep === "review";

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 pb-24 sm:p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/autobot"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
            aria-label="Back to autobot"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Drama className="h-5 w-5" />
              New persona
            </h1>
            <p className="text-xs text-muted-foreground">
              Configure identity, look, and platform behaviour for an alternate operating identity.
            </p>
          </div>
        </div>
      </div>

      {stepper}

      {body}

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={goBack}
          disabled={stepIndex === 0 || isSubmitting}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        {isLastStep ? (
          <Button type="button" onClick={handleCreate} disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating...
              </>
            ) : (
              <>
                <Check className="mr-2 h-4 w-4" /> Create persona
              </>
            )}
          </Button>
        ) : (
          <Button type="button" onClick={goNext} disabled={!canGoNext}>
            Next <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
