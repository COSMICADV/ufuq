'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchMany, fetchOne, issueKeys, sendNoContent } from '../../lib/api-client';
import {
  GOAL_NOTE_MAX_LENGTH,
  chartPoints,
  goalsPath,
  ownerName,
  progressParts,
} from '../../lib/goals';
import type {
  GoalDetail,
  GoalHistoryRow,
  GoalProgressResult,
  GoalWriteResult,
} from '../../lib/goals';
import { formatPercent, taskPath, todayIn } from '../../lib/tasks';
import { formatDate, formatTime } from '../attendance/attendance-shared';
import { Alert, Button, Card, EmptyState, Field, Input, Modal, Textarea } from '../design-system';
import { loadSession } from '../employees/use-session';
import type { SessionView } from '../employees/use-session';
import { RecordHistory } from '../settings/record-history';
import {
  describeError,
  ErrorState,
  LoadingState,
  Ltr,
  optionalError,
  SuccessNotice,
} from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { ProgressRing, TaskStatusChip } from '../tasks/tasks-shared';

import { GoalForm } from './goal-form';
import { DaysRemaining, GoalPeriod, GoalStatusChip, GoalTypeChip, GoalValue } from './goals-shared';

/**
 * `/admin/goals/:id` — DOCUMENT 04 B12 — and `/app/goals/:id` — C7.
 *
 * One screen serves both. What the caller can do follows the server's own
 * `abilities`, and the API enforces every action again; on the employee
 * surface there are no editing affordances at all (DOCUMENT 14 "Mobile
 * behaviour": read-only for employees).
 *
 *   - **Progress** is the capped bar beside the true figure (DOCUMENT 14
 *     rule 2), and for a percentage-unit goal both of its numbers.
 *   - **Update progress** (Sales, Custom) appends a history row; a Task goal
 *     has none, because its value is derived (rules 3–4).
 *   - **The chart** draws each history row against the target that row
 *     recorded, so a target change does not redraw the past (DOCUMENT 14
 *     "Target changed mid-period"). The stacked history list is beneath it.
 *   - **Linked tasks** show which ones count (C7: "the contributing tasks").
 */

interface Loaded {
  readonly session: SessionView;
  readonly goal: GoalDetail;
  readonly history: readonly GoalHistoryRow[];
}

const HISTORY_PER_PAGE = '100';

