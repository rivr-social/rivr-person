"use client";

/**
 * Recovery Seed settings panel.
 *
 * Renders inside Settings → Security on sovereign instances. Supports:
 *
 * - Reveal (#13): fresh email/phone MFA → show mnemonic (if encrypted local
 *   stash exists and the user supplies the right passphrase) OR a clear
 *   "not retrievable from this device; use your written copy" message.
 * - Rotate (#14): fresh MFA → generate a new mnemonic client-side, ask the
 *   user to save the new phrase + word-N confirm → POST the new public key
 *   to `/api/recovery/rotate`.
 *
 * Hosted-federated instances render null — seed phrases do not exist there.
 *
 * Security invariants:
 * - The plaintext mnemonic never leaves the browser.
 * - The reveal token is the only value passed across fetch boundaries;
 *   it is one-shot and expires in minutes.
 * - On rotation, the old key is archived server-side in
 *   `retired_recovery_keys` before the new key replaces it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  Lock,
  RefreshCcw,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  generateRecoveryMnemonic,
  mnemonicToRecoveryKeyPair,
  pickMnemonicConfirmationIndex,
  splitMnemonic,
  validateRecoveryMnemonic,
  type RecoveryKeyPair,
} from '@/lib/recovery-seed';
import {
  RecoverySeedLocalStoreError,
  decryptMnemonic,
  loadEncryptedMnemonicBlob,
  storeEncryptedMnemonic,
} from '@/lib/recovery-seed-local-store';

interface RecoveryStatus {
  instanceMode: 'sovereign' | 'hosted-federated';
  sovereignMode: boolean;
  registered: boolean;
  fingerprint: string | null;
  createdAt: string | null;
  rotatedAt: string | null;
}

type Mode = 'idle' | 'reveal' | 'rotate';

type ChallengeState =
  | { phase: 'not-started' }
  | { phase: 'sending'; method: 'email' | 'sms' }
  | {
      phase: 'sent';
      challengeId: string;
      method: 'email' | 'sms';
      expiresAt: string;
      codeTtlMs: number;
    }
  | { phase: 'verifying' }
  | {
      phase: 'verified';
      revealToken: string;
      revealTokenExpiresAt: string;
      method: 'email' | 'sms';
    }
  | { phase: 'error'; error: string };

export function RecoverySeedPanel() {
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [challenge, setChallenge] = useState<ChallengeState>({ phase: 'not-started' });
  const [code, setCode] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [revealedMnemonic, setRevealedMnemonic] = useState<string | null>(null);
  const [revealSource, setRevealSource] = useState<'displayed' | 'local_decrypted' | null>(null);
  const [rotateMnemonic, setRotateMnemonic] = useState<string | null>(null);
  const [rotateKeyPair, setRotateKeyPair] = useState<RecoveryKeyPair | null>(null);
  const [rotateConfirmWord, setRotateConfirmWord] = useState('');
  const [rotateNewPassphrase, setRotateNewPassphrase] = useState('');
  const [rotateNewPassphraseRepeat, setRotateNewPassphraseRepeat] = useState('');
  const [rotateOptInLocalStash, setRotateOptInLocalStash] = useState(true);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch status on mount + whenever we complete a rotate.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/recovery/status', { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load recovery status');
        const data = (await res.json()) as RecoveryStatus;
        if (!cancelled) setStatus(data);
      } catch (err) {
        if (!cancelled) setStatusError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const resetTransientState = useCallback(() => {
    setChallenge({ phase: 'not-started' });
    setCode('');
    setPassphrase('');
    setRevealedMnemonic(null);
    setRevealSource(null);
    setRotateMnemonic(null);
    setRotateKeyPair(null);
    setRotateConfirmWord('');
    setRotateNewPassphrase('');
    setRotateNewPassphraseRepeat('');
    setInfo(null);
    setError(null);
  }, []);

  const enter = useCallback(
    (next: Mode) => {
      resetTransientState();
      setMode(next);
    },
    [resetTransientState],
  );

  // Challenge request shared by reveal + rotate.
  const requestChallenge = useCallback(async (method: 'email' | 'sms') => {
    setError(null);
    setChallenge({ phase: 'sending', method });
    try {
      const res = await fetch('/api/recovery/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method }),
      });
      const payload = (await res.json()) as
        | {
            ok: true;
            challengeId: string;
            method: 'email' | 'sms';
            expiresAt: string;
            codeTtlMs: number;
          }
        | { ok: false; error: string; message: string };
      if (!('ok' in payload) || !payload.ok) {
        throw new Error((payload as { message?: string }).message ?? 'Challenge failed.');
      }
      setChallenge({
        phase: 'sent',
        challengeId: payload.challengeId,
        method: payload.method,
        expiresAt: payload.expiresAt,
        codeTtlMs: payload.codeTtlMs,
      });
    } catch (err) {
      setChallenge({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  const submitCode = useCallback(async () => {
    if (challenge.phase !== 'sent') return;
    setError(null);
    setChallenge({ phase: 'verifying' });
    try {
      const res = await fetch('/api/recovery/verify-challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: challenge.challengeId, code: code.trim() }),
      });
      const payload = (await res.json()) as
        | {
            ok: true;
            revealToken: string;
            revealTokenExpiresAt: string;
            method: 'email' | 'sms';
          }
        | { ok: false; error: string; message: string; attemptsRemaining?: number };

      if (!('ok' in payload) || !payload.ok) {
        const msg =
          (payload as { message?: string; attemptsRemaining?: number }).message ??
          'Verification failed.';
        const remaining = (payload as { attemptsRemaining?: number }).attemptsRemaining;
        throw new Error(
          remaining !== undefined ? `${msg} (${remaining} attempts left)` : msg,
        );
      }

      setChallenge({
        phase: 'verified',
        revealToken: payload.revealToken,
        revealTokenExpiresAt: payload.revealTokenExpiresAt,
        method: payload.method,
      });
    } catch (err) {
      setChallenge({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }, [challenge, code]);

  // -------------------------------------------------------------------
  // Reveal flow
  // -------------------------------------------------------------------
  const tryLocalDecrypt = useCallback(async () => {
    if (challenge.phase !== 'verified') return;
    setError(null);
    setInfo(null);
    const blob = loadEncryptedMnemonicBlob();
    if (!blob) {
      setRevealedMnemonic(null);
      setRevealSource('displayed');
      setInfo(
        'No encrypted copy of your recovery phrase is stored in this browser. ' +
          'Use your written copy as the source of truth, or rotate the seed to generate a new one.',
      );
      // Even when we have nothing to show, log the reveal attempt (method=displayed noop).
      void fetch('/api/recovery/audit-reveal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revealToken: challenge.revealToken, source: 'displayed' }),
      });
      return;
    }
    try {
      const plain = await decryptMnemonic(passphrase);
      if (!validateRecoveryMnemonic(plain)) {
        throw new RecoverySeedLocalStoreError('malformed', 'Decrypted mnemonic failed validation.');
      }
      setRevealedMnemonic(plain);
      setRevealSource('local_decrypted');
      void fetch('/api/recovery/audit-reveal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revealToken: challenge.revealToken, source: 'local_decrypted' }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to decrypt.');
    }
  }, [challenge, passphrase]);

  // -------------------------------------------------------------------
  // Rotate flow
  // -------------------------------------------------------------------
  const beginRotateGeneration = useCallback(async () => {
    setError(null);
    try {
      const m = generateRecoveryMnemonic();
      const kp = await mnemonicToRecoveryKeyPair(m);
      setRotateMnemonic(m);
      setRotateKeyPair(kp);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate new mnemonic.');
    }
  }, []);

  const rotateConfirmationIndex = useMemo(
    () => (rotateMnemonic ? pickMnemonicConfirmationIndex(rotateMnemonic) : null),
    [rotateMnemonic],
  );
  const rotateExpectedConfirmWord = useMemo(() => {
    if (!rotateMnemonic || !rotateConfirmationIndex) return null;
    return splitMnemonic(rotateMnemonic)[rotateConfirmationIndex - 1]?.word ?? null;
  }, [rotateMnemonic, rotateConfirmationIndex]);

  const submitRotate = useCallback(async () => {
    if (challenge.phase !== 'verified' || !rotateMnemonic || !rotateKeyPair) return;
    if (!rotateConfirmationIndex || !rotateExpectedConfirmWord) return;
    setError(null);
    if (
      rotateConfirmWord.trim().toLowerCase() !==
      rotateExpectedConfirmWord.toLowerCase()
    ) {
      setError(`Word ${rotateConfirmationIndex} does not match.`);
      return;
    }
    if (rotateOptInLocalStash) {
      if (rotateNewPassphrase.length < 8) {
        setError('Passphrase must be at least 8 characters.');
        return;
      }
      if (rotateNewPassphrase !== rotateNewPassphraseRepeat) {
        setError('Passphrases do not match.');
        return;
      }
    }

    try {
      const res = await fetch('/api/recovery/rotate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revealToken: challenge.revealToken,
          publicKeyHex: rotateKeyPair.publicKeyHex,
          fingerprint: rotateKeyPair.fingerprint,
          algorithm: rotateKeyPair.algorithm,
        }),
      });
      const payload = (await res.json()) as
        | { ok: true; fingerprint: string; rotatedAt: string }
        | { ok: false; error: string; message: string };
      if (!('ok' in payload) || !payload.ok) {
        throw new Error((payload as { message?: string }).message ?? 'Rotation failed.');
      }

      if (rotateOptInLocalStash) {
        await storeEncryptedMnemonic(
          rotateMnemonic,
          rotateNewPassphrase,
          rotateKeyPair.fingerprint,
        );
      }

      // Refresh status to show new fingerprint + rotated-at.
      const statusRes = await fetch('/api/recovery/status', { cache: 'no-store' });
      if (statusRes.ok) setStatus((await statusRes.json()) as RecoveryStatus);

      setInfo(
        `Recovery key rotated. New fingerprint: ${payload.fingerprint}. Your old recovery phrase is no longer valid.`,
      );
      enter('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [
    challenge,
    rotateMnemonic,
    rotateKeyPair,
    rotateConfirmationIndex,
    rotateExpectedConfirmWord,
    rotateConfirmWord,
    rotateOptInLocalStash,
    rotateNewPassphrase,
    rotateNewPassphraseRepeat,
    enter,
  ]);

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------
  if (statusError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-destructive" /> Recovery Seed
          </CardTitle>
          <CardDescription>{statusError}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (!status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Loader2 className="h-5 w-5 animate-spin" /> Recovery Seed
          </CardTitle>
        </CardHeader>
      </Card>
    );
  }
  if (!status.sovereignMode) {
    // Hosted-federated: suppress the UI entirely.
    return null;
  }
  if (!status.registered) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" /> Recovery Seed
          </CardTitle>
          <CardDescription>
            No recovery key is registered on this account yet. Complete sovereign signup to
            generate one.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" /> Recovery Seed
        </CardTitle>
        <CardDescription>
          Your recovery phrase lets you restore this account on a new device. Reveal and rotate
          are gated by a fresh email or phone verification.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="secondary" className="gap-1">
            <Lock className="h-3.5 w-3.5" />
            Fingerprint
          </Badge>
          <code className="font-mono">{status.fingerprint}</code>
          {status.rotatedAt ? (
            <span className="text-muted-foreground">
              Last rotated {new Date(status.rotatedAt).toLocaleDateString()}
            </span>
          ) : status.createdAt ? (
            <span className="text-muted-foreground">
              Created {new Date(status.createdAt).toLocaleDateString()}
            </span>
          ) : null}
        </div>

        {info ? <p className="text-sm text-emerald-700">{info}</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {mode === 'idle' ? (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => enter('reveal')} variant="secondary">
              Reveal seed phrase
            </Button>
            <Button
              onClick={() => {
                enter('rotate');
                void beginRotateGeneration();
              }}
              variant="outline"
              className="gap-2"
            >
              <RefreshCcw className="h-4 w-4" /> Rotate recovery seed
            </Button>
          </div>
        ) : null}

        {mode !== 'idle' ? (
          <ChallengeStep
            challenge={challenge}
            code={code}
            setCode={setCode}
            onRequest={requestChallenge}
            onSubmit={submitCode}
            onCancel={() => enter('idle')}
          />
        ) : null}

        {mode === 'reveal' && challenge.phase === 'verified' ? (
          <RevealStep
            passphrase={passphrase}
            setPassphrase={setPassphrase}
            onDecrypt={tryLocalDecrypt}
            revealedMnemonic={revealedMnemonic}
            revealSource={revealSource}
            onDone={() => enter('idle')}
          />
        ) : null}

        {mode === 'rotate' && challenge.phase === 'verified' ? (
          <RotateStep
            mnemonic={rotateMnemonic}
            keyPair={rotateKeyPair}
            confirmIndex={rotateConfirmationIndex}
            confirmInput={rotateConfirmWord}
            setConfirmInput={setRotateConfirmWord}
            optInLocalStash={rotateOptInLocalStash}
            setOptInLocalStash={setRotateOptInLocalStash}
            passphrase={rotateNewPassphrase}
            setPassphrase={setRotateNewPassphrase}
            passphraseRepeat={rotateNewPassphraseRepeat}
            setPassphraseRepeat={setRotateNewPassphraseRepeat}
            onSubmit={submitRotate}
            onCancel={() => enter('idle')}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ChallengeStep(props: {
  challenge: ChallengeState;
  code: string;
  setCode: (v: string) => void;
  onRequest: (method: 'email' | 'sms') => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { challenge, code, setCode, onRequest, onSubmit, onCancel } = props;

  if (challenge.phase === 'not-started' || challenge.phase === 'error') {
    return (
      <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
        <p className="text-sm text-muted-foreground">
          We&apos;ll send a verification code to confirm it&apos;s you. Pick a channel:
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onRequest('email')}>
            Email me a code
          </Button>
          <Button size="sm" variant="outline" onClick={() => onRequest('sms')}>
            Text me a code (if configured)
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {challenge.phase === 'error' ? (
          <p className="text-sm text-destructive">{challenge.error}</p>
        ) : null}
      </div>
    );
  }

  if (challenge.phase === 'sending' || challenge.phase === 'verifying') {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {challenge.phase === 'sending' ? 'Sending code…' : 'Verifying code…'}
      </div>
    );
  }

  if (challenge.phase === 'sent') {
    return (
      <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
        <Label htmlFor="mfa-code">
          Enter the 6-digit code we sent via {challenge.method === 'email' ? 'email' : 'SMS'}
        </Label>
        <Input
          id="mfa-code"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="123456"
        />
        <div className="flex gap-2">
          <Button size="sm" onClick={onSubmit} disabled={code.trim().length < 4}>
            Verify
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return null;
}

function RevealStep(props: {
  passphrase: string;
  setPassphrase: (v: string) => void;
  onDecrypt: () => void;
  revealedMnemonic: string | null;
  revealSource: 'displayed' | 'local_decrypted' | null;
  onDone: () => void;
}) {
  const { passphrase, setPassphrase, onDecrypt, revealedMnemonic, revealSource, onDone } = props;
  const handleCopy = useCallback(async () => {
    if (!revealedMnemonic) return;
    try {
      await navigator.clipboard.writeText(revealedMnemonic);
    } catch {
      /* fall through — user can select and copy manually */
    }
  }, [revealedMnemonic]);

  if (revealedMnemonic && revealSource === 'local_decrypted') {
    return (
      <div className="space-y-3 rounded-lg border bg-muted/40 p-4">
        <p className="text-sm flex items-center gap-2 text-emerald-700">
          <CheckCircle2 className="h-4 w-4" /> Recovery phrase decrypted from this device.
        </p>
        <ol className="grid grid-cols-2 gap-2 md:grid-cols-3">
          {splitMnemonic(revealedMnemonic).map(({ index, word }) => (
            <li
              key={index}
              className="flex items-baseline gap-2 rounded-md bg-background px-3 py-2 text-sm"
            >
              <span className="w-6 text-right font-mono text-xs text-muted-foreground">
                {index}.
              </span>
              <span className="font-mono">{word}</span>
            </li>
          ))}
        </ol>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={handleCopy} className="gap-1.5">
            <Copy className="h-4 w-4" /> Copy
          </Button>
          <Button size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
      <p className="text-sm text-muted-foreground">
        Unlock the encrypted copy of your recovery phrase stored in this browser. If you have not
        stashed a copy on this device, the Reveal button can only confirm the fingerprint — use
        your written copy as the source of truth.
      </p>
      <Label htmlFor="reveal-passphrase">Device passphrase</Label>
      <Input
        id="reveal-passphrase"
        type="password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        autoComplete="current-password"
      />
      <Button size="sm" onClick={onDecrypt}>
        Decrypt on this device
      </Button>
    </div>
  );
}

