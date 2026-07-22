"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, Globe, MapPin, Moon, Shield, Sun, Store, CheckCircle2, AlertCircle, ExternalLink, Loader2, X, Sparkles, Brain } from "lucide-react";
import { updateProfileAction, updateProfileImageAction } from "@/app/actions/settings";
import { updateMyProfileTabVisibility } from "@/app/actions/interactions/profile";
import {
  linkAtprotoIdentityAction,
  linkPeermeshIdentityAction,
  unlinkAtprotoIdentityAction,
  unlinkPeermeshIdentityAction,
} from "@/app/actions/federation-identities";
import { setupConnectAccountAction, getConnectBalanceAction, getConnectStatusAction } from "@/app/actions/wallet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsTrigger } from "@/components/ui/tabs";
import { ResponsiveTabsList } from "@/components/responsive-tabs-list";
import { useToast } from "@/components/ui/use-toast";
import { useTheme } from "next-themes";
import { invalidateGraphCache, useLocalesAndBasins } from "@/lib/hooks/use-graph-data";
import { SearchableSelect } from "@/components/searchable-select";
import { HomeLocaleSelector } from "@/components/home-locale-selector";
import { Textarea } from "@/components/ui/textarea";
import { ImageUpload } from "@/components/image-upload";
import { SocialLinksEditor } from "@/components/social-links-editor";
import { ProfileTabVisibilityEditor } from "@/components/profile-tab-visibility-editor";
import type { ProfileTabVisibilitySettings } from "@/lib/types";
import type { FederationIdentityStatus } from "@/lib/federation-identities";
import type { AppReleaseStatus } from "@/lib/app-release";
import { DomainSettings } from "@/components/domain-settings";
import { RecoverySeedPanel } from "@/components/recovery-seed-panel";
import { AssistantSettingsPanel } from "@/components/assistant-settings-panel";

export type SettingsInitialData = {
  name: string;
  username: string;
  email: string;
  bio: string;
  tagline: string;
  phone: string;
  image: string;
  skills: string[];
  geneKeys: string;
  humanDesign: string;
  westernAstrology: string;
  vedicAstrology: string;
  ocean: string;
  myersBriggs: string;
  enneagram: string;
  homeLocale: string;
  murmurationsPublishing: boolean;
  socialLinks: Record<string, string>;
  profilePhotos: string[];
  notificationSettings: Omit<NotificationSettings, "murmurationsPublishing">;
  profileTabVisibility: ProfileTabVisibilitySettings;
};

type SettingsTab =
  | "account"
  | "privacy"
  | "notifications"
  | "appearance"
  | "agent-hq"
  | "connectors"
  | "seller"
  | "federation"
  | "security";

const SETTINGS_TAB_VALUES: SettingsTab[] = [
  "account",
  "privacy",
  "notifications",
  "appearance",
  "agent-hq",
  "connectors",
  "seller",
  "federation",
  "security",
];

/**
 * Notification preferences that are actually consumed by this app.
 *
 * `emailNotifications` is read by `isEmailEnabled` (`@/app/actions/email`)
 * before any transactional/broadcast send; `murmurationsPublishing` drives
 * `syncMurmurationsProfilesForActor`. The former push/eventReminders/
 * newMessages toggles were removed in the 2026-07-22 truth-in-UI wave —
 * this app has no push infrastructure and no reader ever existed for them.
 */
type NotificationSettings = {
  emailNotifications: boolean;
  murmurationsPublishing: boolean;
};

/**
 * Appearance preferences. Only dark mode is real — it is applied through
 * `next-themes`. The former text-size slider and colour-theme swatches were
 * removed in the 2026-07-22 truth-in-UI wave (state was never persisted and
 * nothing consumed it).
 */
type AppearanceSettings = {
  darkMode: boolean;
};

