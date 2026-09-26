/**
 * Module boundary rules — DOCUMENT 27 RULES 5, 6, 7, 20, 34.
 *
 * Enforced with core ESLint rules so the boundary policy carries no plugin
 * dependency of its own:
 *
 *   1. Shared packages never import an application. Dependencies point one way.
 *   2. Applications never import each other. Sharing happens through packages/*.
 *   3. Nobody deep-imports another package's internals. Only its public entry.
 *   4. No relative path escapes its own workspace package.
 */

const NO_DEEP_IMPORT =
  "Import a package's public entry point (`@ufuq/<pkg>`), not its internals. DOCUMENT 27 RULE 20.";
const NO_ESCAPE =
  'A workspace package may not reach outside itself with a relative path. Depend on it by name instead. DOCUMENT 27 RULE 34.';

const commonPatterns = [
  { group: ['@ufuq/*/src/*', '@ufuq/*/dist/*'], message: NO_DEEP_IMPORT },
  { group: ['**/../../apps/**', '**/../../packages/**'], message: NO_ESCAPE },
];

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'ufuq/boundaries/packages',
    files: ['packages/**/*.{ts,tsx,mts,js,mjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...commonPatterns,
            {
              group: [
                '@ufuq/web',
                '@ufuq/web/*',
                '@ufuq/api',
                '@ufuq/api/*',
                '@ufuq/mobile',
                '@ufuq/mobile/*',
              ],
              message:
                'A shared package must not depend on an application. Dependencies flow apps → packages only. DOCUMENT 27 RULE 34.',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'ufuq/boundaries/apps',
    files: ['apps/**/*.{ts,tsx,mts,js,mjs,jsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...commonPatterns,
            {
              group: [
                '@ufuq/web',
                '@ufuq/web/*',
                '@ufuq/api',
                '@ufuq/api/*',
                '@ufuq/mobile',
                '@ufuq/mobile/*',
              ],
              message:
                'Applications do not import each other. Move shared code into packages/*. DOCUMENT 27 RULES 6 and 20.',
            },
          ],
        },
      ],
    },
  },
];
