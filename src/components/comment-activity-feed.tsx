"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { MessageCircle } from "lucide-react";
import Link from "next/link";
import { RelativeTime } from "@/components/relative-time";
import type { MyCommentEntry } from "@/app/actions/resource-creation/profile-feeds";

interface CommentActivityFeedProps {
  comments: MyCommentEntry[];
  loading?: boolean;
  error?: string | null;
}

/**
 * Renders a feed of the current user's comments on other people's posts.
 * Each card shows the comment content, context about the original post, and a link.
 */
export function CommentActivityFeed({ comments, loading, error }: CommentActivityFeedProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <MessageCircle className="mr-2 h-4 w-4 animate-pulse" />
        Loading comments...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-12 text-destructive">
        {error}
      </div>
    );
  }

  if (comments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <MessageCircle className="mb-2 h-8 w-8" />
        <p className="text-sm">No comments yet.</p>
        <p className="text-xs">Your comments on other posts will appear here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {comments.map((comment) => (
        <Card key={comment.id} className="overflow-hidden">
          <CardContent className="p-4">
            {/* Context: which post this comment is on */}
            <div className="mb-3 flex items-start gap-2 text-xs text-muted-foreground">
              <span className="shrink-0">Commented on</span>
              <Link
                href={`/posts/${comment.post.id}`}
                className="font-medium text-foreground hover:underline truncate"
              >
                {comment.post.name}
              </Link>
              <span className="shrink-0 ml-auto">
                <RelativeTime date={comment.timestamp} />
              </span>
            </div>

            {/* The original post excerpt */}
            {comment.post.excerpt ? (
              <div className="mb-3 rounded-md bg-muted/50 px-3 py-2">
                <div className="flex items-center gap-2 mb-1">
                  <Avatar className="h-5 w-5">
                    <AvatarImage src={comment.postAuthor.image ?? undefined} />
                    <AvatarFallback className="text-[10px]">
                      {comment.postAuthor.name.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-xs font-medium">{comment.postAuthor.name}</span>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2">
                  {comment.post.excerpt}
                </p>
              </div>
            ) : null}

            {/* The user's comment */}
            <div className="flex items-start gap-2">
              <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <p className="text-sm">{comment.content}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
