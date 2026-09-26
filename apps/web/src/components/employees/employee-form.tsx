'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchEnvelope, fetchMany, fetchOne } from '../../lib/api-client';
import {
  ASSIGNABLE_ROLES,
  createBody,
  employeeIssueKey,
  employeePath,
  employeesPath,
  emptyEmployeeForm,
  formFromEmployee,
  fullName,
  isDirty,
  updateBody,
} from '../../lib/employees';
import type { EmployeeFormValues, EmployeeView } from '../../lib/employees';
import { settingsPath } from '../../lib/settings-nav';
import { Alert, Button, EmptyState, Field, Input, Select, Toggle } from '../design-system';
import { describeError, ErrorState, LoadingState, optionalError } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { EmployeesBreadcrumb, EmployeesHeading } from './employees-shell';

/**
 * `/admin/employees/new` and `/admin/employees/:id/edit` — DOCUMENT 04 B3,
 * DOCUMENT 05 FLOW 02.
 *
 * Sections: Personal · Employment · Schedule · Access. DOCUMENT 04 B3's
 * Compensation and Leave sections arrive with Phases 11 and 10 (approved
 * decision); they are not rendered as disabled placeholders.
 *
 * - User input is preserved on failure — never cleared (DOCUMENT 11 §1.10).
 * - Field-level messages, plus a summary at the top (DOCUMENT 11 §4).
 * - An unsaved-changes warning when leaving a dirty form (DOCUMENT 11 §4).
 * - On mobile the sections become an accordion with a sticky save bar
 *   (DOCUMENT 04 B3), which is what `<details>` and `.form-actions` give.
 */

const OPTIONS_PAGE_SIZE = '100';

interface ScheduleOption {
  readonly id: string;
  readonly name: string;
  readonly is_default: boolean;
}
interface DepartmentOption {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string;
}
interface PositionOption {
  readonly id: string;
  readonly title_ar: string;
  readonly title_en: string;
}

interface FormData {
  readonly schedules: readonly ScheduleOption[];
  readonly departments: readonly DepartmentOption[];
  readonly positions: readonly PositionOption[];
  readonly managers: readonly EmployeeView[];
  readonly employee: EmployeeView | null;
}

export function EmployeeForm({
  locale,
  employeeId,
}: {
  readonly locale: Locale;
  /** Null to create. */
  readonly employeeId: string | null;
}): React.JSX.Element {
  const t = createTranslator(locale);

  const load = useCallback(
    async (signal: AbortSignal): Promise<FormData> => {
      const query = { per_page: OPTIONS_PAGE_SIZE };
      const [schedules, departments, positions, managers, employee] = await Promise.all([
        fetchMany<ScheduleOption>('/work-schedules', { locale, signal, query }),
        fetchMany<DepartmentOption>('/departments', { locale, signal, query }),
        fetchMany<PositionOption>('/positions', { locale, signal, query }),
        fetchMany<EmployeeView>('/employees', {
          locale,
          signal,
          query: { ...query, sort: 'name' },
        }),
        employeeId === null
          ? Promise.resolve(null)
          : fetchOne<EmployeeView>(`/employees/${employeeId}`, { locale, signal }),
      ]);
      return {
        schedules: schedules.items,
        departments: departments.items,
        positions: positions.items,
        managers: managers.items,
        employee,
      };
    },
    [locale, employeeId],
  );
  const { state, reload } = useResource<FormData>(load);

  const title = employeeId === null ? t('employees.new_title') : t('employees.edit');
  const breadcrumb = (name: string | null): React.JSX.Element => (
    <EmployeesBreadcrumb
      label={t('employees.title')}
      items={[
        { label: t('employees.title'), href: employeesPath(locale) },
        ...(employeeId !== null && name !== null
          ? [{ label: name, href: employeePath(locale, employeeId) }]
          : []),
        { label: title },
      ]}
    />
  );

  if (state.status === 'loading') {
    return (
      <>
        {breadcrumb(null)}
        <EmployeesHeading title={title} />
        <LoadingState t={t} rows={12} />
      </>
    );
  }

  if (state.status === 'error') {
    return (
      <>
        {breadcrumb(null)}
        <EmployeesHeading title={title} />
        {state.error.status === 404 ? (
          <EmptyState
            title={t('employees.not_found_title')}
            description={t('employees.not_found')}
            action={
              <Link className="button button--secondary button--md" href={employeesPath(locale)}>
                {t('employees.back_to_list')}
              </Link>
            }
          />
        ) : (
          <ErrorState error={state.error} t={t} onRetry={reload} />
        )}
      </>
    );
  }

  const data = state.value;

  // Every employee needs a schedule (DOCUMENT 06 §3.6, NOT NULL), and nothing
  // in the system supplies one (DOCUMENT 27 RULE 12). The empty state points
  // at the screen that resolves it.
  if (data.employee === null && data.schedules.length === 0) {
    return (
      <>
        {breadcrumb(null)}
        <EmployeesHeading title={title} />
        <EmptyState
          title={t('employees.no_schedules_title')}
          description={t('employees.no_schedules')}
          action={
            <Link
              className="button button--primary button--md"
              href={settingsPath(locale, 'schedules')}
            >
              {t('employees.open_schedules')}
            </Link>
          }
        />
      </>
    );
  }

  return (
    <>
      {breadcrumb(data.employee === null ? null : fullName(data.employee))}
      <EmployeesHeading title={title} />
      <EmployeeFormBody locale={locale} t={t} data={data} />
    </>
  );
}

