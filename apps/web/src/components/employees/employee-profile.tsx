'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { createTranslator, formatDate, formatDateTime } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchEnvelope, fetchOne } from '../../lib/api-client';
import {
  canInvite,
  editEmployeePath,
  employeePath,
  employeesPath,
  fullName,
  initials,
  invitationState,
  statusTone,
  visibleTabs,
} from '../../lib/employees';
import type { EmployeeTab, EmployeeView } from '../../lib/employees';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal } from '../design-system';
import {
  describeError,
  ErrorState,
  LoadingState,
  Ltr,
  optionalError,
  SuccessNotice,
} from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { EmployeeGoals } from '../goals/employee-goals';
import { EmployeeRequests } from '../requests/employee-requests';
import { LeaveBalancesCard } from '../leave/leave-balances-card';
import { EmployeeTasks } from '../tasks/employee-tasks';
import { newGoalPath } from '../../lib/goals';
import { newTaskPath } from '../../lib/tasks';

import { EmployeeHistory } from './employee-history';
import { EmployeesBreadcrumb } from './employees-shell';
import { PerformanceSnapshot } from './performance-snapshot';
import { loadSession } from './use-session';
import type { SessionView } from './use-session';

/**
 * `/admin/employees/:id` and its tabs — DOCUMENT 04 B4.
 *
 * Header: avatar, name, ID, department, position, manager, status, joining
 * date, and the quick actions this phase can perform — edit, deactivate or
 * activate, resend the invitation, and — from Phase 7 — "Assign task" for a
 * caller holding `task.create` while the employee is active (the API refuses
 * an inactive assignee and one outside the caller's scope again) and — from
 * Phase 8 — "Assign goal" on the same terms with `goal.create`.
 *
 * Tabs: all seven. The Tasks tab lists this employee's tasks (Phase 7,
 * `employee-tasks.tsx`), the Goals tab their goal cards (Phase 8,
 * `employee-goals.tsx`), and the Overview carries the performance snapshot
 * for a caller holding `report.employee_monthly` (Phase 8). DOCUMENT 25 Phase 5 allows the later-phase tabs to be
 * empty; each one shows the honest empty state for data that does not exist
 * yet, never sample data (DOCUMENT 27 RULE 26). Tab visibility follows
 * permissions, and a tab the caller may not see is refused here as well as by
 * the API that will serve it.
 *
 * The overview also carries DOCUMENT 21's employee history panel for a caller
 * holding `audit.view` (see `employee-history.tsx`).
 */

interface ProfileData {
  readonly employee: EmployeeView;
  readonly session: SessionView;
}

