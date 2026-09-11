# Production image for the x402-gated Venus health service.
#
# Only the `service` workspace is built and shipped. The `agent` workspace is a local
# operator CLI that holds buyer keys and has no business inside a public image — its
# package.json is copied solely because npm needs every workspace manifest present to
# validate the lockfile, and .dockerignore keeps its source out.

# ---- build ----------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app

# Manifests first, so a dependency install is cached across source edits.
COPY package.json package-lock.json ./
COPY service/package.json ./service/
COPY agent/package.json ./agent/

RUN npm ci

COPY tsconfig.base.json ./
COPY service ./service

RUN npm run build --workspace=service

# ---- runtime --------------------------------------------------------------
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY service/package.json ./service/
COPY agent/package.json ./agent/

# Production dependencies for the service workspace only.
RUN npm ci --omit=dev --workspace=service --include-workspace-root \
  && npm cache clean --force

COPY --from=build /app/service/dist ./service/dist

# Drop privileges: the image ships with an unprivileged `node` user.
USER node

# Overridden by the platform; the default matches local development.
ENV PORT=4021
ENV HOST=0.0.0.0
EXPOSE 4021

CMD ["node", "service/dist/server.js"]
