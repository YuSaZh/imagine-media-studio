# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.23.0 --activate

FROM base AS dependencies

RUN apt-get update \
  && apt-get install --yes --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/provider-contract/package.json packages/provider-contract/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/testkit/package.json packages/testkit/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile

FROM dependencies AS build

COPY . .
RUN pnpm build
RUN pnpm --filter @imagine/server --prod deploy --legacy /opt/imagine-server
RUN mkdir -p /opt/imagine-server/public /opt/imagine-server/migrations \
  && cp -R apps/web/dist/. /opt/imagine-server/public/ \
  && cp -R apps/server/migrations/. /opt/imagine-server/migrations/ \
  && cp LICENSE THIRD_PARTY_NOTICES.md /opt/imagine-server/

FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*

ENV APP_PORT=3030
ENV DATA_DIR=/data
ENV WEB_DIST_DIR=/app/public
ENV NODE_ENV=production

WORKDIR /app
COPY --from=build --chown=node:node /opt/imagine-server/ /app/
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3030

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD ["node", "-e", "const port=process.env.APP_PORT||'3030';fetch('http://127.0.0.1:'+port+'/internal/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
