'use client';

import type { ReactNode } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import {
  ATTENDANCE_STATUSES,
  formatDuration,
  STATUS_TONE,
  statusKey,
  workModeKey,
} from '../../lib/attendance';
import type {
  AttendanceRecord,
  AttendanceStatus,
  CorrectionRequest,
  WorkMode,
} from '../../lib/attendance';
import { Ltr } from '../settings/screen-states';

/**
 * The pieces every attendance screen shares — DOCUMENT 27 RULES 19 and 20.
 *
 * A status is drawn one way across the daily board, the matrix, the calendar
 * and the profile, because all four ask this file. Building a second status
 * chip somewhere else is how a product ends up with two colours for "late".
 */

/**
 * Times are rendered in the **company's** timezone, never the browser's
 * (DOCUMENT 11 §9, DOCUMENT 12 "Timezone"). The server sends an instant; this
 * is the only place that decides which clock it is read against.
 */
export function formatTime(
  instant: string | null,
  locale: Locale,
  timeZone: string,
): string | null {
  if (instant === null) return null;
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: locale === 'ar',
  }).format(new Date(instant));
}

export function formatDate(date: string, locale: Locale, timeZone: string): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${date}T12:00:00.000Z`));
}

export function StatusChip({
  status,
  t,
}: {
  readonly status: AttendanceStatus;
  readonly t: Translator;
}): React.JSX.Element {
  return (
    <span className={`attendance-chip attendance-chip--${STATUS_TONE[status]}`}>
      {t(statusKey(status))}
    </span>
  );
}

export function ModeChip({
  mode,
  t,
}: {
  readonly mode: WorkMode | null;
  readonly t: Translator;
}): React.JSX.Element {
  if (mode === null) return <span className="attendance-muted">—</span>;
  return <span className={`attendance-mode attendance-mode--${mode}`}>{t(workModeKey(mode))}</span>;
}

/** A duration, with the digits isolated so RTL cannot reorder `7:05`. */
export function Duration({ minutes }: { readonly minutes: number | null }): React.JSX.Element {
  const text = formatDuration(minutes);
  if (text === null) return <span className="attendance-muted">—</span>;
  return <Ltr>{text}</Ltr>;
}

/** The legend DOCUMENT 04 B6 requires — the same tones the cells use. */
export function StatusLegend({ t }: { readonly t: Translator }): React.JSX.Element {
  return (
    <div className="attendance-legend">
      <span className="attendance-legend__label">{t('attendance.legend')}</span>
      <ul>
        {ATTENDANCE_STATUSES.map((status) => (
          <li key={status}>
            <span
              className={`attendance-swatch attendance-swatch--${STATUS_TONE[status]}`}
              aria-hidden="true"
            />
            {t(statusKey(status))}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function employeeName(employee: AttendanceRecord['employee']): string {
  return `${employee.first_name} ${employee.last_name}`.trim();
}

export function departmentName(
  department: AttendanceRecord['employee']['department'],
  locale: Locale,
): string | null {
  if (department === null) return null;
  return locale === 'ar' ? department.name_ar : department.name_en;
}

/** A labelled value, used by the record detail and the correction comparison. */
export function Detail({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="attendance-detail">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * DOCUMENT 04 B7 — a correction's "current recorded values vs requested
 * values side by side". Shared by the corrections screen and the Requests
 * Centre detail (DOCUMENT 04 B13: "the relevant attendance record for
 * corrections"), so the comparison reads the same in both.
 */
export function CorrectionComparison({
  correction,
  locale,
  t,
  timeZone,
}: {
  readonly correction: CorrectionRequest;
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
}): React.JSX.Element {
  const zone = timeZone;
  return (
    <div className="attendance-compare">
      <section>
        <h3>{t('attendance.correction_current')}</h3>
        {correction.current === null ? (
          <p>{t('attendance.correction_nothing_recorded')}</p>
        ) : (
          <dl className="attendance-details">
            <Detail label={t('attendance.status.present')}>
              <StatusChip status={correction.current.status} t={t} />
            </Detail>
            <Detail label={t('attendance.work_mode')}>
              <ModeChip mode={correction.current.work_mode} t={t} />
            </Detail>
            <Detail label={t('attendance.check_in_time')}>
              <span dir="ltr">
                {formatTime(correction.current.check_in_at, locale, zone) ?? '—'}
              </span>
            </Detail>
            <Detail label={t('attendance.check_out_time')}>
              <span dir="ltr">
                {formatTime(correction.current.check_out_at, locale, zone) ?? '—'}
              </span>
            </Detail>
            <Detail label={t('attendance.working_hours')}>
              <Duration minutes={correction.current.working_minutes} />
            </Detail>
          </dl>
        )}
      </section>
      <section>
        <h3>{t('attendance.correction_requested')}</h3>
        <dl className="attendance-details">
          <Detail label={t('attendance.check_in_time')}>
            <span dir="ltr">{formatTime(correction.requested_check_in, locale, zone) ?? '—'}</span>
          </Detail>
          <Detail label={t('attendance.check_out_time')}>
            <span dir="ltr">{formatTime(correction.requested_check_out, locale, zone) ?? '—'}</span>
          </Detail>
          <Detail label={t('attendance.work_mode')}>
            <ModeChip mode={correction.requested_work_mode} t={t} />
          </Detail>
          <Detail label={t('attendance.correction_reason')}>{correction.reason}</Detail>
          {correction.review_note === null ? null : (
            <Detail label={t('attendance.review_note')}>{correction.review_note}</Detail>
          )}
        </dl>
      </section>
    </div>
  );
}
