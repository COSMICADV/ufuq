# UFUQ hosted staging/demo — one container: Next.js web + NestJS API.
# Deployed as a single Render Free web service behind a Cloudflare Worker.
# See deploy/hosted/README.md. Not the production topology (Phase 18).
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

WORKDIR /app
COPY . .

# Only what the web app and API need (the Expo app is not deployed).
RUN pnpm install --frozen-lockfile --filter "ufuq" --filter "@ufuq/api..." --filter "@ufuq/web..."

# The browser-facing origin (the Cloudflare Worker URL) is compiled into the
# web bundle; the web app forwards /api/v1 to the API in this container.
ARG PUBLIC_ORIGIN
ENV NEXT_PUBLIC_API_ORIGIN=${PUBLIC_ORIGIN} \
    WEB_ORIGIN=${PUBLIC_ORIGIN} \
    API_PROXY_TARGET=http://127.0.0.1:4000
RUN test -n "$PUBLIC_ORIGIN" || (echo "PUBLIC_ORIGIN build argument is required" && exit 1)
RUN pnpm turbo run build --filter=@ufuq/api... --filter=@ufuq/web...

ENV NODE_ENV=staging
CMD ["bash", "deploy/hosted/start.sh"]
