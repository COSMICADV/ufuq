/**
 * Environment configuration.
 *
 * DOCUMENT 20 §11 — secrets come from the environment or a secret manager,
 * never from source control, and each environment has its own credentials.
 *
 * The loader fails fast: an application that boots with a missing or malformed
 * variable would fail later, further from the cause.
 */

export type AppEnvironment = 'development' | 'test' | 'staging' | 'production';

export interface Env {
  readonly nodeEnv: AppEnvironment;
  /** Postgres connection string — the RLS-enabled application role (AD-03). */
  readonly databaseUrl: string;
  /** Redis connection string — BullMQ queues and rate limiting (AD-01). */
  readonly redisUrl: string;
  /** S3-compatible private object storage (AD-02). */
  readonly storage: {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
    /**
     * Largest accepted upload, in bytes — DOCUMENT 20 §7: "10 MB per file,
     * configurable". `STORAGE_MAX_UPLOAD_BYTES`, default 10 MiB.
     */
    readonly maxUploadBytes: number;
  };
  /**
   * SMTP for authentication and Phase 16 public contact delivery.
   * Uses the existing transport (approved Phase 5/16 decisions). Not a notification
   * channel: DOCUMENT 24 keeps email notifications in FUTURE.
   */
  readonly mail: {
    readonly smtpHost: string;
    readonly smtpPort: number;
    /** Implicit TLS (typically port 465). STARTTLS on 587 leaves this false. */
    readonly smtpSecure: boolean;
    /** Both set, or both null — an unauthenticated relay is a real deployment shape. */
    readonly smtpUser: string | null;
    readonly smtpPassword: string | null;
    /** The `From` header, e.g. `أُفق <no-reply@example.com>`. */
    readonly from: string;
    /** Phase 16 contact delivery; null disables submission until configured. */
    readonly contactTo?: string | null;
  };
  readonly apiPort: number;
  readonly webPort: number;
  /** Origin allowed to call the API with credentials. */
  readonly webOrigin: string;
  /**
   * Reverse-proxy hops in front of the API whose `X-Forwarded-For` entries are
   * trusted for the client IP (rate limits, audit). `null` — the default —
   * trusts none, which is right whenever the API is reached directly.
   */
  readonly trustProxyHops?: number | null;
}

export class EnvError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvError';
    this.issues = issues;
  }
}

export type RawEnv = Readonly<Record<string, string | undefined>>;

const APP_ENVIRONMENTS: readonly AppEnvironment[] = [
  'development',
  'test',
  'staging',
  'production',
];

function requireString(raw: RawEnv, key: string, issues: string[]): string {
  const value = raw[key]?.trim();
  if (!value) {
    issues.push(`${key} is required`);
    return '';
  }
  return value;
}

function optionalString(raw: RawEnv, key: string): string | null {
  const value = raw[key]?.trim();
  return value ? value : null;
}

function requireUrl(
  raw: RawEnv,
  key: string,
  protocols: readonly string[],
  issues: string[],
): string {
  const value = requireString(raw, key, issues);
  if (value === '') {
    return value;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    issues.push(`${key} is not a valid URL`);
    return value;
  }
  if (!protocols.includes(parsed.protocol)) {
    issues.push(`${key} must use one of: ${protocols.join(', ')}`);
  }
  return value;
}

function parsePort(value: string, key: string, issues: string[]): number | null {
  if (!/^\d+$/.test(value)) {
    issues.push(`${key} must be a whole number`);
    return null;
  }
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65535) {
    issues.push(`${key} must be between 1 and 65535`);
    return null;
  }
  return port;
}

function requirePort(raw: RawEnv, key: string, fallback: number, issues: string[]): number {
  const value = raw[key]?.trim();
  if (!value) {
    return fallback;
  }
  return parsePort(value, key, issues) ?? fallback;
}

/** DOCUMENT 20 §7 — "10 MB per file, configurable". */
export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** A whole number of at least 1, or the fallback when unset. */
function requirePositiveInt(raw: RawEnv, key: string, fallback: number, issues: string[]): number {
  const value = raw[key]?.trim();
  if (!value) {
    return fallback;
  }
  if (!/^\d+$/.test(value) || Number.parseInt(value, 10) < 1) {
    issues.push(`${key} must be a whole number of at least 1`);
    return fallback;
  }
  return Number.parseInt(value, 10);
}

