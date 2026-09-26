'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ApiError, fetchMany, fetchOne } from '../../lib/api-client';
import { DEFAULT_CORRECTION_WINDOW_DAYS, isDate, WORK_MODES } from '../../lib/attendance';
import type { AttendanceRecord, CorrectionRequest, WorkMode } from '../../lib/attendance';
import { Alert, Button, Card, Field, Input, Select } from '../design-system';
import { describeError, ErrorState, LoadingState, optionalError } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { Detail, Duration, formatTime, ModeChip, StatusChip } from './attendance-shared';
import { loadSession } from '../employees/use-session';

/**
 * `/{locale}/app/attendance/correction/new` — DOCUMENT 04 C4.
 *
 * "Shows current recorded values above the fields so the employee can see what
 * they are changing" — so the day being corrected is fetched first and shown
 * read-only above the form, including the case where there is nothing recorded
 * at all (the forgotten check-in DOCUMENT 12 rule 14 routes here).
 *
 * The date arrives from the history screen as `?date=`, and the window is
 * stated in the helper text. The server enforces it (DOCUMENT 12 rule 13) and
 * answers `CORRECTION_WINDOW_CLOSED`; this only keeps the employee from
 * filling in a form that cannot be accepted.
 */

/**
 * A `datetime-local` value is wall-clock text with no zone. It is combined
 * with the company timezone's offset for that date so the instant sent is the
 * one the employee meant — never the browser's own zone (DOCUMENT 12).
 */
function toInstant(date: string, time: string, timeZone: string): string | null {
  if (time === '') return null;
  const [hours, minutes] = time.split(':').map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  const naive = Date.parse(`${date}T${time}:00.000Z`);
  const probe = new Date(naive);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(probe);
  const read = Object.fromEntries(
    parts.filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(
    read['year'] as number,
    (read['month'] as number) - 1,
    read['day'] as number,
    (read['hour'] as number) % 24,
    read['minute'] as number,
  );
  const offset = asUtc - naive;
  return new Date(naive - offset).toISOString();
}

export function CorrectionForm({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const params = useSearchParams();
  const initialDate = params.get('date') ?? '';

  const [date, setDate] = useState(isDate(initialDate) ? initialDate : '');
  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [mode, setMode] = useState<WorkMode | ''>('');
  const [reason, setReason] = useState('');
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const session = await loadSession(locale, signal);
      let current: AttendanceRecord | null = null;
      if (isDate(date)) {
        const found = await fetchMany<AttendanceRecord>(`/attendance?date=${date}`, {
          locale,
          signal,
        });
        current = found.items[0] ?? null;
      }
      return { session, current };
    },
    [locale, date],
  );

  const resource = useResource(load);

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const zone = resource.state.status === 'ready' ? resource.state.value.session.timeZone : 'UTC';

    const next: Record<string, string> = {};
    if (!isDate(date)) next['date'] = t('validation.invalid');
    if (reason.trim() === '') next['reason'] = t('validation.required');
    if (checkIn === '' && checkOut === '' && mode === '') {
      next['requested_check_in'] = t('validation.required');
    }
    setIssues(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;

    const body: Record<string, unknown> = { date, reason: reason.trim() };
    const inAt = toInstant(date, checkIn, zone);
    const outAt = toInstant(date, checkOut, zone);
    if (inAt !== null) body['requested_check_in'] = inAt;
    if (outAt !== null) body['requested_check_out'] = outAt;
    if (mode !== '') body['requested_work_mode'] = mode;

    setSaving(true);
    fetchOne<CorrectionRequest>('/attendance-corrections', { locale, method: 'POST', body })
      .then(() => {
        router.push(`/${locale}/app/attendance/history?correction=sent`);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
          const mapped: Record<string, string> = {};
          for (const field of Object.keys(error.fields)) {
            mapped[field] = t('validation.invalid');
          }
          setIssues(mapped);
        }
        // Everything the employee typed is kept — DOCUMENT 11 §11.
        setFormError(describeError(error, t));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const zone = resource.state.status === 'ready' ? resource.state.value.session.timeZone : 'UTC';

  return (
    <Card className="attendance-correction">
      {resource.state.status === 'loading' ? <LoadingState t={t} rows={4} /> : null}
      {resource.state.status === 'error' ? (
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      ) : null}

      {resource.state.status === 'ready' ? (
        <>
          <section className="attendance-correction__current">
            <h2>{t('attendance.correction_current')}</h2>
            {resource.state.value.current === null ? (
              <p>{t('attendance.correction_nothing_recorded')}</p>
            ) : (
              <dl className="attendance-details">
                <Detail label={t('attendance.status.present')}>
                  <StatusChip status={resource.state.value.current.status} t={t} />
                </Detail>
                <Detail label={t('attendance.work_mode')}>
                  <ModeChip mode={resource.state.value.current.work_mode} t={t} />
                </Detail>
                <Detail label={t('attendance.check_in_time')}>
                  <span dir="ltr">
                    {formatTime(resource.state.value.current.check_in_at, locale, zone) ?? '—'}
                  </span>
                </Detail>
                <Detail label={t('attendance.check_out_time')}>
                  <span dir="ltr">
                    {formatTime(resource.state.value.current.check_out_at, locale, zone) ?? '—'}
                  </span>
                </Detail>
                <Detail label={t('attendance.working_hours')}>
                  <Duration minutes={resource.state.value.current.working_minutes} />
                </Detail>
              </dl>
            )}
          </section>

          <form className="attendance-correction__form" onSubmit={submit} noValidate>
            {formError === null ? null : (
              <Alert tone="danger" title={t('state.action_blocked')}>
                {formError}
              </Alert>
            )}

            <Field
              label={t('attendance.correction_date')}
              required
              helper={t('attendance.correction_window_note', {
                days: String(
                  resource.state.status === 'ready'
                    ? resource.state.value.session.correctionWindowDays
                    : DEFAULT_CORRECTION_WINDOW_DAYS,
                ),
              })}
              {...optionalError(issues['date'])}
            >
              <Input
                type="date"
                dir="ltr"
                value={date}
                required
                onChange={(event) => {
                  setDate(event.target.value);
                }}
              />
            </Field>

            <Field
              label={t('attendance.correction_check_in')}
              {...optionalError(issues['requested_check_in'])}
            >
              <Input
                type="time"
                dir="ltr"
                value={checkIn}
                onChange={(event) => {
                  setCheckIn(event.target.value);
                }}
              />
            </Field>

            <Field
              label={t('attendance.correction_check_out')}
              {...optionalError(issues['requested_check_out'])}
            >
              <Input
                type="time"
                dir="ltr"
                value={checkOut}
                onChange={(event) => {
                  setCheckOut(event.target.value);
                }}
              />
            </Field>

            <Field label={t('attendance.correction_mode')}>
              <Select
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value as WorkMode | '');
                }}
              >
                <option value="">{t('attendance.all_modes')}</option>
                {WORK_MODES.map((value) => (
                  <option key={value} value={value}>
                    {t(`attendance.mode.${value}`)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label={t('attendance.correction_reason')}
              required
              helper={t('attendance.correction_reason_helper')}
              {...optionalError(issues['reason'])}
            >
              <Input
                value={reason}
                maxLength={1000}
                required
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            </Field>

            <Button type="submit" size="lg" loading={saving}>
              {t('attendance.correction_submit')}
            </Button>
          </form>
        </>
      ) : null}
    </Card>
  );
}
