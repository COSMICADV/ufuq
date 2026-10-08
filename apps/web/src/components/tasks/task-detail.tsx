'use client';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchMany, fetchOne, sendNoContent } from '../../lib/api-client';
import type { CollectionResult } from '../../lib/api-client';
import {
  CHECKLIST_TITLE_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  REASON_MAX_LENGTH,
  applyTick,
  assigneeName,
  formatPercent,
  needsReason,
  statusKey,
  todayIn,
  transitionAction,
} from '../../lib/tasks';
import type { ProgressUpdate, TaskDetail, TaskStatus } from '../../lib/tasks';
import type { RecordAttachments } from '../../lib/attachments';
import { goalPath } from '../../lib/goals';
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

import { TaskAttachments } from './task-attachments';
import { TaskForm } from './task-form';
import { Deadline, PriorityChip, ProgressRing, TaskStatusChip } from './tasks-shared';

/**
 * Task detail — DOCUMENT 04 B9 (`/admin/tasks/:id`) and C6 (`/app/tasks/:id`).
 *
 * One screen for both surfaces, because they show the same task and differ
 * only in what the caller may do — and that is decided by the caller's
 * permissions (rendered here as an affordance, DOCUMENT 09 §5) and enforced
 * by the API on every request. An employee therefore sees tick, note and the
 * status moves allowed from the current status; an admin or manager also
 * sees edit, reassign, re-deadline, the checklist editor, delete and the
 * record history.
 *
 * - **Checklist ticks are optimistic** (DOCUMENT 04 C6): the item and the
 *   progress change at once; on failure the item returns to its previous
 *   state and an error appears (DOCUMENT 13 "Error states").
 * - **Status moves** are offered only as the server's `allowed_transitions`.
 *   Cancelling and reopening ask for a reason; completing with open items
 *   asks for confirmation naming the count (rules 4, 6, 7).
 * - **Progress notes** are append-only: there is no edit or delete control
 *   because there is no API for either (rule 9). On a phone the composer is
 *   a bottom sheet (DOCUMENT 13 "Mobile behaviour").
 *
 * - **Attachments** (Phase 7 addendum) come with the task load, with the
 *   server's own `can_upload` / `can_delete` answers — see
 *   `task-attachments.tsx`.
 *
 * - **Linked goal** (Phase 8, DOCUMENT 04 B9) — a link to the goal, on the
 *   surface the caller is on.
 */

interface Loaded {
  readonly session: SessionView;
  readonly task: TaskDetail;
  /** From `GET /tasks/{id}` only; the task's write responses do not carry it. */
  readonly attachments: RecordAttachments;
}

type StatusDialog =
  | { readonly kind: 'reason'; readonly to: TaskStatus }
  | { readonly kind: 'open_items'; readonly to: TaskStatus; readonly count: number };

const NOTES_PER_PAGE = 20;

