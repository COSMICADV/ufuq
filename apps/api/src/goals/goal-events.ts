/**
 * Goal milestones as domain events — DOCUMENT 14 rule 6, DOCUMENT 19
 * "Architecture".
 *
 * Phase 8 owns **detection**: every write that changes a goal's value works
 * out which of 25 / 50 / 75 / 100% it crossed (`milestonesCrossed`), and the
 * event says so. **Delivery** — `goal_milestone` notifications to the owner
 * and the creator — is DOCUMENT 19's notification pipeline, which DOCUMENT 25
 * schedules for Phase 15. Building a notifications table now would be that
 * phase built early.
 *
 * So the boundary is a port. Events are handed to a {@link GoalEventSink}
 * **after the transaction commits** (DOCUMENT 19 rule 2: "No notification for
 * a rolled-back transaction"); Phase 15 replaces the sink with one that
 * resolves recipients and dispatches. Until then the deferred sink records
 * that delivery is pending and does nothing else.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import type { Milestone } from './goal-rules.js';

export interface GoalMilestoneEvent {
  readonly type: 'goal_milestone';
  readonly companyId: string;
  readonly goalId: string;
  /** The goal owner (DOCUMENT 14 rule 6: "notification to the goal owner…"). */
  readonly employeeId: string;
  /** "…and creator". */
  readonly createdBy: string;
  readonly milestone: Milestone;
  /** The true progress after the change that crossed it. */
  readonly progressPercent: string;
  readonly occurredAt: Date;
}

export interface GoalEventSink {
  milestonesReached(events: readonly GoalMilestoneEvent[]): Promise<void>;
}

export const GOAL_EVENT_SINK = Symbol('GOAL_EVENT_SINK');

/**
 * The sink until Phase 15. It does not pretend to notify anybody: it records,
 * at debug level, that a milestone was detected and that delivery is deferred.
 */
@Injectable()
export class DeferredGoalEventSink implements GoalEventSink {
  private readonly logger = new Logger('GoalMilestones');

  milestonesReached(events: readonly GoalMilestoneEvent[]): Promise<void> {
    for (const event of events) {
      this.logger.debug(
        `Goal ${event.goalId} crossed ${String(event.milestone)}% — notification delivery is Phase 15.`,
      );
    }
    return Promise.resolve();
  }
}

/**
 * Hands committed events to the sink. A sink failure is logged and swallowed:
 * the write it describes has already committed, and failing the request now
 * would report a successful change as an error.
 */
@Injectable()
export class GoalEventPublisher {
  private readonly logger = new Logger(GoalEventPublisher.name);

  constructor(@Inject(GOAL_EVENT_SINK) private readonly sink: GoalEventSink) {}

  async publish(events: readonly GoalMilestoneEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    try {
      await this.sink.milestonesReached(events);
    } catch (error) {
      this.logger.error(
        `Goal milestone events could not be handed on: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
