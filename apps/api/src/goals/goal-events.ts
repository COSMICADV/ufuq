/**
 * Goal milestones as domain events — DOCUMENT 14 rule 6, DOCUMENT 19
 * "Architecture".
 *
 * Phase 8 owns **detection**: every write that changes a goal's value works
 * out which of 25 / 50 / 75 / 100% it crossed (`milestonesCrossed`), and the
 * event says so. **Delivery** — `goal_milestone` notifications to the owner,
 * the creator and the owner's manager, and `goal_assigned` to the owner of a
 * new goal — is DOCUMENT 19's notification pipeline (Phase 15,
 * `notifications/`), which implements {@link GoalEventSink}.
 *
 * Events are handed to the sink **after the transaction commits** (DOCUMENT 19
 * rule 2: "No notification for a rolled-back transaction").
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
  /** Who made the change that crossed it (DOCUMENT 19: no self-notification). */
  readonly actorUserId: string;
  readonly occurredAt: Date;
}

/** DOCUMENT 19 `goal_assigned` — a new goal for its owner. */
export interface GoalAssignedEvent {
  readonly type: 'goal_assigned';
  readonly companyId: string;
  readonly goalId: string;
  readonly employeeId: string;
  readonly actorUserId: string;
  readonly occurredAt: Date;
}

export type GoalEvent = GoalMilestoneEvent | GoalAssignedEvent;

export interface GoalEventSink {
  handle(events: readonly GoalEvent[]): Promise<void>;
}

export const GOAL_EVENT_SINK = Symbol('GOAL_EVENT_SINK');

/**
 * Hands committed events to the sink. A sink failure is logged and swallowed:
 * the write it describes has already committed, and failing the request now
 * would report a successful change as an error.
 */
@Injectable()
export class GoalEventPublisher {
  private readonly logger = new Logger(GoalEventPublisher.name);

  constructor(@Inject(GOAL_EVENT_SINK) private readonly sink: GoalEventSink) {}

  async publish(events: readonly GoalEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    try {
      await this.sink.handle(events);
    } catch (error) {
      this.logger.error(
        `Goal milestone events could not be handed on: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
