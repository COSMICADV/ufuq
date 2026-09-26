import ufuq from '@ufuq/eslint-config';

/**
 * apps/mobile layers the CommonJS globals its Babel and Metro configuration
 * files need. The decimal-safety, boundary and TypeScript rules apply
 * unchanged.
 */
export default [
  ...ufuq,
  {
    name: 'ufuq/mobile/ignores',
    ignores: ['.expo/**', 'babel.config.js', 'metro.config.js'],
  },
  {
    name: 'ufuq/mobile/react',
    files: ['src/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
];
