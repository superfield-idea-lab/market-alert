# Unified multi-stage Dockerfile for all Superfield service variants.
#
# All targets share a single `install` stage so bun install runs once and its
# layer is reused across every target build on the same host.
#
# Targets
# -------
#   production           — distroless server bundle (default, replaces Dockerfile)
#   release              — distroless server + baked Vite frontend (replaces Dockerfile.release)
#   worker               — distroless Codex worker (replaces Dockerfile.worker)
#   agent-worker         — distroless Claude agent worker (replaces Dockerfile.agent-worker)
#   autolearn-worker     — distroless autolearn worker (replaces Dockerfile.autolearn-worker)
#   transcription-worker — distroless transcription worker (replaces Dockerfile.transcription-worker)
#   dev                  — oven/bun:1 with shell, hot-reload entrypoint (replaces Dockerfile.dev)
#   dev-worker           — oven/bun:1 with shell, dev-codex-stub (replaces Dockerfile.worker.dev)
#
# Usage examples
# ---------------
#   docker build --target release      -t myrepo/superfield:latest .
#   docker build --target worker       -t myrepo/worker:latest .
#   docker build --target agent-worker -t myrepo/agent-worker:latest .
#   docker build --target dev          -t superfield-dev .

# ── Pinned base images ──────────────────────────────────────────────────────

ARG BUN_VERSION=1.2
ARG BUN_BUILDER_DIGEST=sha256:6ebf306367da43ad75c4d5119563e24de9b66372929ad4fa31546be053a16f74
ARG BUN_DISTROLESS_DIGEST=sha256:e2c3f36733fa2c2c9c80d89b481d9fc7629558cac2533c776f6285ae1ba6b8fa

# ── Stage: install — shared dependency installation ─────────────────────────
# All subsequent build stages copy node_modules from here so bun install
# executes exactly once per cache key across all targets.

FROM oven/bun:${BUN_VERSION}@${BUN_BUILDER_DIGEST} AS install

WORKDIR /app

# Copy workspace manifests and lockfile first for layer caching.
# All workspace member package.json files must be present so bun can resolve
# the full workspace graph against the frozen lockfile.
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/embedding/package.json packages/embedding/
COPY packages/ui/package.json packages/ui/

# Install all workspace dependencies with frozen lockfile for reproducibility.
RUN bun install --frozen-lockfile --ignore-scripts

# ── Stage: build-server — compile the server bundle ─────────────────────────

FROM install AS build-server

# Copy source files needed for the server bundle
COPY apps/server/ apps/server/
COPY apps/web/ apps/web/
COPY packages/ packages/
COPY tsconfig.json ./

# Compile the server entry-point to a single bundle targeting the bun runtime
RUN bun build apps/server/src/index.ts \
      --target bun \
      --outfile dist/server.js \
      --external postgres

# ── Stage: build-web — compile the Vite frontend ────────────────────────────

FROM build-server AS build-web

# The shared install layer already populated node_modules and workspace links.
# Reuse that layer directly so the release build only compiles the frontend once.
RUN cd apps/web && bun run build

# ── Stage: build-worker — compile the worker bundle ─────────────────────────

FROM install AS build-worker

# Copy only what the worker bundle needs
COPY apps/worker/ apps/worker/
COPY packages/core/ packages/core/
COPY packages/db/ packages/db/
COPY tsconfig.json ./

# Compile the worker entry-point to a single bundle targeting the bun runtime
RUN bun build apps/worker/src/index.ts \
      --target bun \
      --outfile dist/worker.js \
      --external postgres

# ── Stage: production — distroless server (no web assets) ───────────────────
# Replaces the former Dockerfile (two-stage server-only image).
# Blueprint: WORKER-C-001 (no-shell distroless runtime)

FROM oven/bun:${BUN_VERSION}-distroless@${BUN_DISTROLESS_DIGEST} AS production

WORKDIR /app

COPY --from=build-server /app/dist/server.js ./dist/server.js
COPY --from=build-server /app/packages/db ./packages/db
COPY --from=install /app/node_modules ./node_modules

ENV PORT=31415

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:' + (process.env.PORT || 31415) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

