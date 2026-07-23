"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  PAYOUT_COUNTRY_OPTIONS,
  payoutRailNote,
  railForCountry,
} from "@/lib/payout-countries";

/**
 * "Where is your bank?" dialog for FIRST-TIME payout setup.
 *
 * Stripe account country is IMMUTABLE, so a seller must pick their bank
 * country before the connected account (or Global Payouts recipient) is
 * created — otherwise the account silently defaults to US and a foreign
 * seller is stranded. Shared by every first-time setup entry point (the
 * group Treasury card AND the personal wallet), so the country is asked
 * consistently and the corridor is routed correctly.
 *
 * onConfirm receives the chosen ISO-2 country; the caller passes it to
 * setupConnectAccountAction. Only shown for NEW accounts — an existing
 * account's "Finish/Continue setup" must NOT open this (country is fixed).
 */
export function PayoutCountryDialog({
  open,
  onOpenChange,
  onConfirm,
  disabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (country: string) => void;
  disabled?: boolean;
}) {
  const [country, setCountry] = useState("US");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Where is your bank?</DialogTitle>
          <DialogDescription>
            We use your bank&apos;s country to set up the right payout method. This
            can&apos;t be changed later, so pick the country of the bank account you
            want to be paid into.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select value={country} onValueChange={setCountry}>
            <SelectTrigger>
              <SelectValue placeholder="Select country" />
            </SelectTrigger>
            <SelectContent>
              {PAYOUT_COUNTRY_OPTIONS.map((option) => (
                <SelectItem key={option.code} value={option.code}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            {payoutRailNote(railForCountry(country))}
          </p>
        </div>
        <DialogFooter>
          <Button
            onClick={() => {
              onOpenChange(false);
              onConfirm(country);
            }}
            disabled={disabled}
          >
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
