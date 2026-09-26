/**
 * Marks a route as not requiring `SessionAuthGuard` — DOCUMENT 08 §4.1's 🔓
 * endpoints (login, forgot/reset-password, accept-invitation, refresh) and
 * the DOCUMENT 25 Phase 1 health check.
 *
 * `SessionAuthGuard` is applied application-wide (see `app.module.ts`)
 * rather than per-controller: DOCUMENT 27 RULE 29 requires *every* protected
 * endpoint to verify authentication, and a guard a new endpoint must
 * remember to add is exactly the kind of thing that gets forgotten. Opting
 * a route *out* with `@Public()` is a decision that has to be made on
 * purpose; being protected is what happens if nobody decides anything.
 */

import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'ufuq:isPublic';

export const Public = (): ReturnType<typeof SetMetadata> => SetMetadata(IS_PUBLIC_KEY, true);
