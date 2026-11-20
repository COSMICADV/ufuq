'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { documentDay } from '../../../lib/health';
import type { HealthDocument } from '../../../lib/health';
import { personalHref } from '../../../lib/personal';
import { receiptBlob } from '../../../lib/receipts';
import { FreehandIcon } from '../../freehand-icon';
import { PersonalIcon } from '../personal-shell';

/** The Health heading, with its screens as tabs. */
export function HealthHeader({
  locale,
  action,
}: {
  readonly locale: Locale;
  readonly action?: React.ReactNode;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const pathname = usePathname();
  const base = personalHref(locale, 'health');
  const tabs = [
    { href: base, label: t('health.tabs.overview') },
    { href: `${base}/records`, label: t('health.tabs.records') },
  ];
  return (
    <div className="fin-head">
      <header className="pscreen-head">
        <PersonalIcon entry="health" size={64} />
        <div>
          <h1>{t('personal.nav.health')}</h1>
          <p>{t('personal.about.health')}</p>
        </div>
        {action ? <div className="fin-head__action">{action}</div> : null}
      </header>
      <nav className="fin-tabs" aria-label={t('personal.nav.health')}>
        {tabs.map((tab) => (
          <Link key={tab.href} href={tab.href} className="fin-tab" aria-current={pathname === tab.href ? 'page' : undefined}>
            {tab.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** A document's first page, fetched privately through the API. */
function Cover({ locale, id }: { readonly locale: Locale; readonly id: string | null }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let made: string | null = null;
    let cancelled = false;
    void receiptBlob(locale, id)
      .then((blob) => {
        if (cancelled) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [locale, id]);
  return (
    <span className="health-card__cover">
      {url ? <img src={url} alt="" /> : <FreehandIcon name="document" size={34} />}
    </span>
  );
}

/** One medical document as a card. */
export function DocumentCard({
  locale,
  doc,
  onOpen,
  footer,
}: {
  readonly locale: Locale;
  readonly doc: HealthDocument;
  readonly onOpen: () => void;
  readonly footer?: React.ReactNode;
}): React.JSX.Element {
  const t = createTranslator(locale);
  return (
    <li className="health-card">
      <button type="button" className="health-card__open" onClick={onOpen}>
        <Cover locale={locale} id={doc.cover_id} />
        <span className="health-card__body">
          <span className={`health-chip health-chip--${doc.category}`}>{t(`health.category.${doc.category}`)}</span>
          <strong>{doc.title}</strong>
          <small>
            {[doc.document_date ? documentDay(doc.document_date, locale) : null, t('health.page_count', { count: String(doc.page_count) })]
              .filter(Boolean)
              .join(' · ')}
          </small>
        </span>
      </button>
      {footer ? <div className="health-card__footer">{footer}</div> : null}
    </li>
  );
}
