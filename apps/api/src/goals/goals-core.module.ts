/**
 * The part of goals that other modules write through — the ledger and the
 * milestone publisher (Phase 8).
 *
 * Separate from `GoalsModule` because `TasksModule` needs it (DOCUMENT 13 rule
 * 8: completing or reopening a linked task recalculates a Task goal), and the
 * endpoints, the period-end job and its scheduler have no business being
 * instantiated a second time inside the tasks module.
 *
 * `GOAL_EVENT_SINK` is the Phase 15 seam: notifications replace the deferred
 * sink here, and nothing that detects a milestone changes.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';

import { DeferredGoalEventSink, GOAL_EVENT_SINK, GoalEventPublisher } from './goal-events.js';
import { GoalLedgerService } from './goal-ledger.service.js';

@Module({
  imports: [AuthModule],
  providers: [
    GoalLedgerService,
    GoalEventPublisher,
    { provide: GOAL_EVENT_SINK, useClass: DeferredGoalEventSink },
  ],
  exports: [GoalLedgerService, GoalEventPublisher],
})
export class GoalsCoreModule {}
