import ufuq from '@ufuq/eslint-config';

/**
 * apps/web layers the browser and React globals onto the base rules. The
 * decimal-safety, boundary and TypeScript rules apply unchanged.
 */
export default [
  ...ufuq,
  {
    name: 'ufuq/web/ignores',
    ignores: ['.next/**', 'next-env.d.ts'],
  },
  {
    name: 'ufuq/web/react',
    files: ['src/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
];
