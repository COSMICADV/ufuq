/**
 * The audit read surface — DOCUMENT 21, DOCUMENT 08 §4.16.
 *
 * Reading only. Writing audit records stays with `AuditService` in
 * `AuthModule`, which every module that changes something already uses; this
 * module neither imports nor re-exports it, so nothing here can write.
 */

import { Module } from '@nestjs/common';

import { AuditLogsController } from './audit-logs.controller.js';
import { AuditLogsService } from './audit-logs.service.js';

@Module({
  controllers: [AuditLogsController],
  providers: [AuditLogsService],
})
export class AuditModule {}