type FederationSettingsState =
  | { status: "idle" | "loading" | "error"; error?: string }
  | ({ status: "ready" } & FederationIdentityStatus);

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  return `${parts[0][0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

function normalizeLocaleToken(value: string): string {
  return value.trim().toLowerCase();
}

export function SettingsForm({
  initialData,
  initialFederationStatus,
  initialAppReleaseStatus,
  activePersona,
}: {
  initialData: SettingsInitialData;
  initialFederationStatus: FederationIdentityStatus | null;
  initialAppReleaseStatus: AppReleaseStatus | null;
  /**
   * Persona-context flags forwarded from the server component. When `isPersona`
   * is true the email field is rendered read-only because email is the
   * controller's auth identity and personas share their parent's session.
   */
  activePersona?: {
    isPersona: boolean;
    actorId: string;
    controllerId: string;
    personaName?: string;
  };
}) {
  const isPersonaActive = activePersona?.isPersona === true;
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { theme, setTheme } = useTheme();
  const requestedTab = searchParams.get("tab");
  const resolvedRequestedTab: SettingsTab = requestedTab === "connections"
    ? "connectors"
    : SETTINGS_TAB_VALUES.includes(requestedTab as SettingsTab)
      ? (requestedTab as SettingsTab)
      : "account";
  // The Assistant ("agent-hq") tab is self-owner-only. If a persona is the
  // active actor, fall back to Account so we never land on an empty tab.
  const initialTab: SettingsTab =
    resolvedRequestedTab === "agent-hq" && isPersonaActive
      ? "account"
      : resolvedRequestedTab;

  const [isSaving, setIsSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [profile, setProfile] = useState<SettingsInitialData>(initialData);
  const [skillInput, setSkillInput] = useState("");
  const { data: localesData } = useLocalesAndBasins();
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>({
    emailNotifications: initialData.notificationSettings.emailNotifications,
    murmurationsPublishing: initialData.murmurationsPublishing,
  });
  const [appearanceSettings, setAppearanceSettings] = useState<AppearanceSettings>({
    darkMode: theme === "dark",
  });
  // Sparse per-tab visibility overrides for the public profile. Persisted via a
  // dedicated server action (`updateMyProfileTabVisibility`) separate from the
  // main profile save so it can normalize + emit its own domain event.
  const [profileTabVisibility, setProfileTabVisibility] = useState<ProfileTabVisibilitySettings>(
    initialData.profileTabVisibility
  );
  const [savingTabVisibility, setSavingTabVisibility] = useState(false);
  const [federationSettings, setFederationSettings] = useState<FederationSettingsState>(
    initialFederationStatus
      ? { status: "ready", ...initialFederationStatus }
      : { status: "error", error: "Unable to load federation settings." }
  );
  const [peermeshInput, setPeermeshInput] = useState("");
  const [blueskyHandle, setBlueskyHandle] = useState("");
  const [blueskyAppPassword, setBlueskyAppPassword] = useState("");
  const [federationSaving, setFederationSaving] = useState<"peermesh" | "atproto" | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const localeOptions = useMemo(
    () =>
      localesData.locales.map((locale) => ({
        value: locale.id,
        label: locale.name,
        keywords: [locale.slug, locale.name, locale.id].filter(
          (entry): entry is string => typeof entry === "string" && entry.length > 0
        ),
      })),
    [localesData.locales]
  );

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (!profile.homeLocale || localesData.locales.length === 0) return;

    const normalizedCurrent = normalizeLocaleToken(profile.homeLocale);
    const matchedLocale = localesData.locales.find((locale) => {
      return (
        normalizeLocaleToken(locale.id) === normalizedCurrent ||
        normalizeLocaleToken(locale.slug) === normalizedCurrent ||
        normalizeLocaleToken(locale.name) === normalizedCurrent
      );
    });

    if (matchedLocale && matchedLocale.id !== profile.homeLocale) {
      setProfile((prev) => ({ ...prev, homeLocale: matchedLocale.id }));
    }
  }, [localesData.locales, profile.homeLocale]);

  const handleAvatarUpload = useCallback(async (file: File) => {
    setUploadingAvatar(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("bucket", "avatars");
      const uploadRes = await fetch("/api/upload", { method: "POST", body: formData });
      const uploadJson = await uploadRes.json();
      if (!uploadRes.ok || !uploadJson.results?.[0]?.url) {
        toast({ title: "Upload failed", description: uploadJson.error || "Could not upload image.", variant: "destructive" });
        return;
      }
      const result = await updateProfileImageAction("avatar", uploadJson.results[0].url);
      if (result.success) {
        toast({ title: "Avatar updated" });
        setProfile((prev) => ({ ...prev, image: uploadJson.results[0].url }));
        router.refresh();
      } else {
        toast({ title: "Update failed", description: result.error, variant: "destructive" });
      }
    } catch {
      toast({ title: "Upload failed", description: "Something went wrong.", variant: "destructive" });
    } finally {
      setUploadingAvatar(false);
    }
  }, [toast, router]);

  const applyFederationStatus = useCallback(
    (next: FederationIdentityStatus) => {
      setFederationSettings({
        status: "ready",
        ...next,
      });
    },
    []
  );

  async function handleLinkPeermesh() {
    setFederationSaving("peermesh");
    try {
      const result = await linkPeermeshIdentityAction({ manifestInput: peermeshInput });
      if (!result.success || !result.data) {
        toast({
          title: "Unable to link PeerMesh",
          description: result.error ?? "Please check the export and try again.",
          variant: "destructive",
        });
        return;
      }
      applyFederationStatus(result.data);
      setPeermeshInput("");
      toast({
        title: "PeerMesh linked",
        description: "Your Spatial / Universal Manifest identity is now linked to this profile.",
      });
    } finally {
      setFederationSaving(null);
    }
  }

  async function handleUnlinkPeermesh() {
    setFederationSaving("peermesh");
    try {
      const result = await unlinkPeermeshIdentityAction();
      if (!result.success || !result.data) {
        toast({
          title: "Unable to unlink PeerMesh",
          description: result.error ?? "Please try again.",
          variant: "destructive",
        });
        return;
      }
      applyFederationStatus(result.data);
      toast({
        title: "PeerMesh unlinked",
      });
    } finally {
      setFederationSaving(null);
    }
  }

  async function handleLinkAtproto() {
    setFederationSaving("atproto");
    try {
      const result = await linkAtprotoIdentityAction({
        handle: blueskyHandle,
        appPassword: blueskyAppPassword,
      });
      if (!result.success || !result.data) {
        toast({
          title: "Unable to link Bluesky",
          description: result.error ?? "Please check the handle and app password.",
          variant: "destructive",
        });
        return;
      }
      applyFederationStatus(result.data);
      setBlueskyAppPassword("");
      toast({
        title: "Bluesky linked",
        description: "Your AT Protocol identity is now linked to this profile.",
      });
    } finally {
      setFederationSaving(null);
    }
  }

  async function handleUnlinkAtproto() {
    setFederationSaving("atproto");
    try {
      const result = await unlinkAtprotoIdentityAction();
      if (!result.success || !result.data) {
        toast({
          title: "Unable to unlink Bluesky",
          description: result.error ?? "Please try again.",
          variant: "destructive",
        });
        return;
      }
      applyFederationStatus(result.data);
      toast({
        title: "Bluesky unlinked",
      });
    } finally {
      setFederationSaving(null);
    }
  }

  async function onSaveChanges() {
    setIsSaving(true);
    try {
      const result = await updateProfileAction({
        name: profile.name,
        username: profile.username,
        email: profile.email,
        bio: profile.bio,
        tagline: profile.tagline,
        phone: profile.phone,
        skills: profile.skills,
        geneKeys: profile.geneKeys,
        humanDesign: profile.humanDesign,
        westernAstrology: profile.westernAstrology,
        vedicAstrology: profile.vedicAstrology,
        ocean: profile.ocean,
        myersBriggs: profile.myersBriggs,
        enneagram: profile.enneagram,
        homeLocale: profile.homeLocale,
        murmurationsPublishing: notificationSettings.murmurationsPublishing,
        socialLinks: profile.socialLinks,
        profilePhotos: profile.profilePhotos,
        notificationSettings: {
          emailNotifications: notificationSettings.emailNotifications,
        },
      });

      if (!result.success) {
        toast({
          title: "Unable to save settings",
          description: result.error ?? "Please try again.",
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "Settings saved",
        description: "Your profile changes were saved successfully.",
      });
      invalidateGraphCache("graph.");
      router.refresh();
    } catch (error) {
      toast({
        title: "Unable to save settings",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function onSaveProfileTabVisibility() {
    setSavingTabVisibility(true);
    try {
      const result = await updateMyProfileTabVisibility(profileTabVisibility);
      if (!result.success) {
        toast({
          title: "Unable to save tab visibility",
          description: result.message ?? "Please try again.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Profile tabs updated",
        description: "Your public profile tab visibility was saved.",
      });
      router.refresh();
    } catch (error) {
      toast({
        title: "Unable to save tab visibility",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSavingTabVisibility(false);
    }
  }

  return (
    <div className="container max-w-4xl mx-auto px-4 py-6">
      <div className="flex items-center gap-4 mb-6">
        <Button variant="ghost" className="p-0" onClick={() => router.back()} aria-label="Go back">
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            App Version
          </CardTitle>
          <CardDescription>
            This deployment advertises its current build and, when available, the latest upstream release so sovereign instances can stay in sync.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {initialAppReleaseStatus ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant={initialAppReleaseStatus.updateAvailable ? "destructive" : "secondary"}>
                  {initialAppReleaseStatus.updateAvailable ? "Update Available" : "Up To Date"}
                </Badge>
                <span className="text-muted-foreground">
                  Current <span className="font-medium text-foreground">{initialAppReleaseStatus.currentVersion}</span>
                </span>
                {initialAppReleaseStatus.latestVersion ? (
                  <span className="text-muted-foreground">
                    Latest <span className="font-medium text-foreground">{initialAppReleaseStatus.latestVersion}</span>
                  </span>
                ) : null}
                <span className="text-muted-foreground">
                  Channel <span className="font-medium text-foreground">{initialAppReleaseStatus.releaseChannel}</span>
                </span>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border p-3 text-sm">
                  <p className="font-medium">Upstream Repo</p>
                  <p className="mt-1 break-all text-muted-foreground">{initialAppReleaseStatus.upstreamRepo}</p>
                </div>
                <div className="rounded-lg border p-3 text-sm">
                  <p className="font-medium">Deployment URL</p>
                  <p className="mt-1 break-all text-muted-foreground">{initialAppReleaseStatus.deploymentUrl ?? "Not declared"}</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                {initialAppReleaseStatus.latestUrl ? (
                  <a
                    href={initialAppReleaseStatus.latestUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex"
                  >
                    <Button variant={initialAppReleaseStatus.updateAvailable ? "default" : "outline"}>
                      <ExternalLink className="mr-2 h-4 w-4" />
                      {initialAppReleaseStatus.updateAvailable ? "Update This Instance" : "View Releases"}
                    </Button>
                  </a>
                ) : null}
                {initialAppReleaseStatus.changelogUrl ? (
                  <a
                    href={initialAppReleaseStatus.changelogUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex"
                  >
                    <Button variant="ghost">
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Changelog
                    </Button>
                  </a>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Release metadata is unavailable for this deployment.</p>
          )}
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as SettingsTab)} className="space-y-4">
        <ResponsiveTabsList>
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="privacy">Privacy</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          {!isPersonaActive && <TabsTrigger value="agent-hq">Assistant</TabsTrigger>}
          <TabsTrigger value="connectors">Connectors</TabsTrigger>
          <TabsTrigger value="seller">Seller</TabsTrigger>
          <TabsTrigger value="federation">Federation</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </ResponsiveTabsList>

        <TabsContent value="account" className="space-y-4">
          <div className="flex items-center gap-4 mb-6">
            <Avatar className="h-20 w-20">
              <AvatarImage src={profile.image || "/placeholder.svg?height=80&width=80"} alt={profile.username} />
              <AvatarFallback>{getInitials(profile.name)}</AvatarFallback>
            </Avatar>
            <div>
              <h2 className="text-xl font-bold">{profile.name}</h2>
              <p className="text-muted-foreground">@{profile.username}</p>
              <Button size="sm" variant="outline" className="mt-2" disabled={uploadingAvatar} onClick={() => avatarInputRef.current?.click()}>
                {uploadingAvatar ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Uploading...</> : "Change Photo"}
              </Button>
              <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAvatarUpload(f); e.target.value = ""; }} />
            </div>
          </div>

          <div className="space-y-4">
            <div className="grid gap-2">
              <label className="text-sm font-medium">Name</label>
              <input
                type="text"
                className="p-2 border rounded-md bg-background text-foreground"
                value={profile.name}
                onChange={(e) => setProfile((prev) => ({ ...prev, name: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium">Username</label>
              <input
                type="text"
                className="p-2 border rounded-md bg-background text-foreground"
                value={profile.username}
                onChange={(e) => setProfile((prev) => ({ ...prev, username: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium">Email</label>
              <input
                type="email"
                className="p-2 border rounded-md bg-background text-foreground disabled:opacity-60 disabled:cursor-not-allowed"
                value={profile.email}
                onChange={(e) => setProfile((prev) => ({ ...prev, email: e.target.value }))}
                disabled={isPersonaActive}
                readOnly={isPersonaActive}
                aria-readonly={isPersonaActive}
              />
              {isPersonaActive ? (
                <p className="text-xs text-muted-foreground">
                  Email is shared with your main account and can only be changed there.
                </p>
              ) : null}
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium">Phone</label>
              <input
                type="tel"
                className="p-2 border rounded-md bg-background text-foreground"
                value={profile.phone}
                onChange={(e) => setProfile((prev) => ({ ...prev, phone: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium">Tagline</label>
              <input
                type="text"
                className="p-2 border rounded-md bg-background text-foreground"
                placeholder="A short tagline shown under your name"
                value={profile.tagline}
                onChange={(e) => setProfile((prev) => ({ ...prev, tagline: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium">Bio</label>
              <textarea
                className="p-2 border rounded-md bg-background text-foreground"
                rows={3}
                value={profile.bio}
                onChange={(e) => setProfile((prev) => ({ ...prev, bio: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium">
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="h-4 w-4 text-muted-foreground" />
                  Home Locale
                </span>
              </label>
              <SearchableSelect
                value={profile.homeLocale}
                onChange={(value) => setProfile((prev) => ({ ...prev, homeLocale: value }))}
                options={localeOptions}
                placeholder="Select a locale..."
                searchPlaceholder="Search locales..."
                emptyLabel="No locales found."
              />
              <p className="text-xs text-muted-foreground">Your primary locale community</p>
              <HomeLocaleSelector
                chapters={localesData.locales}
                basins={localesData.basins}
                selectedLocaleId={profile.homeLocale}
                onSelectLocale={(localeId) =>
                  setProfile((prev) => ({ ...prev, homeLocale: localeId }))
                }
              />
            </div>

            <Separator className="my-6" />

            {/* Social Links Section */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <label className="text-sm font-medium">Social Links</label>
              </div>
              {/* Shared editor; values are validated/normalized server-side in
                  updateProfileAction (validateSocialLinks) on Save. */}
              <SocialLinksEditor
                value={profile.socialLinks}
                onChange={(next) => setProfile((prev) => ({ ...prev, socialLinks: next }))}
              />
            </div>

            <Separator className="my-6" />

            {/* Skills Section */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-muted-foreground" />
                <label className="text-sm font-medium">Skills</label>
              </div>
              <div className="flex flex-wrap gap-2">
                {profile.skills.map((skill) => (
                  <Badge key={skill} variant="secondary" className="flex items-center gap-1 px-3 py-1">
                    {skill}
                    <button
                      type="button"
                      aria-label={`Remove ${skill}`}
                      className="ml-1 hover:text-destructive"
                      onClick={() =>
                        setProfile((prev) => ({
                          ...prev,
                          skills: prev.skills.filter((s) => s !== skill),
                        }))
                      }
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <input
                type="text"
                className="p-2 border rounded-md w-full bg-background text-foreground"
                placeholder="Type a skill and press Enter"
                value={skillInput}
                onChange={(e) => setSkillInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const trimmed = skillInput.trim();
                    if (trimmed && !profile.skills.includes(trimmed)) {
                      setProfile((prev) => ({
                        ...prev,
                        skills: [...prev.skills, trimmed],
                      }));
                    }
                    setSkillInput("");
                  }
                }}
              />
            </div>

            <Separator className="my-6" />

            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-muted-foreground" />
                <label className="text-sm font-medium">Profile Photos</label>
              </div>
              <p className="text-sm text-muted-foreground">
                Add photos that appear in your profile&apos;s Photos tab even when they are not attached to a post or offering.
              </p>
              <ImageUpload
                value={profile.profilePhotos}
                onChange={(urls) => setProfile((prev) => ({ ...prev, profilePhotos: urls }))}
                maxFiles={8}
                bucket="uploads"
              />
            </div>

            <Separator className="my-6" />

            {/* Persona Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Brain className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">Persona / Personal Info</h3>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <label className="text-sm font-medium">Gene Keys</label>
                  <input
                    type="text"
                    className="p-2 border rounded-md bg-background text-foreground"
                    placeholder="e.g. 55-59-34"
                    value={profile.geneKeys}
                    onChange={(e) => setProfile((prev) => ({ ...prev, geneKeys: e.target.value }))}
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">Human Design</label>
                  <input
                    type="text"
                    className="p-2 border rounded-md bg-background text-foreground"
                    placeholder="e.g. Generator 2/4"
                    value={profile.humanDesign}
                    onChange={(e) => setProfile((prev) => ({ ...prev, humanDesign: e.target.value }))}
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">Western Astrology</label>
                  <input
                    type="text"
                    className="p-2 border rounded-md bg-background text-foreground"
                    placeholder="e.g. Leo Sun, Pisces Moon"
                    value={profile.westernAstrology}
                    onChange={(e) => setProfile((prev) => ({ ...prev, westernAstrology: e.target.value }))}
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">Vedic Astrology</label>
                  <input
                    type="text"
                    className="p-2 border rounded-md bg-background text-foreground"
                    placeholder="e.g. Ashlesha Nakshatra"
                    value={profile.vedicAstrology}
                    onChange={(e) => setProfile((prev) => ({ ...prev, vedicAstrology: e.target.value }))}
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">OCEAN (Big Five)</label>
                  <input
                    type="text"
                    className="p-2 border rounded-md bg-background text-foreground"
                    placeholder="e.g. O:85 C:70 E:60 A:75 N:30"
                    value={profile.ocean}
                    onChange={(e) => setProfile((prev) => ({ ...prev, ocean: e.target.value }))}
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">Myers-Briggs</label>
                  <input
                    type="text"
                    className="p-2 border rounded-md bg-background text-foreground"
                    placeholder="e.g. INFP"
                    value={profile.myersBriggs}
                    onChange={(e) => setProfile((prev) => ({ ...prev, myersBriggs: e.target.value }))}
                  />
                </div>

                <div className="grid gap-2 sm:col-span-2">
                  <label className="text-sm font-medium">Enneagram</label>
                  <input
                    type="text"
                    className="p-2 border rounded-md bg-background text-foreground"
                    placeholder="e.g. 4w5"
                    value={profile.enneagram}
                    onChange={(e) => setProfile((prev) => ({ ...prev, enneagram: e.target.value }))}
                  />
                </div>
              </div>
            </div>

            <Button className="w-full" onClick={onSaveChanges} disabled={isSaving}>
              {isSaving ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </TabsContent>

        {!isPersonaActive && (
          <TabsContent value="agent-hq" className="space-y-4">
            <AssistantSettingsPanel />
          </TabsContent>
        )}

        {/*
          The connector manager itself lives in the Assistant panel, which is the
          richer mount (it also manages the claude_code connector and the
          assistant's own settings). This tab used to mount a SECOND, bare copy of
          the same manager with divergent surrounding UX (2026-07-22 audit #20);
          it is now a signpost so there is exactly one place to connect accounts.
        */}
        <TabsContent value="connectors" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Connections</CardTitle>
              <CardDescription>
                Connected accounts are managed in one place: the Assistant tab.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                type="button"
                variant="outline"
                disabled={isPersonaActive}
                onClick={() => setActiveTab("agent-hq")}
              >
                {isPersonaActive
                  ? "Switch back to your own account to manage connections"
                  : "Go to Assistant → Connections"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="privacy" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Public Profile Tabs
              </CardTitle>
              <CardDescription>
                Choose who can see each tab on your public profile. You always see
                every tab; &quot;Hidden&quot; removes a tab for everyone. This is the
                privacy control this instance actually enforces — per-item privacy is
                set on each post, offering, or document when you create it.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ProfileTabVisibilityEditor
                value={profileTabVisibility}
                onChange={setProfileTabVisibility}
              />
              <Button
                type="button"
                onClick={onSaveProfileTabVisibility}
                disabled={savingTabVisibility}
              >
                {savingTabVisibility ? "Saving..." : "Save Tab Visibility"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications" className="space-y-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Email Notifications</p>
                <p className="text-sm text-muted-foreground">
                  Receive notifications via email. Turning this off suppresses every
                  non-essential email this instance sends you.
                </p>
              </div>
              <Switch
                checked={notificationSettings.emailNotifications}
                onCheckedChange={(value) =>
                  setNotificationSettings((prev) => ({ ...prev, emailNotifications: value }))
                }
              />
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Publish to Murmurations</p>
                <p className="text-sm text-muted-foreground">
                  Publish your eligible public profile, groups, projects, and marketplace offers to the Murmurations network.
                </p>
              </div>
              <Switch
                checked={notificationSettings.murmurationsPublishing}
                onCheckedChange={(value) =>
                  setNotificationSettings((prev) => ({ ...prev, murmurationsPublishing: value }))
                }
              />
            </div>

            {/*
              This tab previously had NO save control — the toggles only persisted
              if the user happened to hit Save on another tab (2026-07-22 audit #9).
              Both switches here are real, so the tab owns its own save.
            */}
            <Button className="w-full" onClick={onSaveChanges} disabled={isSaving}>
              {isSaving ? "Saving..." : "Save Notification Settings"}
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="appearance" className="space-y-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {appearanceSettings.darkMode ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
                <div>
                  <p className="font-medium">Dark Mode</p>
                  <p className="text-sm text-muted-foreground">Toggle between light and dark mode</p>
                </div>
              </div>
              <Switch
                checked={appearanceSettings.darkMode}
                onCheckedChange={(value) => {
                  setAppearanceSettings((prev) => ({ ...prev, darkMode: value }));
                  setTheme(value ? "dark" : "light");
                }}
              />
            </div>
          </div>
        </TabsContent>
        <TabsContent value="seller" className="space-y-4">
          <SellerAccountSection />
        </TabsContent>

        <TabsContent value="federation" className="space-y-4">
          <DomainSettings />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Globe className="h-5 w-5" />
                Federation
              </CardTitle>
              <CardDescription>
                Manage whether this account can export content to trusted peer nodes from this deployment.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {federationSettings.status === "loading" ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Checking federation status…
                </div>
              ) : federationSettings.status === "ready" ? (
                <>
                  <div className="flex items-center gap-2 text-sm">
                    <Badge variant={federationSettings.node.enabled ? "secondary" : "outline"}>
                      {federationSettings.node.enabled ? "Node Active" : "Node Not Enabled"}
                    </Badge>
                    <span className="text-muted-foreground">
                      {federationSettings.node.enabled ? (
                        <>
                          Hosted node <span className="font-medium text-foreground">{federationSettings.node.slug}</span>
                        </>
                      ) : (
                        "This account does not currently own the hosted Rivr federation node."
                      )}
                    </span>
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-lg border p-3">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Trusted Peers</p>
                      <p className="text-2xl font-semibold">{federationSettings.node.trustedPeers ?? 0}</p>
                    </div>
                    <div className="rounded-lg border p-3">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Queued Events</p>
                      <p className="text-2xl font-semibold">{federationSettings.node.queuedEvents ?? 0}</p>
                    </div>
                    <div className="rounded-lg border p-3">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Exported Events</p>
                      <p className="text-2xl font-semibold">{federationSettings.node.exportedEvents ?? 0}</p>
                    </div>
                  </div>
                  {federationSettings.node.baseUrl ? (
                    <div className="rounded-lg border p-3 text-sm">
                      <p className="font-medium">Base URL</p>
                      <p className="mt-1 break-all text-muted-foreground">{federationSettings.node.baseUrl}</p>
                    </div>
                  ) : null}

                  <div className="grid gap-4 lg:grid-cols-2">
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">PeerMesh Spatial</CardTitle>
                        <CardDescription>
                          Link your Spatial / Universal Manifest identity to this Rivr profile.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {federationSettings.peermesh.linked ? (
                          <div className="space-y-3">
                            <div className="flex items-center gap-2 text-sm">
                              <Badge variant="secondary">Linked</Badge>
                              <span className="font-medium">{federationSettings.peermesh.handle ?? "PeerMesh identity"}</span>
                            </div>
                            {federationSettings.peermesh.did ? (
                              <p className="text-xs break-all text-muted-foreground">{federationSettings.peermesh.did}</p>
                            ) : null}
                            {federationSettings.peermesh.manifestUrl ? (
                              <a
                                href={federationSettings.peermesh.manifestUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                              >
                                View manifest
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            ) : null}
                            <Button
                              variant="outline"
                              onClick={handleUnlinkPeermesh}
                              disabled={federationSaving !== null}
                            >
                              {federationSaving === "peermesh" ? "Unlinking..." : "Unlink PeerMesh"}
                            </Button>
                          </div>
                        ) : (
                          <>
                            <Textarea
                              value={peermeshInput}
                              onChange={(e) => setPeermeshInput(e.target.value)}
                              placeholder="Paste your PeerMesh export JSON or a https://spatial.peermesh.org manifest URL"
                              className="min-h-32"
                            />
                            <div className="flex items-center justify-between gap-3">
                              <a
                                href="https://spatial.peermesh.org/signin"
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                              >
                                Open Spatial
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                              <Button
                                onClick={handleLinkPeermesh}
                                disabled={federationSaving !== null || peermeshInput.trim().length === 0}
                              >
                                {federationSaving === "peermesh" ? "Linking..." : "Link PeerMesh"}
                              </Button>
                            </div>
                          </>
                        )}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">Bluesky / AT Protocol</CardTitle>
                        <CardDescription>
                          Link your Bluesky identity using an app password. The password is used once and never stored.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {federationSettings.atproto.linked ? (
                          <div className="space-y-3">
                            <div className="flex items-center gap-2 text-sm">
                              <Badge variant="secondary">Linked</Badge>
                              <span className="font-medium">{federationSettings.atproto.handle ?? "AT Protocol identity"}</span>
                            </div>
                            {federationSettings.atproto.did ? (
                              <p className="text-xs break-all text-muted-foreground">{federationSettings.atproto.did}</p>
                            ) : null}
                            {federationSettings.atproto.handle ? (
                              <a
                                href={`https://bsky.app/profile/${federationSettings.atproto.handle}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                              >
                                View profile
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            ) : null}
                            <Button
                              variant="outline"
                              onClick={handleUnlinkAtproto}
                              disabled={federationSaving !== null}
                            >
                              {federationSaving === "atproto" ? "Unlinking..." : "Unlink Bluesky"}
                            </Button>
                          </div>
                        ) : (
                          <>
                            <div className="grid gap-2">
                              <label className="text-sm font-medium">Handle</label>
                              <input
                                type="text"
                                className="p-2 border rounded-md bg-background text-foreground"
                                value={blueskyHandle}
                                onChange={(e) => setBlueskyHandle(e.target.value)}
                                placeholder="you.bsky.social"
                              />
                            </div>
                            <div className="grid gap-2">
                              <label className="text-sm font-medium">App Password</label>
                              <input
                                type="password"
                                className="p-2 border rounded-md bg-background text-foreground"
                                value={blueskyAppPassword}
                                onChange={(e) => setBlueskyAppPassword(e.target.value)}
                                placeholder="xxxx-xxxx-xxxx-xxxx"
                              />
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <a
                                href="https://bsky.app/settings/app-passwords"
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                              >
                                Create app password
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                              <Button
                                onClick={handleLinkAtproto}
                                disabled={
                                  federationSaving !== null ||
                                  blueskyHandle.trim().length === 0 ||
                                  blueskyAppPassword.trim().length === 0
                                }
                              >
                                {federationSaving === "atproto" ? "Linking..." : "Link Bluesky"}
                              </Button>
                            </div>
                          </>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </>
              ) : (
                <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                  {federationSettings.error ?? "Unable to load federation settings right now."}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security" className="space-y-4">
          {/*
           * Security tab: sovereign-only surfaces rendered here. The panel
           * self-gates on /api/recovery/status → sovereignMode so
           * hosted-federated deployments collapse it to null.
           */}
          <RecoverySeedPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SellerAccountSection() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [setupLoading, setSetupLoading] = useState(false);
  const [status, setStatus] = useState<{
    hasAccount: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    dashboardUrl?: string;
  } | null>(null);
  const [balance, setBalance] = useState<{ availableCents: number; pendingCents: number } | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const [result, balanceResult] = await Promise.all([
        getConnectStatusAction(),
        getConnectBalanceAction(),
      ]);
      if (result.success && result.status) {
        setStatus({
          hasAccount: result.status.hasAccount,
          chargesEnabled: result.status.chargesEnabled,
          payoutsEnabled: result.status.payoutsEnabled,
          detailsSubmitted: result.status.detailsSubmitted,
          dashboardUrl: result.status.dashboardUrl,
        });
      } else {
        setStatus({ hasAccount: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false });
      }
      if (balanceResult.success && balanceResult.balance) {
        setBalance(balanceResult.balance);
      } else {
        setBalance({ availableCents: 0, pendingCents: 0 });
      }
    } catch {
      setStatus({ hasAccount: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false });
      setBalance({ availableCents: 0, pendingCents: 0 });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  async function handleSetup() {
    setSetupLoading(true);
    try {
      const result = await setupConnectAccountAction();
      if (result.success && result.url) {
        window.location.href = result.url;
      } else {
        toast({
          title: "Setup failed",
          description: result.error ?? "Could not create seller account. Please try again.",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Setup failed",
        description: "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setSetupLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!status?.hasAccount || !status.detailsSubmitted) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Store className="h-6 w-6 text-muted-foreground" />
            <div>
              <CardTitle>Stripe USD Wallet</CardTitle>
              <CardDescription>
                {status?.hasAccount
                  ? "Complete Stripe onboarding to activate your Stripe USD wallet and receive card sales."
                  : "Set up your Stripe USD wallet to receive card payments for offerings and request payouts."}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {status?.hasAccount && (
            <div className="space-y-2">
              <StatusRow label="Details submitted" done={status.detailsSubmitted} />
              <StatusRow label="Charges enabled" done={status.chargesEnabled} />
              <StatusRow label="Payouts enabled" done={status.payoutsEnabled} />
            </div>
          )}
          <Button onClick={handleSetup} disabled={setupLoading} className="w-full">
            {setupLoading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Setting up...
              </>
            ) : status?.hasAccount ? (
              "Complete Setup"
            ) : (
              "Set Up Stripe USD Wallet"
            )}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const isFullyActive = status.chargesEnabled && status.payoutsEnabled;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Store className="h-6 w-6 text-muted-foreground" />
            <div>
              <CardTitle>Stripe USD Wallet</CardTitle>
              <CardDescription>Manage card sales, payout readiness, and Stripe dashboard access.</CardDescription>
            </div>
          </div>
          <Badge variant={isFullyActive ? "default" : "secondary"}>
            {isFullyActive ? "Active" : "Limited"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <StatusRow label="Details submitted" done={status.detailsSubmitted} />
          <StatusRow label="Charges enabled" done={status.chargesEnabled} />
          <StatusRow label="Payouts enabled" done={status.payoutsEnabled} />
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <Card>
            <CardContent className="py-4">
              <p className="text-xs text-muted-foreground">Available Stripe balance</p>
              <p className="text-2xl font-semibold">
                {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((balance?.availableCents ?? 0) / 100)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <p className="text-xs text-muted-foreground">Pending Stripe balance</p>
              <p className="text-2xl font-semibold">
                {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((balance?.pendingCents ?? 0) / 100)}
              </p>
            </CardContent>
          </Card>
        </div>

        <Separator />

        {status.dashboardUrl && (
          <Button variant="outline" className="w-full" asChild>
            <a href={status.dashboardUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4 mr-2" />
              Open Stripe Dashboard
            </a>
          </Button>
        )}

        {!isFullyActive && (
          <Button onClick={handleSetup} disabled={setupLoading} variant="secondary" className="w-full">
            {setupLoading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Loading...
              </>
            ) : (
              "Complete Account Setup"
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function StatusRow({ label, done }: { label: string; done: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {done ? (
        <CheckCircle2 className="h-4 w-4 text-green-600" />
      ) : (
        <AlertCircle className="h-4 w-4 text-amber-500" />
      )}
      <span className={done ? "text-foreground" : "text-muted-foreground"}>{label}</span>
    </div>
  );
}
