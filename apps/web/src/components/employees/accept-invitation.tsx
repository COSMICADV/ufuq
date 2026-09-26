'use client';

import { useCallback, useEffect, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ApiError, fetchOne } from '../../lib/api-client';
import {
  acceptanceIssues,
  PASSWORD_MIN_LENGTH,
  passwordLengthOk,
  tokenFromHash,
} from '../../lib/employees';
import { Alert, Button, Card, Choice, Field, Input, Progress } from '../design-system';
import { describeError, LoadingState, optionalError } from '../settings/screen-states';

/**
 * `/{locale}/accept-invitation` — DOCUMENT 04 A4, DOCUMENT 05 FLOW 03. The page
 * the invitation email links to.
 *
 * The token arrives in the URL fragment and is removed from the address bar
 * as soon as it is read, so it does not linger in history or a bookmark
 * (DOCUMENT 20 §6). It is posted once to `POST /auth/accept-invitation`
 * (Phase 3), which applies the password policy — this page only hints at it.
 *
 * A4's read-only company and employee name come from
 * `POST /auth/invitation-preview`, which resolves the token *without*
 * redeeming it: the invitee sees who invited them before choosing a password.
 * A4's terms checkbox gates the submit here and is re-checked by the API, so
 * it is a real condition of activation rather than a drawing of one.
 *
 * States: loading (reading the link, then resolving it), empty (a link with no
 * token), error (an expired or used link — "ask your administrator to resend",
 * DOCUMENT 04 A4 — a preview that could not be reached, with a retry, or a
 * refused password), success (the account is active).
 */

type Outcome = 'form' | 'done' | 'expired';

interface InvitationIdentity {
  readonly company_name: string;
  readonly employee_name: string | null;
}

