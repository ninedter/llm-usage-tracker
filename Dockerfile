# Headless runtime for the LLM Usage Tracker — runs the Next.js standalone
# server without the Electron shell. See docs/superpowers/specs/2026-07-13-docker-deployment-design.md

# --- Builder ---
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Electron is a devDependency; its binary is useless in the image
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package.json package-lock.json ./
# npm silently skips optional deps on fetch errors, but the native SWC binding
# is required for turbopack builds (WASM fallback can't build) — fail fast here
# rather than flakily at next build
RUN npm ci && node -e "require.resolve('@next/swc-linux-' + process.arch + '-gnu')"

COPY . .
RUN npm run build

# --- Runner ---
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    LLM_DATA_DIR=/data \
    CODEX_HOME=/codex

# postbuild already copied .next/static and public into standalone
COPY --from=builder --chown=node:node /app/.next/standalone ./

RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000

CMD ["node", "server.js"]