function RotateStep(props: {
  mnemonic: string | null;
  keyPair: RecoveryKeyPair | null;
  confirmIndex: number | null;
  confirmInput: string;
  setConfirmInput: (v: string) => void;
  optInLocalStash: boolean;
  setOptInLocalStash: (v: boolean) => void;
  passphrase: string;
  setPassphrase: (v: string) => void;
  passphraseRepeat: string;
  setPassphraseRepeat: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const {
    mnemonic,
    keyPair,
    confirmIndex,
    confirmInput,
    setConfirmInput,
    optInLocalStash,
    setOptInLocalStash,
    passphrase,
    setPassphrase,
    passphraseRepeat,
    setPassphraseRepeat,
    onSubmit,
    onCancel,
  } = props;

  if (!mnemonic || !keyPair) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Generating a new recovery phrase…
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
      <div>
        <p className="text-sm font-medium">Write down your new recovery phrase</p>
        <p className="text-xs text-muted-foreground">
          This replaces the previous phrase the next time you complete the rotation. Do not reuse
          storage locations that may still hold the old phrase.
        </p>
      </div>

      <ol className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {splitMnemonic(mnemonic).map(({ index, word }) => (
          <li
            key={index}
            className="flex items-baseline gap-2 rounded-md bg-background px-3 py-2 text-sm"
          >
            <span className="w-6 text-right font-mono text-xs text-muted-foreground">
              {index}.
            </span>
            <span className="font-mono">{word}</span>
          </li>
        ))}
      </ol>

      <div>
        <Label htmlFor="rotate-confirm-word">
          Confirm word #{confirmIndex}
        </Label>
        <Input
          id="rotate-confirm-word"
          value={confirmInput}
          onChange={(e) => setConfirmInput(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>

      <div className="space-y-3 rounded-lg border bg-background p-4">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={optInLocalStash}
            onChange={(e) => setOptInLocalStash(e.target.checked)}
          />
          <span>
            Also store an encrypted copy of the new phrase on this device (recommended). Protected
            by a passphrase you choose. Only this browser on this device can decrypt it.
          </span>
        </label>
        {optInLocalStash ? (
          <div className="space-y-2">
            <Label htmlFor="rotate-new-passphrase">New device passphrase</Label>
            <Input
              id="rotate-new-passphrase"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="new-password"
            />
            <Label htmlFor="rotate-new-passphrase-repeat">Confirm passphrase</Label>
            <Input
              id="rotate-new-passphrase-repeat"
              type="password"
              value={passphraseRepeat}
              onChange={(e) => setPassphraseRepeat(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        ) : null}
      </div>

      <div className="flex gap-2">
        <Button onClick={onSubmit}>Complete rotation</Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
