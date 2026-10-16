# Production image: Next.js standalone server + migration runner.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN useradd --system --uid 1001 meetsphere
COPY --from=build --chown=meetsphere /app/.next/standalone ./
COPY --from=build --chown=meetsphere /app/.next/static ./.next/static
COPY --from=build --chown=meetsphere /app/public ./public
# Migrations run with `docker compose run --rm migrate` (or as a release step).
COPY --from=build --chown=meetsphere /app/migrations ./migrations
COPY --from=build --chown=meetsphere /app/scripts ./scripts
COPY --from=deps --chown=meetsphere /app/node_modules/tsx ./node_modules/tsx
COPY --from=deps --chown=meetsphere /app/node_modules/esbuild ./node_modules/esbuild
COPY --from=deps --chown=meetsphere /app/node_modules/@esbuild ./node_modules/@esbuild
COPY --from=deps --chown=meetsphere /app/node_modules/get-tsconfig ./node_modules/get-tsconfig
COPY --from=deps --chown=meetsphere /app/node_modules/resolve-pkg-maps ./node_modules/resolve-pkg-maps
USER meetsphere
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