function EmployeeFormBody({
  locale,
  t,
  data,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly data: FormData;
}): React.JSX.Element {
  const router = useRouter();
  const editing = data.employee;
  const [initial] = useState<EmployeeFormValues>(() =>
    editing === null
      ? emptyEmployeeForm(data.schedules.find((schedule) => schedule.is_default)?.id ?? null)
      : formFromEmployee(editing),
  );
  const [values, setValues] = useState<EmployeeFormValues>(initial);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [fieldIssues, setFieldIssues] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const dirty = isDirty(initial, values);

  // DOCUMENT 11 §4: "unsaved-changes warning when navigating away from a
  // dirty form". The browser's own prompt covers reloads and closed tabs.
  useEffect(() => {
    if (!dirty || leaving) {
      return;
    }
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [dirty, leaving]);

  const set = <K extends keyof EmployeeFormValues>(key: K, value: EmployeeFormValues[K]): void => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const issueFor = (field: string): string | undefined => {
    const key = fieldIssues[field];
    return key === undefined ? undefined : t(key);
  };

  const cancelHref = editing === null ? employeesPath(locale) : employeePath(locale, editing.id);

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSaving(true);
    setFieldIssues({});
    setFormError(null);

    const request =
      editing === null
        ? fetchEnvelope<EmployeeView, { invitation_delivery: string }>('/employees', {
            locale,
            method: 'POST',
            body: createBody(values),
          }).then(({ data: created, meta }) => {
            setLeaving(true);
            router.push(
              `${employeePath(locale, created.id)}?notice=created&invitation=${meta.invitation_delivery}`,
            );
          })
        : fetchOne<EmployeeView>(`/employees/${editing.id}`, {
            locale,
            method: 'PATCH',
            body: updateBody(initial, values),
          }).then((saved) => {
            setLeaving(true);
            router.push(`${employeePath(locale, saved.id)}?notice=saved`);
          });

    request
      .catch((error: unknown) => {
        if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
          const issues: Record<string, string> = {};
          for (const field of Object.keys(error.fields)) {
            const key = employeeIssueKey(field, error);
            if (key !== null) {
              issues[field] = key;
            }
          }
          setFieldIssues(issues);
          setFormError(t('validation.generic'));
          return;
        }
        setFormError(describeError(error, t));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const localized = (ar: string, en: string): string => (locale === 'en' ? en : ar);
  const managerOptions = data.managers.filter((manager) => manager.id !== editing?.id);
  const optionalLabel = (key: string): string => `${t(key)} ${t('employees.optional')}`;

  return (
    <form className="employee-form" onSubmit={submit} noValidate>
      {formError === null ? null : (
        <Alert tone="danger" title={t('validation.generic_title')}>
          {formError}
        </Alert>
      )}

      <FormSection title={t('employees.section_personal')}>
        <Field
          label={t('employees.first_name')}
          required
          {...optionalError(issueFor('first_name'))}
        >
          <Input
            value={values.first_name}
            maxLength={100}
            required
            autoComplete="off"
            onChange={(event) => {
              set('first_name', event.target.value);
            }}
          />
        </Field>
        <Field label={t('employees.last_name')} required {...optionalError(issueFor('last_name'))}>
          <Input
            value={values.last_name}
            maxLength={100}
            required
            autoComplete="off"
            onChange={(event) => {
              set('last_name', event.target.value);
            }}
          />
        </Field>
        <Field
          label={t('employees.email')}
          required
          helper={t('employees.email_helper')}
          {...optionalError(issueFor('email'))}
        >
          <Input
            type="email"
            dir="ltr"
            value={values.email}
            maxLength={255}
            required
            autoComplete="off"
            onChange={(event) => {
              set('email', event.target.value);
            }}
          />
        </Field>
        <Field label={optionalLabel('employees.phone')} {...optionalError(issueFor('phone'))}>
          <Input
            type="tel"
            dir="ltr"
            inputMode="tel"
            value={values.phone}
            maxLength={32}
            onChange={(event) => {
              set('phone', event.target.value);
            }}
          />
        </Field>
      </FormSection>

      <FormSection title={t('employees.section_employment')}>
        <Field
          label={t('employees.employee_code')}
          required
          {...optionalError(issueFor('employee_code'))}
        >
          <Input
            dir="ltr"
            value={values.employee_code}
            maxLength={50}
            required
            onChange={(event) => {
              set('employee_code', event.target.value);
            }}
          />
        </Field>
        <Field
          label={optionalLabel('employees.department')}
          {...optionalError(issueFor('department_id'))}
        >
          <Select
            value={values.department_id}
            onChange={(event) => {
              set('department_id', event.target.value);
            }}
          >
            <option value="">{t('employees.none')}</option>
            {data.departments.map((department) => (
              <option key={department.id} value={department.id}>
                {localized(department.name_ar, department.name_en)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={optionalLabel('employees.position')}
          {...optionalError(issueFor('position_id'))}
        >
          <Select
            value={values.position_id}
            onChange={(event) => {
              set('position_id', event.target.value);
            }}
          >
            <option value="">{t('employees.none')}</option>
            {data.positions.map((position) => (
              <option key={position.id} value={position.id}>
                {localized(position.title_ar, position.title_en)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={optionalLabel('employees.manager')}
          {...optionalError(issueFor('manager_id'))}
        >
          <Select
            value={values.manager_id}
            onChange={(event) => {
              set('manager_id', event.target.value);
            }}
          >
            <option value="">{t('employees.none')}</option>
            {managerOptions.map((manager) => (
              <option key={manager.id} value={manager.id}>
                {fullName(manager)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t('employees.joining_date')}
          required
          {...optionalError(issueFor('joining_date'))}
        >
          <Input
            type="date"
            dir="ltr"
            value={values.joining_date}
            required
            onChange={(event) => {
              set('joining_date', event.target.value);
            }}
          />
        </Field>
      </FormSection>

      <FormSection title={t('employees.section_schedule')}>
        <Field
          label={t('employees.work_schedule')}
          required
          helper={t('employees.work_schedule_helper')}
          {...optionalError(issueFor('work_schedule_id'))}
        >
          <Select
            value={values.work_schedule_id}
            required
            onChange={(event) => {
              set('work_schedule_id', event.target.value);
            }}
          >
            <option value="" disabled>
              {t('employees.work_schedule')}
            </option>
            {data.schedules.map((schedule) => (
              <option key={schedule.id} value={schedule.id}>
                {schedule.name}
              </option>
            ))}
          </Select>
        </Field>
      </FormSection>

      <FormSection title={t('employees.section_access')}>
        <Field
          label={t('employees.role')}
          required
          {...(editing === null ? {} : { helper: t('employees.role_helper') })}
          {...optionalError(issueFor('role_key'))}
        >
          <Select
            value={values.role_key}
            required
            onChange={(event) => {
              set('role_key', event.target.value as EmployeeFormValues['role_key']);
            }}
          >
            <option value="" disabled>
              {t('employees.role')}
            </option>
            {ASSIGNABLE_ROLES.map((role) => (
              <option key={role} value={role}>
                {t(`employees.role_${role}`)}
              </option>
            ))}
          </Select>
        </Field>
        {editing === null ? (
          <div className="settings-form__full">
            <Toggle
              label={t('employees.send_invitation')}
              checked={values.send_invitation}
              onChange={(event) => {
                set('send_invitation', event.target.checked);
              }}
            />
            <p className="field__helper">{t('employees.send_invitation_helper')}</p>
          </div>
        ) : null}
      </FormSection>

      <div className="form-actions">
        <Button type="submit" loading={saving}>
          {saving ? t('state.saving') : t('action.save')}
        </Button>
        <Link
          className="button button--ghost button--md"
          href={cancelHref}
          onClick={(event) => {
            if (dirty && !window.confirm(t('employees.unsaved_changes'))) {
              event.preventDefault();
              return;
            }
            setLeaving(true);
          }}
        >
          {t('action.cancel')}
        </Link>
      </div>
    </form>
  );
}

/** A form section — a `<details>` so it collapses into an accordion on narrow screens. */
function FormSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <details className="form-section" open>
      <summary>{title}</summary>
      <div className="settings-form">{children}</div>
    </details>
  );
}
