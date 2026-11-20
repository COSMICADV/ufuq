'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { createTranslator, publicCopy } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ProductLogo } from '../brand-mark';
import { Button, Field, Input } from '../design-system';
import { FreehandIcon } from '../freehand-icon';
import { LanguageSwitch } from '../language-switch';
import { ThemePicker } from '../theme-picker';
import { ApiError, apiUrl, fetchOne } from '../../lib/api-client';
import { languageNames } from '../../lib/language-names';
import { personalBase } from '../../lib/personal';
import { publicPath } from '../../lib/public-content';

/** The reasons the API's Google callback can send back (`?oauth=`). */
const OAUTH_REASONS: ReadonlySet<string> = new Set([
  'unavailable',
  'cancelled',
  'expired',
  'failed',
  'unverified',
  'no_account',
  'locked',
  'deactivated',
  'not_activated',
  'pending',
  'rejected',
  'inactive',
  'rate',
]);

/**
 * 1to1OS Personal sign-up: name, email, password. The account is active at
 * once, so the form signs in straight after and opens the workspace. Signing
 * in later is the shared sign-in page, which sends a Personal account here.
 */
export function PersonalStart({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const c = publicCopy[locale];
  const router = useRouter();
  const [started] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<readonly string[]>([]);
  const [show, setShow] = useState(false);
  // "Continue with Google": shown only when the server has it switched on.
  const [google, setGoogle] = useState(false);
  // With Google on, Google is the way in; the email form waits behind a link.
  const [withEmail, setWithEmail] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetchOne<{ google: boolean }>('/auth/providers', { locale, signal: controller.signal })
      .then((providers) => {
        setGoogle(providers.google);
      })
      .catch(() => undefined);
    // Back from Google with a reason: say what happened.
    const reason = new URLSearchParams(window.location.search).get('oauth');
    if (reason !== null) {
      setError(
        createTranslator(locale)(`personal.oauth.${OAUTH_REASONS.has(reason) ? reason : 'failed'}`),
      );
    }
    return () => {
      controller.abort();
    };
  }, [locale]);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setBusy(true);
    setError('');
    setFields([]);
    try {
      await fetchOne('/public/register-personal', {
        locale,
        method: 'POST',
        body: {
          name: values.name,
          email: values.email,
          password: values.password,
          website: values.website ?? '',
          started_at: started,
        },
      });
      await fetchOne('/auth/login', {
        locale,
        method: 'POST',
        body: { email: values.email, password: values.password, rememberMe: true },
      });
      router.push(personalBase(locale));
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
              : c.error,
      );
      setBusy(false);
    }
  };

  const invalid = (name: string): { error?: string } =>
    fields.includes(name) ? { error: c.fieldInvalid } : {};

  return (
    <div className="os-auth pstart">
      <a className="public-skip" href="#content">
        {c.skip}
      </a>
      <header className="os-auth__bar">
        <Link className="os-auth__home" href={`/${locale}`} aria-label="1to1OS">
          <ProductLogo />
        </Link>
        <div className="os-auth__tools">
          <LanguageSwitch locale={locale} label={t('language.switch')} names={languageNames(t)} />
          <ThemePicker locale={locale} />
        </div>
      </header>

      <main id="content" className="os-auth__main">
        <section className="os-auth__card" aria-labelledby="pstart-title">
          <span className="os-auth__badge" aria-hidden="true">
            <FreehandIcon name="user" size={28} />
          </span>
          <h1 id="pstart-title">{t('personal.start_title')}</h1>
          <p className="os-auth__lead">{t('personal.start_lead')}</p>
          {error ? (
            <p tabIndex={-1} role="alert" className="pstart__error">
              {error}
            </p>
          ) : null}
          {google ? (
            <>
              <a
                className="pstart__google"
                href={apiUrl('/auth/google/start', { intent: 'personal', locale, remember: '1' })}
              >
                <svg viewBox="0 0 48 48" width="22" height="22" aria-hidden="true">
                  <path
                    fill="#FFC107"
                    d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
                  />
                  <path
                    fill="#FF3D00"
                    d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
                  />
                  <path
                    fill="#4CAF50"
                    d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
                  />
                  <path
                    fill="#1976D2"
                    d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
                  />
                </svg>
                <span>{t('personal.google')}</span>
              </a>
              {withEmail ? (
                <p className="pstart__or" aria-hidden="true">
                  <span>{t('personal.or')}</span>
                </p>
              ) : (
                <>
                  <button
                    type="button"
                    className="pstart__email"
                    aria-expanded={false}
                    onClick={() => {
                      setWithEmail(true);
                    }}
                  >
                    {t('personal.with_email')}
                  </button>
                  <p className="pstart__signin">
                    {t('personal.have_account')}{' '}
                    <Link href={publicPath(locale, 'login')}>{t('personal.sign_in')}</Link>
                  </p>
                </>
              )}
            </>
          ) : null}
          {google && !withEmail ? null : (
            <form
              className="public-form"
              onSubmit={(event) => {
                void submit(event);
              }}
            >
              <fieldset disabled={busy}>
                <Field label={t('personal.name')} required {...invalid('name')}>
                  <Input
                    name="name"
                    autoComplete="name"
                    required
                    maxLength={200}
                    aria-invalid={fields.includes('name')}
                  />
                </Field>
                <Field label={t('personal.email')} required {...invalid('email')}>
                  <Input
                    name="email"
                    type="email"
                    dir="ltr"
                    autoComplete="email"
                    required
                    maxLength={255}
                    aria-invalid={fields.includes('email')}
                  />
                </Field>
                <Field
                  label={c.password}
                  required
                  helper={t('personal.password_help')}
                  {...invalid('password')}
                >
                  <Input
                    name="password"
                    type={show ? 'text' : 'password'}
                    dir="ltr"
                    autoComplete="new-password"
                    required
                    minLength={10}
                    maxLength={200}
                    aria-invalid={fields.includes('password')}
                  />
                </Field>
                <button
                  type="button"
                  className="button button--secondary"
                  aria-pressed={show}
                  onClick={() => {
                    setShow((value) => !value);
                  }}
                >
                  {show ? c.hide : c.show}
                </button>
                {/* Left empty by people; bots fill it in. */}
                <div className="public-honeypot" aria-hidden="true">
                  <label>
                    Website
                    <input name="website" tabIndex={-1} autoComplete="off" />
                  </label>
                </div>
                <Button type="submit" size="lg" loading={busy}>
                  {busy ? t('personal.start_busy') : t('personal.start_submit')}
                </Button>
              </fieldset>
              <p className="pstart__signin">
                {t('personal.have_account')}{' '}
                <Link href={publicPath(locale, 'login')}>{t('personal.sign_in')}</Link>
              </p>
            </form>
          )}
        </section>

        <aside className="os-auth__art" aria-hidden="true">
          <div className="pstart__art">
            <img src="/brand/personal.webp" alt="" width={344} height={299} />
            <p dir="ltr">
              1to1OS <em>Personal</em>
            </p>
          </div>
        </aside>
      </main>
    </div>
  );
}
