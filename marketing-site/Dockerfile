FROM node:20-alpine AS base

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

RUN apk add --no-cache libc6-compat

FROM base AS deps

COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

FROM base AS runner

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/db ./db
COPY --from=builder /app/scripts ./scripts

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