EXPOSE 31415

ENTRYPOINT ["bun", "run", "dist/server.js"]

# ── Stage: release — distroless server + baked Vite frontend ────────────────
# Replaces Dockerfile.release. Serves both API and frontend from one container.
# Blueprint: WORKER-C-001 (no-shell distroless runtime)

FROM oven/bun:${BUN_VERSION}-distroless@${BUN_DISTROLESS_DIGEST} AS release

WORKDIR /app

COPY --from=build-web /app/dist/server.js ./dist/server.js
COPY --from=build-web /app/packages/db/schema.sql ./dist/schema.sql
COPY --from=build-web /app/apps/web/dist ./apps/web/dist
COPY --from=build-web /app/packages/db ./packages/db
COPY --from=install /app/node_modules ./node_modules

ENV PORT=31415

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:' + (process.env.PORT || 31415) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

EXPOSE 31415

ENTRYPOINT ["bun", "run", "dist/server.js"]

# ── Stage: worker — distroless Codex task-runner worker ─────────────────────
# Replaces Dockerfile.worker.
# The Codex binary must be present in the build context at codex-binary/codex.
# Blueprint constraints: WORKER-C-001, WORKER-C-002, WORKER-S-001
#
# Build arguments:
#   CODEX_VERSION — version tag for documentation (e.g. "0.1.0"); not used at runtime

FROM oven/bun:${BUN_VERSION}-distroless@${BUN_DISTROLESS_DIGEST} AS worker

ARG CODEX_VERSION=unknown
LABEL codex.version="${CODEX_VERSION}"

WORKDIR /app

COPY --from=build-worker /app/dist/worker.js ./dist/worker.js
COPY --from=install /app/node_modules ./node_modules

# Copy the Codex binary — must be present in the build context as codex-binary/codex.
# The CI build step downloads/verifies the pinned binary before building this image.
COPY codex-binary/codex /usr/local/bin/codex

ENV CODEX_PATH=/usr/local/bin/codex

ENTRYPOINT ["bun", "run", "dist/worker.js"]

# ── Stage: agent-worker — distroless Claude agent worker ────────────────────
# Replaces Dockerfile.agent-worker.
# The Claude CLI binary must be present in the build context at claude-binary/claude.
# Blueprint constraints: WORKER-C-001, WORKER-C-007, WORKER-T-009
#
# Build arguments:
#   CLAUDE_VERSION — version tag for documentation only (e.g. "1.0.0")

FROM oven/bun:${BUN_VERSION}-distroless@${BUN_DISTROLESS_DIGEST} AS agent-worker

ARG CLAUDE_VERSION=unknown
LABEL claude.version="${CLAUDE_VERSION}"
LABEL superfield.worker-type="agent"

# Non-root user — worker runs as UID/GID 1000.
USER 1000:1000

WORKDIR /app

COPY --from=build-worker /app/dist/worker.js ./dist/worker.js
COPY --from=install /app/node_modules ./node_modules

# Copy the Claude CLI binary — must be present in the build context as claude-binary/claude.
# Blueprint: WORKER-C-007 (vendor-cli-array-form-spawn — binary copied directly, no shell)
COPY --chown=1000:1000 claude-binary/claude /usr/local/bin/claude

ENV CLAUDE_CLI_PATH=/usr/local/bin/claude
ENV CLAUDE_AUTH_FILE=/tmp/.claude-credentials.json
ENV CODE_MOUNT_PATH=/repo

ENTRYPOINT ["bun", "run", "dist/worker.js"]

# ── Stage: autolearn-worker — distroless autolearn worker ───────────────────
# Replaces Dockerfile.autolearn-worker.
# The Claude CLI binary must be present in the build context at claude-binary/claude.
# Blueprint constraints: WORKER-C-001, WORKER-C-007, WORKER-C-023, WORKER-T-009
#
# Build arguments:
#   CLAUDE_VERSION — version tag for documentation only (e.g. "1.0.0")

FROM oven/bun:${BUN_VERSION}-distroless@${BUN_DISTROLESS_DIGEST} AS autolearn-worker

