import Link from 'next/link';
import type { ReactNode } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

/**
 * The frame the goal screens sit in — DOCUMENT 03 §7's page skeleton, the
 * same as the task screens'. Like them it is not the product sidebar: most of
 * those modules belong to later phases (DOCUMENT 27 RULE 26).
 */
export function GoalsShell({
  locale,
  surface,
  back,
  children,
}: {
  readonly locale: Locale;
  readonly surface: 'admin' | 'app';
  /** Detail and form screens link back to their list. */
  readonly back?: boolean;
  readonly children: ReactNode;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const admin = surface === 'admin';
  return (
    <div className="tasks-page">
      <header className="page-heading">
        <div>
          <h1>{admin ? t('goals.title') : t('goals.my_title')}</h1>
          <p>{admin ? t('goals.admin_description') : t('goals.my_description')}</p>
        </div>
        {back ? (
          <Link className="tasks-back" href={`/${locale}/${surface}/goals`}>
            {admin ? t('goals.back_to_list') : t('goals.back_to_mine')}
          </Link>
        ) : null}
      </header>
      <main className="tasks-page__content">{children}</main>
    </div>
  );
}
