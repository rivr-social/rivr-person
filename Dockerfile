FROM node:20-slim AS deps

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate

# node-pty requires native compilation tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-rivr-person,target=/pnpm/store pnpm install --frozen-lockfile

FROM node:20-slim AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV AUTH_SECRET="build-placeholder"
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"

RUN pnpm build

RUN mkdir -p .next/standalone/.next && \
    cp -R .next/static .next/standalone/.next/static && \
    cp -R public .next/standalone/public

FROM node:20-slim AS runner

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV HOME=/home/nextjs
ENV COREPACK_HOME=/tmp/corepack
ENV AGENT_HQ_DATA_DIR=/workspace/.agent-hq
ENV AGENT_HQ_APP_WORKSPACE_ROOT=/workspace/apps
ENV AGENT_DOCS_ROOT=/workspace/agents
ENV AGENT_HQ_CLAUDE_HOME=/workspace/.claude-runtime

ENV PTY_BRIDGE_PORT=3100

RUN apt-get update && \
    apt-get install -y --no-install-recommends bash ca-certificates curl git tmux python3 make g++ && \
    npm install -g opencode-ai @anthropic-ai/claude-code && \
    rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nextjs

RUN mkdir -p /workspace/.agent-hq /workspace/apps /workspace/agents /workspace/.claude-runtime/.config /workspace/.claude-runtime/.local/state /home/nextjs && \
    chown -R nextjs:nodejs /workspace /home/nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./

# PTY bridge server files
COPY --chown=nextjs:nodejs src/server/pty-bridge.mjs src/server/start.mjs ./src/server/

# Copy pre-built PTY bridge runtime deps from deps stage (node-pty has native addon)
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/node-pty ./node_modules/node-pty
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/ws ./node_modules/ws

USER nextjs

EXPOSE 3000 3100

CMD ["node", "src/server/start.mjs"]
