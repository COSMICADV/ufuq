/**
 * The part of goals that other modules write through — the ledger and the
 * milestone publisher (Phase 8).
 *
 * Separate from `GoalsModule` because `TasksModule` needs it (DOCUMENT 13 rule
 * 8: completing or reopening a linked task recalculates a Task goal), and the
 * endpoints, the period-end job and its scheduler have no business being
 * instantiated a second time inside the tasks module.
 *
 * `GOAL_EVENT_SINK` is provided by the global notifications module (Phase
 * 15): nothing that detects a milestone knows who is told.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';

import { GoalEventPublisher } from './goal-events.js';
import { GoalLedgerService } from './goal-ledger.service.js';

@Module({
  imports: [AuthModule],
  providers: [GoalLedgerService, GoalEventPublisher],
  exports: [GoalLedgerService, GoalEventPublisher],
})
export class GoalsCoreModule {}
