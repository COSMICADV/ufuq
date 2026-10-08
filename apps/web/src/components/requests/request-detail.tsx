'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchOne } from '../../lib/api-client';
import { decisionBody, RESPONSE_MAX_LENGTH, requesterName } from '../../lib/requests';
import type { RequestDetail } from '../../lib/requests';
import { taskPath } from '../../lib/tasks';
import { CorrectionComparison, Detail, departmentName } from '../attendance/attendance-shared';
import { Alert, Button, Card, Field, Modal, Textarea } from '../design-system';
import { loadSession } from '../employees/use-session';
import { RecordHistory } from '../settings/record-history';
import {
  describeError,
  ErrorState,
  LoadingState,
  optionalError,
  SuccessNotice,
} from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { TaskAttachments } from '../tasks/task-attachments';
import { LeaveContext } from '../leave/leave-context';

import {
  RequestAge,
  RequestCategoryChip,
  RequestStatusChip,
  RequestSummary,
  SubmittedOn,
} from './requests-shared';

/**
 * A request — DOCUMENT 04 B13 detail (`/admin/requests/:id`) and C10
 * (`/app/requests/:id`).
 *
 * - **The complete request**: category, status, subject and description, the
 *   submission date and, while it waits, its age.
 * - **Employee context** (admin): who asked, their code and department.
 *   DOCUMENT 04 B13's "leave balance for leave requests" belongs to Phase 10.
 * - **Attendance context**: an attendance row shows the correction's current
 *   recorded values against the requested ones — the same comparison as the
 *   corrections screen.
 * - **Decision**: the reviewer, the time and the admin response; on the admin
 *   surface, approve / reject with a response field — reject requires one.
 *   What the caller may do is the server's answer (`abilities`); OD-03 means a
 *   reviewer's own request shows why it is not theirs to decide.
 * - **Cancel**: the requester's own pending request only, after confirming.
 * - **Attachments**: the attachment store's one card, authorised by the request.
 * - **Decision history**: the record's audit trail, for a caller with
 *   `audit.view`.
 */
export function RequestDetailScreen({
  locale,
  requestId,
  surface,
}: {
  readonly locale: Locale;
  readonly requestId: string;
  readonly surface: 'admin' | 'app';
}): React.JSX.Element {
  const t = createTranslator(locale);
  const params = new URLSearchParams(useSearchParams()?.toString() ?? '');
  const [updated, setUpdated] = useState<RequestDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(
    params.get('notice') === 'submitted' ? t('requests.submitted_notice') : null,
  );
  const [version, setVersion] = useState(0);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, request] = await Promise.all([
        loadSession(locale, signal),
        fetchOne<RequestDetail>(`/requests/${requestId}`, { locale, signal }),
      ]);
      return { session, request };
    },
    [locale, requestId],
  );
  const resource = useResource(load);

  if (resource.state.status === 'loading') {
    return <LoadingState t={t} rows={8} />;
  }
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const { session } = resource.state.value;
  const request = updated ?? resource.state.value.request;
  const zone = session.timeZone;
  const admin = surface === 'admin';

  const changed = (next: RequestDetail, message: string): void => {
    setUpdated(next);
    setNotice(message);
    setVersion((v) => v + 1);
  };

  return (
    <div className="requests-detail">
      <SuccessNotice message={notice} t={t} />

      <Card className="requests-detail__summary">
        <div className="tasks-card__chips">
          <RequestCategoryChip category={request.category} t={t} />
          <RequestStatusChip status={request.status} t={t} />
          <RequestAge item={request} t={t} timeZone={zone} />
        </div>
        <h2 className="requests-detail__subject">
          <RequestSummary item={request} locale={locale} t={t} timeZone={zone} />
        </h2>
        {request.description === null ? null : (
          <p className="requests-detail__description" dir="auto">
            {request.description}
          </p>
        )}
        <dl className="attendance-details">
          <Detail label={t('requests.col_submitted')}>
            <SubmittedOn item={request} locale={locale} timeZone={zone} />
          </Detail>
          {admin ? (
            <>
              <Detail label={t('requests.col_employee')}>
                {session.permissions.has('employee.view') ? (
                  <Link href={`/${locale}/admin/employees/${request.employee.id}`}>
                    {requesterName(request)}
                  </Link>
                ) : (
                  requesterName(request)
                )}{' '}
                <span className="tasks-muted" dir="ltr">
                  {request.employee.employee_code}
                </span>
              </Detail>
              {request.employee.department === null ? null : (
                <Detail label={t('requests.department')}>
                  {departmentName(request.employee.department, locale)}
                </Detail>
              )}
            </>
          ) : null}
          {request.task === null ? null : (
            <Detail label={t('requests.field_task')}>
              <Link href={taskPath(locale, request.task.id, surface)}>{request.task.title}</Link>
            </Detail>
          )}
        </dl>
      </Card>

      {request.attendance === null ? null : (
        <Card title={t('requests.attendance_context')}>
          <CorrectionComparison
            correction={request.attendance}
            locale={locale}
            t={t}
            timeZone={zone}
          />
        </Card>
      )}

      {request.leave === null ? null : (
        <LeaveContext
          leave={request.leave}
          locale={locale}
          t={t}
          timeZone={zone}
          onCancelled={() => {
            fetchOne<RequestDetail>(`/requests/${request.id}`, { locale })
              .then((next) => {
                changed(next, t('leave.cancelled_approved_notice'));
              })
              .catch(() => {
                resource.reload();
              });
          }}
        />
      )}

      <DecisionCard
        request={request}
        surface={surface}
        locale={locale}
        t={t}
        timeZone={zone}
        onChanged={changed}
      />

      <TaskAttachments
        key={`attachments-${request.id}-${request.status}`}
        recordId={request.id}
        relatedType="request"
        initial={{
          items: request.attachments,
          can_upload: request.attachment_abilities.can_upload,
          can_delete: request.attachment_abilities.can_delete,
        }}
        locale={locale}
        t={t}
        timeZone={zone}
      />

      {admin && session.permissions.has('audit.view') ? (
        <RecordHistory
          key={`history-${String(version)}`}
          locale={locale}
          t={t}
          entityType={
            request.attendance !== null
              ? 'attendance_correction_request'
              : request.leave !== null
                ? 'leave_request'
                : 'request'
          }
          entityId={request.attendance?.id ?? request.leave?.id ?? request.id}
          timeZone={zone}
          title={t('requests.history_title')}
          fullLogLabel={t('employees.history_full_log')}
          emptyTitle={t('requests.history_empty_title')}
          emptyDescription={t('requests.history_empty')}
        />
      ) : null}
    </div>
  );
}