export function TaskDetailScreen({
  locale,
  taskId,
  surface,
}: {
  readonly locale: Locale;
  readonly taskId: string;
  readonly surface: 'admin' | 'app';
}): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialNotice = searchParams?.get('notice') === 'created' ? t('tasks.created') : null;

  const load = useCallback(
    async (signal: AbortSignal): Promise<Loaded> => {
      const [session, loaded] = await Promise.all([
        loadSession(locale, signal),
        fetchOne<TaskDetail & { readonly attachments: RecordAttachments }>(`/tasks/${taskId}`, {
          locale,
          signal,
        }),
      ]);
      const { attachments, ...task } = loaded;
      return { session, task, attachments };
    },
    [locale, taskId],
  );
  const resource = useResource(load);

  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<StatusDialog | null>(null);
  const [reason, setReason] = useState('');
  const [reasonIssue, setReasonIssue] = useState<string | undefined>(undefined);
  const [deleting, setDeleting] = useState(false);
  const [version, setVersion] = useState(0);

  if (resource.state.status === 'loading') {
    return <LoadingState t={t} rows={10} />;
  }
  if (resource.state.status === 'error') {
    if (resource.state.error.status === 404) {
      return (
        <EmptyState
          title={t('tasks.not_found_title')}
          description={t('tasks.not_found_description')}
          action={null}
        />
      );
    }
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }

  const { session, task, attachments } = resource.state.value;
  const can = (permission: string): boolean => session.permissions.has(permission);
  const zone = session.timeZone;
  const replaceTask = (next: TaskDetail): void => {
    resource.replace({ session, task: next, attachments });
  };
  const succeed = (message: string): void => {
    setNotice(message);
    setActionError(null);
    setVersion((v) => v + 1);
  };
  const fail = (error: unknown): void => {
    setNotice(null);
    setActionError(describeTaskError(error, t));
  };

  const sendStatus = (to: TaskStatus, extra: Record<string, unknown> = {}): void => {
    setBusy(true);
    fetchOne<TaskDetail>(`/tasks/${task.id}/status`, {
      locale,
      method: 'POST',
      body: { status: to, ...extra },
    })
      .then((next) => {
        replaceTask(next);
        setDialog(null);
        setReason('');
        succeed(t('tasks.status_saved'));
      })
      .catch((error: unknown) => {
        // Rule 6: the server names the count; ask, then send the confirmation.
        if (error instanceof ApiError && error.code === 'TASK_HAS_OPEN_ITEMS') {
          const count = Number(error.fields.open_items?.[0] ?? '0');
          setDialog({ kind: 'open_items', to, count });
          return;
        }
        if (error instanceof ApiError && error.fields.reason !== undefined) {
          setReasonIssue(t('validation.required'));
          return;
        }
        setDialog(null);
        fail(error);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const requestStatus = (to: TaskStatus): void => {
    setActionError(null);
    if (needsReason(task.status, to)) {
      setReason('');
      setReasonIssue(undefined);
      setDialog({ kind: 'reason', to });
      return;
    }
    const open = task.checklist.filter((item) => !item.is_completed).length;
    if (to === 'completed' && open > 0) {
      setDialog({ kind: 'open_items', to, count: open });
      return;
    }
    sendStatus(to);
  };

  const remove = (): void => {
    setBusy(true);
    sendNoContent(`/tasks/${task.id}`, { locale, method: 'DELETE' })
      .then(() => {
        router.push(`/${locale}/admin/tasks?notice=deleted`);
      })
      .catch((error: unknown) => {
        setDeleting(false);
        fail(error);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (editing) {
    return (
      <TaskForm
        locale={locale}
        task={task}
        onCancel={() => {
          setEditing(false);
        }}
        onSaved={(saved) => {
          replaceTask(saved);
          setEditing(false);
          succeed(t('tasks.saved'));
        }}
      />
    );
  }

  const transitions = can('task.update_status') ? task.allowed_transitions : [];
  const manager = surface === 'admin';

  return (
    <div className="tasks-detail">
      <SuccessNotice message={notice} t={t} />
      {actionError === null ? null : (
        <Alert tone="danger" title={t('state.action_blocked')}>
          {actionError}
        </Alert>
      )}

      <Card className="tasks-detail__header">
        <div className="tasks-detail__summary">
          <div className="tasks-detail__heading">
            <h2>{task.title}</h2>
            <div className="tasks-card__chips">
              <TaskStatusChip status={task.status} t={t} />
              <PriorityChip priority={task.priority} t={t} />
            </div>
            <dl className="tasks-facts">
              <div>
                <dt>{t('tasks.field_assignee')}</dt>
                <dd>{assigneeName(task)}</dd>
              </div>
              <div>
                <dt>{t('tasks.field_deadline')}</dt>
                <dd>
                  <Deadline
                    deadline={task.deadline}
                    overdue={task.is_overdue}
                    locale={locale}
                    timeZone={zone}
                    t={t}
                  />
                </dd>
              </div>
              <div>
                <dt>{t('tasks.field_start_date')}</dt>
                <dd>
                  {task.start_date === null ? (
                    t('tasks.no_start_date')
                  ) : (
                    <Ltr>{formatDate(task.start_date, locale, zone)}</Ltr>
                  )}
                </dd>
              </div>
              <div>
                <dt>{t('tasks.field_department')}</dt>
                <dd>
                  {task.department === null
                    ? t('tasks.no_department')
                    : locale === 'en'
                      ? task.department.name_en
                      : task.department.name_ar}
                </dd>
              </div>
              <div>
                <dt>{t('tasks.field_goal')}</dt>
                <dd>
                  {task.goal === null ? (
                    t('tasks.no_goal')
                  ) : (
                    <Link href={goalPath(locale, task.goal.id, surface)}>{task.goal.title}</Link>
                  )}
                </dd>
              </div>
              <div>
                <dt>{t('tasks.created_by')}</dt>
                <dd>{task.created_by.name}</dd>
              </div>
              {task.completed_at === null ? null : (
                <div>
                  <dt>{t('tasks.completed_at')}</dt>
                  <dd>
                    <Ltr>
                      {formatDate(todayIn(zone, new Date(task.completed_at)), locale, zone)}{' '}
                      {formatTime(task.completed_at, locale, zone)}
                    </Ltr>
                  </dd>
                </div>
              )}
              {task.cancelled_reason === null ? null : (
                <div>
                  <dt>{t('tasks.cancelled_reason')}</dt>
                  <dd>{task.cancelled_reason}</dd>
                </div>
              )}
            </dl>
          </div>
          <ProgressRing percent={task.progress_percent} t={t} size="lg" />
        </div>

        <div className="tasks-detail__actions">
          {transitions.map((to) => (
            <Button
              key={to}
              variant={
                to === 'cancelled'
                  ? 'destructive-ghost'
                  : to === 'completed'
                    ? 'primary'
                    : 'secondary'
              }
              disabled={busy}
              onClick={() => {
                requestStatus(to);
              }}
            >
              {t(`tasks.action.${transitionAction(task.status, to)}`)}
            </Button>
          ))}
          {manager && can('task.update') ? (
            <Button
              variant="secondary"
              onClick={() => {
                setEditing(true);
              }}
            >
              {t('tasks.edit')}
            </Button>
          ) : null}
          {manager && can('task.delete') ? (
            <Button
              variant="destructive-ghost"
              onClick={() => {
                setDeleting(true);
              }}
            >
              {t('tasks.delete')}
            </Button>
          ) : null}
        </div>
        {task.status === 'cancelled' ? (
          <p className="tasks-muted">{t('tasks.no_transitions')}</p>
        ) : null}
      </Card>

      <Card title={t('tasks.field_description')}>
        <p className="tasks-description">{task.description ?? t('tasks.no_description')}</p>
      </Card>

      <Checklist
        task={task}
        locale={locale}
        t={t}
        canTick={can('task.update_checklist')}
        canEdit={manager && can('task.update')}
        onReplace={replaceTask}
        onReload={resource.reload}
        onError={fail}
        onChanged={() => {
          setVersion((v) => v + 1);
        }}
      />

      <TaskAttachments
        key={`attachments-${task.id}`}
        taskId={task.id}
        initial={attachments}
        locale={locale}
        t={t}
        timeZone={zone}
      />

      <ProgressNotes
        key={`notes-${String(version)}`}
        task={task}
        locale={locale}
        t={t}
        timeZone={zone}
        canWrite={can('task.add_progress_note')}
        onPosted={() => {
          // A first note may have started the task (rule 5): re-read it.
          fetchOne<TaskDetail>(`/tasks/${task.id}`, { locale })
            .then(replaceTask)
            .catch(() => {
              resource.reload();
            });
          succeed(t('tasks.note_saved'));
        }}
      />

      {manager && can('audit.view') ? (
        <RecordHistory
          key={`history-${String(version)}`}
          locale={locale}
          t={t}
          entityType="task"
          entityId={task.id}
          timeZone={zone}
          title={t('tasks.history_title')}
          fullLogLabel={t('employees.history_full_log')}
          emptyTitle={t('tasks.history_empty_title')}
          emptyDescription={t('tasks.history_empty')}
        />
      ) : null}

      {dialog?.kind === 'reason' ? (
        <Modal
          open
          title={dialog.to === 'cancelled' ? t('tasks.cancel_title') : t('tasks.reopen_title')}
          closeLabel={t('action.close')}
          onClose={() => {
            setDialog(null);
          }}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setDialog(null);
                }}
              >
                {t('action.cancel')}
              </Button>
              <Button
                variant={dialog.to === 'cancelled' ? 'destructive' : 'primary'}
                loading={busy}
                onClick={() => {
                  if (reason.trim() === '') {
                    setReasonIssue(t('validation.required'));
                    return;
                  }
                  sendStatus(dialog.to, { reason: reason.trim() });
                }}
              >
                {t(`tasks.action.${transitionAction(task.status, dialog.to)}`)}
              </Button>
            </>
          }
        >
          <Field
            label={dialog.to === 'cancelled' ? t('tasks.cancel_reason') : t('tasks.reopen_reason')}
            required
            helper={
              dialog.to === 'cancelled'
                ? t('tasks.cancel_reason_helper')
                : t('tasks.reopen_reason_helper')
            }
            {...optionalError(reasonIssue)}
          >
            <Textarea
              value={reason}
              maxLength={REASON_MAX_LENGTH}
              rows={3}
              required
              onChange={(event) => {
                setReason(event.target.value);
                setReasonIssue(undefined);
              }}
            />
          </Field>
        </Modal>
      ) : null}

      {dialog?.kind === 'open_items' ? (
        <Modal
          open
          title={t('tasks.open_items_title')}
          closeLabel={t('action.close')}
          onClose={() => {
            setDialog(null);
          }}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setDialog(null);
                }}
              >
                {t('action.cancel')}
              </Button>
              <Button
                loading={busy}
                onClick={() => {
                  sendStatus(dialog.to, { confirm_open_items: true });
                }}
              >
                {t('tasks.open_items_confirm')}
              </Button>
            </>
          }
        >
          <p>{t('tasks.open_items_body', { count: String(dialog.count) })}</p>
        </Modal>
      ) : null}

      {deleting ? (
        <Modal
          open
          title={t('tasks.delete_title', { title: task.title })}
          closeLabel={t('action.close')}
          onClose={() => {
            setDeleting(false);
          }}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setDeleting(false);
                }}
              >
                {t('action.cancel')}
              </Button>
              <Button variant="destructive" loading={busy} onClick={remove}>
                {t('tasks.delete')}
              </Button>
            </>
          }
        >
          <p>{t('tasks.delete_body')}</p>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * A failure as a sentence — DOCUMENT 11 §11. An invalid transition also says
 * where the task *can* go, from the list the server sent back (DOCUMENT 13:
 * "422 explaining the allowed transitions").
 */
