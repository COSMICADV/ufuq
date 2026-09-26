import js from '@eslint/js';
import tseslint from 'typescript-eslint';

import boundaries from './boundaries.mjs';
import decimalSafety from './decimal-safety.mjs';

/**
 * The أُفق base ESLint configuration.
 *
 * Applies to every workspace package. Application-specific configuration
 * (React, Next, React Native) is layered on top by each app when it is created.
 */
export default [
  {
    name: 'ufuq/ignores',
    ignores: ['**/dist/**', '**/.next/**', '**/.turbo/**', '**/coverage/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    name: 'ufuq/base',
    rules: {
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-var': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  ...decimalSafety,
  ...boundaries,
  {
    name: 'ufuq/tests',
    files: ['**/*.test.ts', '**/*.test.tsx', 'scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },
];
