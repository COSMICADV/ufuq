'use client';

import type { Locale, Translator } from '@ufuq/i18n';

import {
  PRIORITY_TONE,
  STATUS_TONE,
  formatPercent,
  priorityKey,
  progressValue,
  statusKey,
} from '../../lib/tasks';
import type { TaskPriority, TaskStatus } from '../../lib/tasks';
import { formatDate } from '../attendance/attendance-shared';
import { Badge } from '../design-system';
import { Ltr } from '../settings/screen-states';

/**
 * The pieces every task screen shares — DOCUMENT 27 RULES 19 and 20. A status
 * is drawn one way on the table, the board, the employee's cards and the
 * detail, because all four ask this file. Every colour is an existing
 * design-system tone (`Badge`), never a new one (RULE 22).
 */

export function TaskStatusChip({
  status,
  t,
}: {
  readonly status: TaskStatus;
  readonly t: Translator;
}): React.JSX.Element {
  return <Badge tone={STATUS_TONE[status]}>{t(statusKey(status))}</Badge>;
}

export function PriorityChip({
  priority,
  t,
}: {
  readonly priority: TaskPriority;
  readonly t: Translator;
}): React.JSX.Element {
  return <Badge tone={PRIORITY_TONE[priority]}>{t(priorityKey(priority))}</Badge>;
}

/**
 * DOCUMENT 13 rule 1: overdue is derived, not a status — so it is shown beside
 * the status chip, never instead of it. The flag is the server's.
 */
export function OverdueBadge({
  overdue,
  t,
}: {
  readonly overdue: boolean;
  readonly t: Translator;
}): React.JSX.Element | null {
  return overdue ? <Badge tone="danger">{t('tasks.overdue')}</Badge> : null;
}

/** A deadline in the company's calendar, with the overdue indicator. */
export function Deadline({
  deadline,
  overdue,
  locale,
  timeZone,
  t,
}: {
  readonly deadline: string | null;
  readonly overdue: boolean;
  readonly locale: Locale;
  readonly timeZone: string;
  readonly t: Translator;
}): React.JSX.Element {
  if (deadline === null) {
    return <span className="tasks-muted">{t('tasks.no_deadline')}</span>;
  }
  return (
    <span className={`tasks-deadline${overdue ? ' tasks-deadline--overdue' : ''}`}>
      <Ltr>{formatDate(deadline, locale, timeZone)}</Ltr>
      <OverdueBadge overdue={overdue} t={t} />
    </span>
  );
}

/**
 * The progress ring DOCUMENT 13 "Mobile behaviour" and DOCUMENT 04 B9 / C5
 * ask for. An SVG circle whose stroke is the design-system green; the figure
 * is the server's DECIMAL(5,2), shown without trailing zeros.
 */
export function ProgressRing({
  percent,
  t,
  size = 'md',
}: {
  readonly percent: string;
  readonly t: Translator;
  readonly size?: 'md' | 'lg';
}): React.JSX.Element {
  const value = progressValue(percent);
  const radius = 16;
  const circumference = 2 * Math.PI * radius;
  const label = t('tasks.progress_label', { percent: formatPercent(percent) });
  return (
    <span className={`tasks-ring tasks-ring--${size}`} role="img" aria-label={label}>
      <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
        <circle className="tasks-ring__track" cx="20" cy="20" r={radius} />
        <circle
          className="tasks-ring__value"
          cx="20"
          cy="20"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - value / 100)}
        />
      </svg>
      <span className="tasks-ring__figure" aria-hidden="true">
        <Ltr>{`${formatPercent(percent)}%`}</Ltr>
      </span>
    </span>
  );
}

/** The bar form, for table rows where a ring would crowd the cell. */
export function ProgressBar({
  percent,
  t,
}: {
  readonly percent: string;
  readonly t: Translator;
}): React.JSX.Element {
  const value = progressValue(percent);
  return (
    <span
      className="tasks-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-label={t('tasks.progress_label', { percent: formatPercent(percent) })}
    >
      <span className="tasks-bar__track">
        <span className="tasks-bar__fill" style={{ inlineSize: `${String(value)}%` }} />
      </span>
      <small>
        <Ltr>{`${formatPercent(percent)}%`}</Ltr>
      </small>
    </span>
  );
}
