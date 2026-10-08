'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchMany, fetchOne, issueKeys } from '../../lib/api-client';
import type { EmployeeView } from '../../lib/employees';
import {
  CHECKLIST_TITLE_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  TASK_PRIORITIES,
  TITLE_MAX_LENGTH,
  TITLE_MIN_LENGTH,
  moveItem,
  priorityKey,
  taskPath,
  todayIn,
} from '../../lib/tasks';
import type { TaskDetail, TaskPriority } from '../../lib/tasks';
import { Alert, Button, Card, Field, Input, Select, Textarea } from '../design-system';
import { loadSession } from '../employees/use-session';
import type { SessionView } from '../employees/use-session';
import { describeError, ErrorState, LoadingState, optionalError } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

/**
 * Create / edit task — DOCUMENT 04 B10, DOCUMENT 05 FLOW 09.
 *
 * Form: name, description, assignee, department (auto from assignee,
 * overridable), priority, start date, deadline, and — on create — the
 * checklist builder (add / remove / reorder). On an existing task the
 * checklist is edited on the task itself, where each change recalculates
 * progress (FLOW 11).
 *
 * The browser checks only what helps someone filling the form in; every rule
 * is enforced again by the API, and its field errors are shown against the
 * fields they name. A deadline in the past is allowed — back-dated work — but
 * warned (DOCUMENT 13 edge cases). The assignee list is the caller's own
 * scope: a manager is offered their team.
 *
 * `?assignee=<id>` preselects the assignee — the employee profile's "Assign
 * task" quick action.
 *
 * Linked goal (Phase 8, FLOW 09 "optional goal link"): only the chosen
 * assignee's goals are offered, because the API requires the goal to belong
 * to the assignee (DOCUMENT 13 validation). A deadline outside the goal's
 * period is warned about before saving — the task would not count toward it
 * (DOCUMENT 13 edge cases). Attachments are added on the task detail
 * once the task exists — a file belongs to an existing record
 * (`task-attachments.tsx`).
 */

const OPTIONS_PAGE_SIZE = '100';

interface Option {
  readonly id: string;
  readonly label: string;
  readonly department: { readonly id: string; readonly label: string } | null;
}

interface GoalOption {
  readonly id: string;
  readonly title: string;
  readonly employeeId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
}

interface FormOptions {
  readonly session: SessionView;
  /** Uncancelled goals the caller may see; empty when they may see none. */
  readonly goals: readonly GoalOption[];
  readonly assignees: readonly Option[];
  /** Null when the caller may not list departments; the assignee's is used. */
  readonly departments: readonly { readonly id: string; readonly label: string }[] | null;
}

interface Draft {
  readonly title: string;
  readonly description: string;
  readonly assignee: string;
  readonly department: string;
  readonly priority: TaskPriority;
  readonly startDate: string;
  readonly deadline: string;
  readonly goal: string;
  readonly checklist: readonly string[];
}

function draftFrom(task: TaskDetail | null): Draft {
  return {
    title: task?.title ?? '',
    description: task?.description ?? '',
    assignee: task?.assignee.id ?? '',
    department: task?.department?.id ?? '',
    priority: task?.priority ?? 'medium',
    startDate: task?.start_date ?? '',
    deadline: task?.deadline ?? '',
    goal: task?.goal?.id ?? '',
    checklist: [],
  };
}

