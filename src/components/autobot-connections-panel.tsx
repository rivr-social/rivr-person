"use client";

import Script from "next/script";
import { useCallback, useEffect, useMemo, useState } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import {
  Calendar,
  ChevronDown,
  ExternalLink,
  FileText,
  FolderOpen,
  KeyRound,
  Loader2,
  MessageSquare,
  Network,
  Phone,
  RefreshCw,
  Settings2,
  Wallet,
  Zap,
} from "lucide-react";
import {
  AUTOBOT_CONNECTOR_DEFINITIONS,
  getAutobotConnectorDefinition,
  type AutobotConnection,
  type AutobotConnectionModule,
  type AutobotConnectionProvider,
  type AutobotConnectionStatus,
  type AutobotConnectorDefinition,
} from "@/lib/autobot-connectors";

type LinkedAccount = {
  provider: string;
  providerAccountId: string;
  scope: string | null;
  expiresAt: number | null;
};

type ConnectionsResponse = {
  definitions?: AutobotConnectorDefinition[];
  connections?: AutobotConnection[];
  linkedAccounts?: LinkedAccount[];
  availableAuthProviders?: Partial<Record<string, boolean>>;
  subject?: {
    actorId: string;
    ownerId: string;
    scopeType: "person" | "persona";
    scopeLabel: string;
    personaName?: string;
  };
};

type SyncResponse = {
  result?: {
    provider: AutobotConnectionProvider;
    imported: number;
    updated: number;
    skipped: number;
    message: string;
  };
  connections?: AutobotConnection[];
  subject?: ConnectionsResponse["subject"];
  error?: string;
};

type TestResponse = {
  provider: string;
  valid: boolean;
  label?: string;
  error?: string;
  testedAt: string;
};

type SetupResponse = {
  connection?: AutobotConnection;
  connections?: AutobotConnection[];
  subject?: ConnectionsResponse["subject"];
  error?: string;
};

const API_ENDPOINT = "/api/autobot/connections";
const TELLER_CONNECT_JS_URL = "https://cdn.teller.io/connect/connect.js";

const MODULE_ICON_MAP: Record<AutobotConnectionModule, typeof FileText> = {
  docs: FileText,
  calendar: Calendar,
  messages: MessageSquare,
  media: FolderOpen,
  kg: Network,
  groups: MessageSquare,
  wallet: Wallet,
};

const STATUS_TONE: Record<AutobotConnectionStatus, "outline" | "default" | "secondary" | "destructive"> = {
  disconnected: "outline",
  connected: "default",
  needs_auth: "secondary",
  error: "destructive",
};

declare global {
  interface Window {
    TellerConnect?: {
      setup: (config: Record<string, unknown>) => {
        open: () => void;
      };
    };
  }
}

type ProviderSetupStep = {
  title: string;
  detail: string;
  href?: string;
  value?: string;
};

type GuidedSetupField = {
  key: string;
  label: string;
  placeholder: string;
  description?: string;
  inputType?: "text" | "url" | "password";
};

function getGuidedSetupFields(
  definition: AutobotConnectorDefinition,
): GuidedSetupField[] {
  switch (definition.provider) {
    case "telegram":
      return [
        { key: "botToken", label: "Bot Token", placeholder: "123456:ABC...", inputType: "password" },
        { key: "chatId", label: "Chat ID", placeholder: "-1001234567890" },
        { key: "threadId", label: "Thread ID", placeholder: "optional topic/thread id" },
        { key: "phoneNumber", label: "Phone Number", placeholder: "+15551234567" },
      ];
    case "whatsapp_business":
      return [
        { key: "phoneNumberId", label: "Phone Number ID", placeholder: "Meta phone number id" },
        { key: "businessAccountId", label: "Business Account ID", placeholder: "WhatsApp business account id" },
        { key: "verifyToken", label: "Verify Token", placeholder: "Webhook verify token", inputType: "password" },
        { key: "webhookSecret", label: "Webhook Secret", placeholder: "Webhook app secret", inputType: "password" },
      ];
    case "signal":
      return [
        { key: "serviceUrl", label: "Signal Bridge URL", placeholder: "https://signal.example.com", inputType: "url" },
        { key: "phoneNumber", label: "Phone Number", placeholder: "+15551234567" },
        { key: "deviceName", label: "Device Name", placeholder: "Rivr Signal Bridge" },
      ];
    case "obsidian_vault":
    case "parachute_vault":
      return [
        {
          key: "vaultPath",
          label: definition.provider === "obsidian_vault" ? "Vault Path" : "Library Path",
          placeholder: "/srv/data/vault",
          description: "This path is checked on the self-hosted instance itself.",
        },
      ];
    case "messenger":
      return [
        { key: "exportPath", label: "Export JSON Path", placeholder: "/srv/imports/messenger/inbox" },
        { key: "accountEmail", label: "Facebook Account Email", placeholder: "you@example.com" },
      ];
    case "proton_docs":
      return [
        { key: "workspaceId", label: "Workspace ID", placeholder: "Proton workspace id" },
        { key: "notes", label: "Notes", placeholder: "Optional notes about the Proton workspace" },
      ];
    case "wolfram":
      return [
        { key: "licenseKey", label: "License Key", placeholder: "Wolfram license or API key", inputType: "password" },
        { key: "cloudBaseUrl", label: "Cloud Base URL", placeholder: "https://www.wolframcloud.com", inputType: "url" },
        { key: "appId", label: "App ID", placeholder: "Optional Wolfram app id" },
      ];
    case "github":
      return [
        { key: "repoUrl", label: "Repository URL", placeholder: "https://github.com/owner/repo", inputType: "url" },
        { key: "branch", label: "Branch", placeholder: "main" },
        { key: "token", label: "Personal Access Token", placeholder: "ghp_...", inputType: "password", description: "Fine-grained PAT with Contents read/write permission on the target repo." },
        { key: "basePath", label: "Base Path", placeholder: "site/ (optional subdirectory)" },
      ];
    case "email_smtp":
      return [
        { key: "smtpHost", label: "SMTP Host", placeholder: "smtp.example.com" },
        { key: "smtpPort", label: "SMTP Port", placeholder: "587" },
        { key: "smtpUser", label: "SMTP Username", placeholder: "user@example.com" },
        { key: "smtpPass", label: "SMTP Password", placeholder: "app password", inputType: "password" },
        { key: "imapHost", label: "IMAP Host", placeholder: "imap.example.com (optional)", description: "Optional: for inbound email ingestion." },
        { key: "fromAddress", label: "From Address", placeholder: "noreply@example.com" },
      ];
    case "matrix":
      return [
        { key: "homeserverUrl", label: "Homeserver URL", placeholder: "https://matrix.org", inputType: "url" },
        { key: "userId", label: "User ID", placeholder: "@user:matrix.org" },
        { key: "accessToken", label: "Access Token", placeholder: "syt_...", inputType: "password" },
        { key: "roomId", label: "Default Room ID", placeholder: "!roomid:matrix.org" },
      ];
    case "mastodon":
      return [
        { key: "instanceUrl", label: "Instance URL", placeholder: "https://mastodon.social", inputType: "url" },
        { key: "clientId", label: "Client ID", placeholder: "Application client id" },
        { key: "clientSecret", label: "Client Secret", placeholder: "Application client secret", inputType: "password" },
      ];
    case "bluesky":
      return [
        { key: "handle", label: "Handle", placeholder: "you.bsky.social" },
        { key: "appPassword", label: "App Password", placeholder: "xxxx-xxxx-xxxx-xxxx", inputType: "password" },
        { key: "pdsUrl", label: "PDS URL", placeholder: "https://bsky.social (optional)", inputType: "url", description: "Only needed for self-hosted PDS." },
      ];
    default:
      return [];
  }
}