function DecisionCard({
  request,
  surface,
  locale,
  t,
  timeZone,
  onChanged,
}: {
  readonly request: RequestDetail;
  readonly surface: 'admin' | 'app';
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
  readonly onChanged: (next: RequestDetail, message: string) => void;
}): React.JSX.Element {
  const [response, setResponse] = useState('');
  const [missingReason, setMissingReason] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'reject' | 'cancel' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const send = (action: 'approve' | 'reject' | 'cancel', body: Record<string, string>): void => {
    setBusy(action);
    setFailure(null);
    fetchOne<RequestDetail>(`/requests/${request.id}/${action}`, {
      locale,
      method: 'POST',
      body,
    })
      .then((next) => {
        setResponse('');
        setConfirmCancel(false);
        onChanged(
          next,
          action === 'approve'
            ? t('requests.approved_notice')
            : action === 'reject'
              ? t('requests.rejected_notice')
              : t('requests.cancelled_notice'),
        );
      })
      .catch((error: unknown) => {
        setFailure(describeError(error, t));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const decide = (decision: 'approve' | 'reject'): void => {
    const result = decisionBody(decision, response);
    if (!result.ok) {
      setMissingReason(true);
      return;
    }
    setMissingReason(false);
    send(decision, result.body);
  };

  const pending = request.status === 'pending';
  const decided = request.status === 'approved' || request.status === 'rejected';

  return (
    <Card title={t('requests.decision_title')} className="requests-decision">
      {failure === null ? null : (
        <Alert tone="danger" title={t('requests.action_failed')}>
          {failure}
        </Alert>
      )}

      {decided ? (
        <dl className="attendance-details">
          <Detail label={t('requests.decision')}>
            <RequestStatusChip status={request.status} t={t} />
          </Detail>
          {request.reviewed_by === null ? null : (
            <Detail label={t('requests.reviewer')}>{request.reviewed_by.name}</Detail>
          )}
          {request.reviewed_at === null ? null : (
            <Detail label={t('requests.reviewed_at')}>
              <SubmittedOn
                item={{ created_at: request.reviewed_at }}
                locale={locale}
                timeZone={timeZone}
              />
            </Detail>
          )}
          <Detail label={t('requests.admin_response')}>
            {request.admin_response === null ? (
              <span className="tasks-muted">{t('requests.no_response')}</span>
            ) : (
              <span dir="auto" className="requests-detail__description">
                {request.admin_response}
              </span>
            )}
          </Detail>
        </dl>
      ) : null}

      {request.status === 'cancelled' ? (
        <p className="tasks-muted">{t('requests.cancelled_state')}</p>
      ) : null}

      {pending && !request.abilities.can_review ? (
        surface === 'admin' && request.is_own ? (
          <Alert tone="info" title={t('requests.self_review_title')}>
            {t('requests.self_review_note')}
          </Alert>
        ) : (
          <p className="tasks-muted">{t('requests.awaiting_decision')}</p>
        )
      ) : null}

      {pending && surface === 'admin' && request.abilities.can_review ? (
        <div className="tasks-form__grid">
          <Field
            label={t('requests.admin_response')}
            helper={t('requests.response_helper')}
            {...optionalError(missingReason ? t('requests.reason_required') : undefined)}
          >
            <Textarea
              value={response}
              rows={3}
              maxLength={RESPONSE_MAX_LENGTH}
              onChange={(event) => {
                setResponse(event.target.value);
                if (missingReason) setMissingReason(false);
              }}
            />
          </Field>
          <div className="tasks-form__actions">
            <Button
              variant="destructive"
              loading={busy === 'reject'}
              disabled={busy !== null}
              onClick={() => {
                decide('reject');
              }}
            >
              {t('requests.reject')}
            </Button>
            <Button
              loading={busy === 'approve'}
              disabled={busy !== null}
              onClick={() => {
                decide('approve');
              }}
            >
              {t('requests.approve')}
            </Button>
          </div>
        </div>
      ) : null}

      {request.abilities.can_cancel ? (
        <div className="tasks-form__actions">
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => {
              setConfirmCancel(true);
            }}
          >
            {t('requests.cancel_request')}
          </Button>
        </div>
      ) : null}

      <Modal
        open={confirmCancel}
        title={t('requests.cancel_title')}
        closeLabel={t('action.close')}
        onClose={() => {
          setConfirmCancel(false);
        }}
        footer={
          <>
            <Button
              variant="destructive"
              loading={busy === 'cancel'}
              onClick={() => {
                send('cancel', {});
              }}
            >
              {t('requests.cancel_request')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmCancel(false);
              }}
            >
              {t('requests.keep_request')}
            </Button>
          </>
        }
      >
        <p>{t('requests.cancel_body')}</p>
      </Modal>
    </Card>
  );
}
