"use client";

/**
 * Live avatar overlay -- the "talking picture" mode.
 *
 * Pops a large round MJPEG-animated version of the profile avatar that
 * the user can speak to. Voice goes SpeechRecognition -> the existing
 * /api/autobot/chat lane (same model, tools, and context as text chat),
 * and the reply comes back as speech: Chatterbox clone audio when
 * available (mouth driven by the real audio envelope server-side), or
 * browser speechSynthesis with text-timed mouth motion as fallback.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Crosshair, ImageUp, Loader2, Mic, MicOff, Send, Wand2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { stripMarkdownForSpeech } from "@/lib/speech-text";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 4000;

const SESSION_URL = "/api/autobot/live-avatar/session";
const SPEAK_URL = "/api/autobot/live-avatar/speak";
const STOP_URL = "/api/autobot/live-avatar/stop";
const CHAT_URL = "/api/autobot/chat";
const PORTRAIT_UPLOAD_URL = "/api/autobot/digital-twin/upload";
const CALIBRATION_URL = "/api/autobot/live-avatar/calibration";
const BAKE_URL = "/api/autobot/live-avatar/bake";
const GPU_URL = "/api/autobot/gpu";

const CALIBRATION_STEPS = ["mouth", "leftEye", "rightEye"] as const;
type CalibrationStep = (typeof CALIBRATION_STEPS)[number];
const CALIBRATION_PROMPT: Record<CalibrationStep, string> = {
  mouth: "Tap the mouth",
  leftEye: "Tap the LEFT eye (their left, your right)",
  rightEye: "Tap the RIGHT eye",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OverlayPhase =
  | "connecting"
  | "listening"
  | "muted"
  | "thinking"
  | "speaking"
  | "error";

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

interface LiveAvatarOverlayProps {
  personaName: string;
  personaId?: string;
  onClose: () => void;
  /** Mirror the voice conversation back into the widget's text thread. */
  onExchange?: (userText: string, assistantText: string) => void;
}

