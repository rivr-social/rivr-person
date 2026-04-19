"use client";

import { useMemo, useState, useTransition, useCallback, useRef } from "react";
import Image from "next/image";
import {
  Box,
  Camera,
  Download,
  ExternalLink,
  FileAudio,
  FileText,
  FileVideo,
  ImageIcon,
  Loader2,
  Music,
  Newspaper,
  Plus,
  User,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { createResourceWithLedger } from "@/app/actions/create-resources";
import { setAvatar3d } from "@/app/actions/set-avatar-3d";
import { listMyPersonas } from "@/app/actions/personas";
import { ThreeDViewer } from "@/components/three-d-viewer";
import type { SerializedResource } from "@/lib/graph-serializers";
import type { SerializedAgent } from "@/lib/graph-serializers";

/* ── Constants ── */

const MEDIA_SUBTAB_ALL = "all";
const MEDIA_SUBTAB_PHOTOS = "photos";
const MEDIA_SUBTAB_VIDEOS = "videos";
const MEDIA_SUBTAB_AUDIO = "audio";
const MEDIA_SUBTAB_ARTICLES = "articles";
const MEDIA_SUBTAB_3D = "3d-models";

type MediaSubtab =
  | typeof MEDIA_SUBTAB_ALL
  | typeof MEDIA_SUBTAB_PHOTOS
  | typeof MEDIA_SUBTAB_VIDEOS
  | typeof MEDIA_SUBTAB_AUDIO
  | typeof MEDIA_SUBTAB_ARTICLES
  | typeof MEDIA_SUBTAB_3D;

const MEDIA_CREATE_TYPE_IMAGE = "image" as const;
const MEDIA_CREATE_TYPE_VIDEO = "video" as const;
const MEDIA_CREATE_TYPE_AUDIO = "audio" as const;
const MEDIA_CREATE_TYPE_ARTICLE = "article" as const;
const MEDIA_CREATE_TYPE_3D = "3d-model" as const;

type MediaCreateType =
  | typeof MEDIA_CREATE_TYPE_IMAGE
  | typeof MEDIA_CREATE_TYPE_VIDEO
  | typeof MEDIA_CREATE_TYPE_AUDIO
  | typeof MEDIA_CREATE_TYPE_ARTICLE
  | typeof MEDIA_CREATE_TYPE_3D;

/** File extensions recognized as 3D models. */
const THREE_D_EXTENSIONS = new Set([".glb", ".gltf", ".fbx", ".obj", ".vrm"]);

/** Accept string for 3D file input. */
const THREE_D_ACCEPT = ".glb,.gltf,.fbx,.obj,.vrm";

/** Maximum 3D file upload size: 50MB. */
const THREE_D_MAX_FILE_SIZE = 50 * 1024 * 1024;

/* ── Helpers ── */

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

type MediaItem = {
  id: string;
  title: string;
  description: string;
  type: "image" | "video" | "audio" | "article" | "3d-model";
  url: string;
  thumbnailUrl?: string;
  createdAt: string;
  source?: string;
};

function hasThreeDExtension(url: string): boolean {
  try {
    const pathname = new URL(url, "https://placeholder.local").pathname.toLowerCase();
    return Array.from(THREE_D_EXTENSIONS).some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

function classifyMediaResource(resource: SerializedResource): MediaItem | null {
  const meta = asRecord(resource.metadata);
  const resourceKind = String(meta.resourceKind ?? "").toLowerCase();
  const mediaType = String(meta.mediaType ?? "").toLowerCase();
  const category = String(meta.category ?? "").toLowerCase();

  let type: MediaItem["type"] | null = null;

  // Check 3D models first (explicit metadata or file extension)
  if (
    mediaType === "3d-model" ||
    mediaType === "3d" ||
    resourceKind === "3d-model" ||
    resourceKind === "3d"
  ) {
    type = "3d-model";
  } else {
    const checkUrl = String(meta.url ?? resource.url ?? "").toLowerCase();
    if (!type && hasThreeDExtension(checkUrl)) {
      type = "3d-model";
    }
  }

  if (!type) {
    if (resource.type === "image" || mediaType === "image" || resourceKind === "image" || resourceKind === "photo") {
      type = "image";
    } else if (resource.type === "video" || mediaType === "video" || resourceKind === "video") {
      type = "video";
    } else if (resource.type === "audio" || mediaType === "audio" || resourceKind === "audio") {
      type = "audio";
    } else if (
      mediaType === "article" ||
      resourceKind === "article" ||
      resourceKind === "press" ||
      category.includes("press") ||
      category.includes("news") ||
      category.includes("media") ||
      category.includes("article")
    ) {
      type = "article";
    }
  }

  // Also check for resources tagged as media
  if (!type && (resourceKind === "media" || category === "media")) {
    // Infer from URL or default to article
    const url = String(meta.url ?? resource.url ?? "").toLowerCase();
    if (hasThreeDExtension(url)) {
      type = "3d-model";
    } else if (url.match(/\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/)) {
      type = "image";
    } else if (url.match(/\.(mp4|webm|mov|avi)(\?|$)/) || url.includes("youtube") || url.includes("vimeo")) {
      type = "video";
    } else if (url.match(/\.(mp3|wav|ogg|flac|aac)(\?|$)/) || url.includes("spotify") || url.includes("soundcloud")) {
      type = "audio";
    } else {
      type = "article";
    }
  }

  if (!type) return null;

  const imageUrl =
    typeof meta.imageUrl === "string" ? meta.imageUrl :
    typeof meta.thumbnailUrl === "string" ? meta.thumbnailUrl :
    typeof meta.image === "string" ? meta.image :
    Array.isArray(meta.images) && typeof meta.images[0] === "string" ? meta.images[0] :
    undefined;

  const url = typeof meta.url === "string" ? meta.url : (typeof resource.url === "string" ? resource.url : "");

  return {
    id: resource.id,
    title: resource.name || "Untitled",
    description: resource.description ?? "",
    type,
    url,
    thumbnailUrl: type === "image" ? (imageUrl || url || undefined) : imageUrl,
    createdAt: resource.createdAt,
    source: typeof meta.source === "string" ? meta.source : undefined,
  };
}

function getMediaTypeIcon(type: MediaItem["type"]) {
  switch (type) {
    case "image":
      return <ImageIcon className="h-3.5 w-3.5" />;
    case "video":
      return <Video className="h-3.5 w-3.5" />;
    case "audio":
      return <Music className="h-3.5 w-3.5" />;
    case "article":
      return <Newspaper className="h-3.5 w-3.5" />;
    case "3d-model":
      return <Box className="h-3.5 w-3.5" />;
  }
}

function getMediaTypeLabel(type: MediaItem["type"]) {
  switch (type) {
    case "image":
      return "Photo";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "article":
      return "Article";
    case "3d-model":
      return "3D Model";
  }
}

/* ── Component ── */

type ProfileMediaTabProps = {
  profileResources: SerializedResource[];
  isOwner: boolean;
  ownerId: string;
};

export function ProfileMediaTab({ profileResources, isOwner, ownerId }: ProfileMediaTabProps) {
  const { toast } = useToast();
  const [activeSubtab, setActiveSubtab] = useState<MediaSubtab>(MEDIA_SUBTAB_ALL);
  const [isPending, startTransition] = useTransition();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createType, setCreateType] = useState<MediaCreateType>(MEDIA_CREATE_TYPE_IMAGE);
  const [createTitle, setCreateTitle] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createUrl, setCreateUrl] = useState("");
  const [localMedia, setLocalMedia] = useState<MediaItem[]>([]);
  const [createFile, setCreateFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const mediaItems = useMemo(() => {
    const items: MediaItem[] = [];
    for (const resource of profileResources) {
      const classified = classifyMediaResource(resource);
      if (classified) items.push(classified);
    }
    // Merge locally created items that may not yet appear in profileResources
    for (const local of localMedia) {
      if (!items.some((item) => item.id === local.id)) {
        items.push(local);
      }
    }
    return items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [profileResources, localMedia]);

  const filteredItems = useMemo(() => {
    switch (activeSubtab) {
      case MEDIA_SUBTAB_PHOTOS:
        return mediaItems.filter((item) => item.type === "image");
      case MEDIA_SUBTAB_VIDEOS:
        return mediaItems.filter((item) => item.type === "video");
      case MEDIA_SUBTAB_AUDIO:
        return mediaItems.filter((item) => item.type === "audio");
      case MEDIA_SUBTAB_ARTICLES:
        return mediaItems.filter((item) => item.type === "article");
      case MEDIA_SUBTAB_3D:
        return mediaItems.filter((item) => item.type === "3d-model");
      default:
        return mediaItems;
    }
  }, [activeSubtab, mediaItems]);

  const counts = useMemo(() => ({
    all: mediaItems.length,
    photos: mediaItems.filter((item) => item.type === "image").length,
    videos: mediaItems.filter((item) => item.type === "video").length,
    audio: mediaItems.filter((item) => item.type === "audio").length,
    articles: mediaItems.filter((item) => item.type === "article").length,
    "3d": mediaItems.filter((item) => item.type === "3d-model").length,
  }), [mediaItems]);

  const resetCreateForm = () => {
    setCreateTitle("");
    setCreateDescription("");
    setCreateUrl("");
    setCreateFile(null);
    setCreateType(MEDIA_CREATE_TYPE_IMAGE);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleCreate = () => {
    if (!createTitle.trim()) {
      toast({ title: "Title required", description: "Please enter a title for the media item.", variant: "destructive" });
      return;
    }

    if (createType === MEDIA_CREATE_TYPE_3D && !createFile && !createUrl.trim()) {
      toast({ title: "File or URL required", description: "Please upload a 3D file or provide a URL.", variant: "destructive" });
      return;
    }

    if (createFile && createFile.size > THREE_D_MAX_FILE_SIZE) {
      toast({ title: "File too large", description: "3D model files must be under 50MB.", variant: "destructive" });
      return;
    }

    startTransition(async () => {
      let resolvedUrl = createUrl.trim();

      // Upload 3D file if one was selected
      if (createType === MEDIA_CREATE_TYPE_3D && createFile) {
        try {
          const formData = new FormData();
          formData.append("file", createFile);
          formData.append("bucket", "uploads");
          const uploadResponse = await fetch("/api/upload", { method: "POST", body: formData });
          if (!uploadResponse.ok) {
            const errorData = await uploadResponse.json().catch(() => ({}));
            toast({
              title: "Upload failed",
              description: (errorData as Record<string, string>).error || "Could not upload file.",
              variant: "destructive",
            });
            return;
          }
          const uploadData = await uploadResponse.json() as { results: Array<{ url: string }> };
          resolvedUrl = uploadData.results[0]?.url ?? "";
        } catch {
          toast({ title: "Upload failed", description: "Network error during file upload.", variant: "destructive" });
          return;
        }
      }

      const resourceType = createType === "article" ? "document" as const : createType === MEDIA_CREATE_TYPE_3D ? "document" as const : createType;
      const result = await createResourceWithLedger({
        name: createTitle.trim(),
        type: resourceType,
        description: createDescription.trim() || undefined,
        metadata: {
          resourceKind: createType === "article" ? "article" : createType,
          mediaType: createType,
          url: resolvedUrl || undefined,
          imageUrl: createType === "image" ? (resolvedUrl || undefined) : undefined,
          personalOwnerId: ownerId,
          category: "media",
          source: "profile-media-tab",
        },
      });

      if (!result.success) {
        toast({
          title: "Failed to create media",
          description: result.message || "Please try again.",
          variant: "destructive",
        });
        return;
      }

      const newItem: MediaItem = {
        id: result.resourceId || `temp-${Date.now()}`,
        title: createTitle.trim(),
        description: createDescription.trim(),
        type: createType === "article" ? "article" : createType,
        url: resolvedUrl,
        thumbnailUrl: createType === "image" ? resolvedUrl || undefined : undefined,
        createdAt: new Date().toISOString(),
        source: "profile-media-tab",
      };
      setLocalMedia((prev) => [newItem, ...prev]);

      toast({ title: "Media created", description: `${getMediaTypeLabel(newItem.type)} added successfully.` });
      resetCreateForm();
      setCreateDialogOpen(false);
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <Tabs value={activeSubtab} onValueChange={(value) => setActiveSubtab(value as MediaSubtab)} className="flex-1">
          <div className="flex items-center justify-between gap-2">
            <TabsList className="grid grid-cols-6 w-full max-w-2xl">
              <TabsTrigger value={MEDIA_SUBTAB_ALL}>All ({counts.all})</TabsTrigger>
              <TabsTrigger value={MEDIA_SUBTAB_PHOTOS}>
                <Camera className="h-3.5 w-3.5 mr-1 hidden sm:inline-block" />
                Photos ({counts.photos})
              </TabsTrigger>
              <TabsTrigger value={MEDIA_SUBTAB_VIDEOS}>
                <FileVideo className="h-3.5 w-3.5 mr-1 hidden sm:inline-block" />
                Videos ({counts.videos})
              </TabsTrigger>
              <TabsTrigger value={MEDIA_SUBTAB_AUDIO}>
                <FileAudio className="h-3.5 w-3.5 mr-1 hidden sm:inline-block" />
                Audio ({counts.audio})
              </TabsTrigger>
              <TabsTrigger value={MEDIA_SUBTAB_ARTICLES}>
                <FileText className="h-3.5 w-3.5 mr-1 hidden sm:inline-block" />
                Articles ({counts.articles})
              </TabsTrigger>
              <TabsTrigger value={MEDIA_SUBTAB_3D}>
                <Box className="h-3.5 w-3.5 mr-1 hidden sm:inline-block" />
                3D ({counts["3d"]})
              </TabsTrigger>
            </TabsList>

            {isOwner ? (
              <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Plus className="h-4 w-4 mr-2" />
                    Add Media
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Add Media</DialogTitle>
                    <DialogDescription>
                      Add a photo, video, audio clip, article, or 3D model to your profile.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="space-y-2">
                      <Label htmlFor="media-type">Type</Label>
                      <Select value={createType} onValueChange={(value) => setCreateType(value as MediaCreateType)}>
                        <SelectTrigger id="media-type">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={MEDIA_CREATE_TYPE_IMAGE}>Photo / Image</SelectItem>
                          <SelectItem value={MEDIA_CREATE_TYPE_VIDEO}>Video</SelectItem>
                          <SelectItem value={MEDIA_CREATE_TYPE_AUDIO}>Audio</SelectItem>
                          <SelectItem value={MEDIA_CREATE_TYPE_ARTICLE}>Article / Press</SelectItem>
                          <SelectItem value={MEDIA_CREATE_TYPE_3D}>3D Model</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="media-title">Title</Label>
                      <Input
                        id="media-title"
                        value={createTitle}
                        onChange={(event) => setCreateTitle(event.target.value)}
                        placeholder="Title for this media"
                      />
                    </div>
                    {createType === MEDIA_CREATE_TYPE_3D ? (
                      <div className="space-y-2">
                        <Label htmlFor="media-3d-file">Upload 3D Model</Label>
                        <Input
                          id="media-3d-file"
                          ref={fileInputRef}
                          type="file"
                          accept={THREE_D_ACCEPT}
                          onChange={(event) => {
                            const file = event.target.files?.[0] ?? null;
                            setCreateFile(file);
                            if (file && !createTitle.trim()) {
                              setCreateTitle(file.name.replace(/\.[^.]+$/, ""));
                            }
                          }}
                        />
                        <p className="text-xs text-muted-foreground">
                          Accepted formats: .glb, .gltf, .fbx, .obj, .vrm (max 50MB)
                        </p>
                        <Label htmlFor="media-url" className="pt-2">Or provide a URL</Label>
                        <Input
                          id="media-url"
                          value={createUrl}
                          onChange={(event) => setCreateUrl(event.target.value)}
                          placeholder="https://example.com/model.glb"
                        />
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Label htmlFor="media-url">
                          {createType === MEDIA_CREATE_TYPE_IMAGE
                            ? "Image URL"
                            : createType === MEDIA_CREATE_TYPE_VIDEO
                              ? "Video URL (YouTube, Vimeo, or direct)"
                              : createType === MEDIA_CREATE_TYPE_AUDIO
                                ? "Audio URL (SoundCloud, Spotify, or direct)"
                                : "Article URL"}
                        </Label>
                        <Input
                          id="media-url"
                          value={createUrl}
                          onChange={(event) => setCreateUrl(event.target.value)}
                          placeholder={
                            createType === MEDIA_CREATE_TYPE_IMAGE
                              ? "https://example.com/photo.jpg"
                              : createType === MEDIA_CREATE_TYPE_VIDEO
                                ? "https://youtube.com/watch?v=..."
                                : createType === MEDIA_CREATE_TYPE_AUDIO
                                  ? "https://soundcloud.com/..."
                                  : "https://example.com/article"
                          }
                        />
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="media-description">Description (optional)</Label>
                      <Textarea
                        id="media-description"
                        value={createDescription}
                        onChange={(event) => setCreateDescription(event.target.value)}
                        placeholder="Brief description..."
                        rows={3}
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button onClick={handleCreate} disabled={isPending}>
                      {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                      Add
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            ) : null}
          </div>

          <TabsContent value={MEDIA_SUBTAB_ALL} className="mt-4">
            <MediaGrid items={filteredItems} isOwner={isOwner} />
          </TabsContent>
          <TabsContent value={MEDIA_SUBTAB_PHOTOS} className="mt-4">
            <MediaGrid items={filteredItems} isOwner={isOwner} />
          </TabsContent>
          <TabsContent value={MEDIA_SUBTAB_VIDEOS} className="mt-4">
            <MediaGrid items={filteredItems} isOwner={isOwner} />
          </TabsContent>
          <TabsContent value={MEDIA_SUBTAB_AUDIO} className="mt-4">
            <MediaGrid items={filteredItems} isOwner={isOwner} />
          </TabsContent>
          <TabsContent value={MEDIA_SUBTAB_ARTICLES} className="mt-4">
            <MediaGrid items={filteredItems} isOwner={isOwner} />
          </TabsContent>
          <TabsContent value={MEDIA_SUBTAB_3D} className="mt-4">
            <MediaGrid items={filteredItems} isOwner={isOwner} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

/* ── Grid sub-component ── */

function MediaGrid({ items, isOwner }: { items: MediaItem[]; isOwner: boolean }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No media items yet.</p>;
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {items.map((item) => (
        <MediaCard key={item.id} item={item} isOwner={isOwner} />
      ))}
    </div>
  );
}

function MediaCard({ item, isOwner }: { item: MediaItem; isOwner: boolean }) {
  const { toast } = useToast();
  const [viewerOpen, setViewerOpen] = useState(false);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [personas, setPersonas] = useState<SerializedAgent[] | null>(null);
  const [avatarPending, startAvatarTransition] = useTransition();

  const hasImage = item.type === "image" && item.thumbnailUrl;
  const hasVideoThumb = item.type === "video" && item.thumbnailUrl;
  const is3D = item.type === "3d-model";

  const loadPersonas = useCallback(async () => {
    if (personas !== null) return;
    try {
      const result = await listMyPersonas();
      if (result.success && result.personas) {
        setPersonas(result.personas);
      } else {
        setPersonas([]);
      }
    } catch {
      setPersonas([]);
    }
  }, [personas]);

  const handleSetAvatar = useCallback(
    (target: { type: "profile" } | { type: "persona"; personaId: string }) => {
      startAvatarTransition(async () => {
        const result = await setAvatar3d(target, item.url);
        if (result.success) {
          toast({
            title: "Avatar set",
            description: target.type === "profile"
              ? "3D avatar assigned to your profile."
              : "3D avatar assigned to persona.",
          });
        } else {
          toast({
            title: "Failed to set avatar",
            description: result.error || "Please try again.",
            variant: "destructive",
          });
        }
        setAvatarMenuOpen(false);
      });
    },
    [item.url, toast],
  );

  return (
    <Card className="overflow-hidden">
      {is3D && item.url ? (
        <div
          className="relative aspect-video bg-muted cursor-pointer"
          onClick={() => setViewerOpen(true)}
        >
          <ThreeDViewer url={item.url} title={item.title} inline />
        </div>
      ) : (hasImage || hasVideoThumb) ? (
        <div className="relative aspect-video bg-muted">
          <Image
            src={item.thumbnailUrl!}
            alt={item.title}
            fill
            className="object-cover"
            unoptimized
          />
          {item.type === "video" ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/20">
              <Video className="h-10 w-10 text-white/80" />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="relative aspect-video bg-muted flex items-center justify-center">
          {item.type === "video" ? <FileVideo className="h-12 w-12 text-muted-foreground/40" /> : null}
          {item.type === "audio" ? <FileAudio className="h-12 w-12 text-muted-foreground/40" /> : null}
          {item.type === "article" ? <Newspaper className="h-12 w-12 text-muted-foreground/40" /> : null}
          {item.type === "image" ? <ImageIcon className="h-12 w-12 text-muted-foreground/40" /> : null}
        </div>
      )}
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {getMediaTypeIcon(item.type)}
          <span>{getMediaTypeLabel(item.type)}</span>
          {item.source ? (
            <>
              <span className="text-muted-foreground/50">-</span>
              <span className="capitalize">{item.source}</span>
            </>
          ) : null}
          <span className="text-muted-foreground/50">-</span>
          <span>{new Date(item.createdAt).toLocaleDateString()}</span>
        </div>
        <p className="font-medium text-sm line-clamp-2">{item.title}</p>
        {item.description ? (
          <p className="text-xs text-muted-foreground line-clamp-2">{item.description}</p>
        ) : null}
        <div className="flex items-center gap-2 flex-wrap">
          {item.url ? (
            is3D ? (
              <Button variant="outline" size="sm" onClick={() => setViewerOpen(true)}>
                Open <ExternalLink className="ml-2 h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button variant="outline" size="sm" asChild>
                <a href={item.url} target="_blank" rel="noreferrer">
                  Open <ExternalLink className="ml-2 h-3.5 w-3.5" />
                </a>
              </Button>
            )
          ) : null}
          {is3D && isOwner && item.url ? (
            <DropdownMenu open={avatarMenuOpen} onOpenChange={(open) => {
              setAvatarMenuOpen(open);
              if (open) loadPersonas();
            }}>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm" disabled={avatarPending}>
                  {avatarPending ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <User className="mr-2 h-3.5 w-3.5" />
                  )}
                  Set as Avatar
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Assign 3D Avatar</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => handleSetAvatar({ type: "profile" })}>
                  Profile Avatar
                </DropdownMenuItem>
                {personas && personas.length > 0 ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs">Personas</DropdownMenuLabel>
                    {personas.map((persona) => (
                      <DropdownMenuItem
                        key={persona.id}
                        onClick={() => handleSetAvatar({ type: "persona", personaId: persona.id })}
                      >
                        {persona.name}
                      </DropdownMenuItem>
                    ))}
                  </>
                ) : null}
                {personas !== null && personas.length === 0 ? (
                  <DropdownMenuItem disabled>
                    No personas found
                  </DropdownMenuItem>
                ) : null}
                {personas === null ? (
                  <DropdownMenuItem disabled>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    Loading...
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </CardContent>

      {/* 3D viewer dialog */}
      {is3D && item.url ? (
        <Dialog open={viewerOpen} onOpenChange={setViewerOpen}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>{item.title}</DialogTitle>
              <DialogDescription>
                Interactive 3D model viewer
              </DialogDescription>
            </DialogHeader>
            <div className="w-full h-[500px]">
              <ThreeDViewer url={item.url} title={item.title} />
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" asChild>
                <a href={item.url} download>
                  <Download className="mr-2 h-3.5 w-3.5" />
                  Download
                </a>
              </Button>
              <Button variant="outline" onClick={() => setViewerOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}
