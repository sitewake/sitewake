FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/npm-ci-retry.sh scripts/npm-ci-retry.sh
RUN sh scripts/npm-ci-retry.sh

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
