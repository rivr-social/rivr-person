"use client"

/**
 * Visual query composer for the explore graph + contract/agreement system.
 *
 * Lets users construct Subject-Verb-Object conditional queries that filter
 * the D3 force graph, AND save them as auto-executing contract rules.
 *
 * Layout:
 * - WHEN row: [det] [who] [does what] [det] [with what]
 * - THEN rows (chainable): [I] [do what] [det] [with what] to [det] [who]
 * - Optional IF row via "+ Add Condition"
 * - Mini SVG canvas showing the sentence as a graph
 * - "Save as Agreement" + "My Agreements" section
 *
 * Determiners (any, my, the, that, a, all) prefix agent/resource slots
 * to scope how they match at runtime.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  fetchAgentsForComposer,
  fetchResourcesForComposer,
} from "@/app/actions/graph"
import {
  createContractRule,
  listMyContractRules,
  toggleContractRule,
  deleteContractRule,
} from "@/app/actions/contracts"
import type { ContractRuleRow } from "@/app/actions/contracts"
import type { ContractAction } from "@/db/schema"
import { Plus, X, Filter, Trash2, Save, FileText, ChevronDown, ChevronRight, Sparkles } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import {
  VERB_RESOURCE_TYPES,
  RESOURCE_TYPE_VERBS,
  AGENT_VERBS,
  QUANTIFIABLE_RESOURCE_TYPES,
  WILDCARD_AGENTS,
  AGENT_DETERMINERS,
  RESOURCE_DETERMINERS,
  TYPE_COLORS,
  MINI_NODE_RADII,
} from "./composer/composer-vocab"
import type {
  QueryCondition,
  ThenAction,
  DropdownOption,
} from "./composer/composer-vocab"
import {
  SearchableDropdown,
  VerbDropdown,
  DeterminerDropdown,
  ConditionBlock,
  parseNlpToComposer,
} from "./composer/composer-blocks"

// Re-export the shared composer types so existing import sites keep working.
export type { QueryCondition, ThenAction, ComposerQuery } from "./composer/composer-vocab"


/**
 * Generate a human-readable sentence summary from the composer state.
 */
function composerToSentence(
  when: QueryCondition,
  thenActions: ThenAction[],
  ifCondition: QueryCondition,
  showIf: boolean,
  ownerName: string
): string {
  const parts: string[] = []

  // WHEN
  const whenSubject = when.agentName ?? (when.agentDeterminer ? `${when.agentDeterminer} agent` : "")
  const whenVerb = when.verb?.replace("_", " ") ?? ""
  const whenObject = when.resourceName ?? (when.resourceDeterminer ? `${when.resourceDeterminer} resource` : "")
  if (whenSubject || whenVerb || whenObject) {
    parts.push(`When ${when.agentDeterminer ?? ""} ${whenSubject} ${whenVerb} ${when.resourceDeterminer ?? ""} ${whenObject}`.replace(/\s+/g, " ").trim())
  }

  // THEN
  const actionParts = thenActions
    .filter((a) => a.verb)
    .map((a) => {
      const verb = a.verb?.replace("_", " ") ?? ""
      const qty = a.delta && a.delta > 1 ? `${a.delta}x ` : ""
      const obj = a.objectName ? `${qty}${a.objectDeterminer ?? ""} ${a.objectName}`.trim() : ""
      const target = a.targetName
        ? `to ${a.targetDeterminer ?? ""} ${a.targetName}`.trim()
        : a.targetDeterminer === "that"
          ? "to that subject"
          : ""
      return `${verb} ${obj} ${target}`.trim()
    })

  if (actionParts.length > 0) {
    parts.push(`${ownerName || "I"} ${actionParts.join(", then ")}`)
  }

  // IF
  if (showIf && ifCondition.verb) {
    const ifSubject = ifCondition.agentName ?? ""
    const ifVerb = ifCondition.verb?.replace("_", " ") ?? ""
    const ifObject = ifCondition.resourceName ?? ""
    parts.push(`if ${ifSubject} ${ifVerb} ${ifObject}`.trim())
  }

  return parts.join(", ").replace(/\s+/g, " ").trim()
}

export interface LedgerFilter {
  subjectId?: string
  verb?: string
  objectId?: string
  startDate?: string
  endDate?: string
}

