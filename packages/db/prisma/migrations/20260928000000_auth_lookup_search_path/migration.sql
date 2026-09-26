-- ===========================================================================
-- Pre-Phase 7 hardening — pin the five `auth_lookup_*` SECURITY DEFINER
-- functions against search_path shadowing.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   none is changed. Five function bodies and their
--                       `search_path` settings are replaced; every signature,
--                       result column, filter and grant is unchanged.
--   In-flight records:  none.
--   Reversibility:      reversible — restore the previous definitions from
--                       `20260101000000_phase3_auth_and_tenancy` and (for
--                       `auth_lookup_login`)
--                       `20260924000000_phase6_correction_window_and_system_actor`.
--
-- Why: each function was declared `SET search_path = public`. PostgreSQL
-- searches the session's temporary schema *before* every schema in the path
-- unless `pg_temp` is named explicitly, and `ufuq_app` holds TEMP on the
-- database — so a temporary `users`, `sessions`, `password_reset_tokens` or
-- `invitations` table created in a session could stand in for the real one
-- inside these functions. The same weakness was proved and fixed for
-- `platform_list_active_company_ids()` in
-- `20260927000000_platform_lookup_search_path`; this applies the same fix:
--
--   - `SET search_path = pg_catalog, public, pg_temp` — `pg_temp` named last,
--     the PostgreSQL manual's form for SECURITY DEFINER functions;
--   - every table and enum type schema-qualified, so the body cannot resolve
--     to anything but the `public` objects even if the path changed.
--
-- The bodies are otherwise byte-for-byte the current definitions:
-- `auth_lookup_login` keeps the Phase 6 `NOT u.is_system` exclusion (a system
-- actor stays invisible to login and forgot-password), and nothing here
-- widens what any function returns. Row-level security is untouched.
-- ===========================================================================

-- DOCUMENT 09 §1 step 2, DOCUMENT 08 §4.1 (`POST /auth/login`,
-- `POST /auth/forgot-password`).
CREATE OR REPLACE FUNCTION auth_lookup_login(p_email TEXT)
RETURNS TABLE (
  id UUID,
  company_id UUID,
  email VARCHAR(255),
  password_hash VARCHAR(255),
  role_id UUID,
  status public.user_status,
  failed_login_count SMALLINT,
  last_failed_login_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ,
  company_status public.company_status
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT u.id, u.company_id, u.email, u.password_hash, u.role_id, u.status,
         u.failed_login_count, u.last_failed_login_at, u.locked_until, c.status AS company_status
  FROM public.users u
  JOIN public.companies c ON c.id = u.company_id
  WHERE u.email = p_email AND u.deleted_at IS NULL AND NOT u.is_system;
$$;

-- DOCUMENT 09 §3, §4 — resolving the caller's session.
CREATE OR REPLACE FUNCTION auth_lookup_session(p_token_hash TEXT)
RETURNS TABLE (
  id UUID,
  company_id UUID,
  user_id UUID,
  client_type public.session_client_type,
  remember_me BOOLEAN,
  created_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT s.id, s.company_id, s.user_id, s.client_type, s.remember_me,
         s.created_at, s.last_seen_at, s.expires_at, s.revoked_at
  FROM public.sessions s
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
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT t.id, t.company_id, t.user_id, t.expires_at, t.used_at
  FROM public.password_reset_tokens t
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
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT i.id, i.company_id, i.user_id, i.expires_at, i.accepted_at
  FROM public.invitations i
  WHERE i.token_hash = p_token_hash;
$$;

-- DOCUMENT 09 §3 / OD-02 — mobile refresh.
CREATE OR REPLACE FUNCTION auth_lookup_session_by_refresh_hash(p_refresh_token_hash TEXT)
RETURNS TABLE (
  id UUID,
  company_id UUID,
  user_id UUID,
  client_type public.session_client_type,
  created_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT s.id, s.company_id, s.user_id, s.client_type, s.created_at, s.expires_at, s.revoked_at
  FROM public.sessions s
  WHERE s.refresh_token_hash = p_refresh_token_hash;
$$;

-- `CREATE OR REPLACE` keeps the existing privileges; restated so the
-- restriction is visible in the migration that last defined each function.
-- PUBLIC gains nothing; `ufuq_app` keeps exactly EXECUTE.
REVOKE ALL ON FUNCTION auth_lookup_login(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup_session(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup_reset_token(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup_invitation_token(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup_session_by_refresh_hash(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth_lookup_login(TEXT) TO "ufuq_app";
GRANT EXECUTE ON FUNCTION auth_lookup_session(TEXT) TO "ufuq_app";
GRANT EXECUTE ON FUNCTION auth_lookup_reset_token(TEXT) TO "ufuq_app";
GRANT EXECUTE ON FUNCTION auth_lookup_invitation_token(TEXT) TO "ufuq_app";
GRANT EXECUTE ON FUNCTION auth_lookup_session_by_refresh_hash(TEXT) TO "ufuq_app";
