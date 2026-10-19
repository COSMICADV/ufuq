import { describe, expect, it } from 'vitest';

import { EnvError, loadEnv, redactEnv, SECRET_KEYS } from './env.js';

const valid = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://ufuq:ufuq@localhost:5432/ufuq',
  REDIS_URL: 'redis://localhost:6379',
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_REGION: 'us-east-1',
  STORAGE_BUCKET: 'ufuq-local',
  STORAGE_ACCESS_KEY_ID: 'local-access-key',
  STORAGE_SECRET_ACCESS_KEY: 'local-secret-key',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  MAIL_FROM: 'Ufuq <no-reply@ufuq.local>',
  WEB_ORIGIN: 'http://localhost:3000',
};

function issuesFor(raw: Record<string, string>): readonly string[] {
  try {
    loadEnv(raw);
  } catch (error) {
    if (error instanceof EnvError) {
      return error.issues;
    }
    throw error;
  }
  return [];
}

describe('loadEnv', () => {
  it('accepts a complete environment', () => {
    const env = loadEnv(valid);
    expect(env.nodeEnv).toBe('development');
    expect(env.storage.bucket).toBe('ufuq-local');
    expect(env.apiPort).toBe(4000);
    expect(env.webPort).toBe(3000);
  });

  it('defaults the upload limit to 10 MB and accepts an override — DOCUMENT 20 §7', () => {
    expect(loadEnv(valid).storage.maxUploadBytes).toBe(10 * 1024 * 1024);
    expect(loadEnv({ ...valid, STORAGE_MAX_UPLOAD_BYTES: '5242880' }).storage.maxUploadBytes).toBe(
      5_242_880,
    );
  });

  it.each(['0', '-1', '10MB', '1.5'])('rejects STORAGE_MAX_UPLOAD_BYTES=%s', (value) => {
    expect(issuesFor({ ...valid, STORAGE_MAX_UPLOAD_BYTES: value }).join(' ')).toMatch(
      /STORAGE_MAX_UPLOAD_BYTES/,
    );
  });

  it('reports every missing variable at once', () => {
    try {
      loadEnv({ NODE_ENV: 'development' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).issues.length).toBeGreaterThan(5);
    }
  });

  it('rejects a database URL that is not Postgres', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: 'mysql://localhost:3306/ufuq' })).toThrow(
      EnvError,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'prod' })).toThrow(EnvError);
  });

  it('rejects a port outside the valid range', () => {
    expect(() => loadEnv({ ...valid, API_PORT: '70000' })).toThrow(EnvError);
    expect(() => loadEnv({ ...valid, API_PORT: 'abc' })).toThrow(EnvError);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(loadEnv(valid))).toBe(true);
  });
});

describe('loadEnv — SMTP for invitation mail (approved Phase 5 decision)', () => {
  it('loads an unauthenticated relay with implicit TLS off by default', () => {
    const { mail } = loadEnv(valid);
    expect(mail).toEqual({
      smtpHost: 'localhost',
      smtpPort: 1025,
      smtpSecure: false,
      smtpUser: null,
      smtpPassword: null,
      from: 'Ufuq <no-reply@ufuq.local>',
      contactTo: null,
    });
  });

  it('loads credentials and implicit TLS when given', () => {
    const { mail } = loadEnv({
      ...valid,
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USER: 'mailer',
      SMTP_PASSWORD: 'secret',
    });
    expect(mail.smtpSecure).toBe(true);
    expect(mail.smtpUser).toBe('mailer');
    expect(mail.smtpPassword).toBe('secret');
  });

  it.each(['SMTP_HOST', 'SMTP_PORT', 'MAIL_FROM'])('requires %s', (key) => {
    const raw: Record<string, string> = { ...valid };
    delete raw[key];
    expect(issuesFor(raw)).toContain(`${key} is required`);
  });

  it('refuses a user without a password, and a password without a user', () => {
    expect(issuesFor({ ...valid, SMTP_USER: 'mailer' })).toHaveLength(1);
    expect(issuesFor({ ...valid, SMTP_PASSWORD: 'secret' })).toHaveLength(1);
  });

  it('refuses a MAIL_FROM that is not an address', () => {
    expect(issuesFor({ ...valid, MAIL_FROM: 'no-reply' })).toHaveLength(1);
  });

  it('refuses an SMTP port that is not a port', () => {
    expect(issuesFor({ ...valid, SMTP_PORT: '0' })).toHaveLength(1);
  });
});

describe('redactEnv', () => {
  it('hides every secret (DOCUMENT 20 §8)', () => {
    const raw = { ...valid, SMTP_USER: 'mailer', SMTP_PASSWORD: 'secret' };
    const redacted = redactEnv(raw);
    for (const key of SECRET_KEYS) {
      if (key in raw) {
        expect(redacted[key]).toBe('[redacted]');
      }
    }
    expect(redacted['SMTP_PASSWORD']).toBe('[redacted]');
    expect(redacted['STORAGE_BUCKET']).toBe('ufuq-local');
  });
});

describe('Phase 16 CONTACT_TO', () => {
  it('accepts an environment-specific contact recipient', () => {
    expect(loadEnv({ ...valid, CONTACT_TO: 'Contact <contact@test.test>' }).mail.contactTo).toBe(
      'Contact <contact@test.test>',
    );
  });
  it('disables contact submission if no recipient was configured', () => {
    expect(loadEnv(valid).mail.contactTo).toBeNull();
  });
  it.each(['not-an-email', 'contact@test.test\r\nBcc: victim@test.test'])(
    'rejects invalid CONTACT_TO %s',
    (value) => {
      expect(() => loadEnv({ ...valid, CONTACT_TO: value })).toThrow(EnvError);
    },
  );
});
