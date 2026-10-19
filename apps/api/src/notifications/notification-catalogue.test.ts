/**
 * The catalogue, the database enum and the i18n templates agree — DOCUMENT 19
 * "Validation" (type is a known enum value) and "Data" (both languages).
 */

import { Prisma } from '@ufuq/db';
import { describe, expect, it } from 'vitest';

import {
  definitionOf,
  GROUPING_THRESHOLD,
  GROUPING_WINDOW_MS,
  isNotificationType,
  NOTIFICATION_TYPES,
  RETENTION_MONTHS,
} from './notification-catalogue.js';
import { contentFor, summaryContentFor } from './notification-content.js';
import { eventKey } from './notification-sources.js';
import type { SourceEvent } from './notification-sources.js';
import { retentionCutoff } from './notification-retention.js';

const ENUM = Prisma.dmmf.datamodel.enums.find((e) => e.name === 'NotificationType');

/** DOCUMENT 19's priorities, as the tables state them. */
const DOCUMENTED: Record<string, string> = {
  leave_request_submitted: 'high',
  attendance_correction_submitted: 'high',
  request_submitted: 'medium',
  task_overdue: 'medium',
  low_stock: 'high',
  out_of_stock: 'high',
  goal_milestone: 'low',
  payroll_ready: 'high',
  employee_missing_checkout: 'low',
  tasks_need_reassignment: 'medium',
  task_assigned: 'high',
  task_deadline_approaching: 'medium',
  task_updated: 'low',
  leave_approved: 'high',
  leave_rejected: 'high',
  correction_approved: 'high',
  correction_rejected: 'high',
  request_reviewed: 'medium',
  salary_finalized: 'high',
  goal_assigned: 'medium',
  monthly_report_ready: 'low',
  missing_checkout: 'medium',
};

const PARAMS = {
  employee: 'Omar',
  leave_type: { ar: 'سنوية', en: 'Annual' },
  from: '2026-06-01',
  to: '2026-06-02',
  date: '2026-05-05',
  category: { ar: 'عام', en: 'general' },
  subject: 'Parking',
  task: 'Pitch',
  deadline: '2026-05-10',
  product: { ar: 'قطن', en: 'Cotton' },
  goal: 'Sales',
  milestone: '50',
  period: '2026-03',
  count: '3',
  report: { ar: 'تقرير الحضور', en: 'attendance report' },
};

describe('the notification catalogue', () => {
  it('names exactly the database enum, every DOCUMENT 19 type among them', () => {
    expect(ENUM).toBeDefined();
    const values = (ENUM?.values ?? []).map((value) => value.name).sort();
    expect(NOTIFICATION_TYPES.map((d) => d.type).sort()).toEqual(values);
    for (const type of Object.keys(DOCUMENTED)) {
      expect(isNotificationType(type), type).toBe(true);
    }
    expect(isNotificationType('salary_amount_changed')).toBe(false);
  });

  it('keeps DOCUMENT 19’s priority for every documented type', () => {
    for (const [type, priority] of Object.entries(DOCUMENTED)) {
      expect(definitionOf(type as never).priority, type).toBe(priority);
    }
  });

  it('has Arabic and English content and a summary for every type, in both languages', () => {
    for (const { type } of NOTIFICATION_TYPES) {
      const variants =
        type === 'goal_milestone'
          ? ['goal_milestone', 'goal_milestone_team']
          : type === 'request_reviewed'
            ? ['request_approved', 'request_rejected']
            : [type];
      for (const variant of variants) {
        const content = contentFor(type, PARAMS, variant);
        expect(content.titleAr, variant).toMatch(/[؀-ۿ]/);
        expect(content.bodyAr, variant).toMatch(/[؀-ۿ]/);
        expect(content.titleEn, variant).not.toMatch(/[؀-ۿ]/);
        // Every placeholder was filled.
        for (const text of Object.values(content)) {
          expect(text, variant).not.toMatch(/\{\w+\}/);
        }
      }
      const summary = summaryContentFor(type, 5);
      expect(summary.titleEn, type).toContain('5');
      expect(summary.titleAr, type).toContain('5');
    }
  });

  it('writes no amount: the salary notification says the salary was finalized, not how much', () => {
    const content = contentFor('salary_finalized', { period: '2026-03' });
    expect(content.titleAr).toBe('تم اعتماد راتبك');
    expect(content.bodyEn).toBe('Your salary for 2026-03 has been finalized.');
  });

  it('states DOCUMENT 19’s grouping and retention numbers', () => {
    expect(GROUPING_THRESHOLD).toBe(3);
    expect(GROUPING_WINDOW_MS).toBe(3_600_000);
    expect(RETENTION_MONTHS).toBe(12);
    expect(retentionCutoff(new Date('2026-05-10T08:00:00.000Z')).toISOString()).toBe(
      '2025-05-10T08:00:00.000Z',
    );
  });
});

describe('event identity — DOCUMENT 19 rule 3', () => {
  const at = new Date('2026-05-10T08:00:00.000Z');
  const base = { companyId: 'c', occurredAt: at };

  it('a stock crossing is keyed by its movement: a later crossing is a new moment', () => {
    const one = { ...base, type: 'low_stock', productId: 'p', warehouseId: 'w', movementId: 'm1' };
    const two = { ...one, movementId: 'm2' };
    expect(eventKey(one as SourceEvent)).not.toBe(eventKey(two as SourceEvent));
    expect(eventKey(one as SourceEvent)).toBe(eventKey({ ...one, nonce: 'x' } as SourceEvent));
  });

  it('an overdue task is keyed by its deadline, never by the scan that saw it', () => {
    const event = {
      ...base,
      type: 'task_overdue',
      taskId: 't',
      assigneeEmployeeId: 'e',
      deadline: '2026-05-07',
    };
    const later = { ...event, occurredAt: new Date('2026-05-12T08:00:00.000Z'), nonce: 'n' };
    expect(eventKey(event as SourceEvent)).toBe(eventKey(later as SourceEvent));
    expect(eventKey({ ...event, deadline: '2026-05-08' } as SourceEvent)).not.toBe(
      eventKey(event as SourceEvent),
    );
  });

  it('a goal milestone is keyed by goal and threshold', () => {
    const event = { ...base, type: 'goal_milestone', goalId: 'g', milestone: 50 };
    expect(eventKey({ ...event, nonce: 'a' } as unknown as SourceEvent)).toBe(
      eventKey({ ...event, nonce: 'b' } as unknown as SourceEvent),
    );
  });

  it('a repeatable action is keyed by its publication nonce', () => {
    const event = {
      ...base,
      type: 'task_updated',
      taskId: 't',
      assigneeEmployeeId: 'e',
      actorUserId: 'u',
    };
    expect(eventKey({ ...event, nonce: 'a' } as SourceEvent)).not.toBe(
      eventKey({ ...event, nonce: 'b' } as SourceEvent),
    );
  });
});
