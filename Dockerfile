# syntax=docker/dockerfile:1.18@sha256:dabfc0969b935b2080555ace70ee69a5261af8a8f1b4df97b9e7fbcf6722eddf
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

FROM ${NODE_IMAGE} AS build
WORKDIR /build
RUN apt-get update \
    && apt-get install --yes --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/catalog/package.json packages/catalog/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/ranking/package.json packages/ranking/package.json
RUN npm ci
COPY tsconfig.base.json eslint.config.mjs .prettierrc.json vitest.config.ts ./
COPY apps apps
COPY packages packages
COPY fixtures fixtures
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Quorum" \
      org.opencontainers.image.source="https://github.com/brendentaylor22/quorum" \
      org.opencontainers.image.revision="${VCS_REF}"
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    QUORUM_DATABASE_PATH=/data/quorum.db
WORKDIR /app
RUN groupadd --gid 10001 quorum \
    && useradd --uid 10001 --gid quorum --no-create-home --shell /usr/sbin/nologin quorum \
    && mkdir /data \
    && chown quorum:quorum /data \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build --chown=root:root /build/package.json /build/package-lock.json ./
COPY --from=build --chown=root:root /build/node_modules ./node_modules
COPY --from=build --chown=root:root /build/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=root:root /build/apps/api/dist ./apps/api/dist
COPY --from=build --chown=root:root /build/apps/web/dist ./apps/web/dist
COPY --from=build --chown=root:root /build/packages/catalog/package.json ./packages/catalog/package.json
COPY --from=build --chown=root:root /build/packages/catalog/dist ./packages/catalog/dist
COPY --from=build --chown=root:root /build/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=root:root /build/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=root:root /build/packages/ranking/package.json ./packages/ranking/package.json
COPY --from=build --chown=root:root /build/packages/ranking/dist ./packages/ranking/dist
COPY --from=build --chown=root:root /build/packages/database/package.json ./packages/database/package.json
COPY --from=build --chown=root:root /build/packages/database/dist ./packages/database/dist
COPY --from=build --chown=root:root /build/packages/database/migrations ./packages/database/migrations
# The fixture catalog is the Phase 2 movie source; Phase 4 replaces it with TMDB.
COPY --from=build --chown=root:root /build/fixtures ./fixtures
USER 10001:10001
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
