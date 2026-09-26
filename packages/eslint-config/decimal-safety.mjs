/**
 * Decimal safety rules — DOCUMENT 27 RULE 17, DOCUMENT 06 §1.2, NFR-04.
 *
 * Monetary and stock values are fixed-precision decimals. Binary floating point
 * arithmetic is forbidden anywhere it can touch money or quantities. These rules
 * make the forbidden constructs fail the build instead of failing an audit.
 */

const MONEY_MESSAGE =
  'Floating-point arithmetic is not permitted on monetary or stock values. Use @ufuq/money (DOCUMENT 27 RULE 17).';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'ufuq/decimal-safety',
    rules: {
      'no-restricted-globals': ['error', { name: 'parseFloat', message: MONEY_MESSAGE }],
      'no-restricted-properties': [
        'error',
        {
          object: 'Number',
          property: 'parseFloat',
          message: MONEY_MESSAGE,
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='toFixed']",
          message: `.toFixed() rounds in binary floating point. ${MONEY_MESSAGE}`,
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='round']",
          message: `Math.round() is not a money rounding policy. Rounding is applied once, at the end, per salary_policies.rounding (DOCUMENT 15). ${MONEY_MESSAGE}`,
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: MONEY_MESSAGE,
        },
      ],
    },
  },
];