const PHASE_LABEL: Record<OverlayPhase, string> = {
  connecting: "Waking up…",
  listening: "Listening — just talk",
  muted: "Mic muted",
  thinking: "Thinking…",
  speaking: "Speaking…",
  error: "Something went wrong",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LiveAvatarOverlay({
  personaName,
  personaId,
  onClose,
  onExchange,
}: LiveAvatarOverlayProps) {
  const [phase, setPhase] = useState<OverlayPhase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [streamPath, setStreamPath] = useState<string | null>(null);
  const [micSupported, setMicSupported] = useState(true);
  const [micMuted, setMicMuted] = useState(false);
  const [lastHeard, setLastHeard] = useState("");
  const [lastReply, setLastReply] = useState("");
  const [typedInput, setTypedInput] = useState("");
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [uploadingPortrait, setUploadingPortrait] = useState(false);
  const [faceDetected, setFaceDetected] = useState<boolean | null>(null);
  const [hasVisemePack, setHasVisemePack] = useState(false);
  const [calibrationStep, setCalibrationStep] = useState<CalibrationStep | null>(null);
  const [baking, setBaking] = useState(false);
  const [bakeNotice, setBakeNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const calibrationPointsRef = useRef<Partial<Record<CalibrationStep, [number, number]>>>({});
  const streamImgRef = useRef<HTMLImageElement>(null);

  const sessionIdRef = useRef<string | null>(null);
  const historyRef = useRef<HistoryMessage[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const phaseRef = useRef<OverlayPhase>("connecting");
  const closedRef = useRef(false);

  phaseRef.current = phase;

  const setPhaseSafe = useCallback((next: OverlayPhase) => {
    if (!closedRef.current) setPhase(next);
  }, []);

  // -- Audio teardown helpers ------------------------------------------------

  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    if (typeof window !== "undefined") {
      window.speechSynthesis?.cancel();
    }
  }, []);

  const bargeIn = useCallback(() => {
    stopPlayback();
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      void fetch(STOP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {});
    }
  }, [stopPlayback]);

  // -- Conversation loop -----------------------------------------------------

  const handleUserUtterance = useCallback(
    async (rawText: string) => {
      const text = rawText.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!text || closedRef.current) return;
      if (phaseRef.current === "thinking") return; // one turn at a time

      if (phaseRef.current === "speaking") bargeIn();

      setLastHeard(text);
      setLastReply("");
      setPhaseSafe("thinking");

      try {
        const history = historyRef.current.slice(-MAX_HISTORY_MESSAGES);
        const chatResponse = await fetch(CHAT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, history, personaId, personaName }),
        });
        const chatData: { reply?: string; error?: string } =
          await chatResponse.json();
        if (!chatResponse.ok || chatData.error || !chatData.reply) {
          throw new Error(chatData.error || `Chat failed (${chatResponse.status})`);
        }

        const reply = chatData.reply;
        historyRef.current = [
          ...historyRef.current.slice(-MAX_HISTORY_MESSAGES + 2),
          { role: "user", content: text },
          { role: "assistant", content: reply },
        ];
        setLastReply(reply);
        onExchange?.(text, reply);
        if (closedRef.current) return;

        const speechText = stripMarkdownForSpeech(reply);
        if (!speechText) {
          setPhaseSafe(micMuted ? "muted" : "listening");
          return;
        }

        setPhaseSafe("speaking");
        const sessionId = sessionIdRef.current;
        const speakResponse = sessionId
          ? await fetch(SPEAK_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId, text: speechText }),
            })
          : null;
        const speakData: {
          mode?: "clone" | "browser";
          audioBase64?: string;
          mimeType?: string;
          error?: string;
        } | null = speakResponse ? await speakResponse.json() : null;

        const onSpeechDone = () => {
          // Small settle delay so the speaker tail fades before the mic
          // rearms — otherwise recognition catches the last word of the
          // avatar's own reply.
          setTimeout(() => {
            if (!closedRef.current && phaseRef.current === "speaking") {
              setPhaseSafe(micMuted ? "muted" : "listening");
            }
          }, 500);
        };

        if (
          speakResponse?.ok &&
          speakData?.mode === "clone" &&
          speakData.audioBase64
        ) {
          const binary = atob(speakData.audioBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
          }
          const blob = new Blob([bytes], {
            type: speakData.mimeType || "audio/wav",
          });
          const url = URL.createObjectURL(blob);
          audioUrlRef.current = url;
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended = () => {
            stopPlayback();
            onSpeechDone();
          };
          await audio.play().catch(() => {
            stopPlayback();
            onSpeechDone();
          });
        } else if (typeof window !== "undefined" && window.speechSynthesis) {
          // Browser-voice fallback (worker already runs text-timed mouth).
          const utterance = new SpeechSynthesisUtterance(speechText);
          utterance.onend = onSpeechDone;
          utterance.onerror = onSpeechDone;
          window.speechSynthesis.speak(utterance);
        } else {
          onSpeechDone();
        }
      } catch (err) {
        if (closedRef.current) return;
        setError(err instanceof Error ? err.message : "Conversation failed");
        setPhaseSafe("error");
      }
    },
    [bargeIn, micMuted, onExchange, personaId, personaName, setPhaseSafe, stopPlayback],
  );

  const utteranceRef = useRef(handleUserUtterance);
  utteranceRef.current = handleUserUtterance;

  // -- Session lifecycle -----------------------------------------------------

  useEffect(() => {
    closedRef.current = false;
    let cancelled = false;

    // Best-effort warm-up of the voice GPU (clone lane) — harmless 400
    // when no Vast key is configured.
    if (sessionEpoch === 0 && !personaId) {
      void fetch(GPU_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      }).catch(() => {});
    }

    (async () => {
      try {
        const response = await fetch(SESSION_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personaId }),
        });
        const data: {
          sessionId?: string;
          streamPath?: string;
          faceDetected?: boolean;
          hasVisemePack?: boolean;
          error?: string;
        } = await response.json();
        if (cancelled) return;
        if (!response.ok || !data.sessionId || !data.streamPath) {
          setError(data.error || `Could not start live avatar (${response.status})`);
          setPhase("error");
          return;
        }
        sessionIdRef.current = data.sessionId;
        setStreamPath(data.streamPath);
        setFaceDetected(data.faceDetected ?? null);
        setHasVisemePack(data.hasVisemePack === true);
        setPhase("listening");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not start live avatar");
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
      closedRef.current = true;
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sessionId) {
        void fetch(SESSION_URL, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        }).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaId, sessionEpoch]);

  // Stop playback on unmount (separate effect so it runs last).
  useEffect(() => stopPlayback, [stopPlayback]);

  // -- Microphone (SpeechRecognition) ----------------------------------------

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognitionImpl: any =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionImpl) {
      setMicSupported(false);
      return undefined;
    }
    // Recognition runs ONLY while genuinely listening. Keeping it on while
    // the avatar speaks makes it hear ITSELF through the speakers and
    // barge-in on (or even answer) its own voice.
    if (micMuted || phase !== "listening") {
      recognitionRef.current?.stop?.();
      recognitionRef.current = null;
      return undefined;
    }
    if (recognitionRef.current) return undefined;

    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (event: any) => {
      // Recognition only runs while listening (see the gate above), so
      // anything final here is genuinely the user.
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result.isFinal) continue;
        const transcript = String(result[0]?.transcript || "").trim();
        if (transcript) void utteranceRef.current(transcript);
      }
    };
    recognition.onend = () => {
      recognitionRef.current = null;
    };
    recognition.onerror = () => {
      /* onend fires next and clears the ref; a fresh effect run restarts */
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
    } catch {
      setMicSupported(false);
    }

    return () => {
      recognition.stop?.();
      if (recognitionRef.current === recognition) recognitionRef.current = null;
    };
  }, [micMuted, phase]);

  // -- Alternative avatar picture upload -------------------------------------

  const handlePortraitUpload = useCallback(
    async (file: File) => {
      setUploadingPortrait(true);
      setError(null);
      try {
        const form = new FormData();
        form.append("kind", "reference-portrait");
        form.append("file", file);
        const response = await fetch(PORTRAIT_UPLOAD_URL, {
          method: "POST",
          body: form,
        });
        const data: { error?: string } = await response.json();
        if (!response.ok || data.error) {
          throw new Error(data.error || `Upload failed (${response.status})`);
        }
        // Restart the session so the stream animates the new picture.
        stopPlayback();
        setStreamPath(null);
        setPhase("connecting");
        setSessionEpoch((epoch) => epoch + 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploadingPortrait(false);
      }
    },
    [stopPlayback],
  );

  // -- Tap-to-calibrate (portraits that defeat face detection) ---------------

  const handleCalibrationTap = useCallback(
    (event: React.MouseEvent<HTMLImageElement>) => {
      if (!calibrationStep) return;
      const img = streamImgRef.current;
      if (!img) return;
      const rect = img.getBoundingClientRect();

      // During calibration the image renders object-contain: map the tap
      // into the letterboxed content region to get true image coordinates.
      const naturalW = img.naturalWidth || rect.width;
      const naturalH = img.naturalHeight || rect.height;
      const scale = Math.min(rect.width / naturalW, rect.height / naturalH);
      const contentW = naturalW * scale;
      const contentH = naturalH * scale;
      const offsetX = rect.left + (rect.width - contentW) / 2;
      const offsetY = rect.top + (rect.height - contentH) / 2;
      const x = Math.min(1, Math.max(0, (event.clientX - offsetX) / contentW));
      const y = Math.min(1, Math.max(0, (event.clientY - offsetY) / contentH));

      calibrationPointsRef.current[calibrationStep] = [x, y];
      const nextIndex = CALIBRATION_STEPS.indexOf(calibrationStep) + 1;
      if (nextIndex < CALIBRATION_STEPS.length) {
        setCalibrationStep(CALIBRATION_STEPS[nextIndex]);
        return;
      }

      setCalibrationStep(null);
      const points = calibrationPointsRef.current;
      calibrationPointsRef.current = {};
      void (async () => {
        try {
          const response = await fetch(CALIBRATION_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(points),
          });
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `Calibration failed (${response.status})`);
          }
          stopPlayback();
          setStreamPath(null);
          setPhase("connecting");
          setSessionEpoch((epoch) => epoch + 1);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Calibration failed");
        }
      })();
    },
    [calibrationStep, stopPlayback],
  );

  // -- Viseme-pack bake (photoreal mouth shapes; one-time GPU job) -----------

  const handleBake = useCallback(async () => {
    setBaking(true);
    setBakeNotice(null);
    setError(null);
    try {
      const response = await fetch(BAKE_URL, { method: "POST" });
      const data: { ok?: boolean; error?: string; needGpu?: boolean } =
        await response.json();
      if (response.status === 409 && data.needGpu) {
        void fetch(GPU_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start" }),
        }).catch(() => {});
        setBakeNotice(
          "Starting your voice GPU — give it a few minutes, then tap the wand again.",
        );
        return;
      }
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `Bake failed (${response.status})`);
      }
      setBakeNotice("Mouth shapes baked — restarting with the new pack.");
      stopPlayback();
      setStreamPath(null);
      setPhase("connecting");
      setSessionEpoch((epoch) => epoch + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bake failed");
    } finally {
      setBaking(false);
    }
  }, [stopPlayback]);

  // -- UI --------------------------------------------------------------------

  const submitTyped = useCallback(() => {
    const text = typedInput.trim();
    if (!text) return;
    setTypedInput("");
    void handleUserUtterance(text);
  }, [handleUserUtterance, typedInput]);

  const ringClass =
    phase === "speaking"
      ? "ring-4 ring-emerald-400/80 animate-pulse"
      : phase === "thinking"
        ? "ring-4 ring-amber-400/70 animate-pulse"
        : phase === "listening"
          ? "ring-4 ring-sky-400/70"
          : "ring-2 ring-border";

  return (
    <div className="fixed inset-0 z-[130] flex flex-col items-center justify-center bg-background/90 backdrop-blur-md p-6">
      {/* Close */}
      <Button
        variant="ghost"
        size="icon"
        onClick={onClose}
        className="absolute top-4 right-4 h-10 w-10"
        title="Close live avatar"
      >
        <X className="h-5 w-5" />
      </Button>

      {/* The big round talking picture */}
      <div
        className={cn(
          "relative rounded-full overflow-hidden shadow-2xl transition-all",
          "h-[min(70vw,320px)] w-[min(70vw,320px)]",
          ringClass,
        )}
      >
        {streamPath ? (
          // MJPEG streams can't go through next/image -- plain img is required.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={streamImgRef}
            src={streamPath}
            alt={`${personaName} live avatar`}
            onClick={handleCalibrationTap}
            className={cn(
              "h-full w-full",
              calibrationStep
                ? "object-contain cursor-crosshair bg-black"
                : "object-cover",
            )}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-muted">
            <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
          </div>
        )}
        {calibrationStep ? (
          <div className="absolute inset-x-0 top-0 bg-background/85 px-3 py-2 text-center text-xs font-medium">
            {CALIBRATION_PROMPT[calibrationStep]}
          </div>
        ) : null}
      </div>

      {/* Identity + status */}
      <p className="mt-5 text-lg font-semibold">{personaName}</p>
      <p
        className={cn(
          "mt-1 text-sm",
          phase === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {phase === "error" && error ? error : PHASE_LABEL[phase]}
      </p>

      {/* Last exchange */}
      <div className="mt-4 max-w-md w-full space-y-1 text-center min-h-[3rem]">
        {lastHeard ? (
          <p className="text-xs text-muted-foreground truncate">
            You: {lastHeard}
          </p>
        ) : null}
        {lastReply ? (
          <p className="text-sm line-clamp-3">{lastReply}</p>
        ) : null}
      </div>

      {/* Controls */}
      <div className="mt-5 flex items-center gap-3">
        {!personaId ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void handlePortraitUpload(file);
              }}
            />
            <Button
              variant="secondary"
              size="icon"
              className="h-12 w-12 rounded-full"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingPortrait || phase === "connecting"}
              title="Use a different picture for the live avatar"
            >
              {uploadingPortrait ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <ImageUp className="h-5 w-5" />
              )}
            </Button>
            {faceDetected === false && !hasVisemePack ? (
              <Button
                variant="secondary"
                size="icon"
                className="h-12 w-12 rounded-full"
                onClick={() => {
                  calibrationPointsRef.current = {};
                  setCalibrationStep(calibrationStep ? null : "mouth");
                }}
                disabled={phase === "connecting"}
                title="Fix the mouth position (tap to place mouth and eyes)"
              >
                <Crosshair className={cn("h-5 w-5", calibrationStep && "text-emerald-500")} />
              </Button>
            ) : null}
            {!hasVisemePack ? (
              <Button
                variant="secondary"
                size="icon"
                className="h-12 w-12 rounded-full"
                onClick={() => void handleBake()}
                disabled={baking || phase === "connecting"}
                title="Bake real mouth shapes for this picture (one-time, uses your GPU)"
              >
                {baking ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Wand2 className="h-5 w-5" />
                )}
              </Button>
            ) : null}
          </>
        ) : null}
        {micSupported ? (
          <Button
            variant={micMuted ? "secondary" : "default"}
            size="icon"
            className="h-12 w-12 rounded-full"
            onClick={() => {
              setMicMuted((muted) => {
                const next = !muted;
                if (phaseRef.current === "listening" || phaseRef.current === "muted") {
                  setPhase(next ? "muted" : "listening");
                }
                return next;
              });
            }}
            title={micMuted ? "Unmute microphone" : "Mute microphone"}
          >
            {micMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </Button>
        ) : null}
      </div>

      {bakeNotice ? (
        <p className="mt-2 max-w-sm text-center text-xs text-muted-foreground">
          {bakeNotice}
        </p>
      ) : null}

      {/* Typed fallback (also the lane for browsers without SpeechRecognition) */}
      <div className="mt-4 flex w-full max-w-sm items-center gap-2">
        <Input
          value={typedInput}
          onChange={(event) => setTypedInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submitTyped();
            }
          }}
          placeholder={
            micSupported ? "…or type instead" : "Voice input unavailable — type here"
          }
          maxLength={MAX_MESSAGE_LENGTH}
          className="flex-1 text-sm"
          disabled={phase === "connecting" || phase === "error"}
        />
        <Button
          size="icon"
          className="h-9 w-9 flex-shrink-0"
          onClick={submitTyped}
          disabled={
            typedInput.trim().length === 0 ||
            phase === "connecting" ||
            phase === "error" ||
            phase === "thinking"
          }
          title="Send"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
