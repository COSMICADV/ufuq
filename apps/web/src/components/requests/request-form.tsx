'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ApiError, fetchMany, fetchOne, issueKeys } from '../../lib/api-client';
import {
  categoryKey,
  correctionFormPath,
  createRequestBody,
  DESCRIPTION_MAX_LENGTH,
  EMPTY_REQUEST_FORM,
  NATIVE_CATEGORIES,
  requestPath,
  SUBJECT_MAX_LENGTH,
  validateRequestForm,
} from '../../lib/requests';
import type { NativeCategory, RequestDetail, RequestForm } from '../../lib/requests';
import { Alert, Button, Card, Choice, Field, Input, Select, Textarea } from '../design-system';
import { loadSession } from '../employees/use-session';
import { describeError, ErrorState, LoadingState, optionalError } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

/**
 * `/{locale}/app/requests/new` — DOCUMENT 04 C9: a category selector, then
 * that category's form.
 *
 * - **Salary, task, general** are the Requests Centre's own (OD-09): subject
 *   and description, and for a task request, optionally, one of the
 *   requester's own tasks.
 * - **Attendance** is a correction (OD-09): the selector sends the employee to
 *   DOCUMENT 04 C4's form, which files the correction and, with it, its inbox
 *   row. There is no second correction form.
 * - **Leave** is not offered: it needs leave types and balances, which
 *   DOCUMENT 25 schedules for Phase 10 (DOCUMENT 25, as amended in Phase
 *   9). DOCUMENT 27 RULE 26: no placeholder for it.
 *
 * Files are attached on the request's own page once it exists — the store
 * attaches to a record, and before submission there is none.
 */

/** DOCUMENT 08 §1's maximum page — the requester's own tasks. */
const TASKS_PAGE_SIZE = '100';

export function RequestFormScreen({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const [draft, setDraft] = useState<RequestForm>(EMPTY_REQUEST_FORM);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const session = await loadSession(locale, signal);
      const tasks =
        session.employeeId === null || !session.permissions.has('task.view')
          ? []
          : ((
              await fetchMany<{ id: string; title: string }>('/tasks', {
                locale,
                signal,
                query: { assignee_employee_id: session.employeeId, per_page: TASKS_PAGE_SIZE },
              }).catch(() => null)
            )?.items ?? []);
      return { session, tasks };
    },
    [locale],
  );
  const resource = useResource(load);

  if (resource.state.status === 'loading') {
    return <LoadingState t={t} rows={6} />;
  }
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const { session, tasks } = resource.state.value;
  const canCorrect = session.permissions.has('attendance.request_correction');

  const set = (patch: Partial<RequestForm>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const issue = (field: string): string | undefined =>
    issues[field] === undefined ? undefined : t(issues[field]);

  const submit = (): void => {
    const found = validateRequestForm(draft);
    setIssues(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    fetchOne<RequestDetail>('/requests', {
      locale,
      method: 'POST',
      body: createRequestBody(draft),
    })
      .then((created) => {
        router.push(`${requestPath(locale, created.id, 'app')}?notice=submitted`);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 422) {
          const keys = issueKeys(error);
          if (Object.keys(keys).length > 0) setIssues(keys);
        }
        setFailure(describeError(error, t));
        setBusy(false);
      });
  };

  return (
    <Card className="tasks-form">
      <form
        className="tasks-form__grid"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <fieldset className="tasks-builder">
          <legend>{t('requests.field_category')}</legend>
          {NATIVE_CATEGORIES.map((category) => (
            <Choice
              key={category}
              type="radio"
              name="category"
              label={t(categoryKey(category))}
              checked={draft.category === category}
              onChange={() => {
                set({ category: category as NativeCategory });
              }}
            />
          ))}
        </fieldset>
        {canCorrect ? (
          <p className="tasks-muted">
            {t('requests.attendance_hint')}{' '}
            <Link href={correctionFormPath(locale)}>{t('requests.attendance_link')}</Link>
          </p>
        ) : null}

        {failure === null ? null : (
          <Alert tone="danger" title={t('requests.submit_failed')}>
            {failure}
          </Alert>
        )}

        <Field label={t('requests.field_subject')} required {...optionalError(issue('subject'))}>
          <Input
            value={draft.subject}
            maxLength={SUBJECT_MAX_LENGTH}
            onChange={(event) => {
              set({ subject: event.target.value });
            }}
          />
        </Field>
        <Field
          label={t('requests.field_description')}
          required
          {...optionalError(issue('description'))}
        >
          <Textarea
            value={draft.description}
            rows={5}
            maxLength={DESCRIPTION_MAX_LENGTH}
            onChange={(event) => {
              set({ description: event.target.value });
            }}
          />
        </Field>
        {draft.category === 'task' ? (
          <Field
            label={t('requests.field_task')}
            helper={t('requests.task_helper')}
            {...optionalError(issue('task_id'))}
          >
            <Select
              value={draft.task_id}
              onChange={(event) => {
                set({ task_id: event.target.value });
              }}
            >
              <option value="">{t('requests.no_task')}</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <p className="field__helper">{t('requests.attach_after')}</p>

        <div className="tasks-form__actions">
          <Button type="submit" loading={busy}>
            {t('requests.submit')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
