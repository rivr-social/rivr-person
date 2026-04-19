# ==============================================================
# OpenClaw Web — Token Server + Chat UI
# ==============================================================
# Builds the Express proxy that serves the chat web interface
# and handles LiveKit token generation, OpenClaw API proxying,
# voice sample uploads, and digital twin job dispatch.
#
# Source files (server.js, package.json, web/) must be copied
# into this build context from the Autobot repo before building.
# See docs/sovereign-deployment.md for instructions.
#
# Build:
#   docker build -t openclaw-web:local .
# ==============================================================

FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3001

RUN groupadd --system --gid 1001 appuser && \
    useradd --system --uid 1001 --gid appuser appuser && \
    mkdir -p /data/voice-samples && \
    chown -R appuser:appuser /data

USER appuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3001/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
