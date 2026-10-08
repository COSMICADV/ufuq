'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchOne, issueKeys, uploadForm } from '../../lib/api-client';
import { ACCEPT_ATTRIBUTE } from '../../lib/attachments';
import {
  calculateQuery,
  EMPTY_LEAVE_FORM,
  formatDays,
  isNegative,
  leaveSubmission,
  REASON_MAX_LENGTH,
  typeName,
  validateLeaveForm,
} from '../../lib/leave';
import type { LeaveBalance, LeaveCalculation, LeaveForm, LeaveType } from '../../lib/leave';
import { requestsPath } from '../../lib/requests';
import { Alert, Button, Field, Input, Select, Textarea } from '../design-system';
import { describeError, ErrorState, LoadingState, optionalError } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

/**
 * The leave category of DOCUMENT 04 C9 — DOCUMENT 05 FLOW 07, DOCUMENT 16
 * "Mobile behaviour".
 *
 * - The type, with its **live balance above the dates** so the impact is
 *   visible before submitting.
 * - Native date pickers; **the server counts the days** as they change
 *   (`GET /leave-requests/calculate`). The client never calculates or sends a
 *   day count.
 * - The impact per year, and the consequence spelled out: insufficient
 *   balance blocks ("your remaining balance is 3 days and the request is 5");
 *   a type that allows a negative balance warns that the excess is unpaid; an
 *   unpaid type says payroll deducts it.
 * - The attachment field when the type requires one (the native picker, which
 *   offers the camera on a phone); the file is checked with the submission.
 */

/** A short pause so the count follows typing without a request per keystroke. */
const CALCULATE_DELAY_MS = 300;

