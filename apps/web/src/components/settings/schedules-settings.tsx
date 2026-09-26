'use client';

import { useCallback, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchMany, fetchOne, issueKeys } from '../../lib/api-client';
import type { CollectionResult } from '../../lib/api-client';
import { DEFAULT_PER_PAGE, pageFromParams, withPage } from '../../lib/paging';
import { blankWeek, toRequestDays, toWeek, weekIssues, withDay } from '../../lib/schedule-week';
import type { WeekDay } from '../../lib/schedule-week';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Toggle,
} from '../design-system';
import {
  Cell,
  describeError,
  ErrorState,
  LoadingState,
  Ltr,
  optionalError,
  Pagination,
  SuccessNotice,
} from './screen-states';
import { SettingsHeading } from './settings-shell';
import { useResource } from './use-resource';

/**
 * `/admin/settings/schedules` — DOCUMENT 04 B25: "Working schedule templates:
 * working days, start/end times, break, grace period, overtime rule,
 * holidays." Holidays live on this screen because that is where DOCUMENT 04
 * puts them, not as a section invented here.
 *
 * This is the screen DOCUMENT 27 RULE 12 is about. The week editor starts
 * blank — seven days, none of them working, no hours — because a pre-filled
 * "Sunday to Thursday, nine to five" is a hardcoded working week no matter how
 * convenient it looks in a form. The admin states the week; the system has no
 * opinion about it.
 *
 * Two collections on one screen means two page parameters, so paging one list
 * never resets the other (DOCUMENT 11 §6 — pagination lives in the URL).
 */

const SCHEDULES_PAGE_KEY = 'schedules_page';
const HOLIDAYS_PAGE_KEY = 'holidays_page';

const OVERTIME_POLICIES = ['none', 'paid', 'banked'] as const;

interface SchedulePayload {
  readonly id: string;
  readonly name: string;
  readonly is_default: boolean;
  readonly timezone: string;
  readonly grace_period_minutes: number;
  readonly half_day_threshold_hours: string;
  readonly overtime_policy: string;
  readonly break_minutes: number;
  readonly days: readonly WeekDay[];
}

interface HolidayPayload {
  readonly id: string;
  readonly date: string;
  readonly name_ar: string;
  readonly name_en: string;
  readonly is_recurring: boolean;
}

interface CompanyDefaults {
  readonly timezone: string;
}

interface ScreenData {
  readonly schedules: CollectionResult<SchedulePayload>;
  readonly holidays: CollectionResult<HolidayPayload>;
  readonly company: CompanyDefaults;
}

interface ScheduleForm {
  name: string;
  is_default: boolean;
  timezone: string;
  grace_period_minutes: string;
  half_day_threshold_hours: string;
  overtime_policy: string;
  break_minutes: string;
  days: WeekDay[];
}

interface HolidayForm {
  date: string;
  name_ar: string;
  name_en: string;
  is_recurring: boolean;
}

const EMPTY_HOLIDAY: HolidayForm = { date: '', name_ar: '', name_en: '', is_recurring: false };

/**
 * A new schedule's starting point. Every value is either empty or the one
 * DOCUMENT 06 §3.7 gives the column as its own default — nothing about the
 * working week is filled in. `timezone` is seeded from the company's own zone
 * because the column is required and the company's zone is the only value the
 * system already knows; the admin can change it, and it is not a default the
 * *code* invented.
 */
function newSchedule(company: CompanyDefaults): ScheduleForm {
  return {
    name: '',
    is_default: false,
    timezone: company.timezone,
    grace_period_minutes: '0',
    half_day_threshold_hours: '',
    overtime_policy: 'none',
    break_minutes: '0',
    days: blankWeek(),
  };
}

function toForm(schedule: SchedulePayload): ScheduleForm {
  return {
    name: schedule.name,
    is_default: schedule.is_default,
    timezone: schedule.timezone,
    grace_period_minutes: String(schedule.grace_period_minutes),
    half_day_threshold_hours: schedule.half_day_threshold_hours,
    overtime_policy: schedule.overtime_policy,
    break_minutes: String(schedule.break_minutes),
    days: toWeek(schedule.days),
  };
}

type Editing = { readonly mode: 'create' } | { readonly mode: 'edit'; readonly id: string };