interface QueryComposerProps {
  onApply: (filter: LedgerFilter) => void
  onClear: () => void
}

// ─── THEN Action Row ─────────────────────────────────────────────────────────

function ThenActionRow({
  label,
  ownerName,
  action,
  agents,
  resources,
  onChange,
  onRemove,
  canRemove,
}: {
  label: string
  ownerName: string
  action: ThenAction
  agents: DropdownOption[]
  resources: DropdownOption[]
  onChange: (a: ThenAction) => void
  onRemove?: () => void
  canRemove: boolean
}) {
  const agentOptions: DropdownOption[] = [
    { id: "__trigger_subject__", name: "Trigger Subject", type: "wildcard" },
    ...WILDCARD_AGENTS,
    ...agents,
  ]

  // Contextual filtering for THEN rows
  const isAgentVerb = action.verb ? AGENT_VERBS.has(action.verb) : false
  const allowedResourceTypes = useMemo(() => {
    if (!action.verb) return undefined
    const types = VERB_RESOURCE_TYPES[action.verb]
    return types && types.length > 0 ? new Set(types) : undefined
  }, [action.verb])

  const allowedVerbs = useMemo(() => {
    if (!action.objectType) return undefined
    const verbs = RESOURCE_TYPE_VERBS[action.objectType]
    return verbs ? new Set(verbs) : undefined
  }, [action.objectType])

  const filteredResources = useMemo(() => {
    if (isAgentVerb) return []
    if (!allowedResourceTypes) return resources
    return resources.filter((r) => allowedResourceTypes.has(r.type))
  }, [resources, allowedResourceTypes, isAgentVerb])

  const objectOptions = isAgentVerb ? agentOptions : filteredResources

  // Look up the selected resource to check if it's quantifiable
  const selectedResource = action.objectId
    ? resources.find((r) => r.id === action.objectId)
    : undefined
  const isQuantifiable = !!(
    action.objectType && QUANTIFIABLE_RESOURCE_TYPES.has(action.objectType)
  ) || !!(
    action.objectDeterminer && (action.objectDeterminer === "all" || /^\d+$/.test(action.objectDeterminer))
  )
  const maxQuantity = selectedResource?.quantityRemaining
    ?? selectedResource?.quantityAvailable
    ?? undefined

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Row label */}
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground w-10 shrink-0">
        {label}
      </span>

      {/* I (auto-filled, read-only) */}
      <span className="flex items-center gap-1.5 min-w-[60px] h-8 px-2.5 rounded-md border border-border bg-muted/50 text-sm truncate">
        <span className="inline-block h-2 w-2 rounded-full shrink-0 bg-blue-500" />
        <span className="truncate text-xs font-medium">{ownerName || "I"}</span>
      </span>

      {/* Do what — filtered by selected object type */}
      <VerbDropdown
        value={action.verb}
        onSelect={(verb) => onChange({ ...action, verb })}
        onClear={() => onChange({ ...action, verb: undefined })}
        allowedVerbs={allowedVerbs}
      />

      {/* [det] With what — filtered by selected verb */}
      <DeterminerDropdown
        value={action.objectDeterminer}
        options={isAgentVerb ? AGENT_DETERMINERS : RESOURCE_DETERMINERS}
        onSelect={(det) => onChange({ ...action, objectDeterminer: det })}
      />

      {/* Quantity input — shown for quantifiable resource types */}
      {isQuantifiable && (
        <div className="flex items-center gap-1">
          <Input
            type="number"
            min={1}
            max={maxQuantity}
            value={action.delta ?? 1}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10)
              onChange({ ...action, delta: Number.isNaN(val) ? undefined : Math.max(1, val) })
            }}
            className="h-8 w-[56px] text-xs text-center px-1"
            title="Quantity"
          />
          {maxQuantity !== undefined && (
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
              of {maxQuantity}
            </span>
          )}
        </div>
      )}

      <SearchableDropdown
        options={objectOptions}
        value={
          action.objectId
            ? { id: action.objectId, name: action.objectName ?? "Unknown", type: action.objectType ?? "resource" }
            : undefined
        }
        onSelect={(opt) => {
          const res = resources.find((r) => r.id === opt.id)
          const hasQty = QUANTIFIABLE_RESOURCE_TYPES.has(opt.type)
          onChange({
            ...action,
            objectId: opt.id,
            objectName: opt.name,
            objectType: opt.type,
            // Auto-set delta to 1 for quantifiable resources if not already set
            ...(hasQty && !action.delta ? { delta: 1 } : {}),
            // Clear delta if non-quantifiable
            ...(!hasQty ? { delta: undefined } : {}),
          })
        }}
        onClear={() =>
          onChange({ ...action, objectId: undefined, objectName: undefined, objectType: undefined, delta: undefined })
        }
        placeholder={isAgentVerb ? "whom" : "what"}
        label={isAgentVerb ? "Agent" : "Resource"}
      />

      {/* to [det] [who] */}
      <span className="text-xs text-muted-foreground">to</span>
      <DeterminerDropdown
        value={action.targetDeterminer}
        options={AGENT_DETERMINERS}
        onSelect={(det) => onChange({ ...action, targetDeterminer: det })}
      />
      <SearchableDropdown
        options={agentOptions}
        value={
          action.targetId
            ? { id: action.targetId, name: action.targetName ?? "Unknown", type: action.targetType ?? "person" }
            : undefined
        }
        onSelect={(opt) =>
          onChange({ ...action, targetId: opt.id, targetName: opt.name, targetType: opt.type })
        }
        onClear={() =>
          onChange({ ...action, targetId: undefined, targetName: undefined, targetType: undefined })
        }
        placeholder="who"
        label="Target"
      />

      {/* Remove button */}
      {canRemove && onRemove && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          className="h-8 w-8 p-0 shrink-0"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}

