'use client';

import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';
import { useCallback, useState } from 'react';

import { createCategory, DOCUMENT_KINDS, loadCategories, updateCategory } from '../../lib/medical';
import type { DocumentCategory, DocumentKind } from '../../lib/medical';
import { Badge, Button, Card, Field, Input, Select } from '../design-system';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { categoryLabel } from './patient-documents';

/** The ten default document categories, and the clinic's own (categories.manage). */
export function DocumentCategories({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback((signal: AbortSignal) => loadCategories(locale, signal), [locale]);
  const list = useResource(load);
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [kind, setKind] = useState<DocumentKind>('document');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (): Promise<void> => {
    if (!nameAr.trim() || !nameEn.trim()) {
      setError(t('medical.categories.error_names'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createCategory(locale, { name_ar: nameAr.trim(), name_en: nameEn.trim(), kind });
      setNameAr('');
      setNameEn('');
      list.reload();
    } catch {
      setError(t('medical.error.save'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (category: DocumentCategory): Promise<void> => {
    try {
      await updateCategory(locale, category.id, { archived: !category.archived });
      list.reload();
    } catch {
      setError(t('medical.error.save'));
    }
  };

  return (
    <Card title={t('medical.categories.title')} className="doc-categories">
      <p className="medical-note">{t('medical.categories.help')}</p>
      {list.state.status === 'loading' ? (
        <LoadingState t={t} rows={3} />
      ) : list.state.status === 'error' ? (
        <ErrorState t={t} error={list.state.error} onRetry={list.reload} />
      ) : (
        <ul className="doc-categories__list">
          {list.state.value.map((c) => (
            <li key={c.id} data-archived={c.archived ? 'true' : undefined}>
              <span>{categoryLabel(t, locale, c)}</span>
              <Badge tone={c.kind === 'imaging' ? 'info' : c.kind === 'lab' ? 'warning' : 'wfh'}>{t(`medical.doc.kind.${c.kind}`)}</Badge>
              {c.custom ? (
                <Button variant="ghost" size="sm" onClick={() => void toggle(c)}>
                  {t(c.archived ? 'medical.categories.restore' : 'medical.categories.hide')}
                </Button>
              ) : (
                <span className="medical-muted">{t('medical.categories.default')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="doc-categories__add">
        <Field label={t('medical.categories.name_ar')}>
          <Input value={nameAr} dir="rtl" maxLength={80} onChange={(e) => setNameAr(e.target.value)} />
        </Field>
        <Field label={t('medical.categories.name_en')}>
          <Input value={nameEn} dir="ltr" maxLength={80} onChange={(e) => setNameEn(e.target.value)} />
        </Field>
        <Field label={t('medical.categories.kind')} helper={t('medical.categories.kind_help')}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)}>
            {DOCUMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`medical.doc.kind.${k}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Button loading={busy} onClick={() => void add()}>
          {t('medical.categories.add')}
        </Button>
      </div>
      {error ? (
        <p className="medical-form__error" role="alert">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
