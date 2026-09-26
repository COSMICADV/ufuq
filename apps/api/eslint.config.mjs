import ufuq from '@ufuq/eslint-config';

/**
 * apps/api layers nothing onto the base rules beyond the CommonJS globals the
 * few configuration files need. The decimal-safety, boundary and TypeScript
 * rules apply unchanged.
 */
export default [
  ...ufuq,
  {
    name: 'ufuq/api/ignores',
    ignores: ['dist/**'],
  },
];
