/**
 * Notification rules — DOCUMENT 19's two tables, one rule per source event.
 *
 * A rule turns a committed domain event into the notifications it means:
 * which type, for whom (through {@link RecipientResolver}, never a broad
 * list), linking to which record, saying what. It reads the source record
 * for the names and dates it states and **decides nothing the source module
 * owns**: a milestone was crossed because the goal ledger said so, a stock
 * line was crossed because the movement said so, a task is overdue because
 * DOCUMENT 13 rule 1's own query selected it. Where a scan's event may be
 * replayed later (a retry), the rule checks the record still says the same
 * thing before telling anyone.
 *
 * A rule also names the event's **actor** — who did the thing — so the
 * pipeline can suppress telling them about their own action (DOCUMENT 19
 * "Employee is their own approver"), and, for a decision, the submitted
 * notifications it **resolves** ("the first decision resolves it and the
 * notification is marked handled for the others").
 *
 * Content never carries an amount (DOCUMENT 19 rule 7): no salary, total,
 * cost or quantity is read here.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { NotificationType, TenantClient } from '@ufuq/db';
import { createTranslator, formatDate, toBcp47 } from '@ufuq/i18n';

import type { AttendanceEvent } from '../attendance/attendance-events.js';
import type { EmployeeEvent } from '../employees/employee-events.js';
import type { GoalEvent } from '../goals/goal-events.js';
import type { InventoryEvent } from '../inventory/inventory-events.js';
import type { LeaveEvent } from '../leave/leave-events.js';
import type { PayrollEvent } from '../payroll/payroll-events.js';
import type { ReportEvent } from '../reports/report-events.js';
import type { RequestEvent } from '../requests/request-events.js';
import { OPEN_STATUSES } from '../tasks/task-rules.js';
import type { TaskEvent } from '../tasks/task-events.js';

import { definitionOf } from './notification-catalogue.js';
import type { NotificationAudience, RelatedType } from './notification-catalogue.js';
import { contentFor } from './notification-content.js';
import type {
  LocalizedValue,
  NotificationContent,
  NotificationParams,
} from './notification-content.js';
import type { SourceEvent } from './notification-sources.js';
import { RecipientResolver } from './recipients.js';
import type { Subject } from './recipients.js';

/** One notification to write, before suppression, preferences and grouping. */
export interface Draft {
  readonly type: NotificationType;
  readonly userId: string;
  readonly audience: NotificationAudience;
  readonly relatedType: RelatedType;
  readonly relatedId: string;
  readonly content: NotificationContent;
}

export interface Resolution {
  /** The source whose pending notifications the event resolves. */
  readonly relatedType: 'request';
  readonly relatedId: string;
  readonly types: readonly NotificationType[];
}

export interface RuleOutcome {
  readonly drafts: readonly Draft[];
  /** Who performed the action: never told about it. */
  readonly actorUserId: string | null;
  readonly resolves: Resolution | null;
}

const NOTHING: RuleOutcome = { drafts: [], actorUserId: null, resolves: null };

const AR = createTranslator('ar');
const EN = createTranslator('en');

function label(key: string): LocalizedValue {
  return { ar: AR(key), en: EN(key) };
}

/**
 * A calendar day as each language writes it ("06 May 2026" / "06 مايو 2026"),
 * the format every screen uses — an ISO string would break at its hyphens in
 * a right-to-left line. Calendar days are stored at UTC midnight.
 */
function day(value: Date | string): LocalizedValue {
  const date = typeof value === 'string' ? new Date(`${value}T00:00:00.000Z`) : value;
  return {
    ar: formatDate(date, { locale: 'ar', timeZone: 'UTC' }),
    en: formatDate(date, { locale: 'en', timeZone: 'UTC' }),
  };
}

/** A payroll or report month: "March 2026" / "مارس 2026". */
function period(year: number, month: number): LocalizedValue {
  const date = new Date(Date.UTC(year, month - 1, 1));
  const format = (locale: 'ar' | 'en'): string =>
    new Intl.DateTimeFormat(toBcp47(locale), {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
      numberingSystem: 'latn',
    }).format(date);
  return { ar: format('ar'), en: format('en') };
}