export function TaskForm({
  locale,
  task,
  onSaved,
  onCancel,
}: {
  readonly locale: Locale;
  /** Null to create. */
  readonly task: TaskDetail | null;
  /** Edit only: called with the saved task instead of navigating. */
  readonly onSaved?: (task: TaskDetail) => void;
  readonly onCancel?: () => void;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();

  const load = useCallback(
    async (signal: AbortSignal): Promise<FormOptions> => {
      const query = { per_page: OPTIONS_PAGE_SIZE };
      const [session, employees, departments, goals] = await Promise.all([
        loadSession(locale, signal),
        fetchMany<EmployeeView>('/employees', {
          locale,
          signal,
          query: { ...query, sort: 'name', status: 'active' },
        }),
        fetchMany<{ id: string; name_ar: string; name_en: string }>('/departments', {
          locale,
          signal,
          query,
        }).catch(() => null),
        fetchMany<{
          id: string;
          title: string;
          status: string;
          employee: { id: string };
          period_start: string;
          period_end: string;
        }>('/goals', { locale, signal, query }).catch(() => null),
      ]);
      const assignees: Option[] = employees.items.map((e) => ({
        id: e.id,
        label: `${e.first_name} ${e.last_name}`.trim(),
        department:
          e.department === null
            ? null
            : {
                id: e.department.id,
                label: locale === 'en' ? e.department.name_en : e.department.name_ar,
              },
      }));
      // An existing task's assignee stays selectable even if they have since
      // been deactivated — the screen then says so and suggests reassigning.
      if (task !== null && !assignees.some((option) => option.id === task.assignee.id)) {
        assignees.unshift({
          id: task.assignee.id,
          label: `${task.assignee.first_name} ${task.assignee.last_name}`.trim(),
          department:
            task.department === null
              ? null
              : {
                  id: task.department.id,
                  label: locale === 'en' ? task.department.name_en : task.department.name_ar,
                },
        });
      }
      return {
        session,
        goals: (goals?.items ?? [])
          .filter((goal) => goal.status !== 'cancelled' || goal.id === task?.goal?.id)
          .map((goal) => ({
            id: goal.id,
            title: goal.title,
            employeeId: goal.employee.id,
            periodStart: goal.period_start,
            periodEnd: goal.period_end,
          })),
        assignees,
        departments:
          departments === null
            ? null
            : departments.items.map((d) => ({
                id: d.id,
                label: locale === 'en' ? d.name_en : d.name_ar,
              })),
      };
    },
    [locale, task],
  );
  const options = useResource(load);

  const [draft, setDraft] = useState<Draft>(() => draftFrom(task));
  const [newItem, setNewItem] = useState('');
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The employee profile's "Assign task" arrives as `?assignee=<id>`
  // (DOCUMENT 04 B4). It preselects that employee — and, as choosing them by
  // hand would, their department — once the options are loaded. An id that
  // is not among the caller's assignable employees is simply not applied; the
  // API would refuse it anyway.
  const searchParams = useSearchParams();
  const requestedAssignee = task === null ? (searchParams?.get('assignee') ?? '') : '';
  useEffect(() => {
    if (options.state.status !== 'ready' || requestedAssignee === '') {
      return;
    }
    const chosen = options.state.value.assignees.find((option) => option.id === requestedAssignee);
    if (chosen !== undefined) {
      setDraft((current) =>
        current.assignee === ''
          ? { ...current, assignee: chosen.id, department: chosen.department?.id ?? '' }
          : current,
      );
    }
  }, [options.state, requestedAssignee]);

  const set = (patch: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  if (options.state.status === 'loading') {
    return <LoadingState t={t} rows={8} />;
  }
  if (options.state.status === 'error') {
    return <ErrorState error={options.state.error} t={t} onRetry={options.reload} />;
  }
  const { session, assignees, departments, goals } = options.state.value;
  const goalChoices = goals.filter((goal) => goal.employeeId === draft.assignee);
  const chosenGoal = goalChoices.find((goal) => goal.id === draft.goal);
  const goalOutsidePeriod =
    chosenGoal !== undefined &&
    draft.deadline !== '' &&
    (draft.deadline < chosenGoal.periodStart || draft.deadline > chosenGoal.periodEnd);
  const today = todayIn(session.timeZone);
  const pastDeadline = draft.deadline !== '' && draft.deadline < today;
  const assigneeInactive =
    task !== null && draft.assignee === task.assignee.id && task.assignee.status !== 'active';

  const fieldIssue = (field: string): string | undefined => {
    const key = issues[field];
    return key === undefined ? undefined : t(key);
  };

  const validate = (): Record<string, string> => {
    const found: Record<string, string> = {};
    if (draft.title.trim().length < TITLE_MIN_LENGTH) found.title = 'validation.required';
    if (draft.assignee === '') found.assignee_employee_id = 'validation.required';
    if (draft.startDate !== '' && draft.deadline !== '' && draft.deadline < draft.startDate) {
      found.deadline = 'validation.end_before_start';
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
    const common = {
      title: draft.title.trim(),
      description: draft.description.trim() === '' ? null : draft.description.trim(),
      assignee_employee_id: draft.assignee,
      department_id: draft.department === '' ? null : draft.department,
      priority: draft.priority,
      start_date: draft.startDate === '' ? null : draft.startDate,
      deadline: draft.deadline === '' ? null : draft.deadline,
      goal_id: draft.goal === '' ? null : draft.goal,
    };
    const request =
      task === null
        ? fetchOne<TaskDetail>('/tasks', {
            locale,
            method: 'POST',
            body: {
              ...common,
              ...(draft.checklist.length === 0 ? {} : { checklist: draft.checklist }),
            },
          })
        : fetchOne<TaskDetail>(`/tasks/${task.id}`, {
            locale,
            method: 'PATCH',
            // Only what changed, so an edit never re-sends an assignee it did
            // not touch (and so never trips the inactive-assignee rule).
            body: changedFields(task, common),
          });
    request
      .then((saved) => {
        if (task === null) {
          router.push(`${taskPath(locale, saved.id)}?notice=created`);
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

  const assigneeError = fieldIssue('assignee_employee_id');

  return (
    <Card
      title={task === null ? t('tasks.new_title') : t('tasks.edit_title')}
      className="tasks-form"
    >
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

        <Field
          label={t('tasks.field_title')}
          required
          helper={t('tasks.field_title_helper')}
          {...optionalError(fieldIssue('title'))}
        >
          <Input
            value={draft.title}
            minLength={TITLE_MIN_LENGTH}
            maxLength={TITLE_MAX_LENGTH}
            required
            onChange={(event) => {
              set({ title: event.target.value });
            }}
          />
        </Field>

        <Field label={t('tasks.field_description')} {...optionalError(fieldIssue('description'))}>
          <Textarea
            value={draft.description}
            maxLength={DESCRIPTION_MAX_LENGTH}
            rows={4}
            onChange={(event) => {
              set({ description: event.target.value });
            }}
          />
        </Field>

        <Field label={t('tasks.field_assignee')} required {...optionalError(assigneeError)}>
          <Select
            value={draft.assignee}
            required
            onChange={(event) => {
              const chosen = assignees.find((option) => option.id === event.target.value);
              // DOCUMENT 04 B10: the department follows the assignee, and the
              // admin may still override it afterwards. A goal belongs to one
              // employee, so a new assignee clears the link.
              set({
                assignee: event.target.value,
                department: chosen?.department?.id ?? '',
                goal: event.target.value === draft.assignee ? draft.goal : '',
              });
            }}
          >
            <option value="">{t('tasks.choose_assignee')}</option>
            {assignees.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        {assigneeInactive || issues.assignee_employee_id === 'validation.not_active' ? (
          <Alert tone="warning" title={t('validation.not_active')}>
            {t('tasks.assignee_inactive_hint')}
          </Alert>
        ) : null}

        <Field
          label={t('tasks.field_department')}
          helper={t('tasks.field_department_helper')}
          {...optionalError(fieldIssue('department_id'))}
        >
          <Select
            value={draft.department}
            onChange={(event) => {
              set({ department: event.target.value });
            }}
          >
            <option value="">{t('tasks.no_department')}</option>
            {departmentChoices(departments, draft, assignees, task, locale).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label={t('tasks.field_priority')}
          required
          {...optionalError(fieldIssue('priority'))}
        >
          <Select
            value={draft.priority}
            onChange={(event) => {
              set({ priority: event.target.value as TaskPriority });
            }}
          >
            {TASK_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {t(priorityKey(priority))}
              </option>
            ))}
          </Select>
        </Field>

        <div className="tasks-form__dates">
          <Field label={t('tasks.field_start_date')} {...optionalError(fieldIssue('start_date'))}>
            <Input
              type="date"
              value={draft.startDate}
              onChange={(event) => {
                set({ startDate: event.target.value });
              }}
            />
          </Field>
          <Field label={t('tasks.field_deadline')} {...optionalError(fieldIssue('deadline'))}>
            <Input
              type="date"
              value={draft.deadline}
              min={draft.startDate === '' ? undefined : draft.startDate}
              onChange={(event) => {
                set({ deadline: event.target.value });
              }}
            />
          </Field>
        </div>
        {pastDeadline ? (
          <Alert tone="warning" title={t('tasks.overdue')}>
            {t('tasks.deadline_past_warning')}
          </Alert>
        ) : null}

        <Field
          label={t('tasks.field_goal')}
          helper={t('tasks.field_goal_helper')}
          {...optionalError(fieldIssue('goal_id'))}
        >
          <Select
            value={draft.goal}
            disabled={draft.assignee === ''}
            onChange={(event) => {
              set({ goal: event.target.value });
            }}
          >
            <option value="">{t('tasks.no_goal')}</option>
            {goalChoices.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.title}
              </option>
            ))}
          </Select>
        </Field>
        {goalOutsidePeriod ? (
          <Alert tone="warning" title={t('tasks.goal_outside_period_title')}>
            {t('tasks.goal_outside_period')}
          </Alert>
        ) : null}

        {task === null ? (
          <ChecklistBuilder
            t={t}
            items={draft.checklist}
            newItem={newItem}
            onNewItem={setNewItem}
            onChange={(checklist) => {
              set({ checklist });
            }}
          />
        ) : null}

        <div className="tasks-form__actions">
          {task === null ? (
            <Link className="button button--secondary button--md" href={`/${locale}/admin/tasks`}>
              {t('action.cancel')}
            </Link>
          ) : (
            <Button type="button" variant="secondary" onClick={onCancel}>
              {t('action.cancel')}
            </Button>
          )}
          <Button type="submit" loading={busy}>
            {task === null ? t('tasks.new_task') : t('action.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** The department choices: the list when the caller may read it, else the assignee's. */
function departmentChoices(
  departments: FormOptions['departments'],
  draft: Draft,
  assignees: readonly Option[],
  task: TaskDetail | null,
  locale: Locale,
): readonly { readonly id: string; readonly label: string }[] {
  if (departments !== null) {
    return departments;
  }
  if (task?.department && task.department.id === draft.department) {
    return [
      {
        id: task.department.id,
        label: locale === 'en' ? task.department.name_en : task.department.name_ar,
      },
    ];
  }
  const fromAssignee = assignees.find((option) => option.id === draft.assignee)?.department;
  return fromAssignee ? [fromAssignee] : [];
}

function changedFields(
  task: TaskDetail,
  next: {
    title: string;
    description: string | null;
    assignee_employee_id: string;
    department_id: string | null;
    priority: TaskPriority;
    start_date: string | null;
    deadline: string | null;
    goal_id: string | null;
  },
): Record<string, unknown> {
  const before: Record<string, unknown> = {
    title: task.title,
    description: task.description,
    assignee_employee_id: task.assignee.id,
    department_id: task.department?.id ?? null,
    priority: task.priority,
    start_date: task.start_date,
    deadline: task.deadline,
    goal_id: task.goal?.id ?? null,
  };
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => before[key] !== value));
}

/** DOCUMENT 04 B10 "checklist builder (add/remove/reorder)". */
function ChecklistBuilder({
  t,
  items,
  newItem,
  onNewItem,
  onChange,
}: {
  readonly t: Translator;
  readonly items: readonly string[];
  readonly newItem: string;
  readonly onNewItem: (value: string) => void;
  readonly onChange: (items: readonly string[]) => void;
}): React.JSX.Element {
  const add = (): void => {
    const title = newItem.trim();
    if (title === '') return;
    onChange([...items, title]);
    onNewItem('');
  };
  return (
    <fieldset className="tasks-builder">
      <legend>{t('tasks.field_checklist')}</legend>
      {items.length === 0 ? <p className="tasks-muted">{t('tasks.checklist_empty')}</p> : null}
      <ol className="tasks-builder__list">
        {items.map((item, index) => (
          <li key={`${String(index)}-${item}`} className="tasks-builder__item">
            <span>{item}</span>
            <span className="tasks-builder__controls">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={index === 0}
                aria-label={t('tasks.move_up', { title: item })}
                onClick={() => {
                  onChange(moveItem(items, index, index - 1));
                }}
              >
                ↑
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={index === items.length - 1}
                aria-label={t('tasks.move_down', { title: item })}
                onClick={() => {
                  onChange(moveItem(items, index, index + 1));
                }}
              >
                ↓
              </Button>
              <Button
                type="button"
                variant="destructive-ghost"
                size="sm"
                aria-label={t('tasks.checklist_remove', { title: item })}
                onClick={() => {
                  onChange(items.filter((_, position) => position !== index));
                }}
              >
                ×
              </Button>
            </span>
          </li>
        ))}
      </ol>
      <div className="tasks-builder__add">
        <Field label={t('tasks.checklist_new_item')}>
          <Input
            value={newItem}
            maxLength={CHECKLIST_TITLE_MAX_LENGTH}
            onChange={(event) => {
              onNewItem(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
          />
        </Field>
        <Button type="button" variant="secondary" onClick={add} disabled={newItem.trim() === ''}>
          {t('tasks.checklist_add')}
        </Button>
      </div>
    </fieldset>
  );
}
