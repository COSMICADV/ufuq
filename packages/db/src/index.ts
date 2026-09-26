export { createPrismaClient } from './client.js';
export { generateId } from './id.js';
export { withPlatformContext, withTenant, type TenantClient } from './tenant.js';
export {
  lookupInvitationByTokenHash,
  lookupPasswordResetTokenByHash,
  lookupSessionByRefreshTokenHash,
  lookupSessionByTokenHash,
  lookupUsersByEmail,
  type AuthInvitationLookupRow,
  type AuthLoginLookupRow,
  type AuthRefreshSessionLookupRow,
  type AuthResetTokenLookupRow,
  type AuthSessionLookupRow,
} from './auth-lookups.js';
export { listActiveCompanyIds } from './platform-lookups.js';

// Re-exported so `apps/api` never imports `@prisma/client` directly — every
// generated model, enum and input type comes from `@ufuq/db`'s public entry
// point instead (DOCUMENT 27 RULE 20).
export * from '@prisma/client';