export function EmployeeProfile({
  locale,
  employeeId,
  tab,
}: {
  readonly locale: Locale;
  readonly employeeId: string;
  readonly tab: EmployeeTab;
}): React.JSX.Element {
  const t = createTranslator(locale);

  const load = useCallback(
    async (signal: AbortSignal): Promise<ProfileData> => {
      const [employee, session] = await Promise.all([
        fetchOne<EmployeeView>(`/employees/${employeeId}`, { locale, signal }),
        loadSession(locale, signal),
      ]);
      return { employee, session };
    },
    [locale, employeeId],
  );
  const { state, reload, replace } = useResource<ProfileData>(load);

  const rootCrumb = { label: t('employees.title'), href: employeesPath(locale) };

  if (state.status === 'loading') {
    return (
      <>
        <EmployeesBreadcrumb label={t('employees.title')} items={[rootCrumb]} />
        <LoadingState t={t} rows={10} />
      </>
    );
  }

  if (state.status === 'error') {
    return (
      <>
        <EmployeesBreadcrumb label={t('employees.title')} items={[rootCrumb]} />
        {state.error.status === 404 || state.error.status === 403 ? (
          // 404 (not in this company) and 403 (outside the caller's scope)
          // read the same to a person: this employee is not available to you.
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

  return (
    <ProfileBody
      locale={locale}
      t={t}
      data={state.value}
      tab={tab}
      onEmployeeChange={(employee) => {
        replace({ ...state.value, employee });
      }}
    />
  );
}

type Dialog = 'deactivate' | 'activate' | null;

function ProfileBody({
  locale,
  t,
  data,
  tab,
  onEmployeeChange,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly data: ProfileData;
  readonly tab: EmployeeTab;
  readonly onEmployeeChange: (employee: EmployeeView) => void;
}): React.JSX.Element {
  const { employee, session } = data;
  const searchParams = useSearchParams();
  const name = fullName(employee);
  const permissions = session.permissions;
  // DOCUMENT 04 B4 quick action. An inactive employee cannot be assigned work
  // (DOCUMENT 13 validation), so the action is not offered for one.
  const assignTask =
    permissions.has('task.create') && employee.status === 'active' ? (
      <Link className="button button--secondary button--md" href={newTaskPath(locale, employee.id)}>
        {t('employees.assign_task')}
      </Link>
    ) : null;
  // DOCUMENT 04 B4 "assign goal" — the same rule: an owner must be active.
  const assignGoal =
    permissions.has('goal.create') && employee.status === 'active' ? (
      <Link className="button button--secondary button--md" href={newGoalPath(locale, employee.id)}>
        {t('employees.assign_goal')}
      </Link>
    ) : null;
  const tabs = visibleTabs(permissions);

  // A notice carried from the create/edit form (DOCUMENT 11 §2, success:
  // "the user lands somewhere useful").
  const arrivedWith = searchParams?.get('notice') ?? null;
  const arrivedInvitation = searchParams?.get('invitation') ?? null;
  const initialNotice =
    arrivedWith === 'created'
      ? arrivedInvitation === 'sent' && employee.email !== null
        ? `${t('employees.created_notice')} — ${t('employees.invitation_sent_notice', { email: employee.email })}`
        : t('employees.created_notice')
      : arrivedWith === 'saved'
        ? t('employees.saved_notice')
        : null;

  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [invitationFailed, setInvitationFailed] = useState(arrivedInvitation === 'failed');
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState('');
  const [reasonIssue, setReasonIssue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startAction = (): void => {
    setBusy(true);
    setNotice(null);
    setActionError(null);
    setInvitationFailed(false);
  };

  const deactivate = (): void => {
    if (reason.trim() === '') {
      setReasonIssue(t('validation.required'));
      return;
    }
    startAction();
    fetchOne<EmployeeView>(`/employees/${employee.id}/deactivate`, {
      locale,
      method: 'POST',
      body: { reason },
    })
      .then((updated) => {
        onEmployeeChange(updated);
        setDialog(null);
        setReason('');
        setNotice(t('employees.deactivated_notice'));
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.fields['reason'] !== undefined) {
          setReasonIssue(t('validation.invalid'));
          return;
        }
        setActionError(describeError(error, t));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const activate = (): void => {
    startAction();
    fetchEnvelope<EmployeeView, { invitation_delivery: string }>(
      `/employees/${employee.id}/activate`,
      { locale, method: 'POST' },
    )
      .then(({ data: updated, meta }) => {
        onEmployeeChange(updated);
        setDialog(null);
        setNotice(t('employees.activated_notice'));
        setInvitationFailed(meta.invitation_delivery === 'failed');
      })
      .catch((error: unknown) => {
        setActionError(describeError(error, t));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const resend = (): void => {
    startAction();
    fetchOne<EmployeeView>(`/employees/${employee.id}/invite`, { locale, method: 'POST' })
      .then((updated) => {
        onEmployeeChange(updated);
        setNotice(t('employees.resent_notice'));
      })
      .catch((error: unknown) => {
        setActionError(describeError(error, t));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const localized = (ar: string, en: string): string => (locale === 'en' ? en : ar);
  const departmentName =
    employee.department === null
      ? t('employees.none')
      : localized(employee.department.name_ar, employee.department.name_en);
  const positionName =
    employee.position === null
      ? t('employees.none')
      : localized(employee.position.title_ar, employee.position.title_en);
  const joined = formatDate(new Date(`${employee.joining_date}T00:00:00.000Z`), {
    locale,
    timeZone: 'UTC',
  });

  return (
    <>
      <EmployeesBreadcrumb
        label={t('employees.title')}
        items={[{ label: t('employees.title'), href: employeesPath(locale) }, { label: name }]}
      />

      <SuccessNotice message={notice} t={t} />
      {invitationFailed ? (
        <Alert tone="warning" title={t('employees.invitation_failed_title')}>
          {t('employees.invitation_failed')}
        </Alert>
      ) : null}
      {actionError === null ? null : (
        <Alert tone="danger" title={t('state.action_blocked')}>
          {actionError}
        </Alert>
      )}

      <Card className="profile-header">
        <div className="profile-header__identity">
          <span className="avatar avatar--lg" aria-hidden="true">
            {initials(employee)}
          </span>
          <div>
            <h1>{name}</h1>
            <p className="profile-header__code">
              <Ltr>{employee.employee_code}</Ltr>
            </p>
            <Badge tone={statusTone(employee.status)}>
              {t(`employees.status_${employee.status}`)}
            </Badge>
          </div>
        </div>

        <dl className="detail-list profile-header__facts">
          <div>
            <dt>{t('employees.department')}</dt>
            <dd>{departmentName}</dd>
          </div>
          <div>
            <dt>{t('employees.position')}</dt>
            <dd>{positionName}</dd>
          </div>
          <div>
            <dt>{t('employees.manager')}</dt>
            <dd>
              {employee.manager === null ? (
                t('employees.none')
              ) : (
                <Link href={employeePath(locale, employee.manager.id)}>
                  {fullName(employee.manager)}
                </Link>
              )}
            </dd>
          </div>
          <div>
            <dt>{t('employees.joining_date')}</dt>
            <dd>
              <Ltr>{joined}</Ltr>
            </dd>
          </div>
        </dl>

        <div className="profile-header__actions">
          {assignTask}
          {assignGoal}
          {permissions.has('employee.update') ? (
            <Link
              className="button button--secondary button--md"
              href={editEmployeePath(locale, employee.id)}
            >
              {t('settings.edit')}
            </Link>
          ) : null}
          {permissions.has('employee.create') && canInvite(employee) ? (
            <Button variant="secondary" loading={busy && dialog === null} onClick={resend}>
              {invitationState(employee, new Date()) === 'not_sent'
                ? t('employees.send_invitation_action')
                : t('employees.resend_invitation')}
            </Button>
          ) : null}
          {permissions.has('employee.deactivate') && employee.status === 'active' ? (
            <Button
              variant="destructive-ghost"
              onClick={() => {
                setReason('');
                setReasonIssue(null);
                setActionError(null);
                setDialog('deactivate');
              }}
            >
              {t('employees.deactivate')}
            </Button>
          ) : null}
          {permissions.has('employee.deactivate') && employee.status === 'inactive' ? (
            <Button
              variant="secondary"
              onClick={() => {
                setActionError(null);
                setDialog('activate');
              }}
            >
              {t('employees.activate')}
            </Button>
          ) : null}
        </div>
      </Card>

      <nav className="tabs" aria-label={t('employees.tabs_label')}>
        {tabs.map((candidate) => (
          <Link
            key={candidate}
            href={employeePath(locale, employee.id, candidate)}
            className={candidate === tab ? 'is-active' : ''}
            {...(candidate === tab ? { 'aria-current': 'page' as const } : {})}
          >
            {t(`employees.tab_${candidate}`)}
          </Link>
        ))}
      </nav>

      <section className="tab-panel">
        {!tabs.includes(tab) ? (
          <Alert tone="danger" title={t('state.action_blocked')}>
            {t('error.forbidden')}
          </Alert>
        ) : tab === 'overview' ? (
          <>
            <Overview locale={locale} t={t} employee={employee} timeZone={session.timeZone} />
            {permissions.has('report.employee_monthly') ? (
              <PerformanceSnapshot locale={locale} t={t} employeeId={employee.id} />
            ) : null}
            {/* B4 Overview: "leave balance" (Phase 10). */}
            {permissions.has('leave.view') ? (
              <LeaveBalancesCard locale={locale} t={t} employeeId={employee.id} />
            ) : null}
            {/* DOCUMENT 21 "UI" — the record's audit trail inline, for a
                caller who may read the audit log (ADMIN only in V1). */}
            {permissions.has('audit.view') ? (
              <EmployeeHistory
                locale={locale}
                t={t}
                employeeId={employee.id}
                timeZone={session.timeZone}
              />
            ) : null}
          </>
        ) : tab === 'tasks' ? (
          <EmployeeTasks
            locale={locale}
            t={t}
            employeeId={employee.id}
            timeZone={session.timeZone}
            assignAction={assignTask}
          />
        ) : tab === 'goals' ? (
          <EmployeeGoals
            locale={locale}
            t={t}
            employeeId={employee.id}
            timeZone={session.timeZone}
            assignAction={assignGoal}
          />
        ) : tab === 'requests' ? (
          <EmployeeRequests
            locale={locale}
            t={t}
            employeeId={employee.id}
            timeZone={session.timeZone}
          />
        ) : (
          <EmptyState
            title={t(`employees.${tab}_empty_title`)}
            description={t(`employees.${tab}_empty`)}
            action={null}
          />
        )}
      </section>

      <Modal
        open={dialog === 'deactivate'}
        title={t('employees.deactivate_title', { name })}
        onClose={() => {
          setDialog(null);
        }}
        closeLabel={t('action.close')}
        footer={
          <div className="settings-form__actions">
            <Button variant="destructive" loading={busy} onClick={deactivate}>
              {t('employees.deactivate_confirm')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDialog(null);
              }}
            >
              {t('action.cancel')}
            </Button>
          </div>
        }
      >
        <p>{t('employees.deactivate_body', { name })}</p>
        <Field
          label={t('employees.deactivate_reason')}
          required
          helper={t('employees.deactivate_reason_helper')}
          {...optionalError(reasonIssue ?? undefined)}
        >
          <Input
            value={reason}
            maxLength={500}
            required
            onChange={(event) => {
              setReason(event.target.value);
              setReasonIssue(null);
            }}
          />
        </Field>
        {actionError === null ? null : (
          <Alert tone="danger" title={t('state.action_blocked')}>
            {actionError}
          </Alert>
        )}
      </Modal>

      <Modal
        open={dialog === 'activate'}
        title={t('employees.activate_title', { name })}
        onClose={() => {
          setDialog(null);
        }}
        closeLabel={t('action.close')}
        footer={
          <div className="settings-form__actions">
            <Button loading={busy} onClick={activate}>
              {t('employees.activate_confirm')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDialog(null);
              }}
            >
              {t('action.cancel')}
            </Button>
          </div>
        }
      >
        <p>{t('employees.activate_body', { name })}</p>
        {actionError === null ? null : (
          <Alert tone="danger" title={t('state.action_blocked')}>
            {actionError}
          </Alert>
        )}
      </Modal>
    </>
  );
}

function Overview({
  locale,
  t,
  employee,
  timeZone,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly employee: EmployeeView;
  readonly timeZone: string;
}): React.JSX.Element {
  const state = invitationState(employee, new Date());
  return (
    <div className="profile-grid">
      <Card title={t('employees.details_title')}>
        <dl className="detail-list">
          <div>
            <dt>{t('employees.email')}</dt>
            <dd>{employee.email === null ? t('employees.none') : <Ltr>{employee.email}</Ltr>}</dd>
          </div>
          <div>
            <dt>{t('employees.phone')}</dt>
            <dd>{employee.phone === null ? t('employees.none') : <Ltr>{employee.phone}</Ltr>}</dd>
          </div>
          <div>
            <dt>{t('employees.work_schedule')}</dt>
            <dd>{employee.work_schedule.name}</dd>
          </div>
        </dl>
      </Card>

      <Card title={t('employees.account_title')}>
        {employee.account === null ? (
          <p>{t('employees.no_account')}</p>
        ) : (
          <dl className="detail-list">
            <div>
              <dt>{t('employees.role')}</dt>
              <dd>{t(`employees.role_${employee.account.role_key}`)}</dd>
            </div>
            <div>
              <dt>{t('employees.account_status')}</dt>
              <dd>
                <Badge
                  tone={
                    employee.account.status === 'active'
                      ? 'success'
                      : employee.account.status === 'invited'
                        ? 'warning'
                        : 'cancelled'
                  }
                >
                  {t(`employees.account_${employee.account.status}`)}
                </Badge>
              </dd>
            </div>
            {state === 'pending' && employee.account.invitation_expires_at !== null ? (
              <div>
                <dt>{t('employees.invitation_expires')}</dt>
                <dd>
                  <Ltr>
                    {formatDateTime(new Date(employee.account.invitation_expires_at), {
                      locale,
                      timeZone,
                    })}
                  </Ltr>
                </dd>
              </div>
            ) : null}
          </dl>
        )}
        {state === 'expired' ? (
          <Alert tone="warning" title={t('employees.account_invited')}>
            {t('employees.invitation_expired')}
          </Alert>
        ) : null}
        {state === 'not_sent' ? (
          <p className="field__helper">{t('employees.invitation_not_sent')}</p>
        ) : null}
      </Card>
    </div>
  );
}