function describeTaskError(error: unknown, t: Translator): string {
  if (error instanceof ApiError && error.code === 'INVALID_STATUS_TRANSITION') {
    const allowed = (error.fields.allowed_transitions ?? []).map((status) =>
      t(statusKey(status as TaskStatus)),
    );
    return allowed.length === 0
      ? `${t('error.invalid_status_transition')} ${t('tasks.no_transitions')}`
      : `${t('error.invalid_status_transition')} ${t('tasks.allowed_list', { list: allowed.join('، ') })}`;
  }
  if (error instanceof ApiError && error.fields.assignee_employee_id?.[0] === 'not_active') {
    return `${t('validation.not_active')}. ${t('tasks.assignee_inactive_hint')}`;
  }
  return describeError(error, t);
}

// ---------------------------------------------------------------------------
// Checklist — DOCUMENT 05 FLOW 11
// ---------------------------------------------------------------------------

function Checklist({
  task,
  locale,
  t,
  canTick,
  canEdit,
  onReplace,
  onReload,
  onError,
  onChanged,
}: {
  readonly task: TaskDetail;
  readonly locale: Locale;
  readonly t: Translator;
  readonly canTick: boolean;
  readonly canEdit: boolean;
  readonly onReplace: (task: TaskDetail) => void;
  readonly onReload: () => void;
  readonly onError: (error: unknown) => void;
  readonly onChanged: () => void;
}): React.JSX.Element {
  const [newItem, setNewItem] = useState('');
  const [tickError, setTickError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The latest task, for a tick that resolves after another one: rolling back
  // must start from what is on screen now, not from what it was then.
  const latest = useRef(task);
  latest.current = task;

  const tick = (itemId: string, isCompleted: boolean): void => {
    setTickError(null);
    onReplace(applyTick(latest.current, itemId, isCompleted));
    fetchOne<TaskDetail>(`/tasks/${task.id}/checklist/${itemId}`, {
      locale,
      method: 'PATCH',
      body: { is_completed: isCompleted },
    })
      .then((next) => {
        onReplace(next);
        onChanged();
      })
      .catch(() => {
        // DOCUMENT 13 "Error states": roll the item back and say so.
        onReplace(applyTick(latest.current, itemId, !isCompleted));
        setTickError(t('tasks.tick_failed'));
        onReload();
      });
  };

  const mutate = (request: Promise<TaskDetail | null>): void => {
    setBusy(true);
    request
      .then((next) => {
        if (next === null) {
          return fetchOne<TaskDetail>(`/tasks/${task.id}`, { locale }).then(onReplace);
        }
        onReplace(next);
        return undefined;
      })
      .then(onChanged)
      .catch(onError)
      .finally(() => {
        setBusy(false);
      });
  };

  const add = (): void => {
    const title = newItem.trim();
    if (title === '') return;
    mutate(
      fetchOne<TaskDetail>(`/tasks/${task.id}/checklist`, {
        locale,
        method: 'POST',
        body: { title },
      }).then((next) => {
        setNewItem('');
        return next;
      }),
    );
  };

  const done = task.checklist.filter((item) => item.is_completed).length;

  return (
    <Card
      title={t('tasks.checklist_title')}
      action={
        task.checklist.length === 0 ? undefined : (
          <span className="tasks-muted">
            {t('tasks.checklist_progress', {
              done: String(done),
              total: String(task.checklist.length),
            })}{' '}
            · <Ltr>{`${formatPercent(task.progress_percent)}%`}</Ltr>
          </span>
        )
      }
    >
      <div role="status" aria-live="polite">
        {tickError === null ? null : (
          <Alert tone="danger" title={t('state.action_blocked')}>
            {tickError}
          </Alert>
        )}
      </div>
      {task.checklist.length === 0 ? (
        <p className="tasks-muted">{t('tasks.checklist_empty')}</p>
      ) : (
        <ul className="tasks-checklist">
          {task.checklist.map((item, index) => (
            <li key={item.id} className={item.is_completed ? 'is-done' : ''}>
              <label className="tasks-checklist__tick">
                <input
                  type="checkbox"
                  checked={item.is_completed}
                  disabled={!canTick}
                  onChange={(event) => {
                    tick(item.id, event.target.checked);
                  }}
                />
                <span>{item.title}</span>
              </label>
              {canEdit ? (
                <span className="tasks-builder__controls">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || index === 0}
                    aria-label={t('tasks.move_up', { title: item.title })}
                    onClick={() => {
                      mutate(
                        fetchOne<TaskDetail>(`/tasks/${task.id}/checklist/${item.id}`, {
                          locale,
                          method: 'PATCH',
                          body: { position: index - 1 },
                        }),
                      );
                    }}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || index === task.checklist.length - 1}
                    aria-label={t('tasks.move_down', { title: item.title })}
                    onClick={() => {
                      mutate(
                        fetchOne<TaskDetail>(`/tasks/${task.id}/checklist/${item.id}`, {
                          locale,
                          method: 'PATCH',
                          body: { position: index + 1 },
                        }),
                      );
                    }}
                  >
                    ↓
                  </Button>
                  <Button
                    variant="destructive-ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={t('tasks.checklist_remove', { title: item.title })}
                    onClick={() => {
                      mutate(
                        sendNoContent(`/tasks/${task.id}/checklist/${item.id}`, {
                          locale,
                          method: 'DELETE',
                        }).then(() => null),
                      );
                    }}
                  >
                    ×
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <form
          className="tasks-builder__add"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <Field label={t('tasks.checklist_new_item')}>
            <Input
              value={newItem}
              maxLength={CHECKLIST_TITLE_MAX_LENGTH}
              onChange={(event) => {
                setNewItem(event.target.value);
              }}
            />
          </Field>
          <Button type="submit" variant="secondary" loading={busy} disabled={newItem.trim() === ''}>
            {t('tasks.checklist_add')}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Progress notes — DOCUMENT 13 rules 5 and 9
// ---------------------------------------------------------------------------

function ProgressNotes({
  task,
  locale,
  t,
  timeZone,
  canWrite,
  onPosted,
}: {
  readonly task: TaskDetail;
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
  readonly canWrite: boolean;
  readonly onPosted: () => void;
}): React.JSX.Element {
  const load = useCallback(
    (signal: AbortSignal): Promise<CollectionResult<ProgressUpdate>> =>
      fetchMany<ProgressUpdate>(`/tasks/${task.id}/progress-updates`, {
        locale,
        signal,
        query: { per_page: String(NOTES_PER_PAGE) },
      }),
    [locale, task.id],
  );
  const notes = useResource(load);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [issue, setIssue] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const post = (): void => {
    if (note.trim() === '') {
      setIssue(t('validation.required'));
      return;
    }
    setBusy(true);
    fetchOne<ProgressUpdate>(`/tasks/${task.id}/progress-updates`, {
      locale,
      method: 'POST',
      body: { note: note.trim() },
    })
      .then(() => {
        setNote('');
        setOpen(false);
        onPosted();
      })
      .catch((error: unknown) => {
        setIssue(describeError(error, t));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Card
      title={t('tasks.notes_title')}
      action={
        canWrite && !open ? (
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(true);
            }}
          >
            {t('tasks.note_add')}
          </Button>
        ) : undefined
      }
    >
      {open ? (
        <form
          className="tasks-sheet"
          role="dialog"
          aria-label={t('tasks.note_add')}
          onSubmit={(event) => {
            event.preventDefault();
            post();
          }}
        >
          <Field
            label={t('tasks.note_label')}
            required
            helper={t('tasks.note_helper')}
            {...optionalError(issue)}
          >
            <Textarea
              value={note}
              rows={4}
              maxLength={NOTE_MAX_LENGTH}
              required
              autoFocus
              onChange={(event) => {
                setNote(event.target.value);
                setIssue(undefined);
              }}
            />
          </Field>
          <div className="tasks-form__actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setOpen(false);
                setIssue(undefined);
              }}
            >
              {t('action.cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {t('tasks.note_submit')}
            </Button>
          </div>
        </form>
      ) : null}

      {notes.state.status === 'loading' ? <LoadingState t={t} rows={3} /> : null}
      {notes.state.status === 'error' ? (
        <ErrorState error={notes.state.error} t={t} onRetry={notes.reload} />
      ) : null}
      {notes.state.status === 'ready' ? (
        notes.state.value.items.length === 0 ? (
          <EmptyState
            title={t('tasks.notes_empty_title')}
            description={t('tasks.notes_empty_description')}
            action={null}
          />
        ) : (
          <ol className="tasks-timeline">
            {notes.state.value.items.map((update) => (
              <li key={update.id}>
                <p className="tasks-timeline__note">{update.note}</p>
                <p className="tasks-timeline__meta">
                  <span>{update.author.name}</span>
                  <Ltr>
                    {formatDate(todayIn(timeZone, new Date(update.created_at)), locale, timeZone)}{' '}
                    {formatTime(update.created_at, locale, timeZone)}
                  </Ltr>
                  <span>
                    {t('tasks.note_progress', {
                      percent: formatPercent(update.progress_percent_at_time),
                    })}
                  </span>
                </p>
              </li>
            ))}
          </ol>
        )
      ) : null}
    </Card>
  );
}