ARG CLAUDE_VERSION=unknown
LABEL claude.version="${CLAUDE_VERSION}"
LABEL superfield.worker-type="autolearn"
LABEL superfield.ephemeral="true"

# Non-root user — worker runs as UID/GID 1000.
USER 1000:1000

WORKDIR /app

COPY --from=build-worker /app/dist/worker.js ./dist/autolearn-worker.js
COPY --from=install /app/node_modules ./node_modules

# Copy the Claude CLI binary.
# Blueprint: WORKER-C-007 (vendor-cli-array-form-spawn)
# Blueprint: WORKER-C-023 (vendor-cli-version-pinned)
COPY --chown=1000:1000 claude-binary/claude /usr/local/bin/claude

ENV CLAUDE_CLI_PATH=/usr/local/bin/claude
ENV INPUT_PATH=/input
ENV CLAUDE_TIMEOUT_MS=300000
ENV AGENT_TYPE=autolearn

ENTRYPOINT ["bun", "run", "dist/autolearn-worker.js"]

# ── Stage: transcription-worker — distroless transcription worker ────────────
# Replaces Dockerfile.transcription-worker.
# No vendor CLI binary is baked in; the transcription binary is supplied at
# runtime (volume mount or CLAUDE_CLI_PATH env).
# Blueprint constraints: WORKER-C-001, WORKER-C-002
#
# Build arguments:
#   TRANSCRIPTION_CLI_VERSION — version tag for documentation (not used at runtime)

FROM oven/bun:${BUN_VERSION}-distroless@${BUN_DISTROLESS_DIGEST} AS transcription-worker

ARG TRANSCRIPTION_CLI_VERSION=unknown
LABEL transcription.version="${TRANSCRIPTION_CLI_VERSION}"

WORKDIR /app

COPY --from=build-worker /app/dist/worker.js ./dist/worker.js
COPY --from=install /app/node_modules ./node_modules

ENV AGENT_TYPE=transcription

ENTRYPOINT ["bun", "run", "dist/worker.js"]

# ── Stage: dev — hot-reload development server ───────────────────────────────
# Replaces Dockerfile.dev. Source is volume-mounted at runtime.
# Entrypoint: scripts/dev-entrypoint.sh

FROM oven/bun:${BUN_VERSION} AS dev

WORKDIR /app

# Workspace postinstall hooks expect git to be available in dev images.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Copy workspace manifests and lockfile for dependency installation
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/embedding/package.json packages/embedding/
COPY packages/ui/package.json packages/ui/

# Install all workspace dependencies
RUN bun install --frozen-lockfile

# Copy entrypoint before source so volume-mount at runtime overrides the rest
# without losing the pre-installed node_modules layer.
COPY scripts/dev-entrypoint.sh ./scripts/dev-entrypoint.sh
RUN chmod +x ./scripts/dev-entrypoint.sh

# Source is volume-mounted at runtime via docker-compose; copying here provides
# a fallback for plain docker run without a volume.
COPY . .

ENV PORT=31415

EXPOSE 31415

ENTRYPOINT ["./scripts/dev-entrypoint.sh"]

# ── Stage: dev-worker — hot-reload dev worker with codex stub ────────────────
# Replaces Dockerfile.worker.dev. Source is volume-mounted at runtime.

FROM oven/bun:${BUN_VERSION} AS dev-worker

WORKDIR /app

# Workspace postinstall hooks expect git to be available in dev images.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
COPY apps/worker/package.json apps/worker/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/embedding/package.json packages/embedding/
COPY packages/ui/package.json packages/ui/

RUN bun install --frozen-lockfile

# Copy entrypoint and codex stub before source (volume-mount overrides at runtime)
COPY scripts/dev-worker-entrypoint.sh ./scripts/dev-worker-entrypoint.sh
COPY scripts/dev-codex-stub ./scripts/dev-codex-stub
RUN chmod +x ./scripts/dev-worker-entrypoint.sh ./scripts/dev-codex-stub

# Source is volume-mounted at runtime via docker-compose
COPY . .

ENV CODEX_PATH=/app/scripts/dev-codex-stub

ENTRYPOINT ["./scripts/dev-worker-entrypoint.sh"]
