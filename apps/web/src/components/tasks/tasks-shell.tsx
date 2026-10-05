import Link from 'next/link';
import type { ReactNode } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

/**
 * The frame the task screens sit in — DOCUMENT 03 §7's page skeleton.
 *
 * Like the attendance frame, this is not the product sidebar from DOCUMENT 03
 * §2: most of those modules belong to later phases, and linking to them now
 * would be a "coming soon" panel by another name (DOCUMENT 27 RULE 26).
 */
export function TasksShell({
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
          <h1>{admin ? t('tasks.title') : t('tasks.my_title')}</h1>
          <p>{admin ? t('tasks.admin_description') : t('tasks.my_description')}</p>
        </div>
        {back ? (
          <Link className="tasks-back" href={`/${locale}/${surface}/tasks`}>
            {admin ? t('tasks.back_to_list') : t('tasks.back_to_mine')}
          </Link>
        ) : null}
      </header>
      <main className="tasks-page__content">{children}</main>
    </div>
  );
}
