/**
 * Password policy — DOCUMENT 09 §2.
 *
 * "No forced character-class rules; length and a breach check are more
 * effective." Composition rules (uppercase, digit, symbol …) are
 * deliberately absent — adding one would be inventing a rule DOCUMENT 09
 * explicitly rejects.
 */

import { isPasswordBreached } from './breached-passwords.js';

export const MIN_PASSWORD_LENGTH = 10;

export interface PasswordPolicyViolation {
  readonly code: 'too_short' | 'breached';
}

/** Returns every violated rule, or an empty array if the password is acceptable. */
export function checkPasswordPolicy(password: string): readonly PasswordPolicyViolation[] {
  const violations: PasswordPolicyViolation[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) {
    violations.push({ code: 'too_short' });
  }
  if (isPasswordBreached(password)) {
    violations.push({ code: 'breached' });
  }
  return violations;
}

export { isPasswordBreached } from './breached-passwords.js';
