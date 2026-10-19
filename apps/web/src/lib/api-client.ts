/**
 * The browser's side of the DOCUMENT 08 contract.
 *
 * One module, so the envelope (§2), the locale header (§1), the CSRF
 * double-submit (DOCUMENT 20 §6) and the error shape are decided once. A
 * screen that assembled its own `fetch` would sooner or later forget one of
 * them, and the one it forgot would be the CSRF header.
 *
 * The pure parts — URL building, cookie reading, error interpretation — are
 * exported separately from the request itself so they can be tested without a
 * network or a DOM.
 */

import type { Locale } from '@ufuq/i18n';

/**
 * Where the API lives. The web client and the API are separate origins
 * (`WEB_ORIGIN` is what the API's CORS allow-list contains — see
 * `apps/api/src/main.ts`), so the browser calls it directly with credentials.
 * The default matches `API_PORT` in `.env.example`.
 */
export const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';

/** DOCUMENT 08 §1 — `/api/v1`, fixed for the lifetime of V1. */
export const API_BASE_PATH = '/api/v1';

/** DOCUMENT 20 §6 — the non-httpOnly half of the double-submit pair. */
export const CSRF_COOKIE_NAME = 'ufuq_csrf';
export const CSRF_HEADER_NAME = 'X-CSRF-Token';

export function apiUrl(path: string, query: Readonly<Record<string, string>> = {}): string {
  const url = new URL(`${API_BASE_PATH}${path}`, API_ORIGIN);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Read one cookie out of a `document.cookie` string. Written as a pure
 * function of the raw string so it is testable, and so the component tree
 * never touches `document` directly.
 */
export function readCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}

