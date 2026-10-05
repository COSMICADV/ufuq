'use client';

import type { ReactNode } from 'react';
import type { Translator } from '@ufuq/i18n';

import { Alert, Button, Skeleton } from '../design-system';
import { ApiError } from '../../lib/api-client';
import { pageWindow } from '../../lib/paging';

/**
 * The pieces every settings screen needs for DOCUMENT 11 §2's four states, so
 * that "loading" and "error" look and behave the same on all four screens
 * rather than being reinvented per screen (DOCUMENT 27 RULE 20).
 */

/**
 * The error state — DOCUMENT 11 §2: says what failed in the user's language,
 * offers a next step, and never exposes an internal identifier.
 *
 * An expired session is called out separately because it needs a different
 * next step: retrying will not help, signing in again will.
 */
export function ErrorState({
  error,
  t,
  onRetry,
}: {
  readonly error: ApiError;
  readonly t: Translator;
  readonly onRetry: () => void;
}): React.JSX.Element {
  const unauthenticated = error.isUnauthenticated;
  return (
    <div className="state-block">
      {/* Title says what happened, body says what to do next — DOCUMENT 11
          §11. An expired session gets both of its own: retrying will not
          help, and saying "try again" when it cannot work is worse than
          saying nothing. */}
      <Alert
        tone="danger"
        title={unauthenticated ? t('state.session_required_title') : t('state.error')}
      >
        {unauthenticated ? t('state.session_required') : t('state.error_detail')}
      </Alert>
      {unauthenticated ? null : (
        <Button variant="secondary" onClick={onRetry}>
          {t('action.retry')}
        </Button>
      )}
    </div>
  );
}

/**
 * The loading state — DOCUMENT 11 §2: "skeletons matching the real layout",
 * never a full-page spinner. `rows` lets a caller match the shape of what is
 * coming rather than always showing three grey bars.
 */
export function LoadingState({
  t,
  rows = 4,
}: {
  readonly t: Translator;
  readonly rows?: number;
}): React.JSX.Element {
  return (
    <div className="state-block" aria-label={t('state.loading')}>
      <Skeleton lines={rows} />
    </div>
  );
}

/**
 * The success state — DOCUMENT 11 §2. A live region, so a change confirmed
 * only by a colour and a position on screen is still announced (DOCUMENT 11
 * §10: "live regions announce toasts, validation summaries, and async
 * completions").
 */
export function SuccessNotice({
  message,
  t,
}: {
  /** What happened, in the past tense — "Added", "Saved", "Removed". */
  readonly message: string | null;
  readonly t: Translator;
}): React.JSX.Element {
  return (
    <div className="state-live" role="status" aria-live="polite">
      {message === null ? null : (
        <Alert tone="success" title={message}>
          {t('state.success_detail')}
        </Alert>
      )}
    </div>
  );
}

/**
 * The pagination footer — DOCUMENT 03 §7's page skeleton, and DOCUMENT 11 §6
 * ("pagination at the foot"). Rendered as links so a page is addressable and
 * survives a refresh, which state alone could not do.
 *
 * It renders nothing at all for a single page: a "1 of 1" control is furniture
 * with no purpose.
 */
export function Pagination({
  page,
  totalPages,
  hrefForPage,
  t,
}: {
  readonly page: number;
  readonly totalPages: number;
  readonly hrefForPage: (page: number) => string;
  readonly t: Translator;
}): React.JSX.Element | null {
  const window = pageWindow(page, totalPages);
  if (window.totalPages <= 1) {
    return null;
  }

  return (
    <nav className="pagination" aria-label={t('settings.pagination')}>
      <a
        className={window.hasPrevious ? '' : 'is-disabled'}
        href={window.hasPrevious ? hrefForPage(page - 1) : undefined}
        {...(window.hasPrevious ? {} : { 'aria-disabled': true as const, tabIndex: -1 })}
      >
        {t('action.previous')}
      </a>
      <span>{t('settings.page_of', { page: String(page), total: String(window.totalPages) })}</span>
      <a
        className={window.hasNext ? '' : 'is-disabled'}
        href={window.hasNext ? hrefForPage(page + 1) : undefined}
        {...(window.hasNext ? {} : { 'aria-disabled': true as const, tabIndex: -1 })}
      >
        {t('action.next')}
      </a>
    </nav>
  );
}

/**
 * A table cell that also carries its own column label.
 *
 * Below 1024px DOCUMENT 22 requires tables to become stacked cards. The label
 * is `display: none` on wide screens — so it is absent from the accessibility
 * tree, and the `<th>` does the associating — and becomes visible in card
 * mode, where the header row is no longer beside the value.
 */
export function Cell({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <>
      <span className="cell-label">{label}</span>
      <span className="cell-value">{children}</span>
    </>
  );
}

/**
 * A value that must stay left-to-right inside right-to-left text — a
 * timezone, a currency code, a time, a date (DOCUMENT 10 §9.7). `isolate` is
 * what stops the surrounding Arabic from reordering it.
 */
export function Ltr({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <span dir="ltr" className="ltr-value">
      {children}
    </span>
  );
}

/**
 * `exactOptionalPropertyTypes` makes `error={undefined}` a type error distinct
 * from omitting the prop, and every form field here has an error message only
 * sometimes. Spreading the result keeps that at one line per field instead of
 * a conditional around each one.
 */
export function optionalError(message: string | undefined): { error?: string } {
  return message === undefined ? {} : { error: message };
}

/**
 * Turn a failure into a sentence the user can act on — DOCUMENT 11 §11: state
 * what happened, and what to do next, without exposing internals.
 *
 * The specific 409 codes matter. "This department still has positions
 * assigned to it" tells an admin what to do; "could not save" does not, and
 * DOCUMENT 11 §11 lists exactly that difference as the line between a bad
 * message and a good one.
 */
export function describeError(error: unknown, t: Translator): string {
  if (!(error instanceof ApiError)) {
    return t('state.error');
  }
  if (error.isUnauthenticated) {
    return t('state.session_required');
  }
  switch (error.code) {
    case 'DEPARTMENT_HAS_CHILDREN':
      return t('error.department_has_children');
    case 'DEPARTMENT_HAS_POSITIONS':
      return t('error.department_has_positions');
    case 'FORBIDDEN':
      return t('error.forbidden');
    case 'NOT_FOUND':
      return t('error.not_found');
    case 'CONFLICT':
      return t('error.conflict');
    // Phase 5 — each names the state that blocked the action and what to do.
    case 'DEPARTMENT_HAS_EMPLOYEES':
      return t('error.department_has_employees');
    case 'EMPLOYEE_ALREADY_ACTIVE':
      return t('error.employee_already_active');
    case 'EMPLOYEE_ALREADY_INACTIVE':
      return t('error.employee_already_inactive');
    case 'EMPLOYEE_TERMINATED':
      return t('error.employee_terminated');
    case 'EMPLOYEE_NOT_ACTIVE':
      return t('error.employee_not_active');
    case 'ACCOUNT_ALREADY_ACTIVATED':
      return t('error.account_already_activated');
    case 'LAST_ACTIVE_ADMIN':
      return t('error.last_active_admin');
    case 'MAIL_DELIVERY_FAILED':
      return t('error.mail_delivery_failed');
    // Phase 7 — tasks (DOCUMENT 13 "Error states").
    case 'INVALID_STATUS_TRANSITION':
      return t('error.invalid_status_transition');
    case 'TASK_HAS_OPEN_ITEMS':
      return t('error.task_has_open_items');
    default:
      return t('state.error');
  }
}