/** A port with no sensible default — an SMTP relay's port is the operator's choice. */
function requireExplicitPort(raw: RawEnv, key: string, issues: string[]): number {
  const value = raw[key]?.trim();
  if (!value) {
    issues.push(`${key} is required`);
    return 0;
  }
  return parsePort(value, key, issues) ?? 0;
}

/** `name@domain`, optionally as `Display Name <name@domain>`. */
const MAIL_ADDRESS = /^(?:[^<>]*<[^\s@<>]+@[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+)$/;

function requireMailAddress(raw: RawEnv, key: string, issues: string[]): string {
  const value = requireString(raw, key, issues);
  if (value !== '' && (!MAIL_ADDRESS.test(value) || /[\r\n]/.test(value))) {
    issues.push(`${key} must be an email address, optionally as "Name <address>"`);
  }
  return value;
}

function requireEnvironment(raw: RawEnv, issues: string[]): AppEnvironment {
  const value = raw['NODE_ENV']?.trim() ?? 'development';
  if (!APP_ENVIRONMENTS.includes(value as AppEnvironment)) {
    issues.push(`NODE_ENV must be one of: ${APP_ENVIRONMENTS.join(', ')}`);
    return 'development';
  }
  return value as AppEnvironment;
}

function loadMail(raw: RawEnv, issues: string[]): Env['mail'] {
  const smtpUser = optionalString(raw, 'SMTP_USER');
  const smtpPassword = optionalString(raw, 'SMTP_PASSWORD');
  if ((smtpUser === null) !== (smtpPassword === null)) {
    issues.push('SMTP_USER and SMTP_PASSWORD must be set together, or both left empty');
  }
  return {
    smtpHost: requireString(raw, 'SMTP_HOST', issues),
    smtpPort: requireExplicitPort(raw, 'SMTP_PORT', issues),
    smtpSecure: (raw['SMTP_SECURE'] ?? 'false') === 'true',
    smtpUser,
    smtpPassword,
    from: requireMailAddress(raw, 'MAIL_FROM', issues),
    contactTo:
      optionalString(raw, 'CONTACT_TO') === null
        ? null
        : requireMailAddress(raw, 'CONTACT_TO', issues),
  };
}

/**
 * Validate and freeze the environment. Throws {@link EnvError} listing every
 * problem at once, rather than one per restart.
 */
export function loadEnv(raw: RawEnv = process.env): Env {
  const issues: string[] = [];

  const env: Env = {
    nodeEnv: requireEnvironment(raw, issues),
    databaseUrl: requireUrl(raw, 'DATABASE_URL', ['postgres:', 'postgresql:'], issues),
    redisUrl: requireUrl(raw, 'REDIS_URL', ['redis:', 'rediss:'], issues),
    storage: {
      endpoint: requireUrl(raw, 'STORAGE_ENDPOINT', ['http:', 'https:'], issues),
      region: requireString(raw, 'STORAGE_REGION', issues),
      bucket: requireString(raw, 'STORAGE_BUCKET', issues),
      accessKeyId: requireString(raw, 'STORAGE_ACCESS_KEY_ID', issues),
      secretAccessKey: requireString(raw, 'STORAGE_SECRET_ACCESS_KEY', issues),
      forcePathStyle: (raw['STORAGE_FORCE_PATH_STYLE'] ?? 'true') === 'true',
      maxUploadBytes: requirePositiveInt(
        raw,
        'STORAGE_MAX_UPLOAD_BYTES',
        DEFAULT_MAX_UPLOAD_BYTES,
        issues,
      ),
    },
    mail: loadMail(raw, issues),
    apiPort: requirePort(raw, 'API_PORT', 4000, issues),
    webPort: requirePort(raw, 'WEB_PORT', 3000, issues),
    webOrigin: requireUrl(raw, 'WEB_ORIGIN', ['http:', 'https:'], issues),
    trustProxyHops:
      optionalString(raw, 'TRUST_PROXY_HOPS') === null
        ? null
        : requirePositiveInt(raw, 'TRUST_PROXY_HOPS', 1, issues),
  };

  if (issues.length > 0) {
    throw new EnvError(issues);
  }

  return Object.freeze(env);
}

/** Keys whose values must never reach a log line (DOCUMENT 20 §8). */
export const SECRET_KEYS: readonly string[] = [
  'DATABASE_URL',
  'REDIS_URL',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
  'SMTP_PASSWORD',
];

/** Redact secrets before printing configuration anywhere. */
export function redactEnv(raw: RawEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(raw)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, value]) => [key, SECRET_KEYS.includes(key) ? '[redacted]' : value]),
  );
}
