# syntax=docker/dockerfile:1.7
# ATLAS OSINT — production image (web app + worker share this image).
#
#   docker build -t atlas-osint .
#   docker run -p 3000:3000 -v atlas-data:/data atlas-osint
#
# Multi-platform builds (linux/amd64, linux/arm64) compile the app once on the build machine's own architecture and
# only install the per-architecture runtime dependencies for each target, so no slow emulated `next build`.
#
# Base image is a build argument so registries/mirrors can be swapped (e.g. mirror.gcr.io/library/node:24-bookworm-slim).
# Behind a TLS-inspecting proxy, pass its CA as a build secret:  --secret id=extra_ca,src=/path/to/ca.pem
ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------------------------------------- build (native arch)
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# .npmrc sets ignore-scripts: npm ci would otherwise compile better-sqlite3 from source although it ships prebuilt
# binaries. esbuild's install script (used by tsx) is the only one worth running.
RUN --mount=type=secret,id=extra_ca,required=false \
  if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi; \
  npm ci --no-audit --no-fund && npm rebuild esbuild --ignore-scripts=false
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && rm -rf .next/cache .next/dev

# ---------------------------------------------------------------------------------------------- runtime deps (target arch)
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# better-sqlite3 and sharp ship prebuilt binaries for linux x64/arm64. On other platforms, build with
# --build-arg BUILD_TOOLS=true so native modules can compile from source.
ARG BUILD_TOOLS=false
RUN if [ "$BUILD_TOOLS" = "true" ]; then \
    apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*; \
  fi
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=extra_ca,required=false \
  if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi; \
  npm ci --omit=dev --no-audit --no-fund \
  && npm rebuild esbuild --ignore-scripts=false \
  && if [ "$BUILD_TOOLS" = "true" ]; then npm rebuild better-sqlite3 --ignore-scripts=false; fi \
  && node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()" \
  && node -e "require('sharp')" \
  && npm cache clean --force

# ---------------------------------------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
LABEL org.opencontainers.image.title="ATLAS OSINT" \
  org.opencontainers.image.description="Self-hosted, evidence-first OSINT investigation workspace" \
  org.opencontainers.image.source="https://github.com/StevePapasot/atlas-osint" \
  org.opencontainers.image.licenses="AGPL-3.0-only"
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=3000 \
  ATLAS_DATA_DIR=/data \
  DATABASE_URL=file:/data/atlas.db
RUN groupadd --system atlas \
  && useradd --system --gid atlas --home-dir /app --shell /usr/sbin/nologin atlas \
  && mkdir -p /data && chown atlas:atlas /data
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json /app/.npmrc /app/next.config.ts /app/tsconfig.json /app/LICENSE ./
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
USER atlas
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "exec node node_modules/next/dist/bin/next start -H 0.0.0.0 -p ${PORT}"]
