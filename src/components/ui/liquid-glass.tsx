"use client"

import { cn } from "@/lib/utils"

interface LiquidGlassProps {
  children: React.ReactNode
  className?: string
  as?: "div" | "section" | "article"
}

export function LiquidGlass({ children, className, as: Tag = "div" }: LiquidGlassProps) {
  return (
    <Tag className={cn("liquid-glass rounded-xl", className)}>
      <div className="liquid-glass-effect rounded-xl" />
      <div className="liquid-glass-tint rounded-xl" />
      <div className="liquid-glass-shine rounded-xl" />
      {children}
    </Tag>
  )
}
