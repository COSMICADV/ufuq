'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { fetchOne } from '../../../lib/api-client';
import type { HealthOverview } from '../../../lib/health';
import { personalHref } from '../../../lib/personal';
import { FreehandIcon } from '../../freehand-icon';
import type { FreehandIconName } from '../../freehand-icon';
import { Button } from '../../design-system';
import { DocumentDialog } from './document-dialog';
import { DocumentCard, HealthHeader } from './health-parts';

interface Section {
  readonly key: 'records' | 'medications' | 'lab_tests' | 'appointments' | 'notifications';
  readonly icon: FreehandIconName;
  readonly phase: number | null;
}

const SECTIONS: readonly Section[] = [
  { key: 'records', icon: 'folder', phase: null },
  { key: 'medications', icon: 'clock', phase: 2 },
  { key: 'lab_tests', icon: 'clipboard', phase: 3 },
  { key: 'appointments', icon: 'calendar', phase: 4 },
  { key: 'notifications', icon: 'bell', phase: 5 },
];

/**
 * Health home: the five sections, what is coming up, and the latest medical
 * documents. Records work now; the other sections arrive in later phases and
 * say so plainly.
 */
export function HealthOverviewScreen({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [data, setData] = useState<HealthOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState<{ open: boolean; id: string | null; camera: boolean }>({
    open: false,
    id: null,
    camera: false,
  });

  const load = useCallback(async (): Promise<void> => {
    try {
      setFailed(false);
      setData(await fetchOne<HealthOverview>('/personal/health/overview', { locale }));
    } catch {
      setFailed(true);
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const records = `${personalHref(locale, 'health')}/records`;

  return (
    <div className="pscreen fin health">
      <HealthHeader
        locale={locale}
        action={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDialog({ open: true, id: null, camera: false });
              }}
            >
              {t('health.add')}
            </Button>
            <Button
              onClick={() => {
                setDialog({ open: true, id: null, camera: true });
              }}
            >
              {t('health.take_photo')}
            </Button>
          </>
        }
      />

      <ul className="health-sections">
        {SECTIONS.map((section) => {
          const content = (
            <>
              <span className="health-section__icon">
                <FreehandIcon name={section.icon} size={30} />
              </span>
              <span className="health-section__text">
                <strong>{t(`health.section.${section.key}`)}</strong>
                <small>
                  {section.phase === null
                    ? t('health.documents_count', { count: String(data?.documents ?? 0) })
                    : t('health.coming_phase', { phase: String(section.phase) })}
                </small>
              </span>
            </>
          );
          return (
            <li key={section.key}>
              {section.phase === null ? (
                <Link href={records} className="health-section">
                  {content}
                </Link>
              ) : (
                <div className="health-section is-soon" aria-disabled="true">
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="health-upcoming">
        {(['medications_today', 'appointments_next', 'lab_tests_pending'] as const).map((key) => (
          <section key={key} className="fin-card">
            <h2>{t(`health.upcoming.${key}`)}</h2>
            <p className="fin-muted">{t(`health.upcoming.${key}_soon`)}</p>
          </section>
        ))}
      </div>

      <section className="fin-card" aria-labelledby="health-recent">
        <div className="fin-card__head">
          <h2 id="health-recent">{t('health.recent')}</h2>
          <Link href={records}>{t('finance.see_all')}</Link>
        </div>
        {failed ? (
          <div className="pempty" role="alert">
            <p>{t('health.error.load')}</p>
            <Button
              variant="secondary"
              onClick={() => {
                void load();
              }}
            >
              {t('finance.retry')}
            </Button>
          </div>
        ) : data === null ? (
          <div className="fin-loading" aria-busy="true" />
        ) : data.recent.length === 0 ? (
          <div className="health-empty">
            <p className="fin-muted">{t('health.empty')}</p>
            <Button
              onClick={() => {
                setDialog({ open: true, id: null, camera: true });
              }}
            >
              {t('health.take_photo')}
            </Button>
          </div>
        ) : (
          <ul className="health-cards">
            {data.recent.map((doc) => (
              <DocumentCard
                key={doc.id}
                locale={locale}
                doc={doc}
                onOpen={() => {
                  setDialog({ open: true, id: doc.id, camera: false });
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <p className="health-privacy">{t('health.privacy')}</p>

      <DocumentDialog
        locale={locale}
        open={dialog.open}
        documentId={dialog.id}
        startWithCamera={dialog.camera}
        onClose={() => {
          setDialog({ open: false, id: null, camera: false });
        }}
        onSaved={() => {
          void load();
        }}
      />
    </div>
  );
}
