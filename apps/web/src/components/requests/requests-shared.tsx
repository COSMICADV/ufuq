'use client';

import type { Locale, Translator } from '@ufuq/i18n';

import { ageInDays, categoryKey, STATUS_TONE, statusKey, summaryOf } from '../../lib/requests';
import type { RequestCategory, RequestItem, RequestStatus } from '../../lib/requests';
import { formatDate } from '../attendance/attendance-shared';
import { formatDays, typeName } from '../../lib/leave';
import { Badge } from '../design-system';
import { Ltr } from '../settings/screen-states';

/**
 * The pieces every Requests Centre screen shares — DOCUMENT 27 RULES 19 and
 * 20. Colours are existing design-system tones only (RULE 22).
 */

export function RequestStatusChip({
  status,
  t,
}: {
  readonly status: RequestStatus;
  readonly t: Translator;
}): React.JSX.Element {
  return <Badge tone={STATUS_TONE[status]}>{t(statusKey(status))}</Badge>;
}

/** DOCUMENT 04 B13 "category chip". */
export function RequestCategoryChip({
  category,
  t,
}: {
  readonly category: RequestCategory;
  readonly t: Translator;
}): React.JSX.Element {
  return <Badge tone="info">{t(categoryKey(category))}</Badge>;
}

/** DOCUMENT 04 B13 "summary": the subject, or the day an attendance correction is for. */
export function RequestSummary({
  item,
  locale,
  t,
  timeZone,
}: {
  readonly item: Pick<RequestItem, 'subject' | 'attendance'> & {
    readonly leave?: RequestItem['leave'];
  };
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
}): React.JSX.Element {
  const summary = summaryOf(item);
  if (summary === null) return <span className="tasks-muted">—</span>;
  if (summary.kind === 'attendance') {
    return (
      <span>
        {t('requests.summary_attendance')} <Ltr>{formatDate(summary.date, locale, timeZone)}</Ltr>
      </span>
    );
  }
  if (summary.kind === 'leave') {
    return (
      <span>
        {typeName(summary.leave.leave_type, locale)} ·{' '}
        <Ltr>{`${formatDate(summary.leave.start_date, locale, timeZone)} – ${formatDate(summary.leave.end_date, locale, timeZone)}`}</Ltr>{' '}
        <span className="tasks-muted">
          ({t('leave.days_short', { days: formatDays(summary.leave.days_count) })})
        </span>
      </span>
    );
  }
  return <span dir="auto">{summary.text}</span>;
}

/** DOCUMENT 04 B13 "age indicator" — shown while a request is still waiting. */
export function RequestAge({
  item,
  t,
  timeZone,
}: {
  readonly item: Pick<RequestItem, 'created_at' | 'status'>;
  readonly t: Translator;
  readonly timeZone: string;
}): React.JSX.Element | null {
  if (item.status !== 'pending') return null;
  const days = ageInDays(item.created_at, timeZone);
  return (
    <span className="tasks-muted">
      {days === 0 ? t('requests.age_today') : t('requests.age_days', { count: String(days) })}
    </span>
  );
}

/** The submission day, in the company's calendar. */
export function SubmittedOn({
  item,
  locale,
  timeZone,
}: {
  readonly item: Pick<RequestItem, 'created_at'>;
  readonly locale: Locale;
  readonly timeZone: string;
}): React.JSX.Element {
  return (
    <Ltr>
      {new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
        timeZone,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }).format(new Date(item.created_at))}
    </Ltr>
  );
}