function personName(row: { readonly firstName: string; readonly lastName: string }): string {
  return `${row.firstName} ${row.lastName}`;
}

interface Person extends Subject {
  readonly name: string;
}

@Injectable()
export class NotificationRules {
  constructor(@Inject(RecipientResolver) private readonly recipients: RecipientResolver) {}

  async apply(tx: TenantClient, event: SourceEvent): Promise<RuleOutcome> {
    switch (event.type) {
      case 'leave_request_submitted':
      case 'leave_approved':
      case 'leave_rejected':
      case 'leave_cancelled':
        return this.leave(tx, event);
      case 'attendance_correction_submitted':
      case 'correction_approved':
      case 'correction_rejected':
      case 'correction_cancelled':
      case 'missing_checkout':
        return this.attendance(tx, event);
      case 'request_submitted':
      case 'request_reviewed':
      case 'request_cancelled':
        return this.request(tx, event);
      case 'task_assigned':
      case 'task_updated':
      case 'task_overdue':
      case 'task_deadline_approaching':
        return this.task(tx, event);
      case 'goal_milestone':
      case 'goal_assigned':
        return this.goal(tx, event);
      case 'low_stock':
      case 'out_of_stock':
      case 'negative_stock':
      case 'stock_reconciliation_mismatch':
        return this.inventory(tx, event);
      case 'payroll_generated':
      case 'payroll_finalized':
      case 'payroll_marked_paid':
      case 'payroll_adjustment_created':
      case 'payroll_deduction_added':
      case 'payroll_bonus_added':
        return this.payroll(tx, event);
      case 'monthly_report_ready':
      case 'report_export_completed':
      case 'report_export_failed':
        return this.report(tx, event);
      case 'tasks_need_reassignment':
        return this.employee(tx, event);
    }
  }

  // -- Helpers ---------------------------------------------------------------

  private draft(
    type: NotificationType,
    userIds: readonly string[],
    relatedId: string,
    params: NotificationParams,
    options: { audience?: NotificationAudience; variant?: string } = {},
  ): Draft[] {
    const definition = definitionOf(type);
    const content = contentFor(type, params, options.variant);
    return [...new Set(userIds)].map((userId) => ({
      type,
      userId,
      audience: options.audience ?? definition.audience,
      relatedType: definition.relatedType,
      relatedId,
      content,
    }));
  }

  private async person(tx: TenantClient, employeeId: string): Promise<Person | null> {
    const row = await tx.employee.findFirst({
      where: { id: employeeId },
      select: { id: true, firstName: true, lastName: true, managerId: true },
    });
    return row === null
      ? null
      : { employeeId: row.id, managerId: row.managerId, name: personName(row) };
  }

