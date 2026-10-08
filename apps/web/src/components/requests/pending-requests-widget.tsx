'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany, fetchOne } from '../../lib/api-client';
import {
  DASHBOARD_PENDING_LIMIT,
  decisionBody,
  pendingWidgetQuery,
  requestPath,
  requesterName,
  requestsPath,
  RESPONSE_MAX_LENGTH,
} from '../../lib/requests';
import type { PendingCount, RequestDetail, RequestItem } from '../../lib/requests';
import { Alert, Button, Card, Field, KpiCard, Modal, Skeleton, Textarea } from '../design-system';
import {
  describeError,
  ErrorState,
  LoadingState,
  optionalError,
  SuccessNotice,
} from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { RequestAge, RequestCategoryChip, RequestSummary } from './requests-shared';

/**
 * DOCUMENT 04 B1 KPI row 2, "Pending requests" — the requests awaiting the
 * caller's decision (`GET /requests/pending-count`, basis `review`): company
 * for an ADMIN, team for a MANAGER, never their own (OD-03). It loads, fails
 * and retries on its own.
 */
export function PendingRequestsKpi({
  locale,
  t,
}: {
  readonly locale: Locale;
  readonly t: Translator;
}): React.JSX.Element {
  const load = useCallback(
    (signal: AbortSignal) => fetchOne<PendingCount>('/requests/pending-count', { locale, signal }),
    [locale],
  );
  const resource = useResource(load);

  if (resource.state.status === 'loading') {
    return (
      <Card className="kpi">
        <span className="kpi__label">{t('dashboard.kpi_pending_requests')}</span>
        <Skeleton lines={1} />
      </Card>
    );
  }
  if (resource.state.status === 'error') {
    return (
      <Card className="kpi">
        <span className="kpi__label">{t('dashboard.kpi_pending_requests')}</span>
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      </Card>
    );
  }
  return (
    <KpiCard
      label={t('dashboard.kpi_pending_requests')}
      value={String(resource.state.value.count)}
      delta={t('dashboard.kpi_pending_requests_hint')}
    />
  );
}

/**
 * DOCUMENT 04 B1 widget 7 — "Pending requests: 5 most recent, each with inline
 * approve/reject".
 *
 * `GET /requests?status=pending&reviewable=true`, newest first: only what the
 * caller may decide, in their own scope, never their own request (OD-03 —
 * which the API enforces again on every decision). Approve and reject call
 * the same `/requests/{id}/approve|reject` the inbox uses; reject asks for its
 * required reason in a small dialog. An attendance row is decided by the
 * correction's own logic behind that endpoint.
 */
export function PendingRequestsWidget({
  locale,
  t,
  timeZone,
  onDecided,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
  /** Lets the dashboard refresh the KPI after a decision. */
  readonly onDecided: () => void;
}): React.JSX.Element {
  const load = useCallback(
    (signal: AbortSignal) =>
      fetchMany<RequestItem>('/requests', { locale, signal, query: pendingWidgetQuery() }),
    [locale],
  );
  const resource = useResource(load);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<RequestItem | null>(null);
  const [reason, setReason] = useState('');
  const [missingReason, setMissingReason] = useState(false);

  const decide = (item: RequestItem, decision: 'approve' | 'reject', response: string): void => {
    const result = decisionBody(decision, response);
    if (!result.ok) {
      setMissingReason(true);
      return;
    }
    setBusy(item.id);
    setFailure(null);
    setNotice(null);
    fetchOne<RequestDetail>(`/requests/${item.id}/${decision}`, {
      locale,
      method: 'POST',
      body: result.body,
    })
      .then(() => {
        setRejecting(null);
        setReason('');
        setNotice(
          decision === 'approve' ? t('requests.approved_notice') : t('requests.rejected_notice'),
        );
        onDecided();
        resource.reload();
      })
      .catch((error: unknown) => {
        setFailure(describeError(error, t));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  return (
    <Card
      title={t('dashboard.pending_requests_title')}
      className="tasks-reassignment"
      action={
        <Link className="tasks-back" href={requestsPath(locale)}>
          {t('dashboard.pending_requests_all')}
        </Link>
      }
    >
      <SuccessNotice message={notice} t={t} />
      {failure === null ? null : (
        <Alert tone="danger" title={t('requests.action_failed')}>
          {failure}
        </Alert>
      )}
      {resource.state.status === 'loading' ? (
        <LoadingState t={t} rows={DASHBOARD_PENDING_LIMIT} />
      ) : null}
      {resource.state.status === 'error' ? (
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      ) : null}
      {resource.state.status === 'ready' ? (
        resource.state.value.items.length === 0 ? (
          <p className="tasks-muted">{t('dashboard.pending_requests_empty')}</p>
        ) : (
          <ul className="requests-pending">
            {resource.state.value.items.map((item) => (
              <li key={item.id} className="requests-pending__item">
                <div className="requests-pending__main">
                  <Link className="tasks-title-link" href={requestPath(locale, item.id)}>
                    <RequestSummary item={item} locale={locale} t={t} timeZone={timeZone} />
                  </Link>
                  <span className="tasks-card__chips">
                    <RequestCategoryChip category={item.category} t={t} />
                    <span>{requesterName(item)}</span>
                    <RequestAge item={item} t={t} timeZone={timeZone} />
                  </span>
                </div>
                <div className="requests-pending__actions">
                  <Button
                    size="sm"
                    variant="destructive-ghost"
                    disabled={busy !== null}
                    onClick={() => {
                      setRejecting(item);
                      setReason('');
                      setMissingReason(false);
                    }}
                  >
                    {t('requests.reject')}
                  </Button>
                  <Button
                    size="sm"
                    loading={busy === item.id && rejecting === null}
                    disabled={busy !== null}
                    onClick={() => {
                      decide(item, 'approve', '');
                    }}
                  >
                    {t('requests.approve')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <Modal
        open={rejecting !== null}
        title={t('requests.reject_title')}
        closeLabel={t('action.close')}
        onClose={() => {
          setRejecting(null);
        }}
        footer={
          <>
            <Button
              variant="destructive"
              loading={rejecting !== null && busy === rejecting.id}
              onClick={() => {
                if (rejecting !== null) decide(rejecting, 'reject', reason);
              }}
            >
              {t('requests.reject')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setRejecting(null);
              }}
            >
              {t('action.cancel')}
            </Button>
          </>
        }
      >
        <Field
          label={t('requests.admin_response')}
          required
          helper={t('requests.response_helper')}
          {...optionalError(missingReason ? t('requests.reason_required') : undefined)}
        >
          <Textarea
            value={reason}
            rows={3}
            maxLength={RESPONSE_MAX_LENGTH}
            onChange={(event) => {
              setReason(event.target.value);
              if (missingReason) setMissingReason(false);
            }}
          />
        </Field>
      </Modal>
    </Card>
  );
}
