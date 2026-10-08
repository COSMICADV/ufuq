'use client';

import Link from 'next/link';
import type { Locale, Translator } from '@ufuq/i18n';

import { formatDate } from '../attendance/attendance-shared';
import { Badge } from '../design-system';
import { Ltr } from '../settings/screen-states';
import { ProgressBar } from '../tasks/tasks-shared';
import {
  GOAL_STATUS_TONE,
  formatValue,
  goalStatusKey,
  goalTypeKey,
  ownerName,
  progressParts,
} from '../../lib/goals';
import type { Goal, GoalStatus, GoalType } from '../../lib/goals';

/**
 * The pieces every goal screen shares — DOCUMENT 27 RULES 19 and 20. Colours
 * are existing design-system tones only (RULE 22); the bar is the task bar.
 */

export function GoalStatusChip({
  status,
  t,
}: {
  readonly status: GoalStatus;
  readonly t: Translator;
}): React.JSX.Element {
  return <Badge tone={GOAL_STATUS_TONE[status]}>{t(goalStatusKey(status))}</Badge>;
}

export function GoalTypeChip({
  type,
  t,
}: {
  readonly type: GoalType;
  readonly t: Translator;
}): React.JSX.Element {
  return <Badge tone="info">{t(goalTypeKey(type))}</Badge>;
}

/** A value with its unit; the Task unit is a stored code, so it is translated. */
export function GoalValue({
  value,
  unit,
  t,
}: {
  readonly value: string;
  readonly unit: string;
  readonly t: Translator;
}): React.JSX.Element {
  const figure = formatValue(value);
  if (unit === '%') {
    return <Ltr>{`${figure}%`}</Ltr>;
  }
  return (
    <span>
      <Ltr>{figure}</Ltr> {unit === 'tasks' ? t('goals.unit_tasks') : <Ltr>{unit}</Ltr>}
    </span>
  );
}

/**
 * DOCUMENT 14 rule 2 and the Custom example: the bar stops at 100%, and the
 * true figure is written out beside it — "112% of target" — so
 * over-achievement is visible and a percentage-unit goal's two numbers are
 * never confused ("84% (93.3% of target)").
 */
export function GoalProgress({
  goal,
  t,
}: {
  readonly goal: Pick<
    Goal,
    'progress_percent' | 'progress_display_percent' | 'current_value' | 'unit'
  >;
  readonly t: Translator;
}): React.JSX.Element {
  const parts = progressParts(goal);
  return (
    <span className="goals-progress">
      <ProgressBar percent={parts.bar} t={t} />
      <small className="tasks-muted">
        <GoalValue value={goal.current_value} unit={goal.unit} t={t} />{' '}
        {t('goals.of_target', { percent: parts.truth })}
      </small>
    </span>
  );
}

/** DOCUMENT 14 "Mobile behaviour": "days remaining in the period". */
export function DaysRemaining({
  goal,
  t,
}: {
  readonly goal: Pick<Goal, 'days_remaining'>;
  readonly t: Translator;
}): React.JSX.Element | null {
  if (goal.days_remaining === null) {
    return null;
  }
  return (
    <span className="tasks-muted">
      {goal.days_remaining === 0
        ? t('goals.last_day')
        : t('goals.days_remaining', { count: String(goal.days_remaining) })}
    </span>
  );
}

export function GoalPeriod({
  goal,
  locale,
  timeZone,
}: {
  readonly goal: Pick<Goal, 'period_start' | 'period_end'>;
  readonly locale: Locale;
  readonly timeZone: string;
}): React.JSX.Element {
  return (
    <Ltr>
      {`${formatDate(goal.period_start, locale, timeZone)} – ${formatDate(goal.period_end, locale, timeZone)}`}
    </Ltr>
  );
}

/**
 * A goal card — DOCUMENT 14 "Mobile behaviour": full width, a progress bar,
 * current and target values, and days remaining. Read-only.
 */
export function GoalCard({
  goal,
  href,
  locale,
  t,
  timeZone,
  showOwner = true,
}: {
  readonly goal: Goal;
  readonly href: string;
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
  readonly showOwner?: boolean;
}): React.JSX.Element {
  return (
    <Link className="tasks-card goals-card" href={href}>
      <span className="tasks-card__main">
        <strong className="tasks-card__title">{goal.title}</strong>
        {showOwner ? <span className="tasks-muted">{ownerName(goal)}</span> : null}
        <span className="tasks-card__chips">
          <GoalTypeChip type={goal.type} t={t} />
          <GoalStatusChip status={goal.status} t={t} />
          <DaysRemaining goal={goal} t={t} />
        </span>
        <GoalProgress goal={goal} t={t} />
        <span className="tasks-muted">
          {t('goals.target')}: <GoalValue value={goal.target_value} unit={goal.unit} t={t} /> ·{' '}
          <GoalPeriod goal={goal} locale={locale} timeZone={timeZone} />
        </span>
      </span>
    </Link>
  );
}