  /** The Requests Centre row a leave request or correction is listed under (OD-09). */
  private async requestRowFor(
    tx: TenantClient,
    relatedType: 'leave_request' | 'attendance_correction_request',
    relatedId: string,
  ): Promise<string | null> {
    const row = await tx.request.findFirst({
      where: { relatedType, relatedId },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  private async own(tx: TenantClient, employeeId: string): Promise<string[]> {
    const userId = await this.recipients.userOfEmployee(tx, employeeId);
    return userId === null ? [] : [userId];
  }

  // -- Leave — DOCUMENT 19, DOCUMENT 05 FLOW 06/07 -----------------------------

  private async leave(tx: TenantClient, event: LeaveEvent): Promise<RuleOutcome> {
    const leave = await tx.leaveRequest.findFirst({
      where: { id: event.leaveRequestId },
      select: {
        startDate: true,
        endDate: true,
        reviewedBy: true,
        leaveType: { select: { nameAr: true, nameEn: true } },
      },
    });
    const requestId = await this.requestRowFor(tx, 'leave_request', event.leaveRequestId);
    const subject = await this.person(tx, event.employeeId);
    if (leave === null || requestId === null || subject === null) return NOTHING;
    const params = {
      employee: subject.name,
      leave_type: { ar: leave.leaveType.nameAr, en: leave.leaveType.nameEn },
      from: day(leave.startDate),
      to: day(leave.endDate),
    };
    const resolves: Resolution = {
      relatedType: 'request',
      relatedId: requestId,
      types: ['leave_request_submitted'],
    };

    switch (event.type) {
      case 'leave_request_submitted': {
        // Every eligible approver (OD-18 default A): company-scope holders
        // and the employee's own manager. The submitter is the actor.
        const approvers = await this.recipients.holders(
          tx,
          event.companyId,
          'leave.approve',
          subject,
        );
        return {
          drafts: this.draft('leave_request_submitted', approvers, requestId, params),
          actorUserId: await this.recipients.userOfEmployee(tx, event.employeeId),
          resolves: null,
        };
      }
      case 'leave_approved':
      case 'leave_rejected':
        return {
          drafts: this.draft(event.type, await this.own(tx, event.employeeId), requestId, params),
          actorUserId: leave.reviewedBy,
          resolves,
        };
      case 'leave_cancelled':
        // Nobody is told; the approvers' notifications are no longer pending.
        return { drafts: [], actorUserId: null, resolves };
    }
  }

  // -- Attendance — corrections and the forgotten check-out --------------------

  private async attendance(tx: TenantClient, event: AttendanceEvent): Promise<RuleOutcome> {
    const subject = await this.person(tx, event.employeeId);
    if (subject === null) return NOTHING;

    if (event.type === 'missing_checkout') {
      const params = { employee: subject.name, date: day(event.date) };
      const own = await this.own(tx, event.employeeId);
      // The employee's manager and the company's attendance holders — not
      // the employee themself, who has their own wording.
      const supervisors = (
        await this.recipients.holders(tx, event.companyId, 'attendance.view', subject)
      ).filter((userId) => !own.includes(userId));
      return {
        drafts: [
          ...this.draft('missing_checkout', own, event.attendanceRecordId, params),
          ...this.draft('employee_missing_checkout', supervisors, event.attendanceRecordId, params),
        ],
        actorUserId: null,
        resolves: null,
      };
    }

    const correction = await tx.attendanceCorrectionRequest.findFirst({
      where: { id: event.correctionId },
      select: { date: true, reviewedBy: true },
    });
    const requestId = await this.requestRowFor(
      tx,
      'attendance_correction_request',
      event.correctionId,
    );
    if (correction === null || requestId === null) return NOTHING;
    const params = { employee: subject.name, date: day(correction.date) };
    const resolves: Resolution = {
      relatedType: 'request',
      relatedId: requestId,
      types: ['attendance_correction_submitted'],
    };

    switch (event.type) {
      case 'attendance_correction_submitted': {
        const approvers = await this.recipients.holders(
          tx,
          event.companyId,
          'attendance.approve_correction',
          subject,
        );
        return {
          drafts: this.draft('attendance_correction_submitted', approvers, requestId, params),
          actorUserId: await this.recipients.userOfEmployee(tx, event.employeeId),
          resolves: null,
        };
      }
      case 'correction_approved':
      case 'correction_rejected':
        return {
          drafts: this.draft(event.type, await this.own(tx, event.employeeId), requestId, params),
          actorUserId: correction.reviewedBy,
          resolves,
        };
      case 'correction_cancelled':
        return { drafts: [], actorUserId: null, resolves };
    }
  }

  // -- Requests Centre — native categories ------------------------------------

  private async request(tx: TenantClient, event: RequestEvent): Promise<RuleOutcome> {
    const row = await tx.request.findFirst({
      where: { id: event.requestId },
      select: { subject: true, category: true, reviewedBy: true },
    });
    const subject = await this.person(tx, event.employeeId);
    if (row === null || subject === null) return NOTHING;
    const category = label(`notifications.categories.${row.category}`);
    const params = { employee: subject.name, category, subject: row.subject ?? category };
    const resolves: Resolution = {
      relatedType: 'request',
      relatedId: event.requestId,
      types: ['request_submitted'],
    };

    switch (event.type) {
      case 'request_submitted': {
        const reviewers = await this.recipients.holders(
          tx,
          event.companyId,
          'request.review',
          subject,
        );
        return {
          drafts: this.draft('request_submitted', reviewers, event.requestId, params),
          actorUserId: await this.recipients.userOfEmployee(tx, event.employeeId),
          resolves: null,
        };
      }
      case 'request_reviewed':
        return {
          drafts: this.draft(
            'request_reviewed',
            await this.own(tx, event.employeeId),
            event.requestId,
            params,
            { variant: event.decision === 'rejected' ? 'request_rejected' : 'request_approved' },
          ),
          actorUserId: row.reviewedBy,
          resolves,
        };
      case 'request_cancelled':
        return { drafts: [], actorUserId: null, resolves };
    }
  }

  // -- Tasks -------------------------------------------------------------------

  private async task(tx: TenantClient, event: TaskEvent): Promise<RuleOutcome> {
    const task = await tx.task.findFirst({
      where: { id: event.taskId, deletedAt: null },
      select: { title: true, status: true, deadline: true, assigneeEmployeeId: true },
    });
    if (task === null || task.assigneeEmployeeId !== event.assigneeEmployeeId) return NOTHING;
    const subject = await this.person(tx, task.assigneeEmployeeId);
    if (subject === null) return NOTHING;
    const deadline = task.deadline === null ? null : task.deadline.toISOString().slice(0, 10);
    const params = {
      task: task.title,
      employee: subject.name,
      deadline: deadline === null ? '' : day(deadline),
    };

    switch (event.type) {
      case 'task_assigned':
      case 'task_updated':
        return {
          drafts: this.draft(
            event.type,
            await this.own(tx, task.assigneeEmployeeId),
            event.taskId,
            params,
          ),
          actorUserId: event.actorUserId,
          resolves: null,
        };
      case 'task_deadline_approaching':
      case 'task_overdue': {
        // A replayed scan event is told only if the task still says so: open,
        // and due on the day the scan saw.
        const open = (OPEN_STATUSES as readonly string[]).includes(task.status);
        if (!open || deadline !== event.deadline) return NOTHING;
        const userIds =
          event.type === 'task_deadline_approaching'
            ? await this.own(tx, task.assigneeEmployeeId)
            : await this.recipients.holders(tx, event.companyId, 'task.update', subject);
        return {
          drafts: this.draft(event.type, userIds, event.taskId, params),
          actorUserId: null,
          resolves: null,
        };
      }
    }
  }

  // -- Goals — DOCUMENT 14 rule 6 ----------------------------------------------

  private async goal(tx: TenantClient, event: GoalEvent): Promise<RuleOutcome> {
    const goal = await tx.goal.findFirst({
      where: { id: event.goalId, deletedAt: null },
      select: { title: true, employeeId: true, createdBy: true },
    });
    if (goal === null) return NOTHING;
    const subject = await this.person(tx, goal.employeeId);
    if (subject === null) return NOTHING;

    if (event.type === 'goal_assigned') {
      return {
        drafts: this.draft('goal_assigned', await this.own(tx, goal.employeeId), event.goalId, {
          goal: goal.title,
        }),
        actorUserId: event.actorUserId,
        resolves: null,
      };
    }

    const params = { goal: goal.title, employee: subject.name, milestone: String(event.milestone) };
    const own = await this.own(tx, goal.employeeId);
    // "A team goal": its creator and the owner's manager — each only if their
    // grant reaches this goal — never every administrator.
    const permitted = new Set(
      await this.recipients.holders(tx, event.companyId, 'goal.view', subject),
    );
    const manager =
      subject.managerId === null
        ? null
        : await this.recipients.userOfEmployee(tx, subject.managerId);
    const supervisors = [goal.createdBy, manager].filter(
      (userId): userId is string =>
        userId !== null && permitted.has(userId) && !own.includes(userId),
    );
    return {
      drafts: [
        ...this.draft('goal_milestone', own, event.goalId, params, { audience: 'employee' }),
        ...this.draft('goal_milestone', supervisors, event.goalId, params, {
          audience: 'admin',
          variant: 'goal_milestone_team',
        }),
      ],
      actorUserId: event.actorUserId,
      resolves: null,
    };
  }

  // -- Inventory — DOCUMENT 17, FLOW 18 ----------------------------------------

  private async inventory(tx: TenantClient, event: InventoryEvent): Promise<RuleOutcome> {
    if (event.type !== 'low_stock' && event.type !== 'out_of_stock') return NOTHING;
    if (event.productId === null) return NOTHING;
    const product = await tx.product.findFirst({
      where: { id: event.productId, deletedAt: null },
      select: { nameAr: true, nameEn: true },
    });
    if (product === null) return NOTHING;
    // Stock has no team: only a company-scope `stock.view` grant reaches it.
    const holders = await this.recipients.holders(tx, event.companyId, 'stock.view', null);
    return {
      drafts: this.draft(event.type, holders, event.productId, {
        product: { ar: product.nameAr, en: product.nameEn },
      }),
      actorUserId: null,
      resolves: null,
    };
  }

  // -- Payroll — DOCUMENT 15, FLOWs 14–16 ----------------------------------------

  private async payroll(tx: TenantClient, event: PayrollEvent): Promise<RuleOutcome> {
    if (event.type !== 'payroll_generated' && event.type !== 'payroll_finalized') return NOTHING;
    const row = await tx.payrollPeriod.findFirst({
      where: { id: event.periodId },
      select: { year: true, month: true, generatedBy: true, finalizedBy: true },
    });
    if (row === null) return NOTHING;
    const params = { period: period(row.year, row.month) };

    if (event.type === 'payroll_generated') {
      // Payroll has no team (OD-07): company-scope holders only.
      const holders = await this.recipients.holders(tx, event.companyId, 'payroll.view', null);
      return {
        drafts: this.draft('payroll_ready', holders, event.periodId, params),
        actorUserId: row.generatedBy,
        resolves: null,
      };
    }
    // Every employee with a line in the period, each their own notification.
    const lines = await tx.payrollLine.findMany({
      where: { payrollPeriodId: event.periodId },
      select: { employeeId: true },
    });
    const users = await this.recipients.usersOfEmployees(
      tx,
      lines.map((line) => line.employeeId),
    );
    return {
      drafts: this.draft('salary_finalized', [...users.values()], event.periodId, params),
      actorUserId: row.finalizedBy,
      resolves: null,
    };
  }

  // -- Reports — DOCUMENT 18, FLOW 19 ------------------------------------------

  private async report(tx: TenantClient, event: ReportEvent): Promise<RuleOutcome> {
    if (event.type === 'monthly_report_ready') {
      const report = await tx.monthlyEmployeeReport.findFirst({
        where: { id: event.reportId },
        select: { generatedBy: true, year: true, month: true },
      });
      if (report === null) return NOTHING;
      return {
        drafts: this.draft(
          'monthly_report_ready',
          await this.own(tx, event.employeeId),
          event.reportId,
          {
            period: period(report.year, report.month),
          },
        ),
        actorUserId: report.generatedBy,
        resolves: null,
      };
    }
    const exported = await tx.reportExport.findFirst({
      where: { id: event.exportId },
      select: { requestedBy: true, reportKey: true },
    });
    if (exported === null) return NOTHING;
    const active = await this.recipients.isActiveUser(tx, exported.requestedBy);
    return {
      drafts: this.draft(event.type, active ? [exported.requestedBy] : [], event.exportId, {
        report: label(`notifications.reports.${exported.reportKey}`),
      }),
      // The outcome of a job, not the requester's own action: they are told.
      actorUserId: null,
      resolves: null,
    };
  }

  // -- Employees ---------------------------------------------------------------

  private async employee(tx: TenantClient, event: EmployeeEvent): Promise<RuleOutcome> {
    const subject = await this.person(tx, event.employeeId);
    if (subject === null) return NOTHING;
    const holders = await this.recipients.holders(tx, event.companyId, 'task.update', subject);
    return {
      drafts: this.draft('tasks_need_reassignment', holders, event.employeeId, {
        employee: subject.name,
        count: String(event.openTasks),
      }),
      actorUserId: event.actorUserId,
      resolves: null,
    };
  }
}
