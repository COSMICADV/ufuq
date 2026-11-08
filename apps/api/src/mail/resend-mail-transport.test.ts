import { describe, expect, it, vi } from 'vitest';

import { ResendMailTransport } from './resend-mail-transport.js';

const message = { to: 'to@example.test', subject: 'Hi', text: 'Body', html: '<p>Body</p>' };

describe('ResendMailTransport', () => {
  it('posts the message to Resend with the API key', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"id":"1"}', { status: 200 }));
    await new ResendMailTransport('re_key', '1to1OS <a@example.test>', fetchImpl as never).send({
      ...message,
      replyTo: 'r@example.test',
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_key');
    expect(JSON.parse(init.body as string)).toEqual({
      from: '1to1OS <a@example.test>',
      to: ['to@example.test'],
      reply_to: 'r@example.test',
      subject: 'Hi',
      text: 'Body',
      html: '<p>Body</p>',
    });
  });
  it('throws when Resend refuses, so callers can handle the failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('domain not verified', { status: 403 }));
    await expect(
      new ResendMailTransport('re_key', 'a@example.test', fetchImpl as never).send(message),
    ).rejects.toThrow(/403/);
  });
});
