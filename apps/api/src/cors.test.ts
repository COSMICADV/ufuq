import { describe, expect, it } from 'vitest';

import { corsOptions } from './cors.js';

describe('CORS for the web client', () => {
  it('allows exactly the web origin, with credentials', () => {
    const options = corsOptions('https://app.ufuq.example');
    expect(options.origin).toBe('https://app.ufuq.example');
    expect(options.credentials).toBe(true);
  });

  it('exposes the headers a report download reads (a cross-origin browser hides them otherwise)', () => {
    expect(corsOptions('x').exposedHeaders).toEqual([
      'Content-Disposition',
      'X-Report-Rows',
      'Retry-After',
    ]);
  });
});
