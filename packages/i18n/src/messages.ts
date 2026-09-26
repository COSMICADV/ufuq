/**
 * Message resources — DOCUMENT 01 NFR-01, DOCUMENT 27 RULES 24 and 25.
 *
 * No UI string is written in code. Every string is looked up here, and both
 * locales are loaded together so a key that exists in one and not the other
 * fails a test rather than reaching a user.
 */

import arCommon from './locales/ar/common.json' with { type: 'json' };
import enCommon from './locales/en/common.json' with { type: 'json' };
import { LOCALES, type Locale } from './locale.js';

export type MessageTree = { readonly [key: string]: string | MessageTree };

export type Namespace = 'common';

const CATALOGUE: Record<Locale, Record<Namespace, MessageTree>> = {
  ar: { common: arCommon },
  en: { common: enCommon },
};

export class MissingMessageError extends Error {
  constructor(locale: Locale, key: string) {
    super(`Missing ${locale} message for key "${key}".`);
    this.name = 'MissingMessageError';
  }
}

function lookup(tree: MessageTree, key: string): string | undefined {
  let current: string | MessageTree | undefined = tree;
  for (const segment of key.split('.')) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = current[segment];
  }
  return typeof current === 'string' ? current : undefined;
}

function interpolate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

export type Translator = (key: string, values?: Readonly<Record<string, string>>) => string;

/**
 * Build a translator for one locale and namespace. A missing key throws, so an
 * untranslated string cannot ship silently.
 */
export function createTranslator(locale: Locale, namespace: Namespace = 'common'): Translator {
  const tree = CATALOGUE[locale][namespace];
  return (key, values) => {
    const template = lookup(tree, key);
    if (template === undefined) {
      throw new MissingMessageError(locale, `${namespace}.${key}`);
    }
    return values ? interpolate(template, values) : template;
  };
}

export function getMessages(locale: Locale, namespace: Namespace = 'common'): MessageTree {
  return CATALOGUE[locale][namespace];
}

/** Every key present in a message tree, flattened to dotted paths. */
export function messageKeys(tree: MessageTree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return typeof value === 'string' ? [path] : messageKeys(value, path);
  });
}

/** The namespaces available in every locale. */
export const NAMESPACES: readonly Namespace[] = ['common'];

export const CATALOGUE_LOCALES = LOCALES;