function getProviderSetupSteps(
  definition: AutobotConnectorDefinition,
  origin: string,
): ProviderSetupStep[] {
  switch (definition.provider) {
    case "teller":
      return [
        {
          title: "Create a Teller application",
          detail: "In the Teller dashboard, create an application for this Rivr instance.",
          href: "https://teller.io/settings/application",
        },
        {
          title: "Paste this webhook URL into Teller",
          detail: "Use this URL on the Teller Application page so Rivr receives enrollment and transaction events.",
          value: `${origin}/api/wallet/banks/webhook`,
        },
        {
          title: "Add the app ID and signing keys to Rivr env",
          detail: "Set TELLER_APPLICATION_ID, TELLER_SIGNING_PUBLIC_KEY, and TELLER_WEBHOOK_SECRET for this instance. Add cert/key too if you want development or production API calls.",
        },
      ];
    case "google_docs":
    case "google_calendar":
      return [
        {
          title: "Create Google OAuth credentials",
          detail: "In Google Cloud Console, create a Web application OAuth client for this Rivr instance.",
          href: "https://console.cloud.google.com/apis/credentials",
        },
        {
          title: "Authorize this callback URL",
          detail: "Add this exact redirect URI to the Google OAuth client.",
          value: `${origin}/api/auth/callback/google`,
        },
        {
          title: "Add the client ID and secret to Rivr env",
          detail: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then come back and click Connect.",
        },
      ];
    case "notion":
      return [
        {
          title: "Create a Notion OAuth integration",
          detail: "Create a public integration for this Rivr instance in the Notion developer dashboard.",
          href: "https://www.notion.so/profile/integrations",
        },
        {
          title: "Authorize this callback URL",
          detail: "Use this redirect URI in the Notion integration settings.",
          value: `${origin}/api/autobot/connections/notion/callback`,
        },
        {
          title: "Add the client ID and secret to Rivr env",
          detail: "Set NOTION_CLIENT_ID and NOTION_CLIENT_SECRET, then click Connect in Rivr.",
        },
      ];
    case "telegram":
      return [
        {
          title: "Create a Telegram app",
          detail: "Create an application at my.telegram.org so this Rivr instance can use Telegram API credentials.",
          href: "https://my.telegram.org/apps",
        },
        {
          title: "Create or choose a Telegram bot",
          detail: "Use BotFather to create the bot Rivr will use for groups, channels, and notifications.",
          href: "https://t.me/BotFather",
        },
        {
          title: "Add Telegram credentials to Rivr env",
          detail: "Set TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_BOT_TOKEN. Then save the bot token, phone, and chat IDs in this connector.",
        },
      ];
    case "whatsapp_business":
      return [
        {
          title: "Create a Meta app with WhatsApp Business",
          detail: "In the Meta developer dashboard, add the WhatsApp product and finish phone-number onboarding for this Rivr instance.",
          href: "https://developers.facebook.com/apps/",
        },
        {
          title: "Use this webhook URL in WhatsApp Business",
          detail: "Paste this callback URL into the WhatsApp webhook settings and pair it with your verify token.",
          value: `${origin}/api/groups/whatsapp/webhook`,
        },
        {
          title: "Add WhatsApp credentials to Rivr env",
          detail: "Set WHATSAPP_APP_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, and WHATSAPP_PHONE_NUMBER_ID, then save the phone and business IDs here.",
        },
      ];
    case "apple_sign_in":
      return [
        {
          title: "Create an Apple Services ID",
          detail: "In the Apple Developer portal, configure Sign in with Apple for this Rivr instance.",
          href: "https://developer.apple.com/account/resources/identifiers/list/serviceId",
        },
        {
          title: "Authorize this callback URL",
          detail: "Add this return URL under the Services ID web authentication settings.",
          value: `${origin}/api/autobot/connections/apple/callback`,
        },
        {
          title: "Add Apple credentials to Rivr env",
          detail: "Set APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY, then enable the provider for this instance.",
        },
      ];
    case "slack":
      return [
        {
          title: "Create a Slack app",
          detail: "Create the workspace app and define the bot scopes for channels, messages, and files.",
          href: "https://api.slack.com/apps",
        },
        {
          title: "Authorize this callback URL",
          detail: "Use this URL as the Slack OAuth redirect URI.",
          value: `${origin}/api/autobot/connections/slack/callback`,
        },
        {
          title: "Add Slack credentials to Rivr env",
          detail: "Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET, then return here to finish workspace and channel mapping.",
        },
      ];
    case "discord":
      return [
        {
          title: "Create a Discord application",
          detail: "Create the bot and OAuth app that Rivr will use for your servers and channels.",
          href: "https://discord.com/developers/applications",
        },
        {
          title: "Authorize this callback URL",
          detail: "Use this URL in the Discord OAuth2 redirect list.",
          value: `${origin}/api/autobot/connections/discord/callback`,
        },
        {
          title: "Add Discord credentials to Rivr env",
          detail: "Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET, then save your guild and channel defaults here.",
        },
      ];
    case "dropbox":
      return [
        {
          title: "Create a Dropbox app",
          detail: "Create a scoped Dropbox app for this Rivr instance and choose the files/content permissions you want.",
          href: "https://www.dropbox.com/developers/apps",
        },
        {
          title: "Authorize this callback URL",
          detail: "Use this redirect URI in the Dropbox app settings.",
          value: `${origin}/api/autobot/connections/dropbox/callback`,
        },
        {
          title: "Add Dropbox credentials to Rivr env",
          detail: "Set DROPBOX_CLIENT_ID and DROPBOX_CLIENT_SECRET, then save your root path and sync defaults here.",
        },
      ];
    case "zoom":
      return [
        {
          title: "Create a Zoom app",
          detail: "Create a server-to-server or OAuth Zoom app for meetings, recordings, and calendar workflows.",
          href: "https://marketplace.zoom.us/develop/create",
        },
        {
          title: "Authorize this callback URL",
          detail: "Use this redirect URI in the Zoom app settings.",
          value: `${origin}/api/autobot/connections/zoom/callback`,
        },
        {
          title: "Add Zoom credentials to Rivr env",
          detail: "Set ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET, then save your meeting defaults and webhook secret here.",
        },
      ];
    case "signal":
      return [
        {
          title: "Provision a Signal bridge or API endpoint",
          detail: "Expose the Signal bridge service or API endpoint that this Rivr instance will use for secure messaging.",
        },
        {
          title: "Save Signal connection details in Rivr",
          detail: "Store the service URL, phone number, and device or registration info in the advanced settings for this connector.",
        },
      ];
    case "facebook":
      return [
        {
          title: "Create a Meta app",
          detail: "Use the Meta developer dashboard to create the OAuth app for this instance.",
          href: "https://developers.facebook.com/apps/",
        },
        {
          title: "Authorize this callback URL",
          detail: "Add this valid OAuth redirect URI in the Facebook Login product.",
          value: `${origin}/api/autobot/connections/facebook/callback`,
        },
        {
          title: "Add the client ID and secret to Rivr env",
          detail: "Set FACEBOOK_CLIENT_ID and FACEBOOK_CLIENT_SECRET, then return and connect.",
        },
      ];
    case "instagram":
      return [
        {
          title: "Create a Meta app with Instagram scopes",
          detail: "Configure the Instagram product under your Meta app for this Rivr instance.",
          href: "https://developers.facebook.com/apps/",
        },
        {
          title: "Authorize this callback URL",
          detail: "Add this redirect URI in the Instagram/Meta OAuth settings.",
          value: `${origin}/api/autobot/connections/instagram/callback`,
        },
        {
          title: "Add the client ID and secret to Rivr env",
          detail: "Set INSTAGRAM_CLIENT_ID and INSTAGRAM_CLIENT_SECRET, then click Connect.",
        },
      ];
    case "github":
      return [
        {
          title: "Create a fine-grained Personal Access Token",
          detail: "In GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens, create a token with Contents read/write on the target repo.",
          href: "https://github.com/settings/tokens?type=beta",
        },
        {
          title: "Fill in the guided setup fields",
          detail: "Enter the repository URL, branch, token, and optional base path below, then click Complete Guided Setup.",
        },
      ];
    case "email_smtp":
      return [
        {
          title: "Obtain SMTP credentials from your email provider",
          detail: "Use an app password or SMTP relay credentials. Most providers require an app-specific password rather than your main account password.",
        },
        {
          title: "Fill in SMTP host, port, and credentials below",
          detail: "Common ports: 587 (STARTTLS) or 465 (SSL). Enter the from address Rivr should use for outbound mail.",
        },
      ];
    case "matrix":
      return [
        {
          title: "Generate an access token from your Matrix client",
          detail: "In Element or another client, go to Settings → Help & About → Access Token. Or use the login API to generate one programmatically.",
        },
        {
          title: "Enter homeserver URL, user ID, and token below",
          detail: "The room ID is optional — it sets the default room for message bridging.",
        },
      ];
    case "mastodon":
      return [
        {
          title: "Register an application on your Mastodon instance",
          detail: "Go to Preferences → Development → New Application on your instance.",
          href: "https://mastodon.social/settings/applications",
        },
        {
          title: "Authorize this callback URL",
          detail: "Use this redirect URI in the application settings.",
          value: `${origin}/api/autobot/connections/mastodon/callback`,
        },
        {
          title: "Enter the client ID, secret, and instance URL below",
          detail: "Copy the client key and secret from the application page.",
        },
      ];
    case "bluesky":
      return [
        {
          title: "Create an App Password in Bluesky",
          detail: "Go to Settings → App Passwords → Add App Password in the Bluesky app.",
          href: "https://bsky.app/settings/app-passwords",
        },
        {
          title: "Enter your handle and app password below",
          detail: "The PDS URL is only needed if you use a self-hosted Personal Data Server.",
        },
      ];
    default:
      return [];
  }
}

