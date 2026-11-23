'use client';

import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../../lib/api-client';
import {
  categoryInput,
  createDocument,
  deleteDocument,
  loadCategories,
  loadDocuments,
  MAX_PAGE_BYTES,
  MAX_PAGES,
  PAGE_ACCEPT,
  PAGE_TYPES,
  pageBlob,
  setDocumentArchived,
  updateDocument,
  uploadDocumentPage,
} from '../../lib/medical';
import type { DocumentCategory, DocumentKind, DocumentPage, MedicalDocument, PatientDetail, Visit } from '../../lib/medical';
import { Badge, Button, Card, Field, Input, Modal, Select, Textarea } from '../design-system';
import { ErrorState, LoadingState, Ltr } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { day, when } from './medical-parts';

export function categoryLabel(t: Translator, locale: Locale, category: DocumentCategory): string {
  if (!category.custom) return t(`medical.category.${category.id}`);
  return (locale === 'ar' ? category.name_ar : category.name_en) ?? category.name_en ?? category.name_ar ?? '';
}

function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A page thumbnail: images are drawn from their private bytes; PDFs show a document mark. */
function PageThumb({ locale, page, onOpen }: { readonly locale: Locale; readonly page: DocumentPage; readonly onOpen: () => void }): React.JSX.Element {
  const t = createTranslator(locale);
  const [url, setUrl] = useState<string | null>(null);
  const image = page.mime_type.startsWith('image/');
  useEffect(() => {
    if (!image) return;
    let made: string | null = null;
    let alive = true;
    pageBlob(locale, page.id).then(
      (blob) => {
        if (!alive) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      },
      () => setUrl(null),
    );
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [locale, page.id, image]);
  return (
    <button type="button" className="doc-thumb" onClick={onOpen} aria-label={t('medical.doc.open_page')}>
      {image ? url ? <img src={url} alt="" /> : <span className="doc-thumb__wait" /> : <span className="doc-thumb__pdf">PDF</span>}
    </button>
  );
}

/** Opens a page in a private preview (images) or a new tab (PDF), from its bytes. */
function PagePreview({ locale, page, onClose }: { readonly locale: Locale; readonly page: DocumentPage; readonly onClose: () => void }): React.JSX.Element {
  const t = createTranslator(locale);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    pageBlob(locale, page.id).then((blob) => {
      made = URL.createObjectURL(blob);
      setUrl(made);
    }, () => setUrl(null));
    return () => {
      if (made) URL.revokeObjectURL(made);
    };
  }, [locale, page.id]);
  return (
    <Modal open title={t('medical.doc.page')} onClose={onClose} closeLabel={t('medical.close')}>
      <div className="doc-preview">
        {!url ? (
          <LoadingState t={t} rows={3} />
        ) : page.mime_type === 'application/pdf' ? (
          <iframe src={url} title={t('medical.doc.page')} />
        ) : (
          <img src={url} alt={t('medical.doc.page')} />
        )}
      </div>
    </Modal>
  );
}

interface Chosen {
  readonly file: File;
  readonly error: string | null;
}

