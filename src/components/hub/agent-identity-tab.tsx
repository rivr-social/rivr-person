"use client";

/**
 * AgentIdentityTab — read-only identity summary for the selected agent with a
 * link out to the full editor. The rich builder UX (PersonaCreator) lives at
 * `/personas/[id]/edit`; the controller's identity is edited in settings. This
 * tab surfaces the current identity inside the hub and routes to those
 * existing editors rather than duplicating the builder.
 */

import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Pencil } from "lucide-react";

interface AgentIdentityTabProps {
  name: string;
  image: string | null;
  bio: string;
  username: string | null;
  skills: string[];
  editHref: string;
}

export function AgentIdentityTab({
  name,
  image,
  bio,
  username,
  skills,
  editHref,
}: AgentIdentityTabProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">Identity</CardTitle>
          <Button asChild size="sm" variant="outline" className="gap-2">
            <Link href={editHref}>
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Avatar className="h-14 w-14">
            <AvatarImage src={image ?? undefined} alt={name} />
            <AvatarFallback>{name.substring(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="font-medium">{name}</p>
            {username && <p className="text-xs text-muted-foreground">@{username}</p>}
          </div>
        </div>

        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">Bio</p>
          <p className="text-sm">{bio || "No bio set."}</p>
        </div>

        {skills.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">Skills</p>
            <div className="flex flex-wrap gap-1.5">
              {skills.map((skill) => (
                <Badge key={skill} variant="secondary" className="text-xs">
                  {skill}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
