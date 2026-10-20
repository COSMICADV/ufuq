# Hosted staging/demo — Cloudflare + Render Free + Neon + Aiven

Staging/demo only (not Phase 18 production). $0 and no payment card.

```
Browser → Cloudflare Worker (https://ufuq.<subdomain>.workers.dev, deploy/edge)
        → Render Free web service (this repository's Dockerfile, one container)
            relay ($PORT) → Next.js (:3000) → /api/v1 → NestJS API (:4000)
        → Neon Free: PostgreSQL + Object Storage (S3-compatible)
        → Aiven Free: Valkey (Redis-compatible) for BullMQ
```

## Render web service environment

| Variable                    | Value                                                                 |
| --------------------------- | --------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`             | the Worker URL; also needed **at build time** (Docker build argument) |
| `DATABASE_MIGRATION_URL`    | Neon owner connection string (direct, not pooled)                     |
| `UFUQ_APP_DB_SECRET`        | any long random value; the `ufuq_app` password is derived from it     |
| `REDIS_URL`                 | Aiven Valkey service URI (`rediss://…`)                               |
| `STORAGE_ENDPOINT`          | Neon Object Storage S3 endpoint                                       |
| `STORAGE_REGION`            | Neon storage region                                                   |
| `STORAGE_BUCKET`            | `ufuq-staging`                                                        |
| `STORAGE_FORCE_PATH_STYLE`  | `true`                                                                |
| `STORAGE_ACCESS_KEY_ID`     | Neon storage credential `token_id`                                    |
| `STORAGE_SECRET_ACCESS_KEY` | Neon storage credential `s3_secret_access_key`                        |
| `SMTP_HOST` / `SMTP_PORT`   | `127.0.0.1` / `1025` until a real relay is configured (sends fail)    |
| `MAIL_FROM`                 | `Ufuq Staging <no-reply@ufuq.local>`                                  |
| `TRUST_PROXY_HOPS`          | `4` (Worker → Render edge → relay → Next.js)                          |
| `DEMO_SEED`                 | `true` — seeds the demo company once, on an empty database            |

`CONTACT_TO` stays unset (the public contact form answers its safe 503) until SMTP
is configured. Notifications are in-app only.

## Why a relay and a Worker

- The relay drops `X-Forwarded-Proto`: with it, Next.js treats its own locale
  rewrite as an external https proxy to localhost and fails.
- The Worker gives a fixed URL without a domain, forwards the client IP for the
  per-client login rate limits, and rewrites redirects to its own host.
- The browser reaches the API through the same origin, because session and CSRF
  cookies are host-only and `SameSite=Lax`.

## Database owner

The `SECURITY DEFINER` login lookups run as the owner under `FORCE ROW LEVEL
SECURITY`, so the owner needs `BYPASSRLS` — Neon's owner role has it. The start
script logs it on every boot.

## Free-tier behaviour

Render Free sleeps after ~15 idle minutes and takes about a minute to wake;
BullMQ jobs run only while it is awake. Neon pauses when idle. No keep-alive
traffic is generated.
