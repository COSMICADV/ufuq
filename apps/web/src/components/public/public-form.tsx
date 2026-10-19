'use client';
import { useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import { describeError } from '../settings/screen-states';
import type { Locale } from '@ufuq/i18n';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ApiError, fetchOne } from '../../lib/api-client';
import { publicCopy, publicPath } from '../../lib/public-content';
import { Button, Field, Input } from '../design-system';

export function PublicForm({
  locale,
  kind,
}: {
  readonly locale: Locale;
  readonly kind: 'contact' | 'register' | 'login' | 'forgot';
}): React.JSX.Element {
  const c = publicCopy[locale];
  const router = useRouter();
  const [started] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<readonly string[]>([]);
  const [show, setShow] = useState(false);
  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form));
    const body =
      kind === 'login'
        ? { email: values.email, password: values.password, rememberMe: values.remember === 'on' }
        : kind === 'forgot'
          ? { email: values.email }
          : { ...values, started_at: started };
    setBusy(true);
    setError('');
    setFields([]);
    try {
      await fetchOne(
        kind === 'login'
          ? '/auth/login'
          : kind === 'forgot'
            ? '/auth/forgot-password'
            : `/public/${kind}`,
        { locale, method: 'POST', body },
      );
      if (kind === 'login') {
        const me = await fetchOne<{ role: { key: string } }>('/auth/me', { locale });
        router.push(
          `/${locale}/${me.role.key === 'employee' ? 'app' : me.role.key === 'admin' ? 'admin/settings/company' : 'admin'}`,
        );
      } else {
        setDone(true);
      }
    } catch (e) {
      const api = e instanceof ApiError ? e : null;
      setFields(Object.keys(api?.fields ?? {}));
      setError(
        api?.status === 429
          ? c.rate
          : api?.status === 422
            ? c.invalid
            : api?.status === 409
              ? c.conflict
              : api?.status === 401
                ? describeError(api, createTranslator(locale))
                : c.error,
      );
    } finally {
      setBusy(false);
    }
  };
  if (done)
    return (
      <div role="status" className="public-success">
        <p>{kind === 'register' ? c.registered : kind === 'forgot' ? c.resetSent : c.sent}</p>
        {kind === 'register' || kind === 'forgot' ? (
          <Link href={publicPath(locale, 'login')}>{c.login}</Link>
        ) : null}
      </div>
    );
  const input = (
    name: string,
    label: string,
    type = 'text',
    max = 200,
    min = 1,
  ): React.JSX.Element => (
    <Field
      label={label}
      required
      {...(name === 'password' && kind === 'register' ? { helper: c.passwordHelp } : {})}
      {...(fields.includes(name) ? { error: c.fieldInvalid } : {})}
    >
      <Input
        aria-invalid={fields.includes(name)}
        name={name}
        type={type}
        dir={['email', 'tel', 'password'].includes(type) ? 'ltr' : undefined}
        autoComplete={
          name === 'email'
            ? 'email'
            : name === 'password'
              ? kind === 'register'
                ? 'new-password'
                : 'current-password'
              : name === 'phone'
                ? 'tel'
                : name === 'company_name' || name === 'company'
                  ? 'organization'
                  : 'name'
        }
        required
        maxLength={max}
        minLength={min}
      />
    </Field>
  );
  return (
    <form
      className="public-form"
      onSubmit={(e) => {
        void submit(e);
      }}
    >
      <noscript>
        <p>{c.noJs}</p>
      </noscript>
      {error ? (
        <p tabIndex={-1} role="alert">
          {error}
        </p>
      ) : null}
      <fieldset disabled={busy}>
        {kind === 'contact' ? input('name', c.name) : null}
        {kind === 'register' ? input('admin_name', c.admin) : null}
        {kind === 'contact' || kind === 'register'
          ? input(kind === 'contact' ? 'company' : 'company_name', c.company)
          : null}
        {input('email', c.email, 'email', 255)}
        {kind === 'contact' || kind === 'register' ? input('phone', c.phone, 'tel', 40, 5) : null}
        {kind === 'register' ? (
          <label>
            {c.employees}
            <select
              name="employee_count_range"
              aria-invalid={fields.includes('employee_count_range')}
              required
              defaultValue=""
            >
              <option value="" disabled>
                —
              </option>
              {['1-10', '11-50', '51-200', '201+'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        ) : null}
        {kind === 'register' || kind === 'login' ? (
          <>
            {input(
              'password',
              c.password,
              show ? 'text' : 'password',
              200,
              kind === 'register' ? 10 : 1,
            )}
            <button
              className="button button--secondary"
              type="button"
              aria-pressed={show}
              onClick={() => {
                setShow(!show);
              }}
            >
              {show ? c.hide : c.show}
            </button>
          </>
        ) : null}
        {kind === 'login' ? (
          <label className="public-check">
            <input type="checkbox" name="remember" />
            {c.remember}
          </label>
        ) : null}
        {kind === 'contact' ? (
          <>
            <label>
              {c.enquiry}
              <select name="enquiry_type" aria-invalid={fields.includes('enquiry_type')} required>
                {['pricing', 'product', 'support', 'other'].map((v, i) => (
                  <option key={v} value={v}>
                    {c.enquiryOptions[i]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {c.message}
              <textarea
                name="message"
                aria-invalid={fields.includes('message')}
                minLength={10}
                maxLength={5000}
                required
                rows={6}
              />
            </label>
          </>
        ) : null}
        {kind === 'contact' || kind === 'register' ? (
          <div className="public-honeypot" aria-hidden="true">
            <label>
              Website
              <input name="website" tabIndex={-1} autoComplete="off" />
            </label>
          </div>
        ) : null}
        <Button type="submit" size="lg" loading={busy}>
          {busy
            ? c.busy
            : kind === 'contact'
              ? c.submit
              : kind === 'register'
                ? c.register
                : kind === 'forgot'
                  ? c.resetSubmit
                  : c.login}
        </Button>
      </fieldset>
      {kind === 'login' ? (
        <Link href={`${publicPath(locale, 'login')}?reset=1`}>{c.forgot}</Link>
      ) : null}
    </form>
  );
}
