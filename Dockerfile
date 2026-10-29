FROM node:22-alpine AS base

# Stage 1: Production dependencies
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
ENV NODE_ENV=production
RUN npm ci --omit=dev

# Stage 2: Build
FROM base AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
ENV NODE_ENV=development
RUN npm ci --include=dev
RUN npx tsc
RUN cp -r src/db/migrations dist/db/migrations

# Stage 3: Runtime
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

EXPOSE 3001
CMD ["node", "dist/index.js"]
