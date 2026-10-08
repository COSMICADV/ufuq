'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ApiError, fetchMany, fetchOne, issueKeys } from '../../lib/api-client';
import type { EmployeeView } from '../../lib/employees';
import {
  EMPTY_GOAL_FORM,
  GOAL_DESCRIPTION_MAX_LENGTH,
  GOAL_TITLE_MAX_LENGTH,
  GOAL_TYPES,
  GOAL_UNIT_MAX_LENGTH,
  createBody,
  formFromGoal,
  goalPath,
  goalsPath,
  goalTypeKey,
  periodIsValid,
  updateBody,
} from '../../lib/goals';
import type { GoalDetail, GoalForm as Draft, GoalType, GoalWriteResult } from '../../lib/goals';
import { TASK_PRIORITIES, priorityKey } from '../../lib/tasks';
import { Alert, Button, Card, Choice, Field, Input, Select, Textarea } from '../design-system';
import { describeError, ErrorState, LoadingState, optionalError } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

/**
 * Create / edit goal — DOCUMENT 04 B11 "Create form", DOCUMENT 05 FLOW 12.
 *
 * Type selector (Sales / Task / Custom), owner, target value and unit,
 * period, description and — for Task goals — the counting rule. The unit
 * depends on the type: a Sales goal's is the company currency (the API fills
 * it in), a Task goal counts tasks, and only a Custom goal's unit is typed.
 * Type and owner are fixed once a goal exists (DOCUMENT 14: "the goal stays
 * with the employee").
 *
 * The browser checks only what helps someone filling the form in; the API
 * enforces every rule again and its field errors are shown against the fields
 * they name. `?employee=<id>` preselects the owner — the employee profile's
 * "Assign goal" quick action.
 */

const OPTIONS_PAGE_SIZE = '100';

interface OwnerOption {
  readonly id: string;
  readonly label: string;
}

