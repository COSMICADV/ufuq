import type { Env } from '@ufuq/config';
import { describe, expect, it } from 'vitest';

import { HealthService } from './health.service.js';

const env = {
  nodeEnv: 'test',
  databaseUrl: 'postgresql://ufuq:secret@localhost:5432/ufuq',
  redisUrl: 'redis://localhost:6379',
  storage: {
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    bucket: 'ufuq-local',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    forcePathStyle: true,
    maxUploadBytes: 10 * 1024 * 1024,
  },
  mail: {
    smtpHost: 'localhost',
    smtpPort: 1025,
    smtpSecure: false,
    smtpUser: null,
    smtpPassword: null,
    from: 'Ufuq <no-reply@ufuq.local>',
  },
  apiPort: 4000,
  webPort: 3000,
  webOrigin: 'http://localhost:3000',
} satisfies Env;

const info = { name: 'ufuq-api', version: '0.1.0' };

describe('HealthService', () => {
  const service = new HealthService(env, info);
  const at = new Date('2026-09-07T08:00:00.000Z');

  it('reports the running service in Arabic by default', () => {
    const payload = service.read('ar', at);
    expect(payload).toEqual({
      status: 'ok',
      service: 'ufuq-api',
      version: '0.1.0',
      environment: 'test',
      message: 'النظام يعمل',
      time: '2026-09-07T08:00:00.000Z',
    });
  });

  it('reports the running service in English', () => {
    expect(service.read('en', at).message).toBe('System is running');
  });

  it('never reports a secret', () => {
    const serialised = JSON.stringify(service.read('ar', at));
    expect(serialised).not.toContain('secret');
    expect(serialised).not.toContain(env.databaseUrl);
  });
});
