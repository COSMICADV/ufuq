'use client';

import { useCallback, useEffect, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { fetchMany, sendNoContent } from '../../../lib/api-client';
import type { CollectionMeta } from '../../../lib/api-client';
import { DOCUMENT_CATEGORIES } from '../../../lib/health';
import type { DocumentCategory, HealthDocument } from '../../../lib/health';
import { Button, Modal } from '../../design-system';
import { DocumentDialog } from './document-dialog';
import { DocumentCard, HealthHeader } from './health-parts';

/** Every medical document, by category and search; and the 30-day trash. */
export function HealthRecordsScreen({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [trash, setTrash] = useState(false);
  const [category, setCategory] = useState<DocumentCategory | ''>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<readonly HealthDocument[] | null>(null);
  const [meta, setMeta] = useState<CollectionMeta | null>(null);
  const [trashCount, setTrashCount] = useState(0);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState<{ open: boolean; id: string | null; camera: boolean }>({
    open: false,
    id: null,
    camera: false,
  });
  const [removing, setRemoving] = useState<HealthDocument | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setFailed(false);
      const query: Record<string, string> = { page: String(page), per_page: '24' };
      if (trash) query.trash = 'true';
      if (category && !trash) query.category = category;
      if (q.trim()) query.q = q.trim();
      const [result, bin] = await Promise.all([
        fetchMany<HealthDocument>('/personal/health/documents', { locale, query }),
        fetchMany<HealthDocument>('/personal/health/documents', { locale, query: { trash: 'true', per_page: '1' } }),
      ]);
      setItems(result.items);
      setMeta(result.meta);
      setTrashCount(bin.meta.total);
    } catch {
      setFailed(true);
    }
  }, [locale, page, trash, category, q]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
    }, 200);
    return () => {
      clearTimeout(timer);
    };
  }, [load]);

  const restore = async (doc: HealthDocument): Promise<void> => {
    await sendNoContent(`/personal/health/documents/${doc.id}/restore`, { locale, method: 'POST' });
    await load();
  };

  const removeForGood = async (): Promise<void> => {
    if (!removing) return;
    setBusy(true);
    try {
      await sendNoContent(`/personal/health/documents/${removing.id}/permanent`, { locale, method: 'DELETE' });
      setRemoving(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

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

      <div className="health-toolbar">
        <div className="fin-periods" role="tablist">
          <button
            type="button"
            role="tab"
            className="fin-chip"
            aria-selected={!trash}
            onClick={() => {
              setTrash(false);
              setPage(1);
            }}
          >
            {t('health.tabs.records')}
          </button>
          <button
            type="button"
            role="tab"
            className="fin-chip"
            aria-selected={trash}
            onClick={() => {
              setTrash(true);
              setPage(1);
            }}
          >
            {t('health.trash.title', { count: String(trashCount) })}
          </button>
        </div>
        <input
          className="input"
          type="search"
          value={q}
          placeholder={t('health.search')}
          aria-label={t('health.search')}
          onChange={(event) => {
            setQ(event.target.value);
            setPage(1);
          }}
        />
      </div>

      {trash ? (
        <p className="fin-note">{t('health.trash.help')}</p>
      ) : (
        <div className="fin-periods" role="radiogroup" aria-label={t('health.field.category')}>
          <button
            type="button"
            role="radio"
            className="fin-chip"
            aria-checked={category === ''}
            onClick={() => {
              setCategory('');
              setPage(1);
            }}
          >
            {t('health.all_categories')}
          </button>
          {DOCUMENT_CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              className="fin-chip"
              aria-checked={category === c}
              onClick={() => {
                setCategory(c);
                setPage(1);
              }}
            >
              {t(`health.category.${c}`)}
            </button>
          ))}
        </div>
      )}

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
      ) : items === null ? (
        <div className="fin-loading" aria-busy="true" />
      ) : items.length === 0 ? (
        <p className="fin-card fin-muted">{trash ? t('health.trash.empty') : t('health.empty')}</p>
      ) : (
        <ul className="health-cards">
          {items.map((doc) => (
            <DocumentCard
              key={doc.id}
              locale={locale}
              doc={doc}
              onOpen={() => {
                setDialog({ open: true, id: doc.id, camera: false });
              }}
              {...(trash
                ? {
                    footer: (
                      <>
                        <small>{t('health.trash.days_left', { days: String(doc.days_left ?? 0) })}</small>
                        <span>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              void restore(doc);
                            }}
                          >
                            {t('health.trash.restore')}
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive-ghost"
                            onClick={() => {
                              setRemoving(doc);
                            }}
                          >
                            {t('health.trash.delete_now')}
                          </Button>
                        </span>
                      </>
                    ),
                  }
                : {})}
            />
          ))}
        </ul>
      )}
      {meta && meta.total_pages > 1 ? (
        <div className="fin-pager">
          <Button
            variant="secondary"
            size="sm"
            disabled={page <= 1}
            onClick={() => {
              setPage(page - 1);
            }}
          >
            {t('finance.prev')}
          </Button>
          <span>{t('finance.page', { page: String(meta.page), pages: String(meta.total_pages) })}</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= meta.total_pages}
            onClick={() => {
              setPage(page + 1);
            }}
          >
            {t('finance.next')}
          </Button>
        </div>
      ) : null}

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

      <Modal
        open={removing !== null}
        title={t('health.trash.delete_now')}
        closeLabel={t('finance.close')}
        onClose={() => {
          setRemoving(null);
        }}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setRemoving(null);
              }}
            >
              {t('finance.cancel')}
            </Button>
            <Button
              variant="destructive"
              loading={busy}
              onClick={() => {
                void removeForGood();
              }}
            >
              {t('health.trash.delete_now')}
            </Button>
          </>
        }
      >
        <p>{t('health.trash.delete_help', { title: removing?.title ?? '' })}</p>
      </Modal>
    </div>
  );
}
