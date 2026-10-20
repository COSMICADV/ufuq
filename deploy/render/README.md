# Render staging (demo)

A staging/demo deployment on Render's generated `*.onrender.com` URLs, defined by
[`render.yaml`](../../render.yaml). It is not the production topology (Phase 18).

| Service                | What it is                                                             |
| ---------------------- | ---------------------------------------------------------------------- |
| `ufuq-staging-web`     | Next.js: public site, `/login`, `/admin`, `/app`                       |
| `ufuq-staging-api`     | NestJS API; the web app forwards `/api/v1` to it (same-origin)         |
| `ufuq-staging-db`      | Managed PostgreSQL 16, separate staging database                       |
| `ufuq-staging-redis`   | Managed Key Value (Redis-compatible) for BullMQ                        |
| `ufuq-staging-storage` | MinIO, S3-compatible; free instance, so files do not survive a restart |

## Why the API is reached through the web origin

Session and CSRF cookies are host-only and `SameSite=Lax`, and the browser reads
the CSRF cookie to echo it back. `onrender.com` is on the Public Suffix List, so two
Render hostnames are two different sites. `API_PROXY_TARGET` makes the web app
forward `/api/v1/*` to the API, and `NEXT_PUBLIC_API_ORIGIN` points the browser at
the web origin. `TRUST_PROXY_HOPS=3` keeps per-client login rate limits working
behind Render's edge and that rewrite.

## Database roles

`deploy/render/start-api.sh` runs on every boot. It applies migrations and the
reference seed as the database owner, then starts the API as the restricted
`ufuq_app` role. The `ufuq_app` password comes from the generated
`UFUQ_APP_DB_SECRET`. The owner role must bypass row-level security (a superuser
or `BYPASSRLS`), because the `SECURITY DEFINER` login lookups run as the owner
under `FORCE ROW LEVEL SECURITY`.

## Demo company

With `DEMO_SEED=true`, the first boot of an empty database seeds the demo company
through the running API (`apps/api/scripts/demo-seed.mjs`). Later boots detect it and
skip seeding. Set `DEMO_SEED=false` to stop. Never enable it in production.

## Still to configure

- SMTP: set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`
  and `MAIL_FROM` for a real relay. Set `CONTACT_TO` to enable the public contact
  form, which answers 503 until then. Notifications are in-app only.
- Durable storage: point the `STORAGE_*` variables at a persistent S3-compatible
  bucket, for example Cloudflare R2.
