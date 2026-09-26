-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "company_status" AS ENUM ('active', 'suspended', 'cancelled');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('invited', 'active', 'deactivated');

-- CreateEnum
CREATE TYPE "permission_scope" AS ENUM ('self', 'team', 'company', 'platform');

-- CreateEnum
CREATE TYPE "session_client_type" AS ENUM ('web', 'mobile');

-- CreateEnum
CREATE TYPE "audit_action" AS ENUM ('login.success', 'login.failed', 'login.locked', 'logout', 'password.changed', 'password.reset_requested', 'password.reset_completed', 'invitation.sent', 'invitation.accepted', 'session.revoked', 'permission.denied', 'tenancy.violation_attempt');

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "logo_path" VARCHAR(500),
    "timezone" VARCHAR(64) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'EGP',
    "default_locale" CHAR(5) NOT NULL DEFAULT 'ar',
    "fiscal_month_start_day" SMALLINT NOT NULL DEFAULT 1,
    "status" "company_status" NOT NULL DEFAULT 'active',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "company_id" UUID,
    "key" VARCHAR(50) NOT NULL,
    "name_en" VARCHAR(100) NOT NULL,
    "name_ar" VARCHAR(100) NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "module" VARCHAR(50) NOT NULL,
    "description_en" VARCHAR(255) NOT NULL,
    "description_ar" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "scope" "permission_scope" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255),
    "role_id" UUID NOT NULL,
    "locale" CHAR(5),
    "status" "user_status" NOT NULL DEFAULT 'invited',
    "last_login_at" TIMESTAMPTZ(3),
    "failed_login_count" SMALLINT NOT NULL DEFAULT 0,
    "last_failed_login_at" TIMESTAMPTZ(3),
    "locked_until" TIMESTAMPTZ(3),
    "email_verified_at" TIMESTAMPTZ(3),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_type" "session_client_type" NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "refresh_token_hash" VARCHAR(64),
    "remember_me" BOOLEAN NOT NULL DEFAULT false,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "invited_by" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "action" "audit_action" NOT NULL,
    "entity_type" VARCHAR(50) NOT NULL,
    "entity_id" UUID NOT NULL,
    "old_values" JSONB,
    "new_values" JSONB,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_slug_key" ON "companies"("slug");

-- CreateIndex
CREATE INDEX "companies_status_idx" ON "companies"("status");

