'use client';

import { useEffect, useRef, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ApiError, fetchOne, sendNoContent } from '../../../lib/api-client';
import { DOCUMENT_CATEGORIES, MAX_PAGES, todayInput } from '../../../lib/health';
import type { DocumentCategory, HealthDocument, HealthPage } from '../../../lib/health';
import { receiptBlob, releasePage, toPage, uploadPage } from '../../../lib/receipts';
import type { Page } from '../../../lib/receipts';
import { CaptureButtons } from '../../capture/capture-buttons';
import { PhotoEditor } from '../../capture/photo-editor';
import { PendingReceipt, StoredReceipt } from '../../capture/receipt-thumbs';
import { Button, Field, Input, Modal, Select, Textarea } from '../../design-system';

/**
 * Add or open one medical document. The flow is the spec's own:
 * Take photo → preview / edit (rotate, crop, retake) → details → save.
 * Several pages per document; an open document can take more pages, have its
 * details changed, have a page downloaded, or go to the trash.
 */
export function DocumentDialog({
  locale,
  open,
  documentId,
  startWithCamera = false,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly open: boolean;
  /** An existing document to open, or null to add a new one. */
  readonly documentId: string | null;
  readonly startWithCamera?: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element | null {
  const t = createTranslator(locale);
  const [doc, setDoc] = useState<HealthDocument | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<DocumentCategory>('prescription');
  const [date, setDate] = useState(todayInput());
  const [notes, setNotes] = useState('');
  const [pages, setPages] = useState<readonly Page[]>([]);
  const [stored, setStored] = useState<readonly HealthPage[]>([]);
  const [editor, setEditor] = useState<{ file: File; replace: string | null; camera: boolean } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const savedId = useRef<string | null>(null);
  const changed = useRef(false);
  const cameraClicked = useRef(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setEditor(null);
    setConfirmTrash(false);
    setPages((old) => {
      old.forEach(releasePage);
      return [];
    });
    setStored([]);
    savedId.current = documentId;
    changed.current = false;
    cameraClicked.current = false;
    if (documentId === null) {
      setDoc(null);
      setTitle('');
      setCategory('prescription');
      setDate(todayInput());
      setNotes('');
      return;
    }
    void fetchOne<HealthDocument>(`/personal/health/documents/${documentId}`, { locale })
      .then((d) => {
        setDoc(d);
        setTitle(d.title);
        setCategory(d.category);
        setDate(d.document_date ?? '');
        setNotes(d.notes ?? '');
        setStored(d.pages ?? []);
      })
      .catch(() => {
        setErrors({ form: t('health.error.load') });
      });
  }, [open, documentId]);

  // "Take photo" from the dashboard opens the camera straight away.
  useEffect(() => {
    if (!open || !startWithCamera || documentId !== null || cameraClicked.current) return;
    cameraClicked.current = true;
    const timer = setTimeout(() => {
      document.querySelector<HTMLInputElement>('.health-pages input[capture]')?.click();
    }, 80);
    return () => {
      clearTimeout(timer);
    };
  }, [open, startWithCamera, documentId]);

  const inTrash = doc?.in_trash ?? false;
  const room = MAX_PAGES - stored.length - pages.length;

  const close = (): void => {
    if (changed.current) onSaved();
    onClose();
  };

  const addFiles = async (files: readonly File[]): Promise<void> => {
    const next: Page[] = [];
    let problem = '';
    for (const file of files.slice(0, Math.max(0, room))) {
      try {
        next.push(await toPage(file));
      } catch (error) {
        problem = error instanceof Error && error.message === 'too_large' ? t('capture.error_size') : t('capture.error_type');
      }
    }
    if (files.length > room) problem = t('health.error.page_limit', { max: String(MAX_PAGES) });
    setErrors((e) => ({ ...e, pages: problem }));
    setPages((old) => [...old, ...next]);
  };

  const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!title.trim()) next.title = t('health.error.title');
    if (documentId === null && stored.length + pages.length === 0) next.pages = t('health.error.no_pages');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setSaving(true);
    try {
      const body = { title: title.trim(), category, notes, document_date: date };
      const id = savedId.current;
      const saved = id
        ? await fetchOne<HealthDocument>(`/personal/health/documents/${id}`, { locale, method: 'PATCH', body })
        : await fetchOne<HealthDocument>('/personal/health/documents', {
            locale,
            method: 'POST',
            body: { ...body, ...(date ? {} : { document_date: undefined }) },
          });
      savedId.current = saved.id;
      changed.current = true;
      // Pages go up one by one; a page that fails stays for "Save" to retry.
      let left = pages;
      let index = stored.length;
      for (const page of pages) {
        index += 1;
        try {
          // Neutral names: a medical file's name never says what it is.
          await uploadPage(locale, 'health_document', saved.id, page, `page-${String(index)}.${page.pdf ? 'pdf' : 'jpg'}`);
          releasePage(page);
          left = left.filter((p) => p.key !== page.key);
        } catch {
          // kept for retry
        }
      }
      setPages(left);
      if (left.length > 0) {
        setErrors({ pages: t('health.error.upload_failed') });
        return;
      }
      close();
    } catch (error) {
      setErrors(
        error instanceof ApiError && error.fields['title'] ? { title: t('health.error.title') } : { form: t('health.error.generic') },
      );
    } finally {
      setSaving(false);
    }
  };

  const removeStored = async (page: HealthPage): Promise<void> => {
    try {
      await sendNoContent(`/attachments/${page.id}`, { locale, method: 'DELETE' });
      setStored((old) => old.filter((p) => p.id !== page.id));
      changed.current = true;
    } catch {
      setErrors({ pages: t('health.error.generic') });
    }
  };

  const download = async (page: HealthPage, index: number): Promise<void> => {
    const blob = await receiptBlob(locale, page.id);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${title || 'document'}-${String(index + 1)}.${page.mime_type === 'application/pdf' ? 'pdf' : 'jpg'}`;
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 30_000);
  };

  const trash = async (): Promise<void> => {
    if (!documentId) return;
    setSaving(true);
    try {
      await sendNoContent(`/personal/health/documents/${documentId}`, { locale, method: 'DELETE' });
      changed.current = true;
      close();
    } finally {
      setSaving(false);
    }
  };

  if (editor) {
    return (
      <Modal
        open={open}
        title={t('capture.edit_title')}
        closeLabel={t('finance.close')}
        onClose={() => {
          setEditor(null);
        }}
      >
        <PhotoEditor
          locale={locale}
          file={editor.file}
          onCancel={() => {
            setEditor(null);
          }}
          {...(editor.camera
            ? {
                onRetake: () => {
                  setEditor(null);
                  setTimeout(() => {
                    document.querySelector<HTMLInputElement>('.health-pages input[capture]')?.click();
                  }, 60);
                },
              }
            : {})}
          onUse={(result) => {
            void toPage(editor.file, result).then((page) => {
              const replace = editor.replace;
              setPages((old) =>
                replace === null
                  ? [...old, page]
                  : old.map((p) => {
                      if (p.key !== replace) return p;
                      releasePage(p);
                      return page;
                    }),
              );
              setEditor(null);
            });
          }}
        />
      </Modal>
    );
  }

  if (confirmTrash) {
    return (
      <Modal
        open={open}
        title={t('health.trash.move_title')}
        closeLabel={t('finance.close')}
        onClose={() => {
          setConfirmTrash(false);
        }}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmTrash(false);
              }}
            >
              {t('finance.cancel')}
            </Button>
            <Button
              variant="destructive"
              loading={saving}
              onClick={() => {
                void trash();
              }}
            >
              {t('health.trash.move')}
            </Button>
          </>
        }
      >
        <p>{t('health.trash.move_help')}</p>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      title={documentId === null ? t('health.add') : t('health.document')}
      closeLabel={t('finance.close')}
      onClose={close}
    >
      <form
        className="fin-form"
        noValidate
        onSubmit={(event) => {
          void save(event);
        }}
      >
        {errors.form ? (
          <p className="fin-form__error" role="alert">
            {errors.form}
          </p>
        ) : null}
        {inTrash ? <p className="fin-note">{t('health.trash.read_only', { days: String(doc?.days_left ?? 0) })}</p> : null}

        <section className="fin-receipts health-pages" aria-label={t('health.pages')}>
          <div className="fin-receipts__head">
            <h3>{t('health.pages')}</h3>
            <small>
              {stored.length + pages.length}/{MAX_PAGES}
            </small>
          </div>
          {stored.length + pages.length > 0 ? (
            <div className="fin-receipts__list">
              {stored.map((p, index) => (
                <div key={p.id} className="health-page">
                  <StoredReceipt
                    locale={locale}
                    receipt={p}
                    {...(inTrash
                      ? {}
                      : {
                          onRemove: () => {
                            void removeStored(p);
                          },
                        })}
                  />
                  <button
                    type="button"
                    className="health-page__download"
                    onClick={() => {
                      void download(p, index);
                    }}
                  >
                    {t('health.download')}
                  </button>
                </div>
              ))}
              {pages.map((p) => (
                <PendingReceipt
                  key={p.key}
                  locale={locale}
                  page={p}
                  onEdit={() => {
                    setEditor({ file: p.original, replace: p.key, camera: false });
                  }}
                  onRemove={() => {
                    releasePage(p);
                    setPages((old) => old.filter((x) => x.key !== p.key));
                  }}
                />
              ))}
            </div>
          ) : (
            <p className="fin-muted">{t('health.pages_empty')}</p>
          )}
          {room > 0 && !inTrash ? (
            <CaptureButtons
              locale={locale}
              onCamera={(file) => {
                setEditor({ file, replace: null, camera: true });
              }}
              onFiles={(files) => {
                void addFiles(files);
              }}
            />
          ) : null}
          {errors.pages ? (
            <p className="fin-form__error" role="alert">
              {errors.pages}
            </p>
          ) : null}
        </section>

        <Field label={t('health.field.title')} required {...(errors.title ? { error: errors.title } : {})}>
          <Input
            value={title}
            maxLength={160}
            disabled={inTrash}
            placeholder={t('health.field.title_hint')}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        </Field>
        <Field label={t('health.field.category')} required>
          <Select
            value={category}
            disabled={inTrash}
            onChange={(event) => {
              setCategory(event.target.value as DocumentCategory);
            }}
          >
            {DOCUMENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`health.category.${c}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('health.field.date')}>
          <Input
            type="date"
            value={date}
            disabled={inTrash}
            onChange={(event) => {
              setDate(event.target.value);
            }}
          />
        </Field>
        <Field label={t('health.field.notes')}>
          <Textarea
            value={notes}
            rows={3}
            maxLength={2000}
            disabled={inTrash}
            onChange={(event) => {
              setNotes(event.target.value);
            }}
          />
        </Field>

        <div className="fin-form__actions">
          {documentId !== null && !inTrash ? (
            <Button
              type="button"
              variant="destructive-ghost"
              className="fin-form__delete"
              onClick={() => {
                setConfirmTrash(true);
              }}
            >
              {t('health.trash.move')}
            </Button>
          ) : null}
          <Button type="button" variant="secondary" onClick={close}>
            {inTrash ? t('finance.close') : t('finance.cancel')}
          </Button>
          {inTrash ? null : (
            <Button type="submit" loading={saving}>
              {t('finance.save')}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