export function GoalForm({
  locale,
  goal,
  onSaved,
  onCancel,
}: {
  readonly locale: Locale;
  /** Null to create. */
  readonly goal: GoalDetail | null;
  /** Edit only: called with the saved goal instead of navigating. */
  readonly onSaved?: (goal: GoalWriteResult) => void;
  readonly onCancel?: () => void;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const creating = goal === null;

  const load = useCallback(
    async (signal: AbortSignal): Promise<readonly OwnerOption[]> => {
      if (!creating) {
        return [];
      }
      const employees = await fetchMany<EmployeeView>('/employees', {
        locale,
        signal,
        query: { per_page: OPTIONS_PAGE_SIZE, sort: 'name', status: 'active' },
      });
      return employees.items.map((e) => ({
        id: e.id,
        label: `${e.first_name} ${e.last_name}`.trim(),
      }));
    },
    [locale, creating],
  );
  const owners = useResource(load);

  const [draft, setDraft] = useState<Draft>(() =>
    goal === null
      ? { ...EMPTY_GOAL_FORM, priorities: [...EMPTY_GOAL_FORM.priorities] }
      : formFromGoal(goal),
  );
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const searchParams = useSearchParams();
  const requestedOwner = creating ? (searchParams?.get('employee') ?? '') : '';
  useEffect(() => {
    if (owners.state.status !== 'ready' || requestedOwner === '') {
      return;
    }
    if (owners.state.value.some((option) => option.id === requestedOwner)) {
      setDraft((current) =>
        current.employee_id === '' ? { ...current, employee_id: requestedOwner } : current,
      );
    }
  }, [owners.state, requestedOwner]);

  if (owners.state.status === 'loading') {
    return <LoadingState t={t} rows={8} />;
  }
  if (owners.state.status === 'error') {
    return <ErrorState error={owners.state.error} t={t} onRetry={owners.reload} />;
  }
  const ownerOptions = owners.state.value;

  const set = (patch: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const fieldIssue = (field: string): string | undefined => {
    const key = issues[field];
    return key === undefined ? undefined : t(key);
  };

  const validate = (): Record<string, string> => {
    const found: Record<string, string> = {};
    if (draft.title.trim() === '') found['title'] = 'validation.required';
    if (creating && draft.employee_id === '') found['employee_id'] = 'validation.required';
    if (draft.target_value.trim() === '') found['target_value'] = 'validation.required';
    if (draft.type === 'custom' && draft.unit.trim() === '') found['unit'] = 'validation.required';
    if (draft.period_start === '') found['period_start'] = 'validation.required';
    if (draft.period_end === '') found['period_end'] = 'validation.required';
    if (!periodIsValid(draft.period_start, draft.period_end)) {
      found['period_end'] = 'validation.end_before_start';
    }
    return found;
  };

  const submit = (): void => {
    const found = validate();
    setIssues(found);
    setFailure(null);
    if (Object.keys(found).length > 0) {
      return;
    }
    setBusy(true);
    const request =
      goal === null
        ? fetchOne<GoalWriteResult>('/goals', { locale, method: 'POST', body: createBody(draft) })
        : fetchOne<GoalWriteResult>(`/goals/${goal.id}`, {
            locale,
            method: 'PATCH',
            body: updateBody(goal, draft),
          });
    request
      .then((saved) => {
        if (goal === null) {
          const warning = saved.warnings.includes('overlapping_goal')
            ? '&warning=overlapping_goal'
            : '';
          router.push(`${goalPath(locale, saved.id)}?notice=created${warning}`);
        } else {
          onSaved?.(saved);
        }
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 422) {
          setIssues(issueKeys(error));
        }
        setFailure(describeError(error, t));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Card title={creating ? t('goals.new_title') : t('goals.edit_title')} className="tasks-form">
      <form
        className="tasks-form__grid"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {failure === null ? null : (
          <Alert tone="danger" title={t('validation.generic_title')}>
            {failure}
          </Alert>
        )}

        {creating ? (
          <>
            <Field label={t('goals.field_type')} required {...optionalError(fieldIssue('type'))}>
              <Select
                value={draft.type}
                onChange={(event) => {
                  set({ type: event.target.value as GoalType });
                }}
              >
                {GOAL_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(goalTypeKey(type))}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={t('goals.field_owner')}
              required
              {...optionalError(fieldIssue('employee_id'))}
            >
              <Select
                value={draft.employee_id}
                onChange={(event) => {
                  set({ employee_id: event.target.value });
                }}
              >
                <option value="">{t('goals.choose_owner')}</option>
                {ownerOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            {issues['employee_id'] === 'validation.not_active' ? (
              <Alert tone="warning" title={t('validation.not_active')}>
                {t('goals.owner_inactive_hint')}
              </Alert>
            ) : null}
          </>
        ) : null}

        <Field label={t('goals.field_title')} required {...optionalError(fieldIssue('title'))}>
          <Input
            value={draft.title}
            maxLength={GOAL_TITLE_MAX_LENGTH}
            required
            onChange={(event) => {
              set({ title: event.target.value });
            }}
          />
        </Field>

        <Field label={t('goals.field_description')} {...optionalError(fieldIssue('description'))}>
          <Textarea
            value={draft.description}
            maxLength={GOAL_DESCRIPTION_MAX_LENGTH}
            rows={3}
            onChange={(event) => {
              set({ description: event.target.value });
            }}
          />
        </Field>

        <div className="tasks-form__dates">
          <Field
            label={t('goals.field_target')}
            required
            helper={
              draft.type === 'task' ? t('goals.target_tasks_helper') : t('goals.target_helper')
            }
            {...optionalError(fieldIssue('target_value'))}
          >
            {/* Not `type="number"`: a number input drops Arabic-Indic digits;
                the API normalises them (DOCUMENT 08 §5.5). */}
            <Input
              inputMode="decimal"
              dir="ltr"
              value={draft.target_value}
              required
              onChange={(event) => {
                set({ target_value: event.target.value });
              }}
            />
          </Field>
          {draft.type === 'custom' ? (
            <Field
              label={t('goals.field_unit')}
              required
              helper={t('goals.unit_helper')}
              {...optionalError(fieldIssue('unit'))}
            >
              <Input
                value={draft.unit}
                maxLength={GOAL_UNIT_MAX_LENGTH}
                required
                onChange={(event) => {
                  set({ unit: event.target.value });
                }}
              />
            </Field>
          ) : (
            <p className="tasks-muted">
              {draft.type === 'sales' ? t('goals.unit_sales_hint') : t('goals.unit_task_hint')}
            </p>
          )}
        </div>

        <div className="tasks-form__dates">
          <Field
            label={t('goals.field_period_start')}
            required
            {...optionalError(fieldIssue('period_start'))}
          >
            <Input
              type="date"
              value={draft.period_start}
              onChange={(event) => {
                set({ period_start: event.target.value });
              }}
            />
          </Field>
          <Field
            label={t('goals.field_period_end')}
            required
            {...optionalError(fieldIssue('period_end'))}
          >
            <Input
              type="date"
              value={draft.period_end}
              min={draft.period_start === '' ? undefined : draft.period_start}
              onChange={(event) => {
                set({ period_end: event.target.value });
              }}
            />
          </Field>
        </div>

        {draft.type === 'task' ? (
          <fieldset className="tasks-builder">
            <legend>{t('goals.field_rule')}</legend>
            <p className="tasks-muted">{t('goals.rule_helper')}</p>
            {TASK_PRIORITIES.map((priority) => (
              <Choice
                key={priority}
                type="checkbox"
                label={t(priorityKey(priority))}
                checked={draft.priorities.includes(priority)}
                onChange={(event) => {
                  set({
                    priorities: event.target.checked
                      ? TASK_PRIORITIES.filter(
                          (candidate) =>
                            candidate === priority || draft.priorities.includes(candidate),
                        )
                      : draft.priorities.filter((candidate) => candidate !== priority),
                  });
                }}
              />
            ))}
            {fieldIssue('task_count_rule') === undefined ? null : (
              <span className="field__error" role="alert">
                {fieldIssue('task_count_rule')}
              </span>
            )}
          </fieldset>
        ) : null}

        {!creating ? (
          <Alert tone="info" title={t('goals.edit_history_title')}>
            {t('goals.edit_history_note')}
          </Alert>
        ) : null}

        <div className="tasks-form__actions">
          {creating ? (
            <Link className="button button--secondary button--md" href={goalsPath(locale)}>
              {t('action.cancel')}
            </Link>
          ) : (
            <Button type="button" variant="secondary" onClick={onCancel}>
              {t('action.cancel')}
            </Button>
          )}
          <Button type="submit" loading={busy}>
            {creating ? t('goals.new_goal') : t('action.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
