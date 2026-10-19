/**
 * Every literal message key the web app asks for exists in both languages —
 * DOCUMENT 27 RULES 24–25. A missing key throws at render time
 * (`MissingMessageError`), which takes the whole screen down; found in Phase
 * 15's browser check on the leave request screen a notification opens.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getMessages } from '@ufuq/i18n';
import type { MessageTree } from '@ufuq/i18n';
import { describe, expect, it } from 'vitest';

const SOURCE = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function has(tree: MessageTree, key: string): boolean {
  let node: string | MessageTree | undefined = tree;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object') return false;
    node = node[segment];
  }
  return typeof node === 'string';
}

describe('message keys', () => {
  it('every literal t("…") key exists in Arabic and English', () => {
    const missing: string[] = [];
    for (const file of sourceFiles(SOURCE)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([a-z0-9_.]+)'/g)) {
        const key = match[1] as string;
        for (const locale of ['ar', 'en'] as const) {
          if (!has(getMessages(locale), key)) missing.push(`${locale} ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
