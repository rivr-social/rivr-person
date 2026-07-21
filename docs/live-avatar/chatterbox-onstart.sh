#!/bin/bash
# PROVEN working Vast onstart for the cloned-voice GPU box (2026-07-21).
#
# This is the EXACT sequence that produced Cameron's working box, CORRECTED
# for the one restart bug the original had (unconditional `git clone` →
# clonefail on the 2nd boot). It is the reference the app's
# `buildOnstartScript` (src/lib/chatterbox/worker-source.ts) must generate
# verbatim, with $VOICE_SAMPLE_URL substituted per user.
#
# Runs the MAINTAINED devnen/Chatterbox-TTS-Server (installs chatterbox with
# --no-deps + a locked dep set — the thing that avoids the whole dependency
# avalanche). Server listens on 8004; /tts clone shape; no auth; /docs=ready.
#
# The Vast instance MUST be created with runtype "ssh_proxy" (NOT "onstart" —
# an invalid runtype makes the host fail container creation) and env
# "-p 8004:8004".
set -x
exec >> /workspace/onstart.log 2>&1
apt-get update -y && apt-get install -y git ffmpeg libgl1 libglib2.0-0 curl

# --- Install ONCE; resume-safe (a box stopped mid-install resumes on restart,
#     and a restart does NOT re-clone into a non-empty dir and die) ---
if [ ! -f /workspace/cbx/.ready ]; then
  [ -d /workspace/cbx ] || git clone --depth 1 https://github.com/devnen/Chatterbox-TTS-Server /workspace/cbx
  cd /workspace/cbx
  # Their locked CUDA-12.1 torch + explicit deps; chatterbox itself --no-deps.
  pip install --no-cache-dir -r requirements-nvidia.txt && \
  pip install --no-cache-dir --no-deps git+https://github.com/devnen/chatterbox-v2.git@master s3tokenizer==0.3.0 onnx==1.16.0 && \
  pip install --no-cache-dir "protobuf>=4.25.3,<5" && \
  touch /workspace/cbx/.ready
fi
cd /workspace/cbx

# --- Load the user's voice as the clone reference (every boot) ---
mkdir -p reference_audio
curl -fsSL "$VOICE_SAMPLE_URL" -o /tmp/ref.audio && ffmpeg -y -i /tmp/ref.audio reference_audio/voice.wav

# --- Idle self-stop after 35 min (storage-only billing when stopped) ---
cat > /workspace/idle.sh <<'WD'
#!/bin/bash
while true; do
  sleep 300
  S=/workspace/last-used
  [ -f "$S" ] || date +%s > "$S"
  L=$(cat "$S" 2>/dev/null || echo 0); N=$(date +%s)
  [ $((N - L)) -gt 2100 ] && shutdown -h now
done
WD
chmod +x /workspace/idle.sh
nohup /workspace/idle.sh >/dev/null 2>&1 &
date +%s > /workspace/last-used

# --- Serve (blocks; model loads before /docs answers = the ready signal) ---
python3 server.py
