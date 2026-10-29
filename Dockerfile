FROM node:22-alpine AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --omit=dev

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build && cp -r src/db/migrations dist/db/migrations

FROM base AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

EXPOSE 3001
CMD ["node", "dist/index.js"]