export function GoalDetailScreen({
  locale,
  goalId,
  surface,
}: {
  readonly locale: Locale;
  readonly goalId: string;
  readonly surface: 'admin' | 'app';
}): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialNotice = searchParams?.get('notice') === 'created' ? t('goals.created') : null;
  const overlapWarning = searchParams?.get('warning') === 'overlapping_goal';

  const load = useCallback(
    async (signal: AbortSignal): Promise<Loaded> => {
      const [session, goal, history] = await Promise.all([
        loadSession(locale, signal),
        fetchOne<GoalDetail>(`/goals/${goalId}`, { locale, signal }),
        fetchMany<GoalHistoryRow>(`/goals/${goalId}/progress`, {
          locale,
          signal,
          query: { per_page: HISTORY_PER_PAGE },
        }),
      ]);
      return { session, goal, history: history.items };
    },
    [locale, goalId],
  );
  const resource = useResource(load);

  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [actionError, setActionError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>(
    overlapWarning ? ['overlapping_goal'] : [],
  );
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<'progress' | 'cancel' | null>(null);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [valueIssue, setValueIssue] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  if (resource.state.status === 'loading') {
    return <LoadingState t={t} rows={10} />;
  }
  if (resource.state.status === 'error') {
    if (resource.state.error.status === 404) {
      return (
        <EmptyState
          title={t('goals.not_found_title')}
          description={t('goals.not_found_description')}
          action={null}
        />
      );
    }
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }

  const { session, goal, history } = resource.state.value;
  const zone = session.timeZone;
  const admin = surface === 'admin';
  const abilities = admin
    ? goal.abilities
    : { can_edit: false, can_update_progress: false, can_cancel: false };
  const parts = progressParts(goal);

  /** The goal and its history again, after any write. */
  const refresh = (message: string): void => {
    Promise.all([
      fetchOne<GoalDetail>(`/goals/${goal.id}`, { locale }),
      fetchMany<GoalHistoryRow>(`/goals/${goal.id}/progress`, {
        locale,
        query: { per_page: HISTORY_PER_PAGE },
      }),
    ])
      .then(([next, rows]) => {
        resource.replace({ session, goal: next, history: rows.items });
      })
      .catch(() => {
        resource.reload();
      });
    setNotice(message);
    setActionError(null);
    setVersion((v) => v + 1);
  };

  const submitProgress = (): void => {
    if (value.trim() === '') {
      setValueIssue(t('validation.required'));
      return;
    }
    setBusy(true);
    setValueIssue(undefined);
    fetchOne<GoalProgressResult>(`/goals/${goal.id}/progress`, {
      locale,
      method: 'POST',
      body: { value: value.trim(), ...(note.trim() === '' ? {} : { note: note.trim() }) },
    })
      .then((result) => {
        setDialog(null);
        setValue('');
        setNote('');
        refresh(
          result.milestones_crossed.length === 0
            ? t('goals.progress_saved')
            : t('goals.progress_saved_milestone', {
                milestones: result.milestones_crossed
                  .map((m) => `${String(m)}%`)
                  .join(locale === 'ar' ? '، ' : ', '),
              }),
        );
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 422) {
          const key = issueKeys(error)['value'];
          if (key !== undefined) {
            setValueIssue(t(key));
            return;
          }
        }
        setDialog(null);
        setActionError(describeError(error, t));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const cancelGoal = (): void => {
    setBusy(true);
    sendNoContent(`/goals/${goal.id}`, { locale, method: 'DELETE' })
      .then(() => {
        setDialog(null);
        router.push(`${goalsPath(locale)}?notice=cancelled`);
      })
      .catch((error: unknown) => {
        setDialog(null);
        setActionError(describeError(error, t));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (editing) {
    return (
      <GoalForm
        locale={locale}
        goal={goal}
        onCancel={() => {
          setEditing(false);
        }}
        onSaved={(saved: GoalWriteResult) => {
          setEditing(false);
          setWarnings(saved.warnings);
          refresh(t('goals.saved'));
        }}
      />
    );
  }

  return (
    <div className="tasks-detail">
      <SuccessNotice message={notice} t={t} />
      {actionError === null ? null : (
        <Alert tone="danger" title={t('state.action_blocked')}>
          {actionError}
        </Alert>
      )}
      {warnings.includes('overlapping_goal') ? (
        <Alert tone="warning" title={t('goals.overlap_title')}>
          {t('goals.overlap_warning')}
        </Alert>
      ) : null}
      {admin && goal.possibly_misconfigured ? (
        <Alert tone="warning" title={t('goals.misconfigured_title')}>
          {t('goals.misconfigured')}
        </Alert>
      ) : null}

      <Card className="tasks-detail__header">
        <div className="tasks-detail__summary">
          <div className="tasks-detail__heading">
            <h2>{goal.title}</h2>
            <div className="tasks-card__chips">
              <GoalTypeChip type={goal.type} t={t} />
              <GoalStatusChip status={goal.status} t={t} />
              <DaysRemaining goal={goal} t={t} />
            </div>
            {goal.description === null ? null : (
              <p className="tasks-description">{goal.description}</p>
            )}
            <dl className="tasks-facts">
              <div>
                <dt>{t('goals.field_owner')}</dt>
                <dd>{ownerName(goal)}</dd>
              </div>
              <div>
                <dt>{t('goals.current')}</dt>
                <dd>
                  <GoalValue value={goal.current_value} unit={goal.unit} t={t} />
                </dd>
              </div>
              <div>
                <dt>{t('goals.target')}</dt>
                <dd>
                  <GoalValue value={goal.target_value} unit={goal.unit} t={t} />
                </dd>
              </div>
              {goal.effective_target_value === goal.target_value ? null : (
                <div>
                  <dt>{t('goals.effective_target')}</dt>
                  <dd>
                    <GoalValue value={goal.effective_target_value} unit={goal.unit} t={t} />
                  </dd>
                </div>
              )}
              <div>
                <dt>{t('goals.progress')}</dt>
                <dd>
                  {t('goals.of_target', { percent: parts.truth })}
                  {parts.overAchieved ? ` — ${t('goals.over_achieved')}` : ''}
                </dd>
              </div>
              <div>
                <dt>{t('goals.period')}</dt>
                <dd>
                  <GoalPeriod goal={goal} locale={locale} timeZone={zone} />
                </dd>
              </div>
              <div>
                <dt>{t('goals.milestones')}</dt>
                <dd>
                  {goal.milestones_reached.length === 0 ? (
                    t('goals.no_milestones')
                  ) : (
                    <Ltr>{goal.milestones_reached.map((m) => `${String(m)}%`).join(' · ')}</Ltr>
                  )}
                </dd>
              </div>
              <div>
                <dt>{t('goals.source')}</dt>
                <dd>
                  {goal.is_automatic ? t('goals.source_automatic') : t('goals.source_manual')}
                </dd>
              </div>
              <div>
                <dt>{t('goals.created_by')}</dt>
                <dd>{goal.created_by.name}</dd>
              </div>
            </dl>
          </div>
          <ProgressRing percent={parts.bar} t={t} size="lg" />
        </div>

        {abilities.can_edit || abilities.can_update_progress || abilities.can_cancel ? (
          <div className="tasks-detail__actions">
            {abilities.can_update_progress ? (
              <Button
                onClick={() => {
                  setValue('');
                  setNote('');
                  setValueIssue(undefined);
                  setDialog('progress');
                }}
              >
                {t('goals.update_progress')}
              </Button>
            ) : null}
            {abilities.can_edit ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(true);
                }}
              >
                {t('settings.edit')}
              </Button>
            ) : null}
            {abilities.can_cancel ? (
              <Button
                variant="destructive-ghost"
                onClick={() => {
                  setDialog('cancel');
                }}
              >
                {t('goals.cancel_goal')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Card>

      <Card title={t('goals.chart_title')}>
        <ProgressChart rows={history} t={t} />
      </Card>

      <Card title={t('goals.history_title')}>
        {history.length === 0 ? (
          <p className="tasks-muted">{t('goals.history_empty')}</p>
        ) : (
          <ol className="goals-history">
            {history.map((row) => (
              <li key={row.id}>
                <span className="goals-history__value">
                  <GoalValue value={row.value} unit={goal.unit} t={t} />
                  <span className="tasks-muted">
                    {t('goals.history_of_target', {
                      percent: formatPercent(row.progress_percent),
                    })}{' '}
                    (<GoalValue value={row.target_value} unit={goal.unit} t={t} />)
                  </span>
                </span>
                <span className="tasks-muted">
                  {row.source === 'system' ? t('goals.source_automatic') : row.author.name} ·{' '}
                  <Ltr>
                    {formatDate(todayIn(zone, new Date(row.created_at)), locale, zone)}{' '}
                    {formatTime(row.created_at, locale, zone)}
                  </Ltr>
                </span>
                {row.note === null ? null : <span className="tasks-description">{row.note}</span>}
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card title={t('goals.linked_tasks_title')}>
        {goal.linked_tasks.length === 0 ? (
          <p className="tasks-muted">
            {goal.is_automatic
              ? t('goals.linked_tasks_empty_task_goal')
              : t('goals.linked_tasks_empty')}
          </p>
        ) : (
          <ul className="goals-history">
            {goal.linked_tasks.map((task) => (
              <li key={task.id}>
                <Link className="tasks-title-link" href={taskPath(locale, task.id, surface)}>
                  {task.title}
                </Link>
                <span className="tasks-card__chips">
                  <TaskStatusChip status={task.status} t={t} />
                  {goal.is_automatic ? (
                    <span className="tasks-muted">
                      {task.counts ? t('goals.task_counts') : t('goals.task_does_not_count')}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {admin && session.permissions.has('audit.view') ? (
        <RecordHistory
          key={`history-${String(version)}`}
          locale={locale}
          t={t}
          entityType="goal"
          entityId={goal.id}
          timeZone={zone}
          title={t('goals.record_history_title')}
          fullLogLabel={t('employees.history_full_log')}
          emptyTitle={t('goals.record_history_empty_title')}
          emptyDescription={t('goals.record_history_empty')}
        />
      ) : null}

      <Modal
        open={dialog === 'progress'}
        title={t('goals.update_progress')}
        closeLabel={t('action.close')}
        onClose={() => {
          setDialog(null);
        }}
        footer={
          <div className="settings-form__actions">
            <Button loading={busy} onClick={submitProgress}>
              {t('action.save')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setDialog(null);
              }}
            >
              {t('action.cancel')}
            </Button>
          </div>
        }
      >
        <div className="tasks-form__grid">
          <p className="tasks-muted">{t('goals.update_progress_help')}</p>
          <Field
            label={t('goals.new_value')}
            required
            helper={t('goals.new_value_helper')}
            {...optionalError(valueIssue)}
          >
            <Input
              inputMode="decimal"
              dir="ltr"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
              }}
            />
          </Field>
          <Field label={t('goals.note')}>
            <Textarea
              value={note}
              maxLength={GOAL_NOTE_MAX_LENGTH}
              rows={3}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={dialog === 'cancel'}
        title={t('goals.cancel_title')}
        closeLabel={t('action.close')}
        onClose={() => {
          setDialog(null);
        }}
        footer={
          <div className="settings-form__actions">
            <Button variant="destructive" loading={busy} onClick={cancelGoal}>
              {t('goals.cancel_confirm')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setDialog(null);
              }}
            >
              {t('action.close')}
            </Button>
          </div>
        }
      >
        <p>{t('goals.cancel_body')}</p>
      </Modal>
    </div>
  );
}

/**
 * DOCUMENT 04 B12 "progress chart over the period" — a line through each
 * history row's own progress, with the 100% line marked. Inline SVG in the
 * design system's green; the figures are also in the history list beneath,
 * so the chart is never the only place a number is shown.
 */
function ProgressChart({
  rows,
  t,
}: {
  readonly rows: readonly GoalHistoryRow[];
  readonly t: Translator;
}): React.JSX.Element {
  if (rows.length === 0) {
    return <p className="tasks-muted">{t('goals.history_empty')}</p>;
  }
  const { points, ceiling } = chartPoints(rows);
  const width = 320;
  const height = 120;
  const pad = 8;
  const x = (value: number): number => pad + value * (width - 2 * pad);
  const y = (value: number): number => height - pad - value * (height - 2 * pad);
  const target = y(100 / ceiling);
  const last = points.at(-1);
  return (
    <figure className="goals-chart">
      <svg
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        role="img"
        aria-label={t('goals.chart_label', { percent: formatPercent(last?.percent ?? '0.00') })}
      >
        <line className="goals-chart__target" x1={pad} x2={width - pad} y1={target} y2={target} />
        <polyline
          className="goals-chart__line"
          points={points.map((point) => `${String(x(point.x))},${String(y(point.y))}`).join(' ')}
        />
        {points.map((point, index) => (
          <circle
            key={index}
            className="goals-chart__point"
            cx={x(point.x)}
            cy={y(point.y)}
            r={3}
          />
        ))}
      </svg>
      <figcaption className="tasks-muted">{t('goals.chart_caption')}</figcaption>
    </figure>
  );
}
