"use client"

import { use, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { ChevronLeft, Plus, Trash2, DollarSign, Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { useToast } from "@/components/ui/use-toast"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { fetchEventDetail } from "@/app/actions/graph"
import { updateResource } from "@/app/actions/create-resources"
import { agentToEvent } from "@/lib/graph-adapters"
import type { EventExpense, EventPayout } from "@/types"

type FinancialEditorExpense = {
  id: string
  recipient: string
  description: string
  amountCents: number
  status: string
}

type FinancialEditorPayout = {
  id: string
  recipientAgentId: string
  recipientLabel: string
  role: string
  amountCents: number
  shareBps?: number
  fixedCents?: number
  status: string
}

function formatCurrency(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(cents / 100)
}

function parseCurrencyInput(value: string): number {
  const parsed = Number.parseFloat(value.trim())
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : 0
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export default function EventFinancialsPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params)
  const router = useRouter()
  const { toast } = useToast()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [eventName, setEventName] = useState("Event")
  const [currency, setCurrency] = useState("USD")
  const [revenueCents, setRevenueCents] = useState(0)
  const [expenses, setExpenses] = useState<FinancialEditorExpense[]>([])
  const [payouts, setPayouts] = useState<FinancialEditorPayout[]>([])

  const [newExpense, setNewExpense] = useState({ description: "", amount: "", recipient: "" })
  const [newPayout, setNewPayout] = useState({ recipientLabel: "", amount: "", role: "", recipientAgentId: "" })
  const [expenseDialogOpen, setExpenseDialogOpen] = useState(false)
  const [payoutDialogOpen, setPayoutDialogOpen] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const agent = await fetchEventDetail(resolvedParams.id)
        if (!agent || cancelled) return

        const event = agentToEvent(agent)
        setEventName(event.name)
        setCurrency(event.financialSummary?.currency ?? "USD")
        setRevenueCents(event.financialSummary?.revenueCents ?? 0)
        setExpenses(
          (event.expenses ?? []).map((expense: EventExpense) => ({
            id: expense.id,
            recipient: expense.recipient,
            description: expense.description,
            amountCents: expense.amountCents,
            status: expense.status ?? "recorded",
          })),
        )
        setPayouts(
          (event.payouts ?? []).map((payout: EventPayout) => ({
            id: payout.id,
            recipientAgentId: payout.recipientAgentId,
            recipientLabel: payout.label ?? payout.recipientAgentId,
            role: payout.role ?? "",
            amountCents:
              typeof payout.fixedCents === "number"
                ? payout.fixedCents
                : typeof payout.shareBps === "number" && (event.financialSummary?.profitCents ?? 0) > 0
                  ? Math.round(((event.financialSummary?.profitCents ?? 0) * payout.shareBps) / 10_000)
                  : 0,
            shareBps: payout.shareBps,
            fixedCents: payout.fixedCents,
            status: payout.status ?? "pending",
          })),
        )
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [resolvedParams.id])

  const expenseTotalCents = useMemo(
    () => expenses.reduce((sum, expense) => sum + expense.amountCents, 0),
    [expenses],
  )
  const payoutTotalCents = useMemo(
    () => payouts.reduce((sum, payout) => sum + payout.amountCents, 0),
    [payouts],
  )
  const profitCents = revenueCents - expenseTotalCents
  const remainingCents = profitCents - payoutTotalCents

  const persistFinancials = async (nextExpenses: FinancialEditorExpense[], nextPayouts: FinancialEditorPayout[]) => {
    setSaving(true)
    try {
      const result = await updateResource({
        resourceId: resolvedParams.id,
        metadataPatch: {
          expenses: nextExpenses.map((expense) => ({
            id: expense.id,
            recipient: expense.recipient,
            description: expense.description,
            amountCents: expense.amountCents,
            status: expense.status,
          })),
          payouts: nextPayouts.map((payout) => ({
            id: payout.id,
            recipientAgentId: payout.recipientAgentId || payout.recipientLabel,
            label: payout.recipientLabel,
            role: payout.role || undefined,
            fixedCents: payout.amountCents,
            shareBps: payout.shareBps,
            status: payout.status,
            currency,
          })),
          financialSummary: {
            revenueCents,
            expensesCents: nextExpenses.reduce((sum, expense) => sum + expense.amountCents, 0),
            payoutsCents: nextPayouts.reduce((sum, payout) => sum + payout.amountCents, 0),
            profitCents: revenueCents - nextExpenses.reduce((sum, expense) => sum + expense.amountCents, 0),
            remainingCents:
              revenueCents -
              nextExpenses.reduce((sum, expense) => sum + expense.amountCents, 0) -
              nextPayouts.reduce((sum, payout) => sum + payout.amountCents, 0),
            currency,
          },
        },
      })

      if (!result.success) {
        toast({
          title: "Could not save financials",
          description: result.message,
          variant: "destructive",
        })
        return false
      }

      router.refresh()
      return true
    } finally {
      setSaving(false)
    }
  }

  const handleAddExpense = async () => {
    const amountCents = parseCurrencyInput(newExpense.amount)
    if (!newExpense.description.trim() || !newExpense.recipient.trim() || amountCents <= 0) {
      toast({ title: "Invalid expense", description: "Provide description, recipient, and a positive amount.", variant: "destructive" })
      return
    }

    const nextExpenses = [
      ...expenses,
      {
        id: createId("expense"),
        recipient: newExpense.recipient.trim(),
        description: newExpense.description.trim(),
        amountCents,
        status: "recorded",
      },
    ]

    if (await persistFinancials(nextExpenses, payouts)) {
      setExpenses(nextExpenses)
      setNewExpense({ description: "", amount: "", recipient: "" })
      setExpenseDialogOpen(false)
      toast({ title: "Expense added" })
    }
  }

  const handleRemoveExpense = async (id: string) => {
    const nextExpenses = expenses.filter((expense) => expense.id !== id)
    if (await persistFinancials(nextExpenses, payouts)) {
      setExpenses(nextExpenses)
    }
  }

  const handleAddPayout = async () => {
    const amountCents = parseCurrencyInput(newPayout.amount)
    if (!newPayout.recipientLabel.trim() || amountCents <= 0) {
      toast({ title: "Invalid payout", description: "Provide a recipient and a positive amount.", variant: "destructive" })
      return
    }

    const nextPayouts = [
      ...payouts,
      {
        id: createId("payout"),
        recipientAgentId: newPayout.recipientAgentId.trim(),
        recipientLabel: newPayout.recipientLabel.trim(),
        role: newPayout.role.trim(),
        amountCents,
        fixedCents: amountCents,
        status: "pending",
      },
    ]

    if (await persistFinancials(expenses, nextPayouts)) {
      setPayouts(nextPayouts)
      setNewPayout({ recipientLabel: "", amount: "", role: "", recipientAgentId: "" })
      setPayoutDialogOpen(false)
      toast({ title: "Payout added" })
    }
  }

  const handleSendPayouts = async () => {
    const nextPayouts = payouts.map((payout) =>
      payout.status === "sent" ? payout : { ...payout, status: "sent" },
    )
    if (await persistFinancials(expenses, nextPayouts)) {
      setPayouts(nextPayouts)
      toast({ title: "Payouts marked sent" })
    }
  }

  const pendingPayoutCount = payouts.filter((payout) => payout.status !== "sent").length

  return (
    <div className="container max-w-5xl mx-auto px-4 py-6 pb-20">
      <div className="flex items-center gap-4 mb-6">
        <Button variant="ghost" className="p-0" onClick={() => router.back()} aria-label="Go back">
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Event Financials</h1>
          <p className="text-sm text-muted-foreground">{eventName}</p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading financials...
        </div>
      ) : (
        <>
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                <div className="rounded-md bg-muted/40 p-4">
                  <p className="text-sm text-muted-foreground">Revenue</p>
                  <p className="text-xl font-semibold">{formatCurrency(revenueCents, currency)}</p>
                </div>
                <div className="rounded-md bg-muted/40 p-4">
                  <p className="text-sm text-muted-foreground">Expenses</p>
                  <p className="text-xl font-semibold">{formatCurrency(expenseTotalCents, currency)}</p>
                </div>
                <div className="rounded-md bg-muted/40 p-4">
                  <p className="text-sm text-muted-foreground">Profit</p>
                  <p className="text-xl font-semibold">{formatCurrency(profitCents, currency)}</p>
                </div>
                <div className="rounded-md bg-muted/40 p-4">
                  <p className="text-sm text-muted-foreground">Payouts</p>
                  <p className="text-xl font-semibold">{formatCurrency(payoutTotalCents, currency)}</p>
                </div>
                <div className="rounded-md bg-muted/40 p-4">
                  <p className="text-sm text-muted-foreground">Remaining</p>
                  <p className="text-xl font-semibold">{formatCurrency(remainingCents, currency)}</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <Button variant="outline" onClick={() => toast({ title: "Report export pending", description: "Use the event metadata export flow next." })}>
                  <Download className="h-4 w-4 mr-2" />
                  Export Report
                </Button>
                <Button onClick={handleSendPayouts} disabled={saving || pendingPayoutCount === 0}>
                  {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <DollarSign className="h-4 w-4 mr-2" />}
                  Mark Payouts Sent
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Expenses</CardTitle>
                <Dialog open={expenseDialogOpen} onOpenChange={setExpenseDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm"><Plus className="h-4 w-4 mr-2" />Add Expense</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add Expense</DialogTitle>
                      <DialogDescription>Track an event cost that should reduce available payout margin.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Description</label>
                        <Input value={newExpense.description} onChange={(e) => setNewExpense((prev) => ({ ...prev, description: e.target.value }))} />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Recipient</label>
                        <Input value={newExpense.recipient} onChange={(e) => setNewExpense((prev) => ({ ...prev, recipient: e.target.value }))} />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Amount</label>
                        <Input value={newExpense.amount} onChange={(e) => setNewExpense((prev) => ({ ...prev, amount: e.target.value }))} type="number" min="0" step="0.01" />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setExpenseDialogOpen(false)}>Cancel</Button>
                      <Button onClick={handleAddExpense} disabled={saving}>Add</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardHeader>
              <CardContent className="space-y-3">
                {expenses.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No expenses recorded yet.</p>
                ) : expenses.map((expense) => (
                  <div key={expense.id} className="rounded-md border p-3">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="font-medium">{expense.description}</p>
                        <p className="text-sm text-muted-foreground">Paid to {expense.recipient}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-medium">{formatCurrency(expense.amountCents, currency)}</p>
                        <Badge variant="outline" className="mt-1">{expense.status}</Badge>
                      </div>
                    </div>
                    <div className="flex justify-end mt-3">
                      <Button variant="ghost" size="sm" className="text-red-600" onClick={() => void handleRemoveExpense(expense.id)} disabled={saving}>
                        <Trash2 className="h-4 w-4 mr-1" />
                        Remove
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Payouts</CardTitle>
                <Dialog open={payoutDialogOpen} onOpenChange={setPayoutDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm"><Plus className="h-4 w-4 mr-2" />Add Payout</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add Payout</DialogTitle>
                      <DialogDescription>Create a payout line for a host or contributor.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Recipient label</label>
                        <Input value={newPayout.recipientLabel} onChange={(e) => setNewPayout((prev) => ({ ...prev, recipientLabel: e.target.value }))} placeholder="Alex Rivera" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Recipient agent ID (optional)</label>
                        <Input value={newPayout.recipientAgentId} onChange={(e) => setNewPayout((prev) => ({ ...prev, recipientAgentId: e.target.value }))} placeholder="agent UUID if known" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Role</label>
                        <Input value={newPayout.role} onChange={(e) => setNewPayout((prev) => ({ ...prev, role: e.target.value }))} placeholder="Lead host, sound, producer" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Amount</label>
                        <Input value={newPayout.amount} onChange={(e) => setNewPayout((prev) => ({ ...prev, amount: e.target.value }))} type="number" min="0" step="0.01" />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setPayoutDialogOpen(false)}>Cancel</Button>
                      <Button onClick={handleAddPayout} disabled={saving}>Add</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardHeader>
              <CardContent className="space-y-3">
                {payouts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No payouts scheduled yet.</p>
                ) : payouts.map((payout) => (
                  <div key={payout.id} className="rounded-md border p-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <Avatar className="h-10 w-10">
                          <AvatarFallback>{payout.recipientLabel.slice(0, 2).toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium">{payout.recipientLabel}</p>
                          <p className="text-sm text-muted-foreground">{payout.role || "Contributor payout"}</p>
                          {typeof payout.shareBps === "number" ? (
                            <p className="text-xs text-muted-foreground">{(payout.shareBps / 100).toFixed(2)}% share</p>
                          ) : null}
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-medium">{formatCurrency(payout.amountCents, currency)}</p>
                        <Badge className={payout.status === "sent" ? "bg-green-100 text-green-800 hover:bg-green-100" : "bg-yellow-100 text-yellow-800 hover:bg-yellow-100"}>
                          {payout.status}
                        </Badge>
                      </div>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <Separator className="my-6" />

          <Card>
            <CardHeader>
              <CardTitle>Host Payout Plan</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {payouts.length === 0 ? (
                <p className="text-sm text-muted-foreground">Build the payout plan here. This is the event-level source of truth for contributor distributions.</p>
              ) : (
                payouts.map((payout) => (
                  <div key={`plan-${payout.id}`} className="flex items-center justify-between rounded-md border p-3">
                    <div>
                      <p className="font-medium">{payout.recipientLabel}</p>
                      <p className="text-sm text-muted-foreground">{payout.role || "Contributor"}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium">{formatCurrency(payout.amountCents, currency)}</p>
                      {typeof payout.shareBps === "number" ? (
                        <p className="text-xs text-muted-foreground">{(payout.shareBps / 100).toFixed(2)}% share</p>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
