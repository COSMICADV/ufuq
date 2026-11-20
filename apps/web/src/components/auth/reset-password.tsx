'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ApiError, fetchOne } from '../../lib/api-client';
import { PASSWORD_MIN_LENGTH, tokenFromHash } from '../../lib/employees';
import { publicPath } from '../../lib/public-content';
import { Alert, Button, Card, Field, Input } from '../design-system';
import { describeError, LoadingState, optionalError } from '../settings/screen-states';

type Outcome = 'form' | 'done' | 'expired';

/**
 * `/{locale}/reset-password` — the page the reset email links to. The token
 * arrives in the URL fragment and is removed from the address bar as soon as
 * it is read (DOCUMENT 20 §6), then posted once to `POST /auth/reset-password`,
 * which applies the password policy and ends the account's other sessions.
 */
export function ResetPassword({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [issues, setIssues] = useState<{ password?: string; confirmation?: string }>({});
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
    setToken((current) => current ?? null);
  }, []);

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (typeof token !== 'string') return;
    const next: { password?: string; confirmation?: string } = {
      ...(password.length < PASSWORD_MIN_LENGTH ? { password: t('reset_password.short') } : {}),
      ...(confirmation !== password ? { confirmation: t('reset_password.mismatch') } : {}),
    };
    setIssues(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;
    setSaving(true);
    fetchOne<Record<string, never>>('/auth/reset-password', {
      locale,
      method: 'POST',
      body: { token, newPassword: password },
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
        if (error instanceof ApiError && error.fields['newPassword'] !== undefined) {
          setIssues({ password: t('reset_password.short') });
          return;
        }
        setFormError(describeError(error, t));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  let body: React.JSX.Element;
  if (token === undefined) {
    body = <LoadingState t={t} rows={3} />;
  } else if (token === null) {
    body = (
      <Alert tone="warning" title={t('reset_password.expired_title')}>
        {t('reset_password.missing')}
      </Alert>
    );
  } else if (outcome === 'expired') {
    body = (
      <>
        <Alert tone="danger" title={t('reset_password.expired_title')}>
          {t('reset_password.expired_body')}
        </Alert>
        <Link href={`${publicPath(locale, 'login')}?reset=1`}>
          {t('reset_password.request_new')}
        </Link>
      </>
    );
  } else if (outcome === 'done') {
    body = (
      <div role="status" aria-live="polite">
        <Alert tone="success" title={t('reset_password.done_title')}>
          {t('reset_password.done_body')}
        </Alert>
        <Link href={publicPath(locale, 'login')}>{t('reset_password.sign_in')}</Link>
      </div>
    );
  } else {
    body = (
      <form className="auth-form" onSubmit={submit} noValidate>
        {formError === null ? null : (
          <Alert tone="danger" title={t('state.action_blocked')}>
            {formError}
          </Alert>
        )}
        <Field
          label={t('reset_password.password')}
          required
          helper={t('reset_password.help')}
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
        <Field label={t('reset_password.confirm')} required {...optionalError(issues.confirmation)}>
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
        <Button type="submit" size="lg" loading={saving}>
          {saving ? t('reset_password.saving') : t('reset_password.submit')}
        </Button>
      </form>
    );
  }

  return (
    <Card className="auth-card">
      <header className="auth-card__heading">
        <strong className="auth-card__brand">{t('app.name')}</strong>
        <h1>{t('reset_password.title')}</h1>
        <p>{t('reset_password.lead')}</p>
      </header>
      {body}
    </Card>
  );
}