export function AutobotConnectionsPanel() {
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const [connections, setConnections] = useState<AutobotConnection[]>([]);
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>([]);
  const [availableAuthProviders, setAvailableAuthProviders] = useState<
    Partial<Record<string, boolean>>
  >({});
  const [loading, setLoading] = useState(true);
  const [savingProvider, setSavingProvider] = useState<AutobotConnectionProvider | null>(null);
  const [settingUpProvider, setSettingUpProvider] = useState<AutobotConnectionProvider | null>(null);
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);
  const [syncingProvider, setSyncingProvider] = useState<AutobotConnectionProvider | null>(null);
  const [testingProvider, setTestingProvider] = useState<AutobotConnectionProvider | null>(null);
  const [subject, setSubject] = useState<ConnectionsResponse["subject"] | null>(null);
  const [tellerScriptReady, setTellerScriptReady] = useState(false);

  const definitions = useMemo(
    () => AUTOBOT_CONNECTOR_DEFINITIONS,
    [],
  );

  const fetchConnections = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(API_ENDPOINT, { cache: "no-store" });
      if (!response.ok) throw new Error(`Failed to load connectors (${response.status})`);
      const data = (await response.json()) as ConnectionsResponse;
      setConnections(Array.isArray(data.connections) ? data.connections : []);
      setLinkedAccounts(Array.isArray(data.linkedAccounts) ? data.linkedAccounts : []);
      setAvailableAuthProviders(
        data.availableAuthProviders &&
          typeof data.availableAuthProviders === "object"
          ? data.availableAuthProviders
          : {},
      );
      setSubject(data.subject ?? null);
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : "Failed to load connectors",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  useEffect(() => {
    const notionError = searchParams.get("notion_error");
    const googleError = searchParams.get("google_error");
    const facebookError = searchParams.get("facebook_error");
    const instagramError = searchParams.get("instagram_error");
    const appleError = searchParams.get("apple_error");
    const slackError = searchParams.get("slack_error");
    const discordError = searchParams.get("discord_error");
    const dropboxError = searchParams.get("dropbox_error");
    const zoomError = searchParams.get("zoom_error");
    const oauthError = searchParams.get("oauth_error");
    const error =
      googleError ||
      notionError ||
      facebookError ||
      instagramError ||
      appleError ||
      slackError ||
      discordError ||
      dropboxError ||
      zoomError ||
      oauthError;
    if (!error) return;

    toast({
      title: "Connection failed",
      description: error.replace(/_/g, " "),
      variant: "destructive",
    });
  }, [searchParams, toast]);

  const launchTellerConnect = useCallback(async () => {
    if (!tellerScriptReady || !window.TellerConnect?.setup) {
      throw new Error("Teller Connect has not finished loading yet.");
    }

    const sessionResponse = await fetch("/api/wallet/banks/connect", {
      cache: "no-store",
    });
    const sessionData = (await sessionResponse.json().catch(() => ({}))) as {
      applicationId?: string;
      environment?: "sandbox" | "development" | "production";
      products?: string[];
      nonce?: string;
      error?: string;
    };

    if (
      !sessionResponse.ok ||
      !sessionData.applicationId ||
      !sessionData.environment ||
      !Array.isArray(sessionData.products) ||
      !sessionData.nonce
    ) {
      throw new Error(sessionData.error || "Unable to initialize Teller Connect.");
    }

    let completed = false;

    await new Promise<void>((resolve, reject) => {
      const teller = window.TellerConnect?.setup({
        applicationId: sessionData.applicationId,
        environment: sessionData.environment,
        products: sessionData.products,
        selectAccount: "multiple",
        nonce: sessionData.nonce,
        onSuccess: async (payload: Record<string, unknown>) => {
          try {
            const enrollResponse = await fetch("/api/wallet/banks/enroll", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            const enrollData = (await enrollResponse.json().catch(() => ({}))) as {
              error?: string;
            };
            if (!enrollResponse.ok) {
              throw new Error(
                enrollData.error || "Failed to save linked bank account.",
              );
            }
            completed = true;
            resolve();
          } catch (error) {
            reject(error);
          }
        },
        onFailure: (failure: { message?: string }) => {
          reject(
            new Error(
              failure?.message || "The bank connection did not complete.",
            ),
          );
        },
        onExit: () => {
          if (!completed) resolve();
        },
      });

      if (!teller) {
        reject(new Error("Unable to open Teller Connect."));
        return;
      }

      teller.open();
    });
  }, [tellerScriptReady]);

  const upsertConnection = useCallback(
    async (provider: AutobotConnectionProvider, patch: Partial<AutobotConnection>) => {
      const existing = connections.find((item) => item.provider === provider);
      const definition = getAutobotConnectorDefinition(provider);
      if (!definition) return;

      const nextConnection: AutobotConnection = {
        provider,
        status: patch.status ?? existing?.status ?? "disconnected",
        syncDirection: patch.syncDirection ?? existing?.syncDirection ?? "import",
        modules: patch.modules ?? existing?.modules ?? definition.modules,
        accountLabel: patch.accountLabel ?? existing?.accountLabel,
        externalAccountId: patch.externalAccountId ?? existing?.externalAccountId,
        lastSyncedAt: patch.lastSyncedAt ?? existing?.lastSyncedAt,
        error: patch.error ?? existing?.error,
        config: patch.config ?? existing?.config ?? {},
      };

      const nextConnections = [
        ...connections.filter((item) => item.provider !== provider),
        nextConnection,
      ].sort((a, b) => a.provider.localeCompare(b.provider));

      setSavingProvider(provider);
      try {
        const response = await fetch(API_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connections: nextConnections }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `Failed to save connector (${response.status})`);
        }
        const data = (await response.json()) as ConnectionsResponse;
        setConnections(Array.isArray(data.connections) ? data.connections : nextConnections);
        setSubject(data.subject ?? null);
        toast({ title: `${definition.label} connector saved` });
      } catch (error) {
        toast({
          title: error instanceof Error ? error.message : "Failed to save connector",
          variant: "destructive",
        });
      } finally {
        setSavingProvider(null);
      }
    },
    [connections, toast],
  );

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Connections</CardTitle>
          <CardDescription>Loading connector settings…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Script
        src={TELLER_CONNECT_JS_URL}
        strategy="afterInteractive"
        onLoad={() => setTellerScriptReady(true)}
      />
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Network className="h-4 w-4" />
            Person Connections
          </CardTitle>
          <CardDescription>
            Manage service connections for this Rivr person instance. Some of them can also be shared with Autobot after setup, but configuration starts here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {subject ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm">
              <Badge variant={subject.scopeType === "persona" ? "default" : "secondary"}>
                {subject.scopeType === "persona" ? "Persona" : "Main profile"}
              </Badge>
              <span className="font-medium">{subject.scopeLabel}</span>
              <span className="text-muted-foreground">
                These settings belong to this {subject.scopeType}. Person-level services like banking stay on the main profile.
              </span>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {linkedAccounts.length > 0 ? (
              linkedAccounts.map((account) => (
                <Badge key={`${account.provider}:${account.providerAccountId}`} variant="secondary">
                  {account.provider}:{account.providerAccountId}
                </Badge>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                No Auth.js OAuth accounts linked yet. Connector configs below can still be prepared before OAuth wiring is completed.
              </p>
            )}
          </div>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" className="gap-1" onClick={fetchConnections}>
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {definitions.map((definition) => {
        const connection =
          connections.find((item) => item.provider === definition.provider) ?? {
            provider: definition.provider,
            status: "disconnected" as const,
            syncDirection: "import" as const,
            modules: definition.modules,
            config: {},
          };
        const isSaving = savingProvider === definition.provider;

        return (
          <ConnectorCard
            key={definition.provider}
            definition={definition}
            connection={connection}
            linkedAccounts={linkedAccounts}
            availableAuthProviders={availableAuthProviders}
            connectingProvider={connectingProvider}
            settingUpProvider={settingUpProvider}
            syncingProvider={syncingProvider}
            testingProvider={testingProvider}
            saving={isSaving}
            onSave={upsertConnection}
            onTest={async (provider) => {
              setTestingProvider(provider);
              try {
                if (provider === "github") {
                  const response = await fetch("/api/builder/github-connection", {
                    cache: "no-store",
                  });
                  const data = (await response.json().catch(() => ({}))) as {
                    connected?: boolean;
                    valid?: boolean;
                    validationError?: string;
                    repo?: string;
                    deployMethod?: string;
                    error?: string;
                  };
                  if (!response.ok) {
                    throw new Error(data.error || `Test failed (${response.status})`);
                  }
                  if (data.deployMethod === "direct") {
                    toast({
                      title: "Sovereign instance",
                      description: "This instance deploys directly. GitHub connection is not needed.",
                    });
                    return;
                  }
                  if (!data.connected) {
                    toast({
                      title: "Not connected",
                      description: "No GitHub repository is connected yet. Use Guided Setup to connect one.",
                      variant: "destructive",
                    });
                    return;
                  }
                  if (data.valid) {
                    toast({
                      title: "GitHub connection is valid",
                      description: `Connected to ${data.repo ?? "repository"} — ready for builder deploy.`,
                    });
                    await upsertConnection("github", {
                      status: "connected",
                      accountLabel: data.repo,
                      lastSyncedAt: new Date().toISOString(),
                      error: undefined,
                    });
                  } else {
                    toast({
                      title: "GitHub connection invalid",
                      description: data.validationError || "The stored token or repo is no longer accessible.",
                      variant: "destructive",
                    });
                    await upsertConnection("github", {
                      status: "error",
                      error: data.validationError || "Connection test failed",
                    });
                  }
                  return;
                }
                // Generic test: use the per-provider test endpoint
                const response = await fetch(`/api/autobot/connections/${provider}/test`, {
                  method: "POST",
                });
                const data = (await response.json().catch(() => ({}))) as {
                  valid?: boolean;
                  label?: string;
                  testedAt?: string;
                  error?: string;
                  connections?: AutobotConnection[];
                };
                if (!response.ok) {
                  throw new Error(data.error || `Test failed (${response.status})`);
                }
                if (data.valid) {
                  toast({
                    title: `${getAutobotConnectorDefinition(provider)?.label ?? provider} test passed`,
                    description: data.label ? `Connected as ${data.label}` : "Connection is working.",
                  });
                } else {
                  toast({
                    title: `${getAutobotConnectorDefinition(provider)?.label ?? provider} test failed`,
                    description: data.error || "Connection could not be verified.",
                    variant: "destructive",
                  });
                }
                if (Array.isArray(data.connections)) {
                  setConnections(data.connections);
                }
              } catch (error) {
                toast({
                  title: error instanceof Error ? error.message : "Connection test failed",
                  variant: "destructive",
                });
              } finally {
                setTestingProvider(null);
              }
            }}
            onConnect={async (provider) => {
              setConnectingProvider(provider);
              try {
                const customOAuthRoutes: Record<string, string> = {
                  apple: "/api/autobot/connections/apple/connect",
                  google: "/api/autobot/connections/google/connect",
                  notion: "/api/autobot/connections/notion/connect",
                  facebook: "/api/autobot/connections/facebook/connect",
                  instagram: "/api/autobot/connections/instagram/connect",
                  slack: "/api/autobot/connections/slack/connect",
                  discord: "/api/autobot/connections/discord/connect",
                  dropbox: "/api/autobot/connections/dropbox/connect",
                  zoom: "/api/autobot/connections/zoom/connect",
                  oauth2: "/api/autobot/connections/oauth2/connect",
                };
                if (provider === "teller_bank") {
                  await launchTellerConnect();
                  await fetchConnections();
                  await upsertConnection("teller", { status: "connected" });
                  toast({
                    title: "Teller connected",
                    description: "Your linked bank accounts are now available in wallet and settings.",
                  });
                  return;
                }
                if (customOAuthRoutes[provider]) {
                  window.location.href = customOAuthRoutes[provider];
                  return;
                }
                await signIn(provider, {
                  redirectTo: `${window.location.pathname}${window.location.search}#connections`,
                });
              } finally {
                setConnectingProvider(null);
              }
            }}
            onSync={async (provider) => {
              setSyncingProvider(provider);
              try {
                if (provider === "teller") {
                  const response = await fetch("/api/wallet/banks", {
                    cache: "no-store",
                  });
                  const data = (await response.json().catch(() => ({}))) as {
                    error?: string;
                  };
                  if (!response.ok) {
                    throw new Error(data.error || `Failed to refresh Teller accounts (${response.status})`);
                  }
                  await fetchConnections();
                  toast({
                    title: "Teller accounts refreshed",
                    description: "Linked bank balances were refreshed from Teller.",
                  });
                  return;
                }
                const response = await fetch(`/api/autobot/connections/${provider}/sync`, {
                  method: "POST",
                });
                const data = (await response.json().catch(() => ({}))) as SyncResponse;
                if (!response.ok) {
                  throw new Error(data.error || `Failed to sync connector (${response.status})`);
                }
                if (Array.isArray(data.connections)) {
                  setConnections(data.connections);
                }
                setSubject(data.subject ?? null);
                toast({
                  title: data.result?.message || "Connector synced",
                  description: data.result
                    ? `${data.result.imported} imported, ${data.result.updated} updated, ${data.result.skipped} skipped`
                    : undefined,
                });
              } catch (error) {
                toast({
                  title: error instanceof Error ? error.message : "Failed to sync connector",
                  variant: "destructive",
                });
              } finally {
                setSyncingProvider(null);
              }
            }}
            onSetup={async (provider, payload) => {
              setSettingUpProvider(provider);
              try {
                if (provider === "github") {
                  // GitHub uses the builder github-connection API
                  const config = payload.config ?? {};
                  const response = await fetch("/api/builder/github-connection", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      repoUrl: config.repoUrl || "",
                      branch: config.branch || "main",
                      token: config.token || "",
                      basePath: config.basePath || undefined,
                    }),
                  });
                  const data = (await response.json().catch(() => ({}))) as {
                    success?: boolean;
                    connected?: boolean;
                    repo?: string;
                    branch?: string;
                    basePath?: string;
                    error?: string;
                    deployMethod?: string;
                  };
                  if (!response.ok || !data.success) {
                    throw new Error(data.error || `Failed to connect GitHub repository (${response.status})`);
                  }
                  // Also save to connector state so the card shows connected
                  await upsertConnection("github", {
                    status: "connected",
                    accountLabel: data.repo,
                    externalAccountId: data.repo,
                    lastSyncedAt: new Date().toISOString(),
                    config: {
                      repoUrl: config.repoUrl || "",
                      branch: data.branch || config.branch || "main",
                      basePath: data.basePath || config.basePath || "",
                    },
                    error: undefined,
                  });
                  toast({
                    title: "GitHub repository connected",
                    description: `Connected to ${data.repo ?? "repository"} (${data.branch ?? "main"}). Builder deploy is ready.`,
                  });
                  return;
                }
                const response = await fetch(`/api/autobot/connections/${provider}/setup`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload),
                });
                const data = (await response.json().catch(() => ({}))) as SetupResponse;
                if (!response.ok) {
                  throw new Error(data.error || `Failed to set up connector (${response.status})`);
                }
                if (Array.isArray(data.connections)) {
                  setConnections(data.connections);
                }
                setSubject(data.subject ?? null);
                toast({
                  title: `${getAutobotConnectorDefinition(provider)?.label ?? provider} setup saved`,
                  description: "The guided setup completed successfully.",
                });
              } catch (error) {
                toast({
                  title: error instanceof Error ? error.message : "Failed to set up connector",
                  variant: "destructive",
                });
              } finally {
                setSettingUpProvider(null);
              }
            }}
          />
        );
      })}
    </div>
  );
}

