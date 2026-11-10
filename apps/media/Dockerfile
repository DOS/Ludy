# crove-media: the media processing sandbox (AI Meeting Notes M3, #2577, ADR-0047).
# Build from the repository root:
#   docker build -f apps/media/Dockerfile -t crove-media .
# ffmpeg and small HTTP service only: no database client, no AI SDK, no credentials.
# Bytes in, JSON out; only the worker calls it over an internal network.
# docker-compose.yml runs it on an internal network with no egress, a read-only root file system,
# /tmp tmpfs, no capabilities, 1 vCPU and 2 GiB.
# Base images are pinned by digest (Node 26.11.1 here); see "Updating pinned images" in AGENTS.md.
FROM node:26-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS build
WORKDIR /app
ENV CI=true
# pnpm 10 is plain JavaScript; it downloads the pnpm version pinned in package.json (packageManager).
RUN npm install -g pnpm@10.34.7 --no-fund --no-audit
COPY . .
# Only crove-media and its workspace dependencies, production dependencies only.
RUN pnpm install --frozen-lockfile --prod --filter "@crove/media..." \
 && rm -rf apps/media/test

FROM node:26-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0
# ffmpeg with libopus for probing, normalizing to mono Opus and splitting into segments.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Dedicated scratch directory for media processing, owned by node:node with 0700 permissions
RUN mkdir -p /data/scratch \
 && chown -R node:node /data/scratch \
 && chmod 700 /data/scratch

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8095 \
    TMPDIR=/data/scratch

WORKDIR /app
# Owned by root and read only for the service user: the service cannot change its own code.
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/media /app/apps/media
# apps/media re-exports the wire contract from this workspace package (a symlink in node_modules, so it must be here too).
COPY --from=build /app/packages/media-contract /app/packages/media-contract

# Marker (apps/media/src/main.ts, IMAGE_MARKER): in this image the environment allowlist always applies,
# even when NODE_ENV is overridden. Owned by root, so the service user cannot remove it.
RUN echo 'crove-media image: the environment allowlist always applies' > /etc/crove-media-image

USER node
EXPOSE 8095
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD node -e "fetch('http://127.0.0.1:8095/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No inspector: SIGUSR1 must not open a debugger port on the service.
ENTRYPOINT ["node", "--disable-sigusr1", "apps/media/src/main.ts"]
