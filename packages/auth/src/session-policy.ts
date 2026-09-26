/**
 * Session timing and lockout constants — DOCUMENT 09 §1, §3.
 *
 * Centralised so the API and its tests share one number instead of two that
 * quietly drift (DOCUMENT 27 RULE 6).
 */

export const SESSION_IDLE_TIMEOUT_MINUTES = 8 * 60;
export const SESSION_ABSOLUTE_TIMEOUT_MINUTES_REMEMBERED = 30 * 24 * 60;
export const SESSION_ABSOLUTE_TIMEOUT_MINUTES_DEFAULT = 24 * 60;

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCKOUT_WINDOW_MINUTES = 15;
export const LOGIN_LOCKOUT_DURATION_MINUTES = 15;

export const PASSWORD_RESET_TOKEN_TTL_MINUTES = 60;
export const INVITATION_TOKEN_TTL_HOURS = 72;

/** DOCUMENT 08 §6 — the login endpoint specifically. */
export const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;
export const LOGIN_RATE_LIMIT_WINDOW_MINUTES = 15;

export const FORGOT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS = 3;
export const FORGOT_PASSWORD_RATE_LIMIT_WINDOW_MINUTES = 60;
