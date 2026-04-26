"use client"

import * as React from "react"

import { TabsList } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

type ResponsiveTabsListProps = React.ComponentPropsWithoutRef<typeof TabsList> & {
  viewportClassName?: string
}

export function ResponsiveTabsList({
  className,
  viewportClassName,
  children,
  ...props
}: ResponsiveTabsListProps) {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const dragRef = React.useRef<{
    pointerId: number
    startX: number
    scrollLeft: number
    dragged: boolean
  } | null>(null)

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return
    if (event.pointerType !== "mouse") return
    const viewport = viewportRef.current
    if (!viewport || viewport.scrollWidth <= viewport.clientWidth) return

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      scrollLeft: viewport.scrollLeft,
      dragged: false,
    }
    viewport.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const viewport = viewportRef.current
    if (!drag || !viewport || drag.pointerId !== event.pointerId) return

    const deltaX = event.clientX - drag.startX
    if (Math.abs(deltaX) > 3) {
      drag.dragged = true
      viewport.scrollLeft = drag.scrollLeft - deltaX
      event.preventDefault()
    }
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const viewport = viewportRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    if (viewport?.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId)
    }
    window.setTimeout(() => {
      if (dragRef.current?.pointerId === event.pointerId) {
        dragRef.current = null
      }
    }, 0)
  }

  const handleClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current?.dragged) return
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = null
  }

  return (
    <div
      ref={viewportRef}
      className={cn(
        "w-full min-w-0 -mx-4 overflow-x-auto overscroll-x-contain px-4 scrollbar-hide md:mx-0 md:px-0",
        viewportClassName,
      )}
      onClickCapture={handleClickCapture}
      onPointerCancel={endDrag}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      style={{
        overflowX: "auto",
        WebkitOverflowScrolling: "touch",
        touchAction: "auto",
      }}
    >
      <TabsList
        className={cn(
          "!inline-flex !w-max !min-w-max !max-w-none !justify-start !overflow-visible md:!min-w-full",
          className,
        )}
        {...props}
      >
        {children}
      </TabsList>
    </div>
  )
}