// ─── Mini Canvas ─────────────────────────────────────────────────────────────

interface MiniNode {
  id: string
  label: string
  type: string
  x: number
  y: number
  determiner?: string
}

interface MiniEdge {
  from: string
  to: string
  label: string
  dashed?: boolean
}

function MiniCanvas({
  whenCondition,
  thenActions,
  ifCondition,
  showIf,
  ownerName,
}: {
  whenCondition: QueryCondition
  thenActions: ThenAction[]
  ifCondition: QueryCondition
  showIf: boolean
  ownerName: string
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [dragState, setDragState] = useState<{ id: string; startX: number; startY: number } | null>(null)
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>({})

  // Build nodes and edges from the current composer state
  const { nodes, edges } = useMemo(() => {
    const ns: MiniNode[] = []
    const es: MiniEdge[] = []
    const seenIds = new Set<string>()

    const addNode = (id: string, label: string, type: string, x: number, y: number, determiner?: string) => {
      if (seenIds.has(id)) return
      seenIds.add(id)
      ns.push({ id, label, type, x, y, determiner })
    }

    // WHEN subject
    const whenSubjectId = whenCondition.agentId ?? "when-subject"
    const whenSubjectLabel = whenCondition.agentName ?? (whenCondition.agentDeterminer === "any" ? "Anyone" : "?")
    const whenSubjectType = whenCondition.agentType ?? "wildcard"
    if (whenCondition.agentId || whenCondition.agentDeterminer) {
      addNode(whenSubjectId, whenSubjectLabel, whenSubjectType, 60, 60, whenCondition.agentDeterminer)
    }

    // WHEN object
    const whenObjectId = whenCondition.resourceId ?? "when-object"
    const whenObjectLabel = whenCondition.resourceName ?? "?"
    const whenObjectType = whenCondition.resourceType ?? "wildcard"
    if (whenCondition.resourceId || whenCondition.resourceDeterminer) {
      addNode(whenObjectId, whenObjectLabel, whenObjectType, 200, 60, whenCondition.resourceDeterminer)
    }

    // WHEN verb edge
    if (whenCondition.verb && seenIds.has(whenSubjectId) && seenIds.has(whenObjectId)) {
      es.push({ from: whenSubjectId, to: whenObjectId, label: whenCondition.verb })
    }

    // "I" node (rule creator) for THEN actions
    const iNodeId = "self-owner"
    if (thenActions.some((a) => a.verb)) {
      addNode(iNodeId, ownerName || "I", "self", 360, 60)

      // Dashed "then" edge from WHEN to THEN
      if (seenIds.has(whenSubjectId) || seenIds.has(whenObjectId)) {
        const fromId = seenIds.has(whenObjectId) ? whenObjectId : whenSubjectId
        if (seenIds.has(fromId)) {
          es.push({ from: fromId, to: iNodeId, label: "then", dashed: true })
        }
      }
    }

    // THEN action nodes
    thenActions.forEach((action, i) => {
      if (!action.verb) return
      const yOffset = 60 + i * 55

      // Action object
      const objId = action.objectId ?? `then-obj-${i}`
      const objLabel = action.objectName ?? "?"
      const objType = action.objectType ?? "wildcard"
      if (action.objectId || action.objectDeterminer) {
        addNode(objId, objLabel, objType, 480, yOffset, action.objectDeterminer)
        es.push({ from: iNodeId, to: objId, label: action.verb })
      } else {
        // Even without object, show the verb from I
        const phantomId = `then-phantom-${i}`
        addNode(phantomId, action.verb, "wildcard", 480, yOffset)
        es.push({ from: iNodeId, to: phantomId, label: action.verb })
      }

      // Action target
      if (action.targetId || action.targetDeterminer) {
        const targetId = action.targetId ?? `then-target-${i}`
        const targetLabel = action.targetName ?? (action.targetDeterminer === "that" ? "Trigger" : "?")
        const targetType = action.targetType ?? "person"
        const sourceId = action.objectId || action.objectDeterminer ? objId : `then-phantom-${i}`
        addNode(targetId, targetLabel, targetType, 600, yOffset, action.targetDeterminer)
        if (seenIds.has(sourceId)) {
          es.push({ from: sourceId, to: targetId, label: "to" })
        }
      }
    })

    // IF condition nodes
    if (showIf && (ifCondition.agentId || ifCondition.verb || ifCondition.resourceId)) {
      const ifSubjectId = ifCondition.agentId ?? "if-subject"
      const ifSubjectLabel = ifCondition.agentName ?? "?"
      const ifSubjectType = ifCondition.agentType ?? "wildcard"
      if (ifCondition.agentId || ifCondition.agentDeterminer) {
        addNode(ifSubjectId, ifSubjectLabel, ifSubjectType, 120, 160, ifCondition.agentDeterminer)
      }

      const ifObjectId = ifCondition.resourceId ?? "if-object"
      const ifObjectLabel = ifCondition.resourceName ?? "?"
      const ifObjectType = ifCondition.resourceType ?? "wildcard"
      if (ifCondition.resourceId || ifCondition.resourceDeterminer) {
        addNode(ifObjectId, ifObjectLabel, ifObjectType, 280, 160, ifCondition.resourceDeterminer)
      }

      if (ifCondition.verb && seenIds.has(ifSubjectId) && seenIds.has(ifObjectId)) {
        es.push({ from: ifSubjectId, to: ifObjectId, label: ifCondition.verb })
      }
    }

    return { nodes: ns, edges: es }
  }, [whenCondition, thenActions, ifCondition, showIf, ownerName])

  // Merge computed positions with drag overrides
  const getPos = (node: MiniNode) => {
    if (nodePositions[node.id]) return nodePositions[node.id]
    return { x: node.x, y: node.y }
  }

  if (nodes.length === 0) return null

  const handleMouseDown = (id: string, e: React.MouseEvent) => {
    e.preventDefault()
    const svg = svgRef.current
    if (!svg) return
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const ctm = svg.getScreenCTM()?.inverse()
    if (!ctm) return
    const svgPt = pt.matrixTransform(ctm)
    setDragState({ id, startX: svgPt.x, startY: svgPt.y })
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragState) return
    const svg = svgRef.current
    if (!svg) return
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const ctm = svg.getScreenCTM()?.inverse()
    if (!ctm) return
    const svgPt = pt.matrixTransform(ctm)
    setNodePositions((prev) => ({
      ...prev,
      [dragState.id]: { x: svgPt.x, y: svgPt.y },
    }))
  }

  const handleMouseUp = () => {
    setDragState(null)
  }

  const canvasHeight = Math.max(180, 80 + thenActions.length * 55 + (showIf ? 80 : 0))

  return (
    <svg
      ref={svgRef}
      className="w-full border border-border/50 rounded-md bg-card/50"
      viewBox={`0 0 680 ${canvasHeight}`}
      style={{ height: `${Math.min(canvasHeight, 250)}px` }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <defs>
        <marker
          id="mini-arrow"
          viewBox="0 0 10 6"
          refX="10"
          refY="3"
          markerWidth="8"
          markerHeight="5"
          orient="auto"
        >
          <path d="M0,0 L10,3 L0,6" fill="#94a3b8" />
        </marker>
        <marker
          id="mini-arrow-dashed"
          viewBox="0 0 10 6"
          refX="10"
          refY="3"
          markerWidth="8"
          markerHeight="5"
          orient="auto"
        >
          <path d="M0,0 L10,3 L0,6" fill="#f59e0b" />
        </marker>
      </defs>

      {/* Edges */}
      {edges.map((edge, i) => {
        const fromNode = nodes.find((n) => n.id === edge.from)
        const toNode = nodes.find((n) => n.id === edge.to)
        if (!fromNode || !toNode) return null
        const fromPos = getPos(fromNode)
        const toPos = getPos(toNode)
        const r = MINI_NODE_RADII[toNode.type] ?? MINI_NODE_RADII.default
        // Shorten line to stop at node boundary
        const dx = toPos.x - fromPos.x
        const dy = toPos.y - fromPos.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const endX = toPos.x - (dx / dist) * (r + 4)
        const endY = toPos.y - (dy / dist) * (r + 4)
        const midX = (fromPos.x + toPos.x) / 2
        const midY = (fromPos.y + toPos.y) / 2

        return (
          <g key={`edge-${i}`}>
            <line
              x1={fromPos.x}
              y1={fromPos.y}
              x2={endX}
              y2={endY}
              stroke={edge.dashed ? "#f59e0b" : "#94a3b8"}
              strokeWidth={1.5}
              strokeDasharray={edge.dashed ? "4 3" : undefined}
              markerEnd={edge.dashed ? "url(#mini-arrow-dashed)" : "url(#mini-arrow)"}
              opacity={0.7}
            />
            <text
              x={midX}
              y={midY - 6}
              textAnchor="middle"
              fontSize="9"
              fill="#94a3b8"
              fontWeight="500"
            >
              {edge.label.replace("_", " ")}
            </text>
          </g>
        )
      })}

      {/* Nodes */}
      {nodes.map((node) => {
        const pos = getPos(node)
        const r = MINI_NODE_RADII[node.type] ?? MINI_NODE_RADII.default
        const color = TYPE_COLORS[node.type] ?? "#6b7280"
        const truncated = node.label.length > 14 ? node.label.slice(0, 12) + ".." : node.label

        return (
          <g
            key={node.id}
            transform={`translate(${pos.x},${pos.y})`}
            style={{ cursor: "grab" }}
            onMouseDown={(e) => handleMouseDown(node.id, e)}
          >
            {/* Determiner label */}
            {node.determiner && (
              <text
                y={-r - 4}
                textAnchor="middle"
                fontSize="8"
                fill="#94a3b8"
                fontStyle="italic"
              >
                {node.determiner}
              </text>
            )}

            {/* Node shape */}
            {node.type === "organization" || node.type === "group" ? (
              <rect
                x={-r}
                y={-r * 0.8}
                width={r * 2}
                height={r * 1.6}
                rx={4}
                fill={color}
                fillOpacity={0.85}
                stroke={color}
                strokeWidth={1}
                strokeOpacity={0.5}
              />
            ) : node.type === "event" ? (
              <polygon
                points={`0,${-r} ${r},0 0,${r} ${-r},0`}
                fill={color}
                fillOpacity={0.85}
                stroke={color}
                strokeWidth={1}
                strokeOpacity={0.5}
              />
            ) : (
              <circle
                r={r}
                fill={color}
                fillOpacity={0.85}
                stroke={color}
                strokeWidth={1}
                strokeOpacity={0.5}
              />
            )}

            {/* Icon (simplified white lineal) */}
            <g fill="none" stroke="white" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none">
              {(node.type === "person" || node.type === "self") && (
                <>
                  <circle cx={0} cy={-2} r={3} />
                  <path d="M-5 6 C-5 2 5 2 5 6" />
                </>
              )}
              {(node.type === "organization" || node.type === "group") && (
                <>
                  <circle cx={-2} cy={-2} r={2.5} />
                  <circle cx={3} cy={-2} r={2.5} />
                  <path d="M-6 5 C-6 2 7 2 7 5" />
                </>
              )}
              {node.type === "event" && (
                <>
                  <rect x={-4} y={-2} width={8} height={7} rx={1} />
                  <line x1={-2} y1={-4} x2={-2} y2={-1} />
                  <line x1={2} y1={-4} x2={2} y2={-1} />
                </>
              )}
            </g>

            {/* Label */}
            <text
              y={r + 10}
              textAnchor="middle"
              fontSize="9"
              fill="currentColor"
              fontWeight="400"
              pointerEvents="none"
            >
              {truncated}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ─── Agreements List ─────────────────────────────────────────────────────────

function AgreementsList({ rules, onRefresh }: { rules: ContractRuleRow[]; onRefresh: () => void }) {
  const { toast } = useToast()
  const [expanded, setExpanded] = useState(false)

  if (rules.length === 0) return null

  const handleToggle = async (id: string, enabled: boolean) => {
    const result = await toggleContractRule(id, enabled)
    if (result.success) {
      onRefresh()
    } else {
      toast({ title: "Error", description: result.error, variant: "destructive" })
    }
  }

  const handleDelete = async (id: string) => {
    const result = await deleteContractRule(id)
    if (result.success) {
      onRefresh()
      toast({ title: "Agreement deleted" })
    } else {
      toast({ title: "Error", description: result.error, variant: "destructive" })
    }
  }

  const summarizeActions = (actions: ContractAction[]) => {
    return actions
      .map((a) => {
        const verb = a.verb?.replace("_", " ") ?? "?"
        const obj = a.objectId ? "..." : ""
        const target = a.targetDeterminer === "that" ? "trigger subject" : (a.targetId ? "..." : "")
        return `${verb}${obj}${target ? ` to ${target}` : ""}`
      })
      .join(", then ")
  }

  return (
    <div className="border-t pt-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors py-1 w-full"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <FileText className="h-3.5 w-3.5" />
        My Agreements ({rules.length})
      </button>

      {expanded && (
        <div className="space-y-1.5 mt-2">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center gap-2 p-2 rounded-md border bg-background text-xs"
            >
              <Switch
                checked={rule.enabled}
                onCheckedChange={(val) => handleToggle(rule.id, val)}
                className="scale-75"
              />
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{rule.name}</p>
                <p className="text-muted-foreground truncate">
                  When {rule.triggerSubjectDeterminer ?? "any"} {rule.triggerVerb ?? "*"}{" "}
                  {rule.triggerObjectDeterminer ?? ""} → I {summarizeActions(rule.actions)}
                </p>
              </div>
              <Badge variant="secondary" className="text-[10px] shrink-0">
                {rule.fireCount}{rule.maxFires !== null ? `/${rule.maxFires}` : ""}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(rule.id)}
                className="h-6 w-6 p-0 shrink-0 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function QueryComposer({ onApply, onClear }: QueryComposerProps) {
  const { toast } = useToast()
  const [whenCondition, setWhenCondition] = useState<QueryCondition>({})
  const [thenActions, setThenActions] = useState<ThenAction[]>([{}])
  const [ifCondition, setIfCondition] = useState<QueryCondition>({})
  const [showIf, setShowIf] = useState(false)

  const [agents, setAgents] = useState<DropdownOption[]>([])
  const [resources, setResources] = useState<DropdownOption[]>([])
  const [loaded, setLoaded] = useState(false)

  // NLP input state
  const [nlpInput, setNlpInput] = useState("")

  // Agreement state
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveName, setSaveName] = useState("")
  const [saving, setSaving] = useState(false)
  const [myRules, setMyRules] = useState<ContractRuleRow[]>([])
  const [ownerName, setOwnerName] = useState("")

  // Fetch agents, resources, and rules on mount
  useEffect(() => {
    if (loaded) return
    let cancelled = false

    async function load() {
      const [agentRows, resourceRows] = await Promise.all([
        fetchAgentsForComposer(),
        fetchResourcesForComposer(),
      ])

      if (cancelled) return

      setAgents(agentRows.map((a) => ({ id: a.id, name: a.name, type: a.type })))
      setResources(resourceRows.map((r) => ({
        id: r.id,
        name: r.title,
        type: r.type,
        quantityAvailable: r.quantityAvailable,
        quantityRemaining: r.quantityRemaining,
      })))
      setLoaded(true)

      // Load rules
      try {
        const rules = await listMyContractRules()
        if (!cancelled) setMyRules(rules)
      } catch {
        // Not authenticated or no rules
      }
    }

    load()
    return () => { cancelled = true }
  }, [loaded])

  const refreshRules = useCallback(async () => {
    try {
      const rules = await listMyContractRules()
      setMyRules(rules)
    } catch {
      // ignore
    }
  }, [])

  // NLP parse handler
  const handleNlpParse = useCallback(() => {
    if (!nlpInput.trim()) return
    const parsed = parseNlpToComposer(nlpInput.trim(), agents, resources)
    setWhenCondition(parsed.when)
    setThenActions(parsed.thenActions.length > 0 ? parsed.thenActions : [{}])
    if (parsed.hasIf) {
      setIfCondition(parsed.ifCondition)
      setShowIf(true)
    }
  }, [nlpInput, agents, resources])

  // Generate sentence summary from current state
  const sentenceSummary = useMemo(
    () => composerToSentence(whenCondition, thenActions, ifCondition, showIf, ownerName || "I"),
    [whenCondition, thenActions, ifCondition, showIf, ownerName]
  )

  // Update THEN actions
  const updateThenAction = useCallback((index: number, action: ThenAction) => {
    setThenActions((prev) => {
      const next = [...prev]
      next[index] = action
      return next
    })
  }, [])

  const addThenAction = useCallback(() => {
    setThenActions((prev) => [...prev, {}])
  }, [])

  const removeThenAction = useCallback((index: number) => {
    setThenActions((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleApply = useCallback(() => {
    const filter: LedgerFilter = {}

    const resolveAgent = (cond: QueryCondition) => {
      if (!cond.agentId || cond.agentId.startsWith("__")) return undefined
      return cond.agentId
    }

    filter.subjectId = resolveAgent(whenCondition)
    filter.verb = whenCondition.verb
    filter.objectId = whenCondition.resourceId
    filter.startDate = whenCondition.startDate
    filter.endDate = whenCondition.endDate

    onApply(filter)
  }, [whenCondition, onApply])

  const handleClear = useCallback(() => {
    setWhenCondition({})
    setThenActions([{}])
    setIfCondition({})
    setShowIf(false)
    onClear()
  }, [onClear])

  const handleSaveAgreement = useCallback(async () => {
    if (!saveName.trim()) return
    setSaving(true)

    // Build actions array from THEN rows
    const contractActions: ContractAction[] = thenActions
      .filter((a) => a.verb)
      .map((a) => ({
        verb: a.verb!,
        objectDeterminer: a.objectDeterminer,
        objectId: a.objectId && !a.objectId.startsWith("__") ? a.objectId : undefined,
        targetDeterminer: a.targetDeterminer,
        targetId: a.targetId === "__trigger_subject__" ? undefined : (a.targetId && !a.targetId.startsWith("__") ? a.targetId : undefined),
        delta: a.delta ?? 0,
      }))

    if (contractActions.length === 0) {
      toast({ title: "Error", description: "At least one THEN action with a verb is required", variant: "destructive" })
      setSaving(false)
      return
    }

    const resolveId = (id?: string) => {
      if (!id || id.startsWith("__")) return undefined
      return id
    }

    const result = await createContractRule({
      name: saveName.trim(),
      triggerSubjectDeterminer: whenCondition.agentDeterminer,
      triggerSubjectId: resolveId(whenCondition.agentId),
      triggerVerb: whenCondition.verb,
      triggerObjectDeterminer: whenCondition.resourceDeterminer,
      triggerObjectId: resolveId(whenCondition.resourceId),
      actions: contractActions,
      conditionSubjectDeterminer: showIf ? ifCondition.agentDeterminer : undefined,
      conditionSubjectId: showIf ? resolveId(ifCondition.agentId) : undefined,
      conditionVerb: showIf ? ifCondition.verb : undefined,
      conditionObjectDeterminer: showIf ? ifCondition.resourceDeterminer : undefined,
      conditionObjectId: showIf ? resolveId(ifCondition.resourceId) : undefined,
    })

    setSaving(false)
    setSaveDialogOpen(false)
    setSaveName("")

    if ("error" in result) {
      toast({ title: "Error", description: result.error, variant: "destructive" })
    } else {
      toast({ title: "Agreement saved", description: `"${saveName.trim()}" is now active` })
      refreshRules()
    }
  }, [saveName, thenActions, whenCondition, ifCondition, showIf, toast, refreshRules])

  const hasAnyFilter =
    whenCondition.agentId ||
    whenCondition.verb ||
    whenCondition.resourceId ||
    thenActions.some((a) => a.verb)

  const hasAnyThenVerb = thenActions.some((a) => a.verb)

  return (
    <div className="rounded-lg border bg-card p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <Filter className="h-3.5 w-3.5" />
          Query Composer
        </h3>
        <div className="flex items-center gap-1.5">
          {hasAnyThenVerb && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSaveDialogOpen(true)}
              className="h-7 text-xs gap-1 px-2"
            >
              <Save className="h-3 w-3" />
              Save as Agreement
            </Button>
          )}
          {hasAnyFilter && (
            <Button variant="ghost" size="sm" onClick={handleClear} className="h-7 text-xs gap-1 px-2">
              <Trash2 className="h-3 w-3" />
              Clear
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleApply}
            disabled={!hasAnyFilter}
            className="h-7 text-xs gap-1 px-3"
          >
            <Filter className="h-3 w-3" />
            Apply
          </Button>
        </div>
      </div>

      {/* NLP input bar */}
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Sparkles className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Describe your agreement in plain English..."
            value={nlpInput}
            onChange={(e) => setNlpInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                handleNlpParse()
              }
            }}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleNlpParse}
          disabled={!nlpInput.trim()}
          className="h-8 text-xs px-2.5 gap-1"
        >
          <Sparkles className="h-3 w-3" />
          Parse
        </Button>
      </div>

      {/* Sentence summary */}
      {sentenceSummary && (
        <p className="text-xs text-muted-foreground italic px-1 py-0.5 border-l-2 border-border/50 ml-1">
          {sentenceSummary}
        </p>
      )}

      {/* WHEN row */}
      <ConditionBlock
        label="when"
        condition={whenCondition}
        agents={agents}
        resources={resources}
        onChange={setWhenCondition}
      />

      {/* THEN rows (chainable) */}
      {thenActions.map((action, i) => (
        <ThenActionRow
          key={i}
          label={i === 0 ? "then" : "and"}
          ownerName={ownerName || "I"}
          action={action}
          agents={agents}
          resources={resources}
          onChange={(a) => updateThenAction(i, a)}
          onRemove={() => removeThenAction(i)}
          canRemove={thenActions.length > 1}
        />
      ))}

      {/* + Add Action */}
      <button
        type="button"
        onClick={addThenAction}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-0.5 ml-10"
      >
        <Plus className="h-3 w-3" />
        Add Action
      </button>

      {/* IF row (optional) */}
      {showIf ? (
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <ConditionBlock
              label="if"
              condition={ifCondition}
              agents={agents}
              resources={resources}
              onChange={setIfCondition}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowIf(false)
              setIfCondition({})
            }}
            className="h-8 w-8 p-0 shrink-0"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowIf(true)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Condition
        </button>
      )}

      {/* Mini Canvas */}
      <MiniCanvas
        whenCondition={whenCondition}
        thenActions={thenActions}
        ifCondition={ifCondition}
        showIf={showIf}
        ownerName={ownerName || "I"}
      />

      {/* My Agreements */}
      <AgreementsList rules={myRules} onRefresh={refreshRules} />

      {/* Save Dialog */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Save as Agreement</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <label className="text-sm font-medium">Agreement Name</label>
            <Input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="e.g., Auto-deliver seedlings"
              className="mt-1.5"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && saveName.trim()) {
                  handleSaveAgreement()
                }
              }}
            />
            <p className="text-xs text-muted-foreground mt-2">
              This agreement will automatically execute the THEN actions whenever the WHEN trigger fires.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveAgreement}
              disabled={!saveName.trim() || saving}
            >
              {saving ? "Saving..." : "Save Agreement"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