export function LeaveRequestForm({
  locale,
  t,
}: {
  readonly locale: Locale;
  readonly t: Translator;
}): React.JSX.Element {
  const router = useRouter();
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [types, balances] = await Promise.all([
        fetchOne<readonly LeaveType[]>('/leave-types', { locale, signal }),
        fetchOne<readonly LeaveBalance[]>('/leave-balances/me', { locale, signal }),
      ]);
      return { types, balances };
    },
    [locale],
  );
  const resource = useResource(load);

  const [draft, setDraft] = useState<LeaveForm>(EMPTY_LEAVE_FORM);
  const [file, setFile] = useState<File | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [calculation, setCalculation] = useState<
    | { readonly status: 'idle' }
    | { readonly status: 'loading' }
    | { readonly status: 'ready'; readonly value: LeaveCalculation }
    | { readonly status: 'error'; readonly message: string }
  >({ status: 'idle' });
  const picker = useRef<HTMLInputElement>(null);

  const query = calculateQuery(draft);
  const queryKey = query === null ? '' : JSON.stringify(query);
  useEffect(() => {
    if (queryKey === '') {
      setCalculation({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    setCalculation({ status: 'loading' });
    const timer = setTimeout(() => {
      fetchOne<LeaveCalculation>('/leave-requests/calculate', {
        locale,
        signal: controller.signal,
        query: JSON.parse(queryKey) as Record<string, string>,
      })
        .then((value) => {
          setCalculation({ status: 'ready', value });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const fieldKey =
            error instanceof ApiError ? (Object.values(issueKeys(error))[0] ?? null) : null;
          setCalculation({
            status: 'error',
            message:
              error instanceof ApiError && error.code === 'LEAVE_NO_WORKING_DAYS'
                ? t('error.leave_no_working_days')
                : fieldKey !== null && fieldKey !== 'validation.invalid'
                  ? t(fieldKey)
                  : describeError(error, t),
          });
        });
    }, CALCULATE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [queryKey, locale, t]);

  if (resource.state.status === 'loading') {
    return <LoadingState t={t} rows={5} />;
  }
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const { types, balances } = resource.state.value;
  const type = types.find((candidate) => candidate.id === draft.leave_type_id) ?? null;
  const balance =
    balances.find((candidate) => candidate.leave_type.id === draft.leave_type_id) ?? null;

  const set = (patch: Partial<LeaveForm>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const issue = (field: string): string | undefined =>
    issues[field] === undefined ? undefined : t(issues[field]);

  const submit = (): void => {
    const found = validateLeaveForm(draft, {
      requiresAttachment: type?.requires_attachment ?? false,
      hasFile: file !== null,
    });
    setIssues(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;
    if (calculation.status === 'ready' && !calculation.value.sufficient) return;
    setBusy(true);
    const submission = leaveSubmission(draft, file);
    const sent =
      submission.kind === 'form'
        ? uploadForm<unknown>('/leave-requests', submission.body, { locale })
        : fetchOne<unknown>('/leave-requests', { locale, method: 'POST', body: submission.body });
    sent
      .then(() => {
        router.push(`${requestsPath(locale, 'app')}?notice=submitted`);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError) {
          const keys = issueKeys(error);
          if (Object.keys(keys).length > 0) setIssues(keys);
        }
        setFailure(describeError(error, t));
        setBusy(false);
      });
  };

  const calc = calculation.status === 'ready' ? calculation.value : null;

  return (
    <form
      className="tasks-form__grid"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {failure === null ? null : (
        <Alert tone="danger" title={t('requests.submit_failed')}>
          {failure}
        </Alert>
      )}

      <Field label={t('leave.field_type')} required {...optionalError(issue('leave_type_id'))}>
        <Select
          value={draft.leave_type_id}
          onChange={(event) => {
            set({ leave_type_id: event.target.value });
            setFile(null);
          }}
        >
          <option value="">{t('leave.choose_type')}</option>
          {types.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {typeName(candidate, locale)}
            </option>
          ))}
        </Select>
      </Field>

      {type === null ? null : type.is_paid ? (
        <p className="leave-balance-line">
          {balance === null
            ? t('leave.balance_unknown')
            : t('leave.balance_line', {
                remaining: formatDays(balance.remaining_days),
                total: formatDays(balance.total_days),
              })}
        </p>
      ) : (
        <Alert tone="info" title={t('leave.unpaid_title')}>
          {t('leave.unpaid_note')}
        </Alert>
      )}

      <div className="tasks-form__dates">
        <Field label={t('leave.start_date')} required {...optionalError(issue('start_date'))}>
          <Input
            type="date"
            value={draft.start_date}
            onChange={(event) => {
              set({ start_date: event.target.value });
            }}
          />
        </Field>
        <Field label={t('leave.end_date')} required {...optionalError(issue('end_date'))}>
          <Input
            type="date"
            value={draft.end_date}
            min={draft.start_date === '' ? undefined : draft.start_date}
            onChange={(event) => {
              set({ end_date: event.target.value });
            }}
          />
        </Field>
      </div>

      <div className="leave-calculation" aria-live="polite">
        {calculation.status === 'loading' ? (
          <p className="tasks-muted">{t('leave.calculating')}</p>
        ) : null}
        {calculation.status === 'error' ? (
          <Alert tone="warning" title={t('leave.cannot_calculate')}>
            {calculation.message}
          </Alert>
        ) : null}
        {calc === null ? null : (
          <>
            <p className="leave-calculation__count">
              {t('leave.working_days', { days: formatDays(calc.days_count) })}
            </p>
            {calc.balance_impact.map((impact) => (
              <p key={impact.year} className="tasks-muted">
                {t('leave.impact_line', {
                  year: String(impact.year),
                  days: formatDays(impact.days),
                  after: formatDays(impact.remaining_after),
                })}
              </p>
            ))}
            {!calc.sufficient ? (
              <Alert tone="danger" title={t('error.leave_insufficient_balance')}>
                {t('leave.insufficient', {
                  remaining: formatDays(
                    calc.balance_impact.find((i) => isNegative(i.remaining_after))
                      ?.remaining_before ?? '0',
                  ),
                  requested: formatDays(calc.days_count),
                })}
              </Alert>
            ) : calc.excess_days !== '0.00' ? (
              <Alert tone="warning" title={t('leave.excess_title')}>
                {t('leave.excess_note', { days: formatDays(calc.excess_days) })}
              </Alert>
            ) : null}
          </>
        )}
      </div>

      <Field
        label={t('leave.reason')}
        required
        helper={t('leave.reason_helper')}
        {...optionalError(issue('reason'))}
      >
        <Textarea
          value={draft.reason}
          rows={3}
          maxLength={REASON_MAX_LENGTH}
          onChange={(event) => {
            set({ reason: event.target.value });
          }}
        />
      </Field>

      {type?.requires_attachment === true ? (
        <Field
          label={t('leave.attachment')}
          required
          helper={t('attachments.hint')}
          {...optionalError(issue('file'))}
        >
          <input
            ref={picker}
            type="file"
            accept={ACCEPT_ATTRIBUTE}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
            }}
          />
        </Field>
      ) : null}

      <div className="tasks-form__actions">
        <Button
          type="submit"
          loading={busy}
          disabled={calculation.status === 'ready' && !calculation.value.sufficient}
        >
          {t('requests.submit')}
        </Button>
      </div>
    </form>
  );
}