/** The DOCUMENT 08 §2 error body, as a client sees it. */
export interface ApiErrorBody {
  readonly code: string;
  readonly message_ar: string;
  readonly message_en: string;
  readonly fields?: Readonly<Record<string, readonly string[]>>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Readonly<Record<string, readonly string[]>>;

  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.code ?? `HTTP ${String(status)}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.code ?? 'INTERNAL_ERROR';
    this.fields = body?.fields ?? {};
  }

  /**
   * 401 is not "something went wrong" — it is "you are not signed in", and it
   * needs a different sentence and a different next step (DOCUMENT 11 §2,
   * error state: "offers a next step").
   */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

export interface CollectionMeta {
  readonly page: number;
  readonly per_page: number;
  readonly total: number;
  readonly total_pages: number;
}

export interface CollectionResult<T> {
  readonly items: readonly T[];
  readonly meta: CollectionMeta;
}

interface RequestOptions {
  readonly locale: Locale;
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Extra headers — `Idempotency-Key` on a financial create (DOCUMENT 08 §8). */
  readonly headers?: Readonly<Record<string, string>>;
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Build the headers for a request. Separate from `send` so the CSRF rule —
 * "every mutating request carries the token, and no safe one does" — can be
 * asserted directly.
 */
export function buildHeaders(
  method: string,
  locale: Locale,
  hasBody: boolean,
  csrfToken: string | null,
): Record<string, string> {
  const headers: Record<string, string> = { 'Accept-Language': locale };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  if (MUTATING_METHODS.has(method) && csrfToken !== null) {
    headers[CSRF_HEADER_NAME] = csrfToken;
  }
  return headers;
}

function currentCsrfToken(): string | null {
  if (typeof document === 'undefined') {
    return null;
  }
  return readCookie(document.cookie, CSRF_COOKIE_NAME);
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const method = options.method ?? 'GET';
  const hasBody = options.body !== undefined;

  return fetch(apiUrl(path, options.query), {
    method,
    // The session is a cookie (OD-02), and the API is a different origin, so
    // the request has to opt in to sending it.
    credentials: 'include',
    headers: {
      ...options.headers,
      ...buildHeaders(method, options.locale, hasBody, currentCsrfToken()),
    },
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

async function readErrorBody(response: Response): Promise<ApiErrorBody | null> {
  try {
    const parsed = (await response.json()) as { error?: ApiErrorBody };
    return parsed.error ?? null;
  } catch {
    // A response that is not the documented envelope (a proxy's own error
    // page, say) still has to become an ApiError rather than a parse crash.
    return null;
  }
}

/** A single-resource request — DOCUMENT 08 §2's `{ data, meta }`. */
export async function fetchOne<T>(path: string, options: RequestOptions): Promise<T> {
  return (await fetchEnvelope<T, Record<string, unknown>>(path, options)).data;
}

/**
 * The same request, keeping `meta` — for the writes whose `meta` says
 * something the screen must show, such as whether an invitation email was
 * actually sent (`POST /employees`).
 */
export async function fetchEnvelope<T, M>(
  path: string,
  options: RequestOptions,
): Promise<{ readonly data: T; readonly meta: M }> {
  const response = await send(path, options);
  if (!response.ok) {
    throw new ApiError(response.status, await readErrorBody(response));
  }
  return (await response.json()) as { data: T; meta: M };
}

/** A collection request — DOCUMENT 08 §2's `{ data: [], meta: { … } }`. */
export async function fetchMany<T>(
  path: string,
  options: RequestOptions,
): Promise<CollectionResult<T>> {
  const response = await send(path, options);
  if (!response.ok) {
    throw new ApiError(response.status, await readErrorBody(response));
  }
  const parsed = (await response.json()) as { data: T[]; meta: CollectionMeta };
  return { items: parsed.data, meta: parsed.meta };
}

/**
 * A multipart upload — `POST /attachments` (DOCUMENT 08 §4.14). Separate from
 * `send` because the body is `FormData`: the browser must write the
 * `Content-Type` itself (it carries the multipart boundary), so the JSON
 * header `buildHeaders` adds for a body is exactly what must be absent. The
 * CSRF header is still sent, as on every mutating request (DOCUMENT 20 §6).
 */
export async function uploadForm<T>(
  path: string,
  form: FormData,
  options: Pick<RequestOptions, 'locale' | 'signal'>,
): Promise<T> {
  const headers = buildHeaders('POST', options.locale, false, currentCsrfToken());
  const response = await fetch(apiUrl(path), {
    method: 'POST',
    credentials: 'include',
    headers,
    body: form,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw new ApiError(response.status, await readErrorBody(response));
  }
  return ((await response.json()) as { data: T }).data;
}

/**
 * The raw response, for a body that is not the JSON envelope — a CSV export
 * (Phase 12). A non-2xx still becomes an `ApiError` with the envelope's code.
 */
export async function sendRaw(path: string, options: RequestOptions): Promise<Response> {
  const response = await send(path, options);
  if (!response.ok) {
    throw new ApiError(response.status, await readErrorBody(response));
  }
  return response;
}

/** A request with no response body — the 204 on `DELETE /departments/{id}`. */
export async function sendNoContent(path: string, options: RequestOptions): Promise<void> {
  const response = await send(path, options);
  if (!response.ok) {
    throw new ApiError(response.status, await readErrorBody(response));
  }
}

/**
 * The field-issue vocabulary the API raises deliberately (see
 * `tenant-scoped.service.ts`). Anything else in a `fields` map is a
 * `class-validator` constraint message — useful in a log, but English prose,
 * so it is never shown to a user (DOCUMENT 27 RULE 25). The screen falls back
 * to its own translated "this value is not valid".
 */
const KNOWN_ISSUES = new Set([
  'required',
  'invalid',
  'already_taken',
  'not_found',
  'would_create_cycle',
  'incomplete_week',
  'end_before_start',
  'not_active',
  'too_large',
  'unsupported_type',
  'must_sum_to_one',
  'not_same_employee',
  'cancelled',
  'before_joining',
  'after_termination',
  'schedule_incomplete',
  'below_committed',
  // Phase 11 — payroll.
  'not_after_current',
  'mismatch',
  // Phase 13 — warehouse transfers.
  'same_location',
  'duplicate_product',
  // Phase 14 — inventory movements.
  'use_transfer',
  'not_allowed',
  // Phase 12 — monthly reports are of closed months.
  'not_closed',
]);

export function issueKeyFor(error: ApiError, field: string): string | null {
  const issues = error.fields[field];
  if (!issues || issues.length === 0) {
    return null;
  }
  const first = issues[0] as string;
  return KNOWN_ISSUES.has(first) ? `validation.${first}` : 'validation.invalid';
}

/** Every field the API complained about, mapped to a translation key. */
export function issueKeys(error: ApiError): Readonly<Record<string, string>> {
  const mapped: Record<string, string> = {};
  for (const field of Object.keys(error.fields)) {
    const key = issueKeyFor(error, field);
    if (key !== null) {
      mapped[field] = key;
    }
  }
  return mapped;
}