export function SchedulesSettings({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams?.toString() ?? '');
  const schedulesPage = pageFromParams(params, SCHEDULES_PAGE_KEY);
  const holidaysPage = pageFromParams(params, HOLIDAYS_PAGE_KEY);

  const load = useCallback(
    async (signal: AbortSignal): Promise<ScreenData> => {
      const [schedules, holidays, company] = await Promise.all([
        fetchMany<SchedulePayload>('/work-schedules', {
          locale,
          signal,
          query: { page: String(schedulesPage), per_page: String(DEFAULT_PER_PAGE) },
        }),
        fetchMany<HolidayPayload>('/holidays', {
          locale,
          signal,
          query: { page: String(holidaysPage), per_page: String(DEFAULT_PER_PAGE) },
        }),
        fetchOne<CompanyDefaults>('/company', { locale, signal }),
      ]);
      return { schedules, holidays, company };
    },
    [locale, schedulesPage, holidaysPage],
  );
  const { state, reload } = useResource<ScreenData>(load);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [scheduleForm, setScheduleForm] = useState<ScheduleForm | null>(null);
  const [holidayOpen, setHolidayOpen] = useState(false);
  const [holidayForm, setHolidayForm] = useState<HolidayForm>(EMPTY_HOLIDAY);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const heading = (
    <SettingsHeading
      title={t('settings.schedules')}
      description={t('settings.schedules_description')}
    />
  );

  if (state.status === 'loading') {
    return (
      <>
        {heading}
        <LoadingState t={t} rows={8} />
      </>
    );
  }

  if (state.status === 'error') {
    return (
      <>
        {heading}
        <ErrorState error={state.error} t={t} onRetry={reload} />
      </>
    );
  }

  const { schedules, holidays, company } = state.value;

  const issueFor = (field: string): string | undefined => {
    const key = fieldIssues[field];
    return key === undefined ? undefined : t(key);
  };

  const resetForm = (): void => {
    setFieldIssues({});
    setFormError(null);
    setNotice(null);
  };

  const openCreateSchedule = (): void => {
    setEditing({ mode: 'create' });
    setScheduleForm(newSchedule(company));
    resetForm();
  };

  const openEditSchedule = (schedule: SchedulePayload): void => {
    setEditing({ mode: 'edit', id: schedule.id });
    setScheduleForm(toForm(schedule));
    resetForm();
  };

  const closeSchedule = (): void => {
    setEditing(null);
    setScheduleForm(null);
    setFieldIssues({});
    setFormError(null);
  };

  const localIssues = scheduleForm === null ? new Map() : weekIssues(scheduleForm.days);

  const submitSchedule = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (editing === null || scheduleForm === null) {
      return;
    }
    // The client check is a convenience; the server validates again regardless
    // (DOCUMENT 08 §5.1). Stopping here just saves a round trip and keeps the
    // message beside the day it is about.
    if (localIssues.size > 0) {
      setFormError(t('validation.generic'));
      return;
    }

    setSaving(true);
    setFieldIssues({});
    setFormError(null);

    const body = {
      name: scheduleForm.name,
      is_default: scheduleForm.is_default,
      timezone: scheduleForm.timezone,
      grace_period_minutes: scheduleForm.grace_period_minutes,
      half_day_threshold_hours: scheduleForm.half_day_threshold_hours,
      overtime_policy: scheduleForm.overtime_policy,
      break_minutes: scheduleForm.break_minutes,
      days: toRequestDays(scheduleForm.days),
    };

    const request =
      editing.mode === 'create'
        ? fetchOne<SchedulePayload>('/work-schedules', { locale, method: 'POST', body })
        : fetchOne<SchedulePayload>(`/work-schedules/${editing.id}`, {
            locale,
            method: 'PATCH',
            body,
          });

    request
      .then(() => {
        const created = editing.mode === 'create';
        closeSchedule();
        setNotice(created ? t('state.created') : t('state.success'));
        reload();
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
          setFieldIssues(issueKeys(error));
          setFormError(t('validation.generic'));
          return;
        }
        setFormError(describeError(error, t));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const submitHoliday = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSaving(true);
    setFieldIssues({});
    setFormError(null);

    fetchOne<HolidayPayload>('/holidays', {
      locale,
      method: 'POST',
      body: holidayForm,
    })
      .then(() => {
        setHolidayOpen(false);
        setNotice(t('state.created'));
        reload();
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
          setFieldIssues(issueKeys(error));
          setFormError(t('validation.generic'));
          return;
        }
        setFormError(describeError(error, t));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const hrefFor = (key: string) => (next: number) =>
    `${pathname ?? ''}${withPage(params, key, next)}`;

  const addSchedule = <Button onClick={openCreateSchedule}>{t('settings.add_schedule')}</Button>;
  const addHoliday = (
    <Button
      onClick={() => {
        setHolidayOpen(true);
        setHolidayForm(EMPTY_HOLIDAY);
        resetForm();
      }}
    >
      {t('settings.add_holiday')}
    </Button>
  );

  return (
    <>
      {heading}
      <SuccessNotice message={notice} t={t} />

      <Alert tone="warning" title={t('settings.historical_warning_title')}>
        {t('settings.historical_warning')}
      </Alert>

      {schedules.items.length === 0 ? (
        <EmptyState
          title={t('settings.no_schedules')}
          description={t('settings.no_schedules_description')}
          action={addSchedule}
        />
      ) : (
        <Card title={t('settings.schedules')} action={addSchedule}>
          <DataTable
            headers={[
              t('settings.schedule_name'),
              t('settings.working_days'),
              t('settings.timezone'),
              t('settings.grace_period_minutes'),
              t('settings.overtime_policy'),
              t('settings.actions'),
            ]}
            rows={schedules.items.map((schedule) => [
              <Cell key="name" label={t('settings.schedule_name')}>
                {schedule.name}
                {schedule.is_default ? (
                  <>
                    {' '}
                    <Badge tone="success">{t('settings.is_default')}</Badge>
                  </>
                ) : null}
              </Cell>,
              <Cell key="days" label={t('settings.working_days')}>
                {summariseWeek(schedule.days, t)}
              </Cell>,
              <Cell key="tz" label={t('settings.timezone')}>
                <Ltr>{schedule.timezone}</Ltr>
              </Cell>,
              <Cell key="grace" label={t('settings.grace_period_minutes')}>
                <Ltr>{schedule.grace_period_minutes}</Ltr>
              </Cell>,
              <Cell key="ot" label={t('settings.overtime_policy')}>
                {t(`settings.overtime_${schedule.overtime_policy}`)}
              </Cell>,
              <Cell key="actions" label={t('settings.actions')}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    openEditSchedule(schedule);
                  }}
                >
                  {t('settings.edit')}
                </Button>
              </Cell>,
            ])}
          />
          <Pagination
            page={schedules.meta.page}
            totalPages={schedules.meta.total_pages}
            hrefForPage={hrefFor(SCHEDULES_PAGE_KEY)}
            t={t}
          />
        </Card>
      )}

      {holidays.items.length === 0 ? (
        <EmptyState
          title={t('settings.no_holidays')}
          description={t('settings.no_holidays_description')}
          action={addHoliday}
        />
      ) : (
        <Card title={t('settings.holidays')} action={addHoliday}>
          <DataTable
            headers={[
              t('settings.date'),
              t('settings.name_ar'),
              t('settings.name_en'),
              t('settings.is_recurring'),
            ]}
            rows={holidays.items.map((holiday) => [
              <Cell key="date" label={t('settings.date')}>
                {/* An ISO date is a Latin token and stays LTR — DOCUMENT 10 §9.7. */}
                <Ltr>{holiday.date}</Ltr>
              </Cell>,
              <Cell key="ar" label={t('settings.name_ar')}>
                {holiday.name_ar}
              </Cell>,
              <Cell key="en" label={t('settings.name_en')}>
                {holiday.name_en}
              </Cell>,
              <Cell key="recurring" label={t('settings.is_recurring')}>
                <Badge tone={holiday.is_recurring ? 'info' : 'cancelled'}>
                  {holiday.is_recurring ? t('action.confirm') : t('settings.none')}
                </Badge>
              </Cell>,
            ])}
          />
          <Pagination
            page={holidays.meta.page}
            totalPages={holidays.meta.total_pages}
            hrefForPage={hrefFor(HOLIDAYS_PAGE_KEY)}
            t={t}
          />
        </Card>
      )}

      <Modal
        open={editing !== null && scheduleForm !== null}
        title={editing?.mode === 'edit' ? t('settings.edit_schedule') : t('settings.add_schedule')}
        onClose={closeSchedule}
        closeLabel={t('action.close')}
      >
        {scheduleForm === null ? null : (
          <form className="settings-form" onSubmit={submitSchedule} noValidate>
            {formError === null ? null : (
              <div className="settings-form__summary">
                <Alert tone="danger" title={t('validation.generic_title')}>
                  {formError}
                </Alert>
              </div>
            )}

            <Field
              label={t('settings.schedule_name')}
              required
              {...optionalError(issueFor('name'))}
            >
              <Input
                value={scheduleForm.name}
                onChange={(event) => {
                  setScheduleForm({ ...scheduleForm, name: event.target.value });
                }}
                maxLength={200}
                required
              />
            </Field>

            <Field
              label={t('settings.timezone')}
              required
              helper={t('settings.timezone_helper')}
              {...optionalError(issueFor('timezone'))}
            >
              <Input
                dir="ltr"
                value={scheduleForm.timezone}
                onChange={(event) => {
                  setScheduleForm({ ...scheduleForm, timezone: event.target.value });
                }}
                maxLength={64}
                required
              />
            </Field>

            <Field
              label={t('settings.grace_period_minutes')}
              required
              helper={t('settings.grace_period_helper')}
              {...optionalError(issueFor('grace_period_minutes'))}
            >
              {/* Text, not `type="number"` — see the same field on the
                  company screen: a number input drops Arabic-Indic digits. */}
              <Input
                inputMode="numeric"
                dir="ltr"
                value={scheduleForm.grace_period_minutes}
                onChange={(event) => {
                  setScheduleForm({ ...scheduleForm, grace_period_minutes: event.target.value });
                }}
                required
              />
            </Field>

            <Field
              label={t('settings.half_day_threshold_hours')}
              required
              helper={t('settings.half_day_threshold_helper')}
              {...optionalError(issueFor('half_day_threshold_hours'))}
            >
              <Input
                inputMode="decimal"
                dir="ltr"
                value={scheduleForm.half_day_threshold_hours}
                onChange={(event) => {
                  setScheduleForm({
                    ...scheduleForm,
                    half_day_threshold_hours: event.target.value,
                  });
                }}
                required
              />
            </Field>

            <Field
              label={t('settings.break_minutes')}
              required
              {...optionalError(issueFor('break_minutes'))}
            >
              <Input
                inputMode="numeric"
                dir="ltr"
                value={scheduleForm.break_minutes}
                onChange={(event) => {
                  setScheduleForm({ ...scheduleForm, break_minutes: event.target.value });
                }}
                required
              />
            </Field>

            <Field
              label={t('settings.overtime_policy')}
              required
              {...optionalError(issueFor('overtime_policy'))}
            >
              <Select
                value={scheduleForm.overtime_policy}
                onChange={(event) => {
                  setScheduleForm({ ...scheduleForm, overtime_policy: event.target.value });
                }}
              >
                {OVERTIME_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>
                    {t(`settings.overtime_${policy}`)}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="settings-form__full">
              <Toggle
                label={t('settings.is_default')}
                checked={scheduleForm.is_default}
                onChange={(event) => {
                  setScheduleForm({ ...scheduleForm, is_default: event.target.checked });
                }}
              />
              <span className="field__helper">{t('settings.is_default_helper')}</span>
            </div>

            <fieldset className="week-editor settings-form__full">
              <legend>{t('settings.working_days')}</legend>
              <p className="field__helper">{t('settings.working_days_helper')}</p>

              {scheduleForm.days.map((day) => {
                const issue =
                  localIssues.get(day.day_of_week) ?? issueFor(`days.${String(day.day_of_week)}`);
                return (
                  <div className="week-editor__day" key={day.day_of_week}>
                    <Toggle
                      label={t(`settings.day_${String(day.day_of_week)}`)}
                      checked={day.is_working_day}
                      onChange={(event) => {
                        setScheduleForm({
                          ...scheduleForm,
                          days: withDay(scheduleForm.days, {
                            ...day,
                            is_working_day: event.target.checked,
                          }),
                        });
                      }}
                    />
                    <label className="week-editor__time">
                      <span className="field__label">{t('settings.start_time')}</span>
                      <Input
                        type="time"
                        dir="ltr"
                        value={day.start_time ?? ''}
                        disabled={!day.is_working_day}
                        onChange={(event) => {
                          setScheduleForm({
                            ...scheduleForm,
                            days: withDay(scheduleForm.days, {
                              ...day,
                              start_time: event.target.value === '' ? null : event.target.value,
                            }),
                          });
                        }}
                      />
                    </label>
                    <label className="week-editor__time">
                      <span className="field__label">{t('settings.end_time')}</span>
                      <Input
                        type="time"
                        dir="ltr"
                        value={day.end_time ?? ''}
                        disabled={!day.is_working_day}
                        onChange={(event) => {
                          setScheduleForm({
                            ...scheduleForm,
                            days: withDay(scheduleForm.days, {
                              ...day,
                              end_time: event.target.value === '' ? null : event.target.value,
                            }),
                          });
                        }}
                      />
                    </label>
                    {issue === undefined ? null : (
                      <span className="field__error" role="alert">
                        {typeof issue === 'string' && issue.startsWith('validation.')
                          ? t(issue)
                          : localIssueText(issue, t)}
                      </span>
                    )}
                  </div>
                );
              })}
            </fieldset>

            <div className="settings-form__actions">
              <Button type="submit" loading={saving}>
                {saving ? t('state.saving') : t('action.save')}
              </Button>
              <Button type="button" variant="ghost" onClick={closeSchedule}>
                {t('action.cancel')}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        open={holidayOpen}
        title={t('settings.add_holiday')}
        onClose={() => {
          setHolidayOpen(false);
        }}
        closeLabel={t('action.close')}
      >
        <form className="settings-form" onSubmit={submitHoliday} noValidate>
          {formError === null ? null : (
            <div className="settings-form__summary">
              <Alert tone="danger" title={t('validation.generic_title')}>
                {formError}
              </Alert>
            </div>
          )}

          <Field label={t('settings.date')} required {...optionalError(issueFor('date'))}>
            <Input
              type="date"
              dir="ltr"
              value={holidayForm.date}
              onChange={(event) => {
                setHolidayForm({ ...holidayForm, date: event.target.value });
              }}
              required
            />
          </Field>

          <Field label={t('settings.name_ar')} required {...optionalError(issueFor('name_ar'))}>
            <Input
              value={holidayForm.name_ar}
              onChange={(event) => {
                setHolidayForm({ ...holidayForm, name_ar: event.target.value });
              }}
              maxLength={200}
              required
            />
          </Field>

          <Field label={t('settings.name_en')} required {...optionalError(issueFor('name_en'))}>
            <Input
              value={holidayForm.name_en}
              onChange={(event) => {
                setHolidayForm({ ...holidayForm, name_en: event.target.value });
              }}
              maxLength={200}
              required
            />
          </Field>

          <div className="settings-form__full">
            <Toggle
              label={t('settings.is_recurring')}
              checked={holidayForm.is_recurring}
              onChange={(event) => {
                setHolidayForm({ ...holidayForm, is_recurring: event.target.checked });
              }}
            />
          </div>

          <div className="settings-form__actions">
            <Button type="submit" loading={saving}>
              {saving ? t('state.saving') : t('action.save')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setHolidayOpen(false);
              }}
            >
              {t('action.cancel')}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/**
 * The working days of a schedule, named — never "5 days a week", which would
 * be a summary of a week the reader still has to open the editor to see.
 *
 * The separator is translated too: Arabic uses `،` (U+060C) and English uses
 * `,`. A comma hardcoded in the component would be right in one language and
 * wrong in the other (DOCUMENT 27 RULE 25).
 */
function summariseWeek(days: readonly WeekDay[], t: Translator): string {
  const working = toWeek(days).filter((day) => day.is_working_day);
  if (working.length === 0) {
    return t('settings.none');
  }
  return working
    .map((day) => t(`settings.day_${String(day.day_of_week)}`))
    .join(t('settings.list_separator'));
}

function localIssueText(issue: string, t: Translator): string {
  return issue === 'required' ? t('validation.required') : t('validation.end_before_start');
}
