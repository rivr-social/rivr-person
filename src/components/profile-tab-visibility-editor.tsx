"use client";

import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  PROFILE_TAB_KEYS,
  PROFILE_TAB_LABELS,
  DEFAULT_PROFILE_TAB_VISIBILITY,
  type ProfileTabKey,
  type ProfileTabVisibilitySettings,
  type ProfileTabVisibilityLevel,
} from "@/lib/types";

type ProfileTabVisibilityEditorProps = {
  value: ProfileTabVisibilitySettings;
  onChange: (settings: ProfileTabVisibilitySettings) => void;
};

/**
 * Visibility options for a PERSON profile tab. These mirror the level set the
 * pure profile resolver understands (public/connections/self/hidden); the
 * group-only "members"/"admin" levels are intentionally absent.
 */
const PROFILE_VISIBILITY_OPTIONS: Array<{ value: ProfileTabVisibilityLevel; label: string; description: string }> = [
  { value: "public", label: "Public", description: "Visible to everyone" },
  { value: "connections", label: "Connections", description: "Visible to your connections only" },
  { value: "self", label: "Only Me", description: "Visible to you only" },
  { value: "hidden", label: "Hidden", description: "Tab is completely hidden" },
];

/**
 * The user-entity analog of the group tab-visibility editor: lets a profile
 * owner pick a visibility level per public-profile tab. Selecting a tab's
 * default removes the now-redundant override so storage stays sparse, matching
 * the group editor's behavior.
 */
export function ProfileTabVisibilityEditor({ value, onChange }: ProfileTabVisibilityEditorProps) {
  const onTabChange = (tab: ProfileTabKey, level: ProfileTabVisibilityLevel) => {
    const next = { ...value };
    if (level === DEFAULT_PROFILE_TAB_VISIBILITY[tab]) {
      delete next[tab];
    } else {
      next[tab] = level;
    }
    onChange(next);
  };

  return (
    <div className="space-y-3">
      {PROFILE_TAB_KEYS.map((tab) => {
        const current = value[tab] ?? DEFAULT_PROFILE_TAB_VISIBILITY[tab];
        return (
          <div key={tab} className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="min-w-0">
              <Label className="font-medium">{PROFILE_TAB_LABELS[tab]}</Label>
            </div>
            <Select
              value={current}
              onValueChange={(v) => onTabChange(tab, v as ProfileTabVisibilityLevel)}
            >
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROFILE_VISIBILITY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      })}
    </div>
  );
}
