"use client";

/**
 * Sovereign signup: recovery-seed step.
 *
 * Flow:
 * 1. Gate on `GET /api/instance/mode`. If hosted-federated, redirect to the
 *    default post-signup destination immediately — hosted users do not get
 *    a recovery seed (Cameron's Clarifications #3).
 * 2. Gate on `GET /api/recovery/status`. If a key is already registered
 *    (e.g. user bounced back via this URL), skip to the next step.
 * 3. Generate a fresh BIP-39 mnemonic in-browser. Derive the Ed25519
 *    public key and fingerprint via `@/lib/recovery-seed`.
 * 4. Display the mnemonic; require the user to acknowledge ("I have
 *    written this down"), then type back the Nth word to prove retention.
 * 5. POST only the public key + fingerprint to `/api/recovery/register`.
 *    The mnemonic and private key never leave the page.
 * 6. Optionally stash a passphrase-encrypted blob of the mnemonic in
 *    `localStorage` so the Settings > Reveal flow can recover it later on
 *    the same device. Server never sees the passphrase or plaintext.
 *
 * References:
 * - GitHub issue rivr-social/rivr-person#12.
 * - HANDOFF 2026-04-19 "Recovery Plan" section 1.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, Copy, Download, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  generateRecoveryMnemonic,
  mnemonicToRecoveryKeyPair,
  pickMnemonicConfirmationIndex,
  splitMnemonic,
  type RecoveryKeyPair,
} from '@/lib/recovery-seed';
import { storeEncryptedMnemonic } from '@/lib/recovery-seed-local-store';

const POST_SIGNUP_HOME = '/';

type Phase = 'loading' | 'unavailable' | 'display' | 'confirm' | 'storing' | 'done';

export default function SignupRecoveryPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [keyPair, setKeyPair] = useState<RecoveryKeyPair | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmationInput, setConfirmationInput] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [passphraseRepeat, setPassphraseRepeat] = useState('');
  const [optInLocalStash, setOptInLocalStash] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const confirmationIndex = useMemo(
    () => (mnemonic ? pickMnemonicConfirmationIndex(mnemonic) : null),
    [mnemonic],
  );
  const expectedConfirmWord = useMemo(() => {
    if (!mnemonic || !confirmationIndex) return null;
    const tokens = splitMnemonic(mnemonic);
    return tokens[confirmationIndex - 1]?.word ?? null;
  }, [mnemonic, confirmationIndex]);

  // 1+2) Gate on instance mode + existing registration.
  useEffect(() => {
    let cancelled = false;

    async function gate() {
      try {
        const modeRes = await fetch('/api/instance/mode', { cache: 'no-store' });
        if (!modeRes.ok) throw new Error('Could not check instance mode');
        const { mode } = (await modeRes.json()) as { mode: string };
        if (mode !== 'sovereign') {
          if (!cancelled) {
            setPhase('unavailable');
            setUnavailableReason(
              'Recovery seeds are only generated on sovereign instances. Redirecting…',
            );
            router.replace(POST_SIGNUP_HOME);
          }
          return;
        }

        const statusRes = await fetch('/api/recovery/status', { cache: 'no-store' });
        if (statusRes.status === 401) {
          router.replace('/auth/login?callbackUrl=/auth/signup/recovery');
          return;
        }
        if (!statusRes.ok) throw new Error('Could not check recovery status');
        const status = (await statusRes.json()) as {
          registered: boolean;
          sovereignMode: boolean;
        };
        if (status.registered) {
          if (!cancelled) {
            setPhase('unavailable');
            setUnavailableReason(
              'A recovery key is already registered for this account. Redirecting…',
            );
            router.replace(POST_SIGNUP_HOME);
          }
          return;
        }

        // Generate the mnemonic and derive keys. Derivation is async so we
        // await here rather than blocking paint.
        const m = generateRecoveryMnemonic();
        const kp = await mnemonicToRecoveryKeyPair(m);
        if (cancelled) return;
        setMnemonic(m);
        setKeyPair(kp);
        setPhase('display');
      } catch (err) {
        if (cancelled) return;
        setPhase('unavailable');
        setUnavailableReason(
          err instanceof Error ? err.message : 'Recovery flow unavailable.',
        );
      }
    }

    void gate();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const handleCopy = useCallback(async () => {
    if (!mnemonic) return;
    try {
      await navigator.clipboard.writeText(mnemonic);
    } catch {
      // Copying can fail in insecure contexts; surface the mnemonic box
      // already on-screen so the user can copy manually.
    }
  }, [mnemonic]);

  const handleDownload = useCallback(() => {
    if (!mnemonic) return;
    const blob = new Blob([mnemonic + '\n'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rivr-recovery-seed.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [mnemonic]);

  const handleProceedToConfirm = useCallback(() => {
    setError(null);
    if (!acknowledged) {
      setError('Acknowledge that you have written down the phrase before continuing.');
      return;
    }
    setPhase('confirm');
  }, [acknowledged]);

  const handleSubmit = useCallback(async () => {
    setError(null);
    if (!mnemonic || !keyPair) {
      setError('No mnemonic generated. Reload the page and try again.');
      return;
    }
    if (!expectedConfirmWord || !confirmationIndex) {
      setError('Confirmation word unavailable.');
      return;
    }
    if (confirmationInput.trim().toLowerCase() !== expectedConfirmWord.toLowerCase()) {
      setError(`Word ${confirmationIndex} does not match. Double-check your written copy.`);
      return;
    }
    if (optInLocalStash) {
      if (passphrase.length < 8) {
        setError('Passphrase must be at least 8 characters to stash locally.');
        return;
      }
      if (passphrase !== passphraseRepeat) {
        setError('Passphrases do not match.');
        return;
      }
    }

    setPhase('storing');
    try {
      const res = await fetch('/api/recovery/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publicKeyHex: keyPair.publicKeyHex,
          fingerprint: keyPair.fingerprint,
          algorithm: keyPair.algorithm,
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? 'Failed to register recovery key.');
      }

      if (optInLocalStash) {
        await storeEncryptedMnemonic(mnemonic, passphrase, keyPair.fingerprint);
      }

      setPhase('done');
      setTimeout(() => router.replace(POST_SIGNUP_HOME), 1500);
    } catch (err) {
      setPhase('confirm');
      setError(err instanceof Error ? err.message : 'Unknown registration error.');
    }
  }, [
    mnemonic,
    keyPair,
    confirmationIndex,
    confirmationInput,
    expectedConfirmWord,
    optInLocalStash,
    passphrase,
    passphraseRepeat,
    router,
  ]);

  if (phase === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" /> Preparing your recovery seed…
      </div>
    );
  }

  if (phase === 'unavailable') {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-4 p-8">
        <h1 className="text-2xl font-semibold">Recovery seed unavailable</h1>
        <p className="text-muted-foreground">{unavailableReason}</p>
        <Button onClick={() => router.replace(POST_SIGNUP_HOME)}>Continue</Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="p-4">
        <Link href="/auth/signup" aria-label="Back">
          <ChevronLeft className="h-6 w-6" />
        </Link>
      </div>

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col p-6">
        <header className="mb-8 flex items-start gap-3">
          <ShieldCheck className="mt-1 h-7 w-7 text-primary" />
          <div className="space-y-1">
            <h1 className="text-3xl font-bold">Save your recovery phrase</h1>
            <p className="text-muted-foreground">
              This 24-word phrase is the only way to recover your account if you lose access.
              Write it down and store it somewhere safe. We can never see it or retrieve it for you.
            </p>
          </div>
        </header>

        {phase === 'display' && mnemonic ? (
          <section className="space-y-6">
            <MnemonicGrid mnemonic={mnemonic} />

            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={handleCopy} className="gap-2">
                <Copy className="h-4 w-4" /> Copy
              </Button>
              <Button variant="secondary" onClick={handleDownload} className="gap-2">
                <Download className="h-4 w-4" /> Download .txt
              </Button>
            </div>

            <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
              <p>
                <strong>Do not</strong> store this in email, cloud notes, or screenshots
                synchronized to third parties. Rivr will never ask for this phrase — anyone who
                asks is trying to steal your account.
              </p>
            </div>

            <div className="flex items-start gap-3">
              <Checkbox
                id="recovery-ack"
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
                className="mt-1"
              />
              <Label htmlFor="recovery-ack" className="text-sm">
                I have written down this 24-word phrase and stored it safely.
              </Label>
            </div>

            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}

            <Button className="w-full" disabled={!acknowledged} onClick={handleProceedToConfirm}>
              I&apos;ve saved it — continue
            </Button>
          </section>
        ) : null}

        {phase === 'confirm' && confirmationIndex && expectedConfirmWord ? (
          <section className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">Confirm your phrase</h2>
              <p className="text-sm text-muted-foreground">
                To make sure you wrote it down correctly, please type word number{' '}
                <strong>{confirmationIndex}</strong> from your recovery phrase.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-word">Word #{confirmationIndex}</Label>
              <Input
                id="confirm-word"
                value={confirmationInput}
                onChange={(e) => setConfirmationInput(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Type the word exactly as shown"
              />
            </div>

            <div className="space-y-3 rounded-lg border bg-muted/40 p-4">
              <div className="flex items-start gap-3">
                <Checkbox
                  id="opt-in-local"
                  checked={optInLocalStash}
                  onCheckedChange={(checked) => setOptInLocalStash(checked === true)}
                  className="mt-1"
                />
                <div className="space-y-1">
                  <Label htmlFor="opt-in-local" className="text-sm font-medium">
                    Also store an encrypted copy on this device (recommended)
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Protected by a passphrase you choose. Only this browser on this device can
                    decrypt it. Without this, the Reveal button in Settings can only show the
                    fingerprint — your written copy will be the only source of truth.
                  </p>
                </div>
              </div>

              {optInLocalStash ? (
                <div className="space-y-2 pl-7">
                  <div className="space-y-1">
                    <Label htmlFor="passphrase" className="text-sm">
                      Passphrase (≥ 8 chars)
                    </Label>
                    <Input
                      id="passphrase"
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      autoComplete="new-password"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="passphrase-repeat" className="text-sm">
                      Confirm passphrase
                    </Label>
                    <Input
                      id="passphrase-repeat"
                      type="password"
                      value={passphraseRepeat}
                      onChange={(e) => setPassphraseRepeat(e.target.value)}
                      autoComplete="new-password"
                    />
                  </div>
                </div>
              ) : null}
            </div>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}

            <Button className="w-full" onClick={handleSubmit}>
              Register recovery key
            </Button>
          </section>
        ) : null}

        {phase === 'storing' ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" /> Registering your recovery key…
          </div>
        ) : null}

        {phase === 'done' ? (
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">Recovery key registered</h2>
            <p className="text-muted-foreground">
              We&apos;ve stored the fingerprint <code>{keyPair?.fingerprint}</code> so we can
              verify you later. Redirecting…
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Renders the mnemonic as a 4x6 numbered grid for readability. */
function MnemonicGrid({ mnemonic }: { mnemonic: string }) {
  const tokens = splitMnemonic(mnemonic);
  return (
    <ol className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-4 md:grid-cols-3">
      {tokens.map(({ index, word }) => (
        <li
          key={index}
          className="flex items-baseline gap-2 rounded-md bg-background px-3 py-2 text-sm"
        >
          <span className="w-6 text-right font-mono text-xs text-muted-foreground">{index}.</span>
          <span className="font-mono tracking-wide">{word}</span>
        </li>
      ))}
    </ol>
  );
}
