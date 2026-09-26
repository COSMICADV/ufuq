export {
  PERMISSIONS,
  isPermissionKey,
  type PermissionDefinition,
  type PermissionKey,
} from './permissions.js';

export {
  ASSIGNABLE_ROLE_KEYS,
  ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  SYSTEM_ROLE_KEYS,
  isAssignableRoleKey,
  isSystemRoleKey,
  permissionsForRole,
  type AssignableRoleKey,
  type PermissionScope,
  type RolePermissionGrant,
  type SystemRoleDefinition,
  type SystemRoleKey,
} from './roles.js';

export {
  resolveScope,
  ScopeResolutionError,
  type ScopeConstraint,
  type ScopeContext,
} from './scope.js';

export {
  checkPasswordPolicy,
  isPasswordBreached,
  MIN_PASSWORD_LENGTH,
  type PasswordPolicyViolation,
} from './password-policy.js';

export {
  dummyPasswordHash,
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  timingSafeEqualStrings,
  verifyPassword,
} from './crypto.js';

export {
  FORGOT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS,
  FORGOT_PASSWORD_RATE_LIMIT_WINDOW_MINUTES,
  INVITATION_TOKEN_TTL_HOURS,
  LOGIN_LOCKOUT_DURATION_MINUTES,
  LOGIN_LOCKOUT_WINDOW_MINUTES,
  LOGIN_MAX_FAILURES,
  LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
  LOGIN_RATE_LIMIT_WINDOW_MINUTES,
  PASSWORD_RESET_TOKEN_TTL_MINUTES,
  SESSION_ABSOLUTE_TIMEOUT_MINUTES_DEFAULT,
  SESSION_ABSOLUTE_TIMEOUT_MINUTES_REMEMBERED,
  SESSION_IDLE_TIMEOUT_MINUTES,
} from './session-policy.js';