export function AcceptInvitation({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  // `undefined` until the fragment has been read in the browser.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [identity, setIdentity] = useState<InvitationIdentity | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [loadingIdentity, setLoadingIdentity] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [terms, setTerms] = useState(false);
  const [issues, setIssues] = useState<{
    password?: string;
    confirmation?: string;
    terms?: string;
  }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>('form');

  useEffect(() => {
    const found = tokenFromHash(window.location.hash);
    if (found !== null) {
      setToken(found);
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      return;
    }
    // The fragment is gone once read, so a second run of this effect (React
    // StrictMode, or a remount) must keep the token already captured rather
    // than conclude the link never had one.
    setToken((current) => current ?? null);
  }, []);

  const loadIdentity = useCallback(
    (value: string): void => {
      setLoadingIdentity(true);
      setIdentityError(null);
      fetchOne<InvitationIdentity>('/auth/invitation-preview', {
        locale,
        method: 'POST',
        body: { token: value },
      })
        .then((found) => {
          setIdentity(found);
        })
        .catch((error: unknown) => {
          // A token the API will not resolve is a token it will not redeem
          // either, so say the one useful thing — ask for a resend — instead
          // of letting the invitee type a password that cannot be accepted.
          if (error instanceof ApiError && error.code === 'TOKEN_INVALID') {
            setOutcome('expired');
            return;
          }
          setIdentityError(describeError(error, t));
        })
        .finally(() => {
          setLoadingIdentity(false);
        });
    },
    // `t` is rebuilt every render but is a pure function of `locale`, which is
    // here — so the closure can never be stale, and depending on the
    // translator itself would re-fetch on every render.
    [locale],
  );

  useEffect(() => {
    if (typeof token === 'string') {
      loadIdentity(token);
    }
  }, [token, loadIdentity]);

  const min = String(PASSWORD_MIN_LENGTH);

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (token === null || token === undefined) {
      return;
    }
    const found = acceptanceIssues({ password, confirmation, terms });
    const nextIssues: { password?: string; confirmation?: string; terms?: string } = {
      ...(found.password === undefined
        ? {}
        : { password: t('invitation.policy_too_short', { min }) }),
      ...(found.confirmation === undefined ? {} : { confirmation: t('invitation.mismatch') }),
      ...(found.terms === undefined ? {} : { terms: t('invitation.terms_required') }),
    };
    setIssues(nextIssues);
    setFormError(null);
    if (Object.keys(nextIssues).length > 0) {
      return;
    }

    setSaving(true);
    fetchOne<Record<string, never>>('/auth/accept-invitation', {
      locale,
      method: 'POST',
      body: { token, password, accept_terms: true },
    })
      .then(() => {
        setPassword('');
        setConfirmation('');
        setOutcome('done');
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'TOKEN_INVALID') {
          setOutcome('expired');
          return;
        }
        if (error instanceof ApiError && error.fields['accept_terms'] !== undefined) {
          setIssues({ terms: t('invitation.terms_required') });
          return;
        }
        if (error instanceof ApiError && error.fields['password'] !== undefined) {
          const codes = error.fields['password'];
          setIssues({
            password: codes.includes('breached')
              ? t('invitation.policy_breached')
              : t('invitation.policy_too_short', { min }),
          });
          return;
        }
        setFormError(describeError(error, t));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  let body: React.JSX.Element;
  if (token === undefined || (loadingIdentity && outcome === 'form')) {
    body = <LoadingState t={t} rows={4} />;
  } else if (token === null) {
    body = (
      <Alert tone="warning" title={t('invitation.missing_token_title')}>
        {t('invitation.missing_token')}
      </Alert>
    );
  } else if (outcome === 'expired') {
    body = (
      <Alert tone="danger" title={t('invitation.expired_title')}>
        {t('invitation.expired')}
      </Alert>
    );
  } else if (outcome === 'done') {
    body = (
      <div role="status" aria-live="polite">
        <Alert tone="success" title={t('invitation.success_title')}>
          {t('invitation.success_body')}
        </Alert>
      </div>
    );
  } else if (identityError !== null) {
    body = (
      <>
        <Alert tone="danger" title={t('invitation.identity_error_title')}>
          {identityError}
        </Alert>
        <Button
          type="button"
          onClick={() => {
            loadIdentity(token);
          }}
        >
          {t('action.retry')}
        </Button>
      </>
    );
  } else {
    const lengthProgress = Math.min(100, Math.floor((password.length * 100) / PASSWORD_MIN_LENGTH));
    body = (
      <form className="auth-form" onSubmit={submit} noValidate>
        {formError === null ? null : (
          <Alert tone="danger" title={t('state.action_blocked')}>
            {formError}
          </Alert>
        )}
        {identity === null ? null : (
          <dl className="auth-identity">
            <div>
              <dt>{t('invitation.company_label')}</dt>
              <dd>{identity.company_name}</dd>
            </div>
            {identity.employee_name === null ? null : (
              <div>
                <dt>{t('invitation.employee_label')}</dt>
                <dd>{identity.employee_name}</dd>
              </div>
            )}
          </dl>
        )}
        <Field
          label={t('invitation.password')}
          required
          helper={t('invitation.password_helper', { min })}
          {...optionalError(issues.password)}
        >
          <Input
            type="password"
            dir="ltr"
            autoComplete="new-password"
            value={password}
            maxLength={200}
            required
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </Field>
        <div className="auth-form__meter">
          <Progress value={lengthProgress} label={t('invitation.strength_label')} />
          <span>
            {passwordLengthOk(password)
              ? t('invitation.strength_ok')
              : t('invitation.strength_short')}
          </span>
        </div>
        <Field
          label={t('invitation.confirm_password')}
          required
          {...optionalError(issues.confirmation)}
        >
          <Input
            type="password"
            dir="ltr"
            autoComplete="new-password"
            value={confirmation}
            maxLength={200}
            required
            onChange={(event) => {
              setConfirmation(event.target.value);
            }}
          />
        </Field>
        <div className="auth-form__terms">
          <Choice
            type="checkbox"
            label={t('invitation.terms_label')}
            checked={terms}
            required
            aria-invalid={issues.terms === undefined ? undefined : true}
            onChange={(event) => {
              setTerms(event.target.checked);
            }}
          />
          {issues.terms === undefined ? null : (
            <p className="auth-form__terms-error" role="alert">
              {issues.terms}
            </p>
          )}
        </div>
        <Button type="submit" size="lg" loading={saving}>
          {saving ? t('state.saving') : t('invitation.submit')}
        </Button>
      </form>
    );
  }

  return (
    <Card className="auth-card">
      <header className="auth-card__heading">
        <strong className="auth-card__brand">{t('app.name')}</strong>
        <h1>{t('invitation.title')}</h1>
        <p>{t('invitation.description')}</p>
      </header>
      {body}
    </Card>
  );
}