function ConnectorCard({
  definition,
  connection,
  linkedAccounts,
  availableAuthProviders,
  connectingProvider,
  settingUpProvider,
  syncingProvider,
  testingProvider,
  saving,
  onSave,
  onTest,
  onConnect,
  onSync,
  onSetup,
}: {
  definition: AutobotConnectorDefinition;
  connection: AutobotConnection;
  linkedAccounts: LinkedAccount[];
  availableAuthProviders: Partial<Record<string, boolean>>;
  connectingProvider: string | null;
  settingUpProvider: AutobotConnectionProvider | null;
  syncingProvider: AutobotConnectionProvider | null;
  testingProvider: AutobotConnectionProvider | null;
  saving: boolean;
  onSave: (
    provider: AutobotConnectionProvider,
    patch: Partial<AutobotConnection>,
  ) => Promise<void>;
  onTest: (provider: AutobotConnectionProvider) => Promise<void>;
  onConnect: (provider: string) => Promise<void>;
  onSync: (provider: AutobotConnectionProvider) => Promise<void>;
  onSetup: (
    provider: AutobotConnectionProvider,
    payload: {
      accountLabel?: string;
      externalAccountId?: string;
      syncDirection?: AutobotConnection["syncDirection"];
      config: Record<string, string>;
    },
  ) => Promise<void>;
}) {
  const [status, setStatus] = useState<AutobotConnectionStatus>(connection.status);
  const [syncDirection, setSyncDirection] = useState(connection.syncDirection);
  const [accountLabel, setAccountLabel] = useState(connection.accountLabel ?? "");
  const [externalAccountId, setExternalAccountId] = useState(connection.externalAccountId ?? "");
  const [configText, setConfigText] = useState(
    JSON.stringify(connection.config ?? {}, null, 2),
  );
  const [guidedValues, setGuidedValues] = useState<Record<string, string>>(connection.config ?? {});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    setStatus(connection.status);
    setSyncDirection(connection.syncDirection);
    setAccountLabel(connection.accountLabel ?? "");
    setExternalAccountId(connection.externalAccountId ?? "");
    setConfigText(JSON.stringify(connection.config ?? {}, null, 2));
    setGuidedValues(connection.config ?? {});
  }, [connection]);

  const relatedAccounts = linkedAccounts.filter((account) =>
    definition.authProvider
      ? (definition.authProvider === "google"
          ? ["google", "google_workspace"].includes(account.provider.toLowerCase())
          : definition.authProvider === "teller_bank"
            ? account.provider.toLowerCase() === "teller_bank"
            : account.provider.toLowerCase() === definition.authProvider.toLowerCase())
      : account.provider.toLowerCase().includes(definition.provider.split("_")[0]),
  );
  const derivedStatus: AutobotConnectionStatus =
    relatedAccounts.length > 0
      ? "connected"
      : connection.status;
  const connectableAuthProvider =
    definition.authStrategy === "oauth2" || definition.authStrategy === "interactive"
      ? definition.authProvider
      : null;
  const canLaunchOAuth = Boolean(
    connectableAuthProvider && availableAuthProviders[connectableAuthProvider],
  );
  const isConnecting =
    connectableAuthProvider !== null &&
    connectingProvider === connectableAuthProvider;
  const canSync = definition.supportsSync;
  const isSyncing = syncingProvider === definition.provider;
  const isTesting = testingProvider === definition.provider;
  const isSettingUp = settingUpProvider === definition.provider;
  const hasConfig = Object.keys(connection.config ?? {}).length > 0;
  const canTest = derivedStatus === "connected" || connection.status === "connected" || connection.status === "error" || connection.status === "needs_auth" || (hasConfig && relatedAccounts.length === 0);
  const guidedSetupFields = getGuidedSetupFields(definition);
  const supportsGuidedSetup = guidedSetupFields.length > 0;
  const setupMode =
    definition.authStrategy === "oauth2"
      ? "oauth"
      : definition.authStrategy === "interactive"
        ? "interactive"
      : definition.authStrategy === "phone"
        ? "phone"
        : definition.authStrategy === "filesystem"
          ? "filesystem"
          : definition.authStrategy === "token" || definition.authStrategy === "api_key"
            ? "credential"
            : "manual";
  const canStartGuidedSetup = setupMode === "oauth" || setupMode === "interactive";
  const primaryCtaLabel =
    setupMode === "oauth" || setupMode === "interactive"
      ? canLaunchOAuth
        ? relatedAccounts.length > 0
          ? "Reconnect"
          : "Connect"
        : "Set Up Provider"
      : setupMode === "phone"
        ? "Set up phone link"
        : setupMode === "filesystem"
          ? "Attach source"
          : setupMode === "credential"
            ? "Add credentials"
            : "Set up";
  const setupHint =
    setupMode === "oauth"
      ? canLaunchOAuth
        ? relatedAccounts.length > 0
          ? "This provider is linked. Reconnect if you need a fresh consent grant."
          : "Click once to sign in and return here connected."
        : `${definition.label} OAuth is not configured on this instance yet.`
      : setupMode === "interactive"
        ? canLaunchOAuth
          ? relatedAccounts.length > 0
            ? "This provider is linked. Reconnect to add or refresh linked accounts."
            : "Click once to open the guided connection flow inside Rivr."
          : `${definition.label} is not configured on this instance yet.`
      : setupMode === "phone"
        ? "Use a guided phone/session setup instead of raw config."
        : setupMode === "filesystem"
          ? "Choose the vault or source path, then sync."
          : setupMode === "credential"
            ? "Paste the provider credential only if the service truly requires it."
            : "Use the guided setup, then adjust advanced options only if needed.";
  const SetupIcon =
    setupMode === "phone"
      ? Phone
      : setupMode === "interactive"
        ? Wallet
      : setupMode === "credential"
        ? KeyRound
        : setupMode === "oauth"
          ? ExternalLink
          : Settings2;
  const origin =
    typeof window === "undefined" ? "" : window.location.origin;
  const providerSetupSteps = getProviderSetupSteps(definition, origin);

  const copySetupValue = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({
        title: "Copied",
        description: "The setup value was copied to your clipboard.",
      });
    } catch {
      toast({
        title: "Copy failed",
        description: "Copy the value manually from the field.",
        variant: "destructive",
      });
    }
  };

  const handleSave = async () => {
    let config: Record<string, string> = {};
    try {
      const parsed = JSON.parse(configText || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = Object.fromEntries(
          Object.entries(parsed).filter((entry): entry is [string, string] =>
            typeof entry[0] === "string" && typeof entry[1] === "string",
          ),
        );
      }
    } catch {
      config = { raw: configText.trim() };
    }

    await onSave(definition.provider, {
      status: relatedAccounts.length > 0 ? "connected" : status,
      syncDirection,
      modules: definition.modules,
      accountLabel: accountLabel.trim() || undefined,
      externalAccountId: externalAccountId.trim() || undefined,
      config,
      error: undefined,
    });
  };

  const handleGuidedSetup = async () => {
    await onSetup(definition.provider, {
      accountLabel: accountLabel.trim() || undefined,
      externalAccountId: externalAccountId.trim() || undefined,
      syncDirection,
      config: {
        ...(connection.config ?? {}),
        ...guidedValues,
      },
    });
  };

  return (
    <Card id={`connector-${definition.provider}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-sm font-medium">{definition.label}</CardTitle>
            <CardDescription>{definition.description}</CardDescription>
          </div>
          <Badge variant={STATUS_TONE[derivedStatus]}>{derivedStatus}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {definition.modules.map((module) => {
            const Icon = MODULE_ICON_MAP[module];
            return (
              <Badge key={module} variant="outline" className="gap-1">
                <Icon className="h-3 w-3" />
                {module}
              </Badge>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/20 p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {derivedStatus === "connected"
                ? `${definition.label} is connected`
                : `${definition.label} is not connected`}
            </p>
            <p className="text-xs text-muted-foreground">{setupHint}</p>
          </div>
          <div className="flex items-center gap-2">
            {canTest ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void onTest(definition.provider)}
                disabled={isTesting}
                className="gap-2"
              >
                {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                Test
              </Button>
            ) : null}
            {canSync ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void onSync(definition.provider)}
                disabled={
                  isSyncing ||
                  (definition.authStrategy === "oauth2" && relatedAccounts.length === 0 && !hasConfig) ||
                  (connection.status === "disconnected" && relatedAccounts.length === 0 && !hasConfig)
                }
                className="gap-2"
              >
                {isSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Sync Now
              </Button>
            ) : null}
            <Button
              type="button"
              variant={canStartGuidedSetup ? "default" : "outline"}
              className="gap-2"
              disabled={
                canStartGuidedSetup
                  ? canLaunchOAuth && isConnecting
                  : false
              }
              onClick={() => {
                if (canStartGuidedSetup && canLaunchOAuth) {
                  if (!connectableAuthProvider) return;
                  void onConnect(connectableAuthProvider);
                  return;
                }
                setAdvancedOpen((current) => !current);
              }}
            >
              {(setupMode === "oauth" || setupMode === "interactive") && isConnecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <SetupIcon className="h-4 w-4" />
              )}
              {primaryCtaLabel}
            </Button>
          </div>
        </div>

        {connection.lastSyncedAt || connection.error ? (
          <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
            {connection.lastSyncedAt ? (
              <p>Last synced: {new Date(connection.lastSyncedAt).toLocaleString()}</p>
            ) : null}
            {connection.error ? (
              <p className="mt-1 text-destructive">Last error: {connection.error}</p>
            ) : null}
          </div>
        ) : null}

        {relatedAccounts.length > 0 && (
          <>
            <Separator />
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Related linked identities</p>
              <div className="flex flex-wrap gap-2">
                {relatedAccounts.map((account) => (
                  <Badge
                    key={`${account.provider}:${account.providerAccountId}`}
                    variant="secondary"
                    className="gap-1"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {account.provider}:{account.providerAccountId}
                  </Badge>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="flex flex-wrap gap-2">
          {definition.capabilities.map((capability) => (
            <Badge key={capability} variant="outline">
              {capability}
            </Badge>
          ))}
        </div>

        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="gap-2 px-0 text-sm">
              <ChevronDown className={`h-4 w-4 transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
              Advanced settings
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-2">
            {providerSetupSteps.length > 0 ? (
              <div className="rounded-md border border-border/60 bg-muted/20 p-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Provider setup guide</p>
                  <p className="text-xs text-muted-foreground">
                    Complete this once for the instance, then come back and use the normal Connect flow.
                  </p>
                </div>
                <div className="mt-3 space-y-3">
                  {providerSetupSteps.map((step, index) => (
                    <div key={`${definition.provider}-setup-${index}`} className="space-y-1">
                      <p className="text-sm font-medium">
                        {index + 1}. {step.title}
                      </p>
                      <p className="text-xs text-muted-foreground">{step.detail}</p>
                      {step.href ? (
                        <a
                          href={step.href}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
                        >
                          Open provider dashboard
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : null}
                      {step.value ? (
                        <div className="flex gap-2">
                          <Input readOnly value={step.value} className="font-mono text-xs" />
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void copySetupValue(step.value!)}
                          >
                            Copy
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {supportsGuidedSetup ? (
              <div className="rounded-md border border-border/60 bg-muted/20 p-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Guided setup</p>
                  <p className="text-xs text-muted-foreground">
                    Fill the required fields for this provider. Rivr will validate and save them for this connection.
                  </p>
                </div>
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  {guidedSetupFields.map((field) => (
                    <div key={`${definition.provider}-${field.key}`} className="space-y-1.5">
                      <Label>{field.label}</Label>
                      <Input
                        type={field.inputType ?? "text"}
                        value={guidedValues[field.key] ?? ""}
                        onChange={(event) =>
                          setGuidedValues((current) => ({
                            ...current,
                            [field.key]: event.target.value,
                          }))
                        }
                        placeholder={field.placeholder}
                      />
                      {field.description ? (
                        <p className="text-xs text-muted-foreground">{field.description}</p>
                      ) : null}
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex justify-end">
                  <Button
                    type="button"
                    onClick={() => void handleGuidedSetup()}
                    disabled={isSettingUp}
                    className="gap-2"
                  >
                    {isSettingUp ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Complete Guided Setup
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Connection Status</Label>
                <Select value={status} onValueChange={(value) => setStatus(value as AutobotConnectionStatus)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="disconnected">Disconnected</SelectItem>
                    <SelectItem value="needs_auth">Needs Auth</SelectItem>
                    <SelectItem value="connected">Connected</SelectItem>
                    <SelectItem value="error">Error</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Sync Direction</Label>
                <Select value={syncDirection} onValueChange={(value) => setSyncDirection(value as AutobotConnection["syncDirection"])}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="import">Import</SelectItem>
                    <SelectItem value="export">Export</SelectItem>
                    <SelectItem value="bidirectional">Bidirectional</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Account Label</Label>
                <Input
                  value={accountLabel}
                  onChange={(event) => setAccountLabel(event.target.value)}
                  placeholder="Workspace, account, page, or vault name"
                />
              </div>

              <div className="space-y-1.5">
                <Label>External Account ID</Label>
                <Input
                  value={externalAccountId}
                  onChange={(event) => setExternalAccountId(event.target.value)}
                  placeholder="calendarId, workspaceId, chatId, phoneNumber"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Connector Config</Label>
              <Textarea
                value={configText}
                onChange={(event) => setConfigText(event.target.value)}
                className="min-h-[120px] font-mono text-xs"
                placeholder={`{\n  "${definition.configHints[0] ?? "key"}": "value"\n}`}
              />
              <p className="text-xs text-muted-foreground">
                Hints: {definition.configHints.join(", ") || "custom connector metadata"}
              </p>
            </div>

            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={saving} className="gap-2">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save Advanced Settings
              </Button>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
