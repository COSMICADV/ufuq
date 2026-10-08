import Link from 'next/link';
import type { ReactNode } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { requestsPath } from '../../lib/requests';

/**
 * The frame the request screens sit in — DOCUMENT 03 §7's page skeleton, the
 * same as the task and goal screens'. Like them it is not the product
 * sidebar: most of those modules belong to later phases (DOCUMENT 27 RULE 26).
 */
export function RequestsShell({
  locale,
  surface,
  back,
  heading,
  children,
}: {
  readonly locale: Locale;
  readonly surface: 'admin' | 'app';
  /** Detail and form screens link back to their list. */
  readonly back?: boolean;
  /** The new-request form names itself; the other screens use the list's title. */
  readonly heading?: 'new';
  readonly children: ReactNode;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const admin = surface === 'admin';
  const title =
    heading === 'new'
      ? t('requests.new_title')
      : admin
        ? t('requests.title')
        : t('requests.my_title');
  const description =
    heading === 'new'
      ? t('requests.new_description')
      : admin
        ? t('requests.admin_description')
        : t('requests.my_description');
  return (
    <div className="tasks-page">
      <header className="page-heading">
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {back ? (
          <Link className="tasks-back" href={requestsPath(locale, surface)}>
            {admin ? t('requests.back_to_inbox') : t('requests.back_to_mine')}
          </Link>
        ) : null}
      </header>
      <main className="tasks-page__content">{children}</main>
    </div>
  );
}
