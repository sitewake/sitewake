# The dependency layer is keyed on a manifest that holds only what npm ci
# reads, so a script edit or the version bump of a release does not rebuild
# node_modules (see scripts/dependency-manifest.mjs).
FROM node:22-bookworm-slim AS manifest
WORKDIR /manifest
COPY package.json package-lock.json scripts/dependency-manifest.mjs ./
RUN node dependency-manifest.mjs package.json package.json

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY --from=manifest /manifest/package.json /manifest/package-lock.json ./
COPY scripts/npm-ci-retry.sh scripts/npm-ci-retry.sh
# Where npm downloads from: ./setup passes the registry that answers fastest
# from this machine. The lockfile's integrity hashes verify every package
# whichever registry serves it, and the setting is not kept in the image.
ARG SITEWAKE_NPM_REGISTRY=https://registry.npmjs.org
RUN npm_config_registry="$SITEWAKE_NPM_REGISTRY" sh scripts/npm-ci-retry.sh

FROM dependencies AS build
ARG SITEWAKE_BUILD_SHA=development
ENV SITEWAKE_BUILD_SHA=$SITEWAKE_BUILD_SHA
COPY . .
RUN node scripts/patch-vinext-sdk-cache.mjs && npm run build
RUN npm prune --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ARG SITEWAKE_BUILD_SHA=development
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
ENV SITEWAKE_BUILD_SHA=$SITEWAKE_BUILD_SHA
WORKDIR /app
COPY --from=build /app /app
EXPOSE 3000
CMD ["npm", "run", "start"]
