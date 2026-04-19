"use client";

import Link from "next/link";
import Script from "next/script";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { Building2, CreditCard, Loader2, RefreshCw, SendHorizontal } from "lucide-react";

type TellerBankAccountSummary = {
  id: string;
  enrollmentId: string;
  tellerUserId?: string | null;
  institutionId?: string | null;
  institutionName: string;
  name: string;
  subtype: string;
  type: string;
  currency: string;
  lastFour: string;
  status: string;
  available?: string | null;
  ledger?: string | null;
  supportsPayments: boolean;
  paymentSchemes: string[];
  sourceProvider: string;
};

type TellerWalletResponse = {
  applicationId?: string;
  environment?: "sandbox" | "development" | "production";
  connectConfigured?: boolean;
  apiConfigured?: boolean;
  linkedAccounts?: TellerBankAccountSummary[];
  error?: string;
};

type TellerConnectSessionResponse = {
  applicationId: string;
  environment: "sandbox" | "development" | "production";
  products: string[];
  apiConfigured: boolean;
  nonce: string;
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

function formatCurrencyAmount(value: string | null | undefined, currency: string) {
  if (!value) return "Unavailable";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(parsed);
}

export function BankAccountsCard() {
  const { toast } = useToast();
  const [scriptReady, setScriptReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [submittingPayment, setSubmittingPayment] = useState(false);
  const [config, setConfig] = useState<TellerWalletResponse | null>(null);
  const [accounts, setAccounts] = useState<TellerBankAccountSummary[]>([]);
  const [sourceAccountId, setSourceAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [payeeAddress, setPayeeAddress] = useState("");
  const [payeeName, setPayeeName] = useState("");
  const [payeeType, setPayeeType] = useState<"person" | "business">("person");

  const refreshAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/wallet/banks", { cache: "no-store" });
      const data = (await response.json()) as TellerWalletResponse;
      if (!response.ok) {
        throw new Error(data.error || `Failed to load linked bank accounts (${response.status})`);
      }
      setConfig(data);
      setAccounts(Array.isArray(data.linkedAccounts) ? data.linkedAccounts : []);
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : "Failed to load linked bank accounts.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void refreshAccounts();
  }, [refreshAccounts]);

  const paymentEligibleAccounts = useMemo(
    () => accounts.filter((account) => account.supportsPayments),
    [accounts],
  );

  useEffect(() => {
    if (!sourceAccountId && paymentEligibleAccounts[0]?.id) {
      setSourceAccountId(paymentEligibleAccounts[0].id);
    }
  }, [paymentEligibleAccounts, sourceAccountId]);

  const launchTellerConnect = useCallback(
    async (mode: "enroll" | "payment_mfa", connectToken?: string) => {
      if (!scriptReady || !window.TellerConnect?.setup) {
        throw new Error("Teller Connect has not finished loading yet.");
      }

      const response = await fetch("/api/wallet/banks/connect", { cache: "no-store" });
      const session = (await response.json()) as Partial<TellerConnectSessionResponse> & { error?: string };
      if (!response.ok || !session.applicationId || !session.environment) {
        throw new Error(session.error || "Unable to initialize Teller Connect.");
      }

      const tellerConnect = window.TellerConnect.setup({
        applicationId: session.applicationId,
        environment: session.environment,
        ...(mode === "enroll"
          ? {
              products: session.products,
              selectAccount: "multiple",
              nonce: session.nonce,
            }
          : {
              connectToken,
            }),
        onSuccess: async (payload: Record<string, unknown>) => {
          if (mode === "payment_mfa") {
            toast({
              title: "Transfer completed",
              description: "Your bank finished the required verification step.",
            });
            void refreshAccounts();
            return;
          }

          const enrollResponse = await fetch("/api/wallet/banks/enroll", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const enrollData = (await enrollResponse.json()) as {
            error?: string;
            linkedAccounts?: TellerBankAccountSummary[];
          };
          if (!enrollResponse.ok) {
            throw new Error(enrollData.error || "Failed to save linked bank.");
          }
          setAccounts(Array.isArray(enrollData.linkedAccounts) ? enrollData.linkedAccounts : []);
          toast({
            title: "Bank connected",
            description: "Your linked accounts are now available in Rivr Wallet.",
          });
          void refreshAccounts();
        },
        onExit: () => {
          setConnecting(false);
        },
        onFailure: (failure: { message?: string }) => {
          toast({
            title: "Teller flow failed",
            description: failure?.message || "The bank connection did not complete.",
            variant: "destructive",
          });
        },
      });

      tellerConnect.open();
    },
    [refreshAccounts, scriptReady, toast],
  );

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await launchTellerConnect("enroll");
    } catch (error) {
      setConnecting(false);
      toast({
        title: error instanceof Error ? error.message : "Unable to start Teller Connect.",
        variant: "destructive",
      });
    }
  };

  const handlePayment = async () => {
    if (!sourceAccountId || !amount.trim() || !payeeAddress.trim()) {
      toast({
        title: "Missing transfer details",
        description: "Choose a source account, amount, and payee address.",
        variant: "destructive",
      });
      return;
    }

    setSubmittingPayment(true);
    try {
      const response = await fetch("/api/wallet/banks/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAccountId,
          amount,
          memo,
          payeeAddress,
          payeeName,
          payeeType,
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        payment?: { id?: string; connect_token?: string };
      };
      if (!response.ok) {
        throw new Error(data.error || `Transfer failed (${response.status})`);
      }

      if (data.payment?.connect_token) {
        await launchTellerConnect("payment_mfa", data.payment.connect_token);
      } else {
        toast({
          title: "Transfer initiated",
          description: data.payment?.id
            ? `Payment ${data.payment.id} was created successfully.`
            : "Your payment request was submitted.",
        });
      }

      setAmount("");
      setMemo("");
      setPayeeAddress("");
      setPayeeName("");
      void refreshAccounts();
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : "Unable to initiate transfer.",
        variant: "destructive",
      });
    } finally {
      setSubmittingPayment(false);
    }
  };

  const hasAccounts = accounts.length > 0;

  return (
    <>
      <Script
        src="https://cdn.teller.io/connect/connect.js"
        strategy="afterInteractive"
        onLoad={() => setScriptReady(true)}
      />
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            Bank Accounts
          </CardTitle>
          <CardDescription>
            Link bank accounts through Teller Connect, view balances here, and send supported payments from eligible accounts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => void handleConnect()}
              disabled={!scriptReady || !config?.connectConfigured || connecting}
            >
              {connecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CreditCard className="mr-2 h-4 w-4" />}
              {hasAccounts ? "Connect Another Bank" : "Connect Bank"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void refreshAccounts()} disabled={loading}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Refresh Accounts
            </Button>
            <Button size="sm" variant="ghost" asChild>
              <Link href="/settings?tab=connections#connector-teller">
                Open Connections Settings
              </Link>
            </Button>
            {config?.connectConfigured ? (
              <Badge variant={config.apiConfigured ? "secondary" : "destructive"}>
                {config.apiConfigured
                  ? `Teller ${config.environment ?? "sandbox"}`
                  : "Teller API not fully configured"}
              </Badge>
            ) : (
              <Badge variant="destructive">Teller not configured</Badge>
            )}
          </div>

          {config?.error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {config.error}
            </div>
          ) : null}

          {!hasAccounts && !loading ? (
            <div className="rounded-md border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
              No linked bank accounts yet. Use the connect button to complete your bank’s sign-in flow from inside Rivr.
              <div className="mt-2">
                <Link href="/settings?tab=connections#connector-teller" className="text-primary underline-offset-4 hover:underline">
                  Need to configure Teller first? Open Connections settings.
                </Link>
              </div>
            </div>
          ) : null}

          {hasAccounts ? (
            <div className="grid gap-3 md:grid-cols-2">
              {accounts.map((account) => (
                <div key={account.id} className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{account.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {account.institutionName} • {account.subtype} • •••• {account.lastFour}
                      </p>
                    </div>
                    <Badge variant={account.supportsPayments ? "default" : "outline"}>
                      {account.supportsPayments ? "Transfer ready" : "Read-only"}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Available</p>
                      <p className="font-medium">
                        {formatCurrencyAmount(account.available, account.currency)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Ledger</p>
                      <p className="font-medium">
                        {formatCurrencyAmount(account.ledger, account.currency)}
                      </p>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Status: {account.status}
                    {account.paymentSchemes.length > 0
                      ? ` • Payment schemes: ${account.paymentSchemes.join(", ")}`
                      : " • This account does not expose Teller payments right now."}
                  </p>
                </div>
              ))}
            </div>
          ) : null}

          <div className="rounded-lg border border-border/60 p-4 space-y-4">
            <div>
              <p className="font-medium">Transfer Funds</p>
              <p className="text-xs text-muted-foreground">
                Transfers use Teller payments on accounts that expose supported schemes. Right now that usually means Zelle-capable checking accounts.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>From Account</Label>
                <Select value={sourceAccountId} onValueChange={setSourceAccountId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a linked bank account" />
                  </SelectTrigger>
                  <SelectContent>
                    {paymentEligibleAccounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.institutionName} • {account.name} • •••• {account.lastFour}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Amount</Label>
                <Input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  inputMode="decimal"
                  placeholder="10.00"
                />
              </div>

              <div className="space-y-1.5">
                <Label>Payee Email or Phone</Label>
                <Input
                  value={payeeAddress}
                  onChange={(event) => setPayeeAddress(event.target.value)}
                  placeholder="name@example.com or +1 555 555 5555"
                />
              </div>

              <div className="space-y-1.5">
                <Label>Payee Name</Label>
                <Input
                  value={payeeName}
                  onChange={(event) => setPayeeName(event.target.value)}
                  placeholder="Recipient"
                />
              </div>

              <div className="space-y-1.5">
                <Label>Payee Type</Label>
                <Select value={payeeType} onValueChange={(value) => setPayeeType(value as "person" | "business")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="person">Person</SelectItem>
                    <SelectItem value="business">Business</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Memo</Label>
                <Input
                  value={memo}
                  onChange={(event) => setMemo(event.target.value)}
                  placeholder="Optional note"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                If your bank requires MFA for the payee or payment, Rivr will reopen Teller Connect to finish the transfer.
              </p>
              <Button
                onClick={() => void handlePayment()}
                disabled={submittingPayment || paymentEligibleAccounts.length === 0}
              >
                {submittingPayment ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <SendHorizontal className="mr-2 h-4 w-4" />
                )}
                Send Transfer
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