-- CreateIndex
CREATE UNIQUE INDEX "roles_company_id_key_key" ON "roles"("company_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "users_company_id_status_idx" ON "users"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "users_company_id_email_key" ON "users"("company_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_company_id_user_id_idx" ON "sessions"("company_id", "user_id");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_user_id_key" ON "invitations"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "audit_logs_company_id_created_at_idx" ON "audit_logs"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_company_id_action_created_at_idx" ON "audit_logs"("company_id", "action", "created_at");

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Multi-tenant isolation — AD-03, DOCUMENT 09 §7, DOCUMENT 20 §3.
--
-- Everything below this line is hand-written; nothing here comes from
-- `prisma migrate diff`. It is the part of the AD-03 decision Prisma cannot
-- express in schema.prisma: a second, deliberately unprivileged database
-- role, and row security policies that apply even to code that forgets a
-- `WHERE company_id = …` clause.
-- ---------------------------------------------------------------------------

-- "At most one system role per key" (DOCUMENT 06 §3.3's "NULL = system role")
-- is a filtered uniqueness rule Prisma's schema DSL cannot express — a plain
-- @@unique([companyId, key]) would treat every NULL company_id as distinct
-- and let 'admin' be inserted twice as a system role.
CREATE UNIQUE INDEX "roles_system_key_unique" ON "roles" ("key") WHERE "company_id" IS NULL;

-- The runtime application role. `ufuq` (or whichever role owns these objects
-- via DATABASE_MIGRATION_URL) keeps DDL and superuser-class privileges;
-- PrismaClient never connects as that role in a running application.
--
-- No password is set here — a migration file is version-controlled, and
-- DOCUMENT 20 §11 forbids secrets in source control. `docker-compose.yml`
-- sets a local-only password for this role via a docker-entrypoint-initdb.d
-- script, the same way it already sets one for the `ufuq` bootstrap user. A
-- real environment sets it through that environment's own secret manager
-- before `DATABASE_URL` is allowed to point at it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ufuq_app') THEN
    CREATE ROLE "ufuq_app" LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO "ufuq_app";

-- Applies to every table this migration creates, and — because it is scoped
-- to the connecting (owner) role rather than to today's table list — to
-- every table a *later* migration creates too, as long as that migration also
-- runs as the owner. A future phase does not need to remember this grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "ufuq_app";

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "companies", "roles", "users", "sessions", "password_reset_tokens", "invitations"
  TO "ufuq_app";

-- Reference data seeded once and never written by the running application in
-- V1 (DOCUMENT 02 §2 — "adding a role is a data insert", made by an operator,
-- not an endpoint). Least privilege: read-only for the app role.
GRANT SELECT ON "permissions", "role_permissions" TO "ufuq_app";

-- DOCUMENT 21 "Database requirements": UPDATE and DELETE on audit_logs must
-- be denied to the application role by the database itself, not only by
-- convention — the append-only default grant above is narrowed immediately.
GRANT SELECT, INSERT ON "audit_logs" TO "ufuq_app";
REVOKE UPDATE, DELETE ON "audit_logs" FROM "ufuq_app";

-- Row-level security. `FORCE` matters alongside `ENABLE`: without it,
-- Postgres exempts the table *owner* from its own policies. It does not
-- (cannot — this is a hard PostgreSQL rule, not a configuration choice)
-- exempt an actual superuser, which is what `docker-compose.yml`'s
-- bootstrap user is, so DATABASE_MIGRATION_URL stays what it already is by
-- necessity: a trusted, deploy-time-only credential, never used by
-- request-handling code. The boundary that isolates one tenant's data from
-- another is `ufuq_app` — the *only* role the running application ever
-- authenticates as — genuinely unable to bypass these policies, proven in
-- `packages/db/test/rls.test.ts` with no `WHERE` clause anywhere in sight.
-- FORCE is still set on every table: it costs nothing, and it is what binds
-- a non-superuser owner (should one replace the bootstrap superuser in a
-- future environment) the same way.
ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "companies" FORCE ROW LEVEL SECURITY;
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_reset_tokens" FORCE ROW LEVEL SECURITY;
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;

-- `permissions` and `role_permissions` carry no `company_id` — there is
-- nothing to isolate, so DOCUMENT 09 §7's global query scope does not apply
-- to them and they get no policy (DOCUMENT 06 §3.3).

-- `current_setting('app.company_id', true)` is set with `SET LOCAL` at the
-- start of every tenant-scoped transaction (see @ufuq/db's `withTenant`) and
-- is the empty string for the handful of explicit, greppable pre-tenant-
-- context lookups below (`withPlatformContext`). `NULLIF(…, '')::uuid` turns
-- that empty string into a genuine SQL NULL *before* the cast — casting ''
-- directly to uuid raises an error rather than failing the comparison
-- closed, and (unlike an `AND`-guarded cast) this form has no dependency on
-- the planner evaluating the guard before the cast.
CREATE POLICY "tenant_isolation" ON "companies"
  USING ("id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

-- `company_id IS NULL` rows are the shared system roles (DOCUMENT 06 §3.3)
-- and are visible regardless of tenant context.
CREATE POLICY "tenant_isolation" ON "roles"
  USING (
    "company_id" IS NULL
    OR "company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid
  )
  WITH CHECK (
    "company_id" IS NULL
    OR "company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid
  );

CREATE POLICY "tenant_isolation" ON "users"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

CREATE POLICY "tenant_isolation" ON "sessions"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

CREATE POLICY "tenant_isolation" ON "password_reset_tokens"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

CREATE POLICY "tenant_isolation" ON "invitations"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

CREATE POLICY "tenant_isolation" ON "audit_logs"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Explicit, greppable RLS bypass points — DOCUMENT 09 §7: "Bypassing the
-- scope requires an explicit, greppable call that appears only in
-- platform-level code."
--
-- A handful of operations run *before* a request has any tenant context to
-- set, because resolving that context is the entire point of the call:
-- logging in, validating a session token, and redeeming a password-reset or
-- invitation token all start from a bare credential with no company attached.
-- Each function below is SECURITY DEFINER (runs as its owner, so it is not
-- itself subject to the RLS policies above), returns only the columns its one
-- caller needs, and is granted to `ufuq_app` and nothing wider than that.
-- Every other query in the application goes through RLS.
-- ---------------------------------------------------------------------------

-- DOCUMENT 09 §1 step 2, DOCUMENT 08 §4.1 (`POST /auth/login`,
-- `POST /auth/forgot-password`). Email is unique per company, not globally
-- (DOCUMENT 06 §3.2), so this can legitimately return more than one row; the
-- caller decides what "more than one" means (see the Phase 3 report).
CREATE OR REPLACE FUNCTION auth_lookup_login(p_email TEXT)
RETURNS TABLE (
  id UUID,
  company_id UUID,
  email VARCHAR(255),
  password_hash VARCHAR(255),
  role_id UUID,
  status user_status,
  failed_login_count SMALLINT,
  last_failed_login_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ,
  company_status company_status
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT u.id, u.company_id, u.email, u.password_hash, u.role_id, u.status,
         u.failed_login_count, u.last_failed_login_at, u.locked_until, c.status AS company_status
  FROM users u
  JOIN companies c ON c.id = u.company_id
  WHERE u.email = p_email AND u.deleted_at IS NULL;
$$;

-- DOCUMENT 09 §3, §4 — every authenticated request starts here: resolving
-- which session a bearer token or cookie names is exactly how the request's
-- tenant context (`app.company_id`) gets set in the first place.
CREATE OR REPLACE FUNCTION auth_lookup_session(p_token_hash TEXT)
RETURNS TABLE (
  id UUID,
  company_id UUID,
  user_id UUID,
  client_type session_client_type,
  remember_me BOOLEAN,
  created_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT s.id, s.company_id, s.user_id, s.client_type, s.remember_me,
         s.created_at, s.last_seen_at, s.expires_at, s.revoked_at
  FROM sessions s
  WHERE s.token_hash = p_token_hash;
$$;

-- DOCUMENT 08 §4.1 (`POST /auth/reset-password`).
CREATE OR REPLACE FUNCTION auth_lookup_reset_token(p_token_hash TEXT)
RETURNS TABLE (
  id UUID,
  company_id UUID,
  user_id UUID,
  expires_at TIMESTAMPTZ,
  used_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT t.id, t.company_id, t.user_id, t.expires_at, t.used_at
  FROM password_reset_tokens t
  WHERE t.token_hash = p_token_hash;
$$;

-- DOCUMENT 08 §4.1 (`POST /auth/accept-invitation`).
CREATE OR REPLACE FUNCTION auth_lookup_invitation_token(p_token_hash TEXT)
RETURNS TABLE (
  id UUID,
  company_id UUID,
  user_id UUID,
  expires_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT i.id, i.company_id, i.user_id, i.expires_at, i.accepted_at
  FROM invitations i
  WHERE i.token_hash = p_token_hash;
$$;

REVOKE ALL ON FUNCTION auth_lookup_login(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup_session(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup_reset_token(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup_invitation_token(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth_lookup_login(TEXT) TO "ufuq_app";
GRANT EXECUTE ON FUNCTION auth_lookup_session(TEXT) TO "ufuq_app";
GRANT EXECUTE ON FUNCTION auth_lookup_reset_token(TEXT) TO "ufuq_app";
GRANT EXECUTE ON FUNCTION auth_lookup_invitation_token(TEXT) TO "ufuq_app";

-- DOCUMENT 09 §3 / OD-02 — mobile refresh. Resolves a session by its refresh
-- token specifically, distinct from `auth_lookup_session` (which resolves by
-- the access token/cookie value) so a caller can never accidentally satisfy
-- one check with the other kind of token.
CREATE OR REPLACE FUNCTION auth_lookup_session_by_refresh_hash(p_refresh_token_hash TEXT)
RETURNS TABLE (
  id UUID,
  company_id UUID,
  user_id UUID,
  client_type session_client_type,
  created_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT s.id, s.company_id, s.user_id, s.client_type, s.created_at, s.expires_at, s.revoked_at
  FROM sessions s
  WHERE s.refresh_token_hash = p_refresh_token_hash;
$$;

REVOKE ALL ON FUNCTION auth_lookup_session_by_refresh_hash(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_session_by_refresh_hash(TEXT) TO "ufuq_app";
