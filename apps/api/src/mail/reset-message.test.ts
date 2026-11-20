import { describe, expect, it } from 'vitest';

import { buildResetMessage, resetLink } from './reset-message.js';

describe('the password-reset email', () => {
  const message = buildResetMessage({
    to: 'person@example.com',
    locale: 'fr',
    token: 'tok<en>&1',
    expiresAt: new Date('2026-11-20T20:00:00Z'),
    timeZone: 'Africa/Cairo',
    webOrigin: 'https://app.1to1os.com',
  });

  it('puts the token in the fragment, never the query string', () => {
    const link = resetLink('https://app.1to1os.com', 'fr', 'abc');
    expect(link).toBe('https://app.1to1os.com/fr/reset-password#token=abc');
    expect(new URL(link).search).toBe('');
  });

  it('is in the account language, with the link in text and escaped HTML', () => {
    expect(message.subject).toContain('mot de passe');
    expect(message.text).toContain(
      'https://app.1to1os.com/fr/reset-password#token=tok%3Cen%3E%261',
    );
    expect(message.html).not.toContain('<en>');
    expect(message.html).toContain('lang="fr"');
  });
});