/** File a new document (with its pages), or edit one's details. */
function DocumentDialog({
  locale,
  patient,
  visits,
  categories,
  kinds,
  document,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly patient: PatientDetail;
  readonly visits: readonly Visit[];
  readonly categories: readonly DocumentCategory[];
  readonly kinds: readonly DocumentKind[];
  readonly document: MedicalDocument | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const input = useRef<HTMLInputElement>(null);
  // Uploading may file any category; editing may only move to a kind the editor can see.
  const usable = categories.filter((c) => !c.archived && (document === null || kinds.includes(c.kind)));
  const [categoryId, setCategoryId] = useState(document?.category.id ?? usable[0]?.id ?? '');
  const category = categories.find((c) => c.id === categoryId) ?? null;
  const [title, setTitle] = useState(document?.title ?? '');
  const [titleTouched, setTitleTouched] = useState(document !== null);
  const [date, setDate] = useState(document?.document_date ?? today());
  const [visitId, setVisitId] = useState(document?.visit?.id ?? '');
  const [notes, setNotes] = useState(document?.notes ?? '');
  const [files, setFiles] = useState<readonly Chosen[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shownTitle = titleTouched ? title : category ? categoryLabel(t, locale, category) : '';

  const add = (list: FileList | null): void => {
    if (!list) return;
    const next = [...files];
    for (const file of Array.from(list)) {
      if (next.length >= MAX_PAGES) break;
      next.push({
        file,
        error: !PAGE_TYPES.includes(file.type) ? t('medical.doc.error_type') : file.size > MAX_PAGE_BYTES ? t('medical.doc.error_size') : null,
      });
    }
    setFiles(next);
  };

  const save = async (): Promise<void> => {
    if (!category) {
      setError(t('medical.doc.error_category'));
      return;
    }
    if (!shownTitle.trim()) {
      setError(t('medical.doc.error_title'));
      return;
    }
    const good = files.filter((f) => !f.error);
    if (!document && good.length === 0) {
      setError(t('medical.doc.error_no_pages'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = {
        ...categoryInput(category),
        title: shownTitle.trim(),
        document_date: date || null,
        visit_id: visitId || null,
        notes: notes.trim() || null,
      };
      const saved = document
        ? await updateDocument(locale, document.id, body)
        : await createDocument(locale, patient.id, { ...body, patient_file_number: patient.file_number });
      const failed: string[] = [];
      for (const [index, chosen] of good.entries()) {
        setProgress(t('medical.doc.uploading', { done: String(index + 1), total: String(good.length) }));
        try {
          await uploadDocumentPage(locale, saved.id, chosen.file, chosen.file.name);
        } catch {
          failed.push(chosen.file.name);
        }
      }
      setProgress(null);
      if (failed.length > 0) {
        setError(t('medical.doc.error_pages_failed', { files: failed.join('، ') }));
        setBusy(false);
        setFiles([]);
        return;
      }
      onSaved();
    } catch (failure) {
      setBusy(false);
      setProgress(null);
      const fields = failure instanceof ApiError ? failure.fields : {};
      setError(
        fields.patient_file_number
          ? t('medical.doc.error_wrong_patient')
          : fields.patient
            ? t('medical.error.archived')
            : failure instanceof ApiError && failure.status === 403
              ? t('medical.doc.error_forbidden')
              : t('medical.error.save'),
      );
    }
  };

  const byKind = (kind: DocumentKind): DocumentCategory[] => usable.filter((c) => c.kind === kind);

  return (
    <Modal
      open
      title={t(document ? 'medical.doc.edit' : 'medical.doc.add')}
      onClose={busy ? () => undefined : onClose}
      closeLabel={t('medical.close')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('medical.cancel')}
          </Button>
          <Button loading={busy} onClick={() => void save()}>
            {t(document ? 'medical.save' : 'medical.doc.file')}
          </Button>
        </>
      }
    >
      <div className="medical-form">
        {/* Who the document is filed into, always in view. */}
        <p className="doc-target" role="note">
          <span>{t('medical.doc.filing_into')}</span>
          <strong>{patient.full_name}</strong>
          <Ltr>{patient.file_number}</Ltr>
        </p>
        <div className="medical-form__row">
          <Field label={t('medical.doc.category')} required>
            <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={busy}>
              {(['document', 'lab', 'imaging'] as const).map((kind) =>
                byKind(kind).length === 0 ? null : (
                  <optgroup key={kind} label={t(`medical.doc.kind.${kind}`)}>
                    {byKind(kind).map((c) => (
                      <option key={c.id} value={c.id}>
                        {categoryLabel(t, locale, c)}
                      </option>
                    ))}
                  </optgroup>
                ),
              )}
            </Select>
          </Field>
          <Field label={t('medical.doc.date')}>
            <Input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} disabled={busy} />
          </Field>
        </div>
        <Field label={t('medical.doc.title')} required>
          <Input
            value={shownTitle}
            maxLength={200}
            disabled={busy}
            onChange={(e) => {
              setTitleTouched(true);
              setTitle(e.target.value);
            }}
          />
        </Field>
        {visits.length > 0 ? (
          <Field label={t('medical.doc.visit')}>
            <Select value={visitId} onChange={(e) => setVisitId(e.target.value)} disabled={busy}>
              <option value="">{t('medical.doc.no_visit')}</option>
              {visits.map((v) => (
                <option key={v.id} value={v.id}>
                  {when(v.visit_at, locale)}
                  {v.reason ? ` — ${v.reason}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label={t('medical.doc.notes')}>
          <Textarea value={notes} rows={2} maxLength={2000} onChange={(e) => setNotes(e.target.value)} disabled={busy} />
        </Field>
        <div>
          <input
            ref={input}
            type="file"
            accept={PAGE_ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              add(e.target.files);
              e.target.value = '';
            }}
          />
          <div className="doc-files__head">
            <span className="brand-label">{t(document ? 'medical.doc.add_pages' : 'medical.doc.pages')}</span>
            <Button variant="secondary" size="sm" onClick={() => input.current?.click()} disabled={busy || files.length >= MAX_PAGES}>
              {t('medical.doc.choose_files')}
            </Button>
          </div>
          <p className="medical-note">{t('medical.doc.files_help')}</p>
          {files.length > 0 ? (
            <ul className="doc-files">
              {files.map((f, i) => (
                <li key={`${f.file.name}-${String(i)}`} data-error={f.error ? 'true' : undefined}>
                  <span className="doc-files__name">{f.file.name}</span>
                  {f.error ? <span className="doc-files__error">{f.error}</span> : null}
                  <Button variant="ghost" size="sm" onClick={() => setFiles(files.filter((_, j) => j !== i))} disabled={busy}>
                    {t('medical.doc.remove_file')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {progress ? (
          <p className="medical-note" role="status">
            {progress}
          </p>
        ) : null}
        {error ? (
          <p className="medical-form__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** «الملفات الطبية والأشعة» in a patient's file. */
export function PatientDocuments({
  locale,
  patient,
  visits,
}: {
  readonly locale: Locale;
  readonly patient: PatientDetail;
  readonly visits: readonly Visit[];
}): React.JSX.Element {
  const t = createTranslator(locale);
  const [kind, setKind] = useState<DocumentKind | null>(null);
  const [archived, setArchived] = useState(false);
  const [dialog, setDialog] = useState<MedicalDocument | 'new' | null>(null);
  const [preview, setPreview] = useState<DocumentPage | null>(null);
  const [confirm, setConfirm] = useState<MedicalDocument | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [categories, setCategories] = useState<readonly DocumentCategory[]>([]);
  const load = useCallback(
    (signal: AbortSignal) => loadDocuments(locale, patient.id, { kind, archived }, signal),
    [locale, patient.id, kind, archived],
  );
  const list = useResource(load);
  useEffect(() => {
    loadCategories(locale).then(setCategories, () => setCategories([]));
  }, [locale]);

  const value = list.state.status === 'ready' ? list.state.value : null;
  const act = async (run: () => Promise<unknown>, message: string): Promise<void> => {
    try {
      await run();
      setNotice(t(message));
      list.reload();
    } catch {
      setNotice(t('medical.error.save'));
    }
  };

  return (
    <Card
      className="medical-documents"
      title={t('medical.doc.title_section')}
      action={
        value?.can_upload && !patient.archived ? (
          <Button size="sm" onClick={() => setDialog('new')}>
            {t('medical.doc.add')}
          </Button>
        ) : undefined
      }
    >
      {notice ? (
        <p className="medical-notice" role="status">
          {notice}
        </p>
      ) : null}
      {value && value.kinds.length > 1 ? (
        <div className="medical-toggles doc-filters" role="group" aria-label={t('medical.filters')}>
          <button type="button" className="medical-chip" aria-pressed={kind === null} onClick={() => setKind(null)}>
            {t('medical.doc.all')}
          </button>
          {value.kinds.map((k) => (
            <button key={k} type="button" className="medical-chip" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {t(`medical.doc.kind.${k}`)}
            </button>
          ))}
          <button type="button" className="medical-chip" aria-pressed={archived} onClick={() => setArchived(!archived)}>
            {t('medical.archived')}
          </button>
        </div>
      ) : null}
      {list.state.status === 'loading' ? (
        <LoadingState t={t} rows={3} />
      ) : list.state.status === 'error' ? (
        <ErrorState t={t} error={list.state.error} onRetry={list.reload} />
      ) : value && value.kinds.length === 0 ? (
        <p className="medical-muted">{t('medical.doc.upload_only')}</p>
      ) : !value || value.documents.length === 0 ? (
        <p className="medical-muted">{t(archived ? 'medical.doc.none_archived' : 'medical.doc.none')}</p>
      ) : (
        <ul className="doc-list">
          {value.documents.map((d) => (
            <li key={d.id}>
              <div className="doc-list__head">
                <div>
                  <strong>{d.title}</strong>
                  <span className="doc-list__meta">
                    <Badge tone={d.category.kind === 'imaging' ? 'info' : d.category.kind === 'lab' ? 'warning' : 'wfh'}>
                      {categoryLabel(t, locale, d.category)}
                    </Badge>
                    {d.document_date ? <span>{day(d.document_date, locale)}</span> : null}
                    {d.visit ? <span>{t('medical.doc.from_visit', { when: when(d.visit.visit_at, locale) })}</span> : null}
                    <span>{t('medical.doc.by', { name: d.created_by })}</span>
                  </span>
                </div>
                <div className="medical-actions">
                  {d.can.edit && !d.archived ? (
                    <Button variant="ghost" size="sm" onClick={() => setDialog(d)}>
                      {t('medical.edit')}
                    </Button>
                  ) : null}
                  {d.can.archive ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void act(() => setDocumentArchived(locale, d.id, !d.archived), d.archived ? 'medical.doc.restored' : 'medical.doc.archived')}
                    >
                      {t(d.archived ? 'medical.restore' : 'medical.doc.archive')}
                    </Button>
                  ) : null}
                  {d.can.delete ? (
                    <Button variant="destructive-ghost" size="sm" onClick={() => setConfirm(d)}>
                      {t('medical.doc.delete')}
                    </Button>
                  ) : null}
                </div>
              </div>
              {d.notes ? <p className="medical-pre doc-list__notes">{d.notes}</p> : null}
              <div className="doc-thumbs">
                {d.pages.map((page) => (
                  <PageThumb key={page.id} locale={locale} page={page} onOpen={() => setPreview(page)} />
                ))}
                {d.pages.length === 0 ? <span className="medical-muted">{t('medical.doc.no_pages')}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {dialog ? (
        <DocumentDialog
          locale={locale}
          patient={patient}
          visits={visits}
          categories={categories}
          kinds={value?.kinds ?? []}
          document={dialog === 'new' ? null : dialog}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            setNotice(t('medical.saved'));
            list.reload();
          }}
        />
      ) : null}
      {preview ? <PagePreview locale={locale} page={preview} onClose={() => setPreview(null)} /> : null}
      {confirm ? (
        <Modal
          open
          title={t('medical.doc.delete_title')}
          onClose={() => setConfirm(null)}
          closeLabel={t('medical.close')}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirm(null)}>
                {t('medical.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const target = confirm;
                  setConfirm(null);
                  void act(() => deleteDocument(locale, target.id), 'medical.doc.deleted');
                }}
              >
                {t('medical.doc.delete')}
              </Button>
            </>
          }
        >
          <p className="medical-note">{t('medical.doc.delete_help', { title: confirm.title })}</p>
        </Modal>
      ) : null}
    </Card>
  );
}
