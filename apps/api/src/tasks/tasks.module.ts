/**
 * Phase 7 — tasks (DOCUMENT 25 Phase 7).
 *
 * `AuthModule` is imported for `AuditService`, which every write here records
 * through rather than duplicating (DOCUMENT 27 RULE 6). No background work:
 * overdue is derived on read (DOCUMENT 13 rule 1), so there is nothing to
 * schedule — the overdue *notification* is Phase 15's.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';

import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

@Module({
  imports: [AuthModule],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
