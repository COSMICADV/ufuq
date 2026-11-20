'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createTranslator, publicCopy } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ProductLogo } from '../brand-mark';
import { Button, Field, Input } from '../design-system';
import { FreehandIcon } from '../freehand-icon';
import { LanguageSwitch } from '../language-switch';
import { ThemePicker } from '../theme-picker';
import { ApiError, fetchOne } from '../../lib/api-client';
import { languageNames } from '../../lib/language-names';
import { personalBase } from '../../lib/personal';
import { publicPath } from '../../lib/public-content';

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
          <form
            className="public-form"
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            {error ? (
              <p tabIndex={-1} role="alert">
                {error}
              </p>
            ) : null}
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
