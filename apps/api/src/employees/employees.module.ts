/**
 * Phase 5 — employees (DOCUMENT 25 Phase 5).
 *
 * `AuthModule` is imported for the three services employee writes share with
 * authentication rather than duplicate (DOCUMENT 27 RULE 6): `AuditDispatcher`,
 * `InvitationService` (the token lifecycle has one owner) and `SessionService`
 * (deactivation and role change revoke sessions). `InvitationMailer` comes
 * from the global `MailModule`.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';

import { EmployeesController } from './employees.controller.js';
import { EmployeesService } from './employees.service.js';

@Module({
  imports: [AuthModule],
  controllers: [EmployeesController],
  providers: [EmployeesService],
})
export class EmployeesModule {}
