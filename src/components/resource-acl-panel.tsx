"use client"

/**
 * Per-resource permissioning panel for the unified filesystem organizer.
 *
 * Surfaced inside the Documents tab's Filesystem view when a Resource node
 * (a `resources/{type}/{id}` virtual folder) is selected. The filesystem is
 * permissionable along three axes, all backed by existing platform primitives:
 *
 * 1. Visibility — implicit-access fallback (public/locale/members/private/hidden)
 *    via PATCH /api/agent-hq/resources/[id].
 * 2. Direct grants — share a verb (view/use/manage/share) with ANY agent
 *    (not just the owner's personas), with an optional role and a context
 *    scope (locale/global), via GET/POST /api/agent-hq/resources/[id]/access.
 * 3. ABAC policies — attribute/context conditions that grant actions to any
 *    actor whose attributes satisfy them, via
 *    GET/POST/DELETE /api/agent-hq/resources/[id]/policies.
 *
 * Read-only audit history comes from GET /api/agent-hq/resources/[id]/ledger.
 * Grant targets are discovered via GET /api/agent-hq/agents/search.
 *
 * The panel is owner/grantor-gated server-side: a viewer without `grant` gets a
 * 403 and the panel renders a read-only notice.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, Plus, ShieldCheck, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"

const VISIBILITY_OPTIONS = ["public", "locale", "members", "private", "hidden"] as const
type Visibility = (typeof VISIBILITY_OPTIONS)[number]

const VISIBILITY_HELP: Record<Visibility, string> = {
  public: "Anyone can find and view this.",
  locale: "Visible to agents in the same locale.",
  members: "Visible to members only.",
  private: "Only you and explicitly granted agents.",
  hidden: "Hidden from listings; grant access explicitly.",
}

const CONDITION_OPERATORS = ["equals", "contains", "in", "exists"] as const
type ConditionOperator = (typeof CONDITION_OPERATORS)[number]

interface AccessGrant {
  subjectId: string
  subjectName: string
  subjectImage: string | null
  isPersona: boolean
  verb: string
  role: string | null
  scope: string | null
  grantedAt: string
}

interface AgentResult {
  id: string
  name: string | null
  image: string | null
  type: string
  isPersona: boolean
  isSelf: boolean
}

interface HistoryEntry {
  id: string
  verb: string
  subjectId: string
  subjectName: string
  summary: string
  timestamp: string
}

interface PolicyCondition {
  key: string
  operator: ConditionOperator
  value: string | string[]
}

interface Policy {
  id: string
  label: string
  allowedActions: string[]
  conditions: PolicyCondition[]
  logicalOperator: "AND" | "OR"
  localeScope: string | null
}

interface AccessResponse {
  visibility: Visibility
  grantableVerbs: string[]
  grants: AccessGrant[]
}

interface ResourceAclPanelProps {
  resourceId: string
  resourceName?: string
  onClose?: () => void
}

export function ResourceAclPanel({ resourceId, resourceName, onClose }: ResourceAclPanelProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [visibility, setVisibility] = useState<Visibility>("private")
  const [grantableVerbs, setGrantableVerbs] = useState<string[]>([])
  const [grants, setGrants] = useState<AccessGrant[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [policies, setPolicies] = useState<Policy[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // Direct-grant form
  const [agentQuery, setAgentQuery] = useState("")
  const [agentResults, setAgentResults] = useState<AgentResult[]>([])
  const [searching, setSearching] = useState(false)
  const [grantSubject, setGrantSubject] = useState<{ id: string; name: string } | null>(null)
  const [grantVerb, setGrantVerb] = useState("")
  const [grantRole, setGrantRole] = useState("")
  const [grantScope, setGrantScope] = useState<"global" | "locale">("global")

  // ABAC policy form
  const [showPolicyForm, setShowPolicyForm] = useState(false)
  const [policyLabel, setPolicyLabel] = useState("")
  const [policyActions, setPolicyActions] = useState<string[]>([])
  const [policyLogical, setPolicyLogical] = useState<"AND" | "OR">("AND")
  const [policyLocaleScope, setPolicyLocaleScope] = useState("")
  const [policyConditions, setPolicyConditions] = useState<PolicyCondition[]>([
    { key: "", operator: "equals", value: "" },
  ])

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadAccess = useCallback(async () => {
    setLoading(true)
    setError(null)
    setForbidden(false)
    try {
      const [accessRes, ledgerRes, policiesRes] = await Promise.all([
        fetch(`/api/agent-hq/resources/${encodeURIComponent(resourceId)}/access`, { cache: "no-store" }),
        fetch(`/api/agent-hq/resources/${encodeURIComponent(resourceId)}/ledger`, { cache: "no-store" }),
        fetch(`/api/agent-hq/resources/${encodeURIComponent(resourceId)}/policies`, { cache: "no-store" }),
      ])

      if (accessRes.status === 403) {
        setForbidden(true)
        return
      }
      const accessData = (await accessRes.json().catch(() => ({}))) as AccessResponse & { error?: string }
      if (!accessRes.ok || accessData.error) {
        throw new Error(accessData.error || `Failed to load access (${accessRes.status})`)
      }
      setVisibility(accessData.visibility)
      setGrantableVerbs(accessData.grantableVerbs ?? [])
      setGrants(accessData.grants ?? [])
      setGrantVerb((current) => current || accessData.grantableVerbs?.[0] || "")
      setPolicyActions((current) => (current.length ? current : accessData.grantableVerbs?.slice(0, 1) ?? []))

      if (ledgerRes.ok) {
        const ledgerData = (await ledgerRes.json().catch(() => ({}))) as { history?: HistoryEntry[] }
        setHistory(ledgerData.history ?? [])
      } else {
        setHistory([])
      }

      if (policiesRes.ok) {
        const policiesData = (await policiesRes.json().catch(() => ({}))) as { policies?: Policy[] }
        setPolicies(policiesData.policies ?? [])
      } else {
        setPolicies([])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load access")
    } finally {
      setLoading(false)
    }
  }, [resourceId])

  useEffect(() => {
    void loadAccess()
  }, [loadAccess])

  // Debounced agent search (any agent — not just personas).
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(
          `/api/agent-hq/agents/search?q=${encodeURIComponent(agentQuery)}`,
          { cache: "no-store" },
        )
        const data = (await res.json().catch(() => ({}))) as { agents?: AgentResult[] }
        setAgentResults(data.agents ?? [])
      } catch {
        setAgentResults([])
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [agentQuery])

  const handleVisibilityChange = useCallback(
    async (next: Visibility) => {
      const previous = visibility
      setVisibility(next)
      setBusy(true)
      setMessage(null)
      try {
        const response = await fetch(`/api/agent-hq/resources/${encodeURIComponent(resourceId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ visibility: next }),
        })
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        if (!response.ok || data.error) {
          throw new Error(data.error || `Failed to update visibility (${response.status})`)
        }
        setMessage(`Visibility set to ${next}.`)
        void loadAccess()
      } catch (err) {
        setVisibility(previous)
        setMessage(err instanceof Error ? err.message : "Failed to update visibility")
      } finally {
        setBusy(false)
      }
    },
    [loadAccess, resourceId, visibility],
  )

  const mutateGrant = useCallback(
    async (
      action: "grant" | "revoke",
      subjectId: string,
      verb: string,
      extra?: { role?: string; scope?: "global" | "locale" },
    ) => {
      setBusy(true)
      setMessage(null)
      try {
        const response = await fetch(`/api/agent-hq/resources/${encodeURIComponent(resourceId)}/access`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, subjectId, verb, ...extra }),
        })
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        if (!response.ok || data.error) {
          throw new Error(data.error || `Failed to ${action} (${response.status})`)
        }
        setMessage(action === "grant" ? `Granted ${verb}.` : `Revoked ${verb}.`)
        if (action === "grant") {
          setGrantSubject(null)
          setAgentQuery("")
          setGrantRole("")
        }
        void loadAccess()
      } catch (err) {
        setMessage(err instanceof Error ? err.message : `Failed to ${action}`)
      } finally {
        setBusy(false)
      }
    },
    [loadAccess, resourceId],
  )

  const createPolicy = useCallback(async () => {
    setBusy(true)
    setMessage(null)
    try {
      const conditions = policyConditions
        .map((c) => ({ ...c, key: c.key.trim() }))
        .filter((c) => c.key.length > 0)
      const response = await fetch(`/api/agent-hq/resources/${encodeURIComponent(resourceId)}/policies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allowedActions: policyActions,
          conditions,
          logicalOperator: policyLogical,
          localeScope: policyLocaleScope || undefined,
          label: policyLabel || undefined,
        }),
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok || data.error) {
        throw new Error(data.error || `Failed to create policy (${response.status})`)
      }
      setMessage("Policy created.")
      setShowPolicyForm(false)
      setPolicyLabel("")
      setPolicyLocaleScope("")
      setPolicyConditions([{ key: "", operator: "equals", value: "" }])
      void loadAccess()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to create policy")
    } finally {
      setBusy(false)
    }
  }, [loadAccess, policyActions, policyConditions, policyLabel, policyLocaleScope, policyLogical, resourceId])

  const deletePolicy = useCallback(
    async (policyId: string) => {
      setBusy(true)
      setMessage(null)
      try {
        const response = await fetch(
          `/api/agent-hq/resources/${encodeURIComponent(resourceId)}/policies?policyId=${encodeURIComponent(policyId)}`,
          { method: "DELETE" },
        )
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        if (!response.ok || data.error) {
          throw new Error(data.error || `Failed to delete policy (${response.status})`)
        }
        setMessage("Policy deleted.")
        void loadAccess()
      } catch (err) {
        setMessage(err instanceof Error ? err.message : "Failed to delete policy")
      } finally {
        setBusy(false)
      }
    },
    [loadAccess, resourceId],
  )

  const toggleAction = (verb: string, list: string[], set: (next: string[]) => void) => {
    set(list.includes(verb) ? list.filter((v) => v !== verb) : [...list, verb])
  }

  if (forbidden) {
    return (
      <div className="space-y-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <ShieldCheck className="h-4 w-4" /> Permissions
        </div>
        <p>You don&apos;t have rights to manage sharing for this item.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <div>
            <p className="text-sm font-medium leading-tight">Permissions</p>
            {resourceName ? (
              <p className="truncate text-xs text-muted-foreground">{resourceName}</p>
            ) : null}
          </div>
        </div>
        {onClose ? (
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose} aria-label="Close permissions">
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading access…
        </div>
      ) : error ? (
        <div className="space-y-2 text-sm">
          <p className="text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={() => void loadAccess()}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          {/* Visibility — implicit-access fallback */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Visibility</p>
            <select
              value={visibility}
              onChange={(event) => void handleVisibilityChange(event.target.value as Visibility)}
              disabled={busy}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {VISIBILITY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">{VISIBILITY_HELP[visibility]}</p>
          </div>

          {/* Explicit grants */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Shared with</p>
            {grants.length === 0 ? (
              <p className="text-xs text-muted-foreground">No explicit grants yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {grants.map((grant) => (
                  <li
                    key={`${grant.subjectId}:${grant.verb}`}
                    className="flex items-center justify-between gap-2 rounded-md border bg-muted/20 px-2 py-1.5 text-xs"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="truncate font-medium">{grant.subjectName}</span>
                      {grant.isPersona ? (
                        <Badge variant="secondary" className="h-4 px-1 text-[10px]">persona</Badge>
                      ) : null}
                      <Badge variant="outline" className="h-4 px-1 text-[10px]">{grant.verb}</Badge>
                      {grant.role ? (
                        <Badge variant="outline" className="h-4 px-1 text-[10px]">role: {grant.role}</Badge>
                      ) : null}
                      {grant.scope && grant.scope !== "global" ? (
                        <Badge variant="outline" className="h-4 px-1 text-[10px]">{grant.scope}</Badge>
                      ) : null}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                      disabled={busy}
                      onClick={() => void mutateGrant("revoke", grant.subjectId, grant.verb)}
                      aria-label={`Revoke ${grant.verb} from ${grant.subjectName}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Add a grant — to ANY agent, with role + context scope */}
          <div className="space-y-2 rounded-md border border-dashed p-2">
            <p className="text-xs font-medium text-muted-foreground">Grant access</p>
            {grantSubject ? (
              <div className="flex items-center gap-2 text-xs">
                <Badge variant="secondary" className="h-5">{grantSubject.name}</Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1 text-[11px]"
                  onClick={() => setGrantSubject(null)}
                >
                  change
                </Button>
              </div>
            ) : (
              <div className="space-y-1">
                <Input
                  value={agentQuery}
                  onChange={(event) => setAgentQuery(event.target.value)}
                  placeholder="Search any agent by name…"
                  className="h-8 text-xs"
                />
                {agentQuery.length > 0 ? (
                  <div className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border bg-background p-1">
                    {searching ? (
                      <p className="px-1 py-1 text-[11px] text-muted-foreground">Searching…</p>
                    ) : agentResults.length === 0 ? (
                      <p className="px-1 py-1 text-[11px] text-muted-foreground">No agents found.</p>
                    ) : (
                      agentResults.map((agent) => (
                        <button
                          key={agent.id}
                          type="button"
                          className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-[11px] hover:bg-muted"
                          onClick={() => {
                            setGrantSubject({ id: agent.id, name: agent.name || agent.id })
                            setAgentResults([])
                          }}
                        >
                          <span className="truncate">{agent.name || agent.id}</span>
                          <span className="flex shrink-0 gap-1">
                            {agent.isSelf ? <Badge variant="outline" className="h-4 px-1 text-[9px]">you</Badge> : null}
                            {agent.isPersona ? <Badge variant="secondary" className="h-4 px-1 text-[9px]">persona</Badge> : null}
                            <Badge variant="outline" className="h-4 px-1 text-[9px]">{agent.type}</Badge>
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={grantVerb}
                onChange={(event) => setGrantVerb(event.target.value)}
                disabled={busy}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              >
                {grantableVerbs.map((verb) => (
                  <option key={verb} value={verb}>{verb}</option>
                ))}
              </select>
              <select
                value={grantScope}
                onChange={(event) => setGrantScope(event.target.value as "global" | "locale")}
                disabled={busy}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                title="Context scope"
              >
                <option value="global">global</option>
                <option value="locale">locale</option>
              </select>
              <Input
                value={grantRole}
                onChange={(event) => setGrantRole(event.target.value)}
                placeholder="role (optional)"
                className="h-8 w-28 text-xs"
              />
              <Button
                size="sm"
                className="h-8 text-xs"
                disabled={busy || !grantSubject || !grantVerb}
                onClick={() =>
                  grantSubject &&
                  void mutateGrant("grant", grantSubject.id, grantVerb, {
                    role: grantRole || undefined,
                    scope: grantScope,
                  })
                }
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add
              </Button>
            </div>
          </div>

          {/* ABAC policies — attribute/context based */}
          <div className="space-y-2 rounded-md border border-dashed p-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">Attribute policies (ABAC)</p>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                onClick={() => setShowPolicyForm((v) => !v)}
              >
                {showPolicyForm ? "Cancel" : "Add policy"}
              </Button>
            </div>

            {policies.length === 0 && !showPolicyForm ? (
              <p className="text-[11px] text-muted-foreground">
                No attribute policies. Grant actions to anyone whose attributes match conditions.
              </p>
            ) : null}

            {policies.map((policy) => (
              <div key={policy.id} className="flex items-start justify-between gap-2 rounded-md border bg-muted/20 px-2 py-1.5 text-[11px]">
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate font-medium">{policy.label}</p>
                  <p className="text-muted-foreground">
                    {policy.allowedActions.join(", ")} when{" "}
                    {policy.conditions
                      .map((c) => `${c.key} ${c.operator} ${Array.isArray(c.value) ? c.value.join("|") : c.value}`)
                      .join(` ${policy.logicalOperator} `)}
                    {policy.localeScope ? ` · locale=${policy.localeScope}` : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                  disabled={busy}
                  onClick={() => void deletePolicy(policy.id)}
                  aria-label={`Delete policy ${policy.label}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}

            {showPolicyForm ? (
              <div className="space-y-2 rounded-md border p-2">
                <Input
                  value={policyLabel}
                  onChange={(event) => setPolicyLabel(event.target.value)}
                  placeholder="Policy label (optional)"
                  className="h-8 text-xs"
                />
                <div className="flex flex-wrap gap-1">
                  {grantableVerbs.map((verb) => (
                    <button
                      key={verb}
                      type="button"
                      onClick={() => toggleAction(verb, policyActions, setPolicyActions)}
                      className={`rounded border px-1.5 py-0.5 text-[11px] ${policyActions.includes(verb) ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground"}`}
                    >
                      {verb}
                    </button>
                  ))}
                </div>
                {policyConditions.map((cond, index) => (
                  <div key={index} className="flex flex-wrap items-center gap-1">
                    <Input
                      value={cond.key}
                      onChange={(event) =>
                        setPolicyConditions((cur) =>
                          cur.map((c, i) => (i === index ? { ...c, key: event.target.value } : c)),
                        )
                      }
                      placeholder="attribute"
                      className="h-7 w-24 text-[11px]"
                    />
                    <select
                      value={cond.operator}
                      onChange={(event) =>
                        setPolicyConditions((cur) =>
                          cur.map((c, i) =>
                            i === index ? { ...c, operator: event.target.value as ConditionOperator } : c,
                          ),
                        )
                      }
                      className="h-7 rounded-md border border-input bg-background px-1 text-[11px]"
                    >
                      {CONDITION_OPERATORS.map((op) => (
                        <option key={op} value={op}>{op}</option>
                      ))}
                    </select>
                    <Input
                      value={Array.isArray(cond.value) ? cond.value.join(",") : cond.value}
                      onChange={(event) =>
                        setPolicyConditions((cur) =>
                          cur.map((c, i) => (i === index ? { ...c, value: event.target.value } : c)),
                        )
                      }
                      placeholder={cond.operator === "exists" ? "(ignored)" : "value"}
                      disabled={cond.operator === "exists"}
                      className="h-7 flex-1 text-[11px]"
                    />
                    {policyConditions.length > 1 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => setPolicyConditions((cur) => cur.filter((_, i) => i !== index))}
                        aria-label="Remove condition"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={() =>
                      setPolicyConditions((cur) => [...cur, { key: "", operator: "equals", value: "" }])
                    }
                  >
                    <Plus className="mr-1 h-3 w-3" /> Condition
                  </Button>
                  <select
                    value={policyLogical}
                    onChange={(event) => setPolicyLogical(event.target.value as "AND" | "OR")}
                    className="h-7 rounded-md border border-input bg-background px-1 text-[11px]"
                  >
                    <option value="AND">match ALL (AND)</option>
                    <option value="OR">match ANY (OR)</option>
                  </select>
                  <Input
                    value={policyLocaleScope}
                    onChange={(event) => setPolicyLocaleScope(event.target.value)}
                    placeholder="locale scope (optional)"
                    className="h-7 w-36 text-[11px]"
                  />
                </div>
                <Button
                  size="sm"
                  className="h-7 text-[11px]"
                  disabled={busy || policyActions.length === 0}
                  onClick={() => void createPolicy()}
                >
                  Create policy
                </Button>
              </div>
            ) : null}
          </div>

          {/* Read-only history */}
          {history.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">History</p>
              <ul className="max-h-40 space-y-1 overflow-y-auto text-[11px] text-muted-foreground">
                {history.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      <span className="font-medium text-foreground">{entry.subjectName}</span> {entry.summary}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {new Date(entry.timestamp).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
        </>
      )}
    </div>
  )
}
