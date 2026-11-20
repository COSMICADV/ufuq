'use client';

import Link from 'next/link';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { LanguageSwitch } from '../language-switch';
import { SignOutButton } from '../sign-out-button';
import { ThemePicker } from '../theme-picker';
import { languageNames } from '../../lib/language-names';
import { PERSONAL_SECTIONS, personalHref } from '../../lib/personal';
import type { PersonalSection } from '../../lib/personal';
import { PersonalIcon, usePersonalSession } from './personal-shell';

function Heading({
  locale,
  section,
}: {
  readonly locale: Locale;
  readonly section: PersonalSection;
}): React.JSX.Element {
  const t = createTranslator(locale);
  return (
    <header className="pscreen-head">
      <PersonalIcon entry={section} size={64} />
      <div>
        <h1>{t(`personal.nav.${section}`)}</h1>
        <p>{t(`personal.about.${section}`)}</p>
      </div>
    </header>
  );
}

/** The workspace home: a greeting and every section as a card. */
export function PersonalHome({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const session = usePersonalSession();
  const sections = PERSONAL_SECTIONS.filter((section) => section !== 'settings');
  return (
    <div className="pscreen">
      <header className="pscreen-hello">
        <h1>
          {session === null
            ? t('personal.hello_anon')
            : t('personal.hello', { name: session.companyName })}
        </h1>
        <p>{t('personal.lead')}</p>
      </header>
      <h2 className="pscreen-sub">{t('personal.sections')}</h2>
      <ul className="pcards">
        {sections.map((section) => (
          <li key={section}>
            <Link className="pcard" href={personalHref(locale, section)}>
              <PersonalIcon entry={section} size={56} />
              <span className="pcard__name">{t(`personal.nav.${section}`)}</span>
              <span className="pcard__about">{t(`personal.about.${section}`)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A section's screen. Each one is ready in the shell; its own data comes one
 * section at a time, so until then it says plainly that it is on its way.
 */
export function PersonalSectionScreen({
  locale,
  section,
}: {
  readonly locale: Locale;
  readonly section: Exclude<PersonalSection, 'settings'>;
}): React.JSX.Element {
  const t = createTranslator(locale);
  return (
    <div className="pscreen">
      <Heading locale={locale} section={section} />
      <section className="pempty" aria-labelledby={`pempty-${section}`}>
        <PersonalIcon entry={section} size={96} />
        <h2 id={`pempty-${section}`}>{t('personal.empty_title')}</h2>
        <p>{t('personal.empty_body')}</p>
        <span className="pempty__soon">{t('personal.soon')}</span>
      </section>
    </div>
  );
}

/** Settings: the account, the language, the theme, and signing out. */
export function PersonalSettings({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const session = usePersonalSession();
  return (
    <div className="pscreen">
      <Heading locale={locale} section="settings" />
      <section className="psettings" aria-labelledby="psettings-account">
        <h2 id="psettings-account">{t('personal.account')}</h2>
        <dl>
          <div>
            <dt>{t('personal.name')}</dt>
            <dd>{session?.companyName ?? '—'}</dd>
          </div>
        </dl>
      </section>
      <section className="psettings" aria-labelledby="psettings-look">
        <h2 id="psettings-look">{t('personal.appearance')}</h2>
        <div className="psettings__row">
          <span>{t('personal.language')}</span>
          <LanguageSwitch locale={locale} label={t('language.switch')} names={languageNames(t)} />
        </div>
        <div className="psettings__row">
          <span>{t('theme.label')}</span>
          <ThemePicker locale={locale} />
        </div>
      </section>
      <div className="psettings__out">
        <SignOutButton locale={locale} />
      </div>
    </div>
  );
}
