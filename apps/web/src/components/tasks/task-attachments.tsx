'use client';

import { useRef, useState } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, sendNoContent } from '../../lib/api-client';
import {
  ACCEPT_ATTRIBUTE,
  downloadUrl,
  fileProblem,
  formatBytes,
  MAX_UPLOADS_PER_BATCH,
  typeLabel,
  uploadErrorKey,
} from '../../lib/attachments';
import { uploadBatch } from './upload-batch';
import type { Attachment, RecordAttachments } from '../../lib/attachments';
import { formatDate } from '../attendance/attendance-shared';
import { Alert, Button, Card, EmptyState, Modal } from '../design-system';
import { Ltr, SuccessNotice } from '../settings/screen-states';

/**
 * A task's files — DOCUMENT 04 B9 / C6, DOCUMENT 13 ("Upload attachment"),
 * DOCUMENT 08 §4.14. Phase 7 addendum, approved 2026-10-05.
 *
 * - **What the caller may do is the server's answer**, not a guess from
 *   permissions: `can_upload` / `can_delete` come with the task
 *   (`TaskAttachmentPolicy`), exactly as status moves come from
 *   `allowed_transitions`. The API decides again on every request.
 * - **Download** is a link to the authorization-checked endpoint, which
 *   answers `Content-Disposition: attachment`. There is no storage URL to
 *   show — the API never has one to give.
 * - **Upload** uses the native file picker, which on a phone also offers the
 *   camera (DOCUMENT 13 "Mobile behaviour"). The picker's filter is a
 *   convenience; type, magic bytes and size are checked by the server.
 * - The list is held here, seeded from the task load: the task's write
 *   endpoints return the task without its files, so the parent's task
 *   updates never wipe this list.
 */
export function TaskAttachments({
  recordId,
  relatedType = 'task',
  initial,
  locale,
  t,
  timeZone,
}: {
  readonly recordId: string;
  /**
   * The record kind the files belong to. The card is the attachment store's
   * one UI (DOCUMENT 27 RULE 20); a request (Phase 9) uses it as a task does.
   */
  readonly relatedType?: 'task' | 'request';
  readonly initial: RecordAttachments;
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
}): React.JSX.Element {
  const [items, setItems] = useState<readonly Attachment[]>(initial.items);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState<Attachment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const refused = (failure: unknown): void => {
    const status = failure instanceof ApiError ? failure.status : 0;
    const issue = failure instanceof ApiError ? (failure.fields['file']?.[0] ?? null) : null;
    setError(t(uploadErrorKey(status, issue)));
    setNotice(null);
  };

  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const folderPicker = useRef<HTMLInputElement>(null);

  /** Upload what was picked — one file, several, or a whole folder. */
  const upload = (list: FileList | null, input: HTMLInputElement | null): void => {
    const picked = Array.from(list ?? []).filter(
      (f) => !f.name.startsWith('.') && f.name !== 'Thumbs.db',
    );
    if (input !== null) input.value = '';
    if (picked.length === 0) return;
    const skipped = picked.filter((f) => fileProblem(f) !== null).length;
    const sendable = picked.length - skipped;
    setError(null);
    setNotice(null);
    if (sendable === 0) {
      setError(
        t(
          picked.length === 1
            ? uploadErrorKey(422, fileProblem(picked[0] as File))
            : 'attachments.none_uploadable',
        ),
      );
      return;
    }
    setUploading(true);
    void uploadBatch(picked, { relatedType, relatedId: recordId }, locale, (done, total) => {
      setProgress({ done, total });
    })
      .then(({ uploaded, failed }) => {
        if (uploaded.length > 0) setItems((current) => [...uploaded].reverse().concat(current));
        const notUploaded = failed.length + skipped + Math.max(0, sendable - MAX_UPLOADS_PER_BATCH);
        if (uploaded.length > 0) {
          setNotice(
            uploaded.length === 1 && notUploaded === 0
              ? t('attachments.uploaded')
              : t('attachments.uploaded_many', { count: String(uploaded.length) }),
          );
        }
        if (notUploaded > 0) {
          const firstSkipped = picked.find((f) => fileProblem(f) !== null);
          const first =
            failed[0] ??
            (firstSkipped === undefined
              ? undefined
              : {
                  name: firstSkipped.name,
                  reason: uploadErrorKey(422, fileProblem(firstSkipped)),
                });
          setError(
            picked.length === 1 && first !== undefined
              ? t(first.reason)
              : t('attachments.some_not_uploaded', { count: String(notUploaded) }) +
                  (first === undefined ? '' : ` ${first.name}: ${t(first.reason)}`),
          );
        }
      })
      .finally(() => {
        setUploading(false);
        setProgress(null);
      });
  };

  const remove = (attachment: Attachment): void => {
    setBusy(true);
    setError(null);
    sendNoContent(`/attachments/${attachment.id}`, { locale, method: 'DELETE' })
      .then(() => {
        setItems((current) => current.filter((item) => item.id !== attachment.id));
        setNotice(t('attachments.deleted'));
        setRemoving(null);
      })
      .catch((failure: unknown) => {
        refused(failure);
        setRemoving(null);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const action = initial.can_upload ? (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        // Opened by the buttons below; hidden so each choice is one control.
        hidden
        onChange={(event) => {
          upload(event.target.files, event.target);
        }}
      />
      <input
        ref={folderPicker}
        type="file"
        multiple
        hidden
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(event) => {
          upload(event.target.files, event.target);
        }}
      />
      <span className="attachment-picker__buttons">
        <Button
          variant="secondary"
          loading={uploading}
          onClick={() => {
            picker.current?.click();
          }}
        >
          {uploading
            ? progress === null
              ? t('attachments.uploading')
              : t('attachments.uploading_progress', {
                  done: String(Math.min(progress.done + 1, progress.total)),
                  total: String(progress.total),
                })
            : t('attachments.add_files')}
        </Button>
        {uploading ? null : (
          <Button
            variant="secondary"
            onClick={() => {
              folderPicker.current?.click();
            }}
          >
            {t('attachments.add_folder')}
          </Button>
        )}
      </span>
    </>
  ) : null;

  return (
    <Card title={t('attachments.title')} action={action} className="task-attachments">
      <SuccessNotice message={notice} t={t} />
      {error === null ? null : (
        <Alert tone="danger" title={t('attachments.error_title')}>
          {error}
        </Alert>
      )}
      {initial.can_upload ? <p className="field__helper">{t('attachments.hint')}</p> : null}

      {items.length === 0 ? (
        <EmptyState
          title={t('attachments.empty_title')}
          description={t('attachments.empty')}
          action={null}
        />
      ) : (
        <ul className="task-attachments__list" aria-label={t('attachments.list_label')}>
          {items.map((item) => (
            <li key={item.id} className="task-attachments__item">
              <div className="task-attachments__file">
                {/* `dir="auto"`: the name is whatever script the person used. */}
                <a href={downloadUrl(item.id)} dir="auto" className="task-attachments__name">
                  {item.original_name}
                </a>
                <span className="task-attachments__meta">
                  <Ltr>{typeLabel(item.mime_type)}</Ltr>
                  <span>{formatBytes(item.size_bytes, locale)}</span>
                  <span>
                    {t('attachments.uploaded_by', {
                      name: item.uploaded_by.name ?? t('attachments.unknown_uploader'),
                    })}
                  </span>
                  <Ltr>{formatDate(item.created_at.slice(0, 10), locale, timeZone)}</Ltr>
                </span>
              </div>
              <div className="task-attachments__actions">
                <a className="button button--ghost button--sm" href={downloadUrl(item.id)}>
                  {t('attachments.download')}
                </a>
                {initial.can_delete ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setRemoving(item);
                    }}
                  >
                    {t('attachments.delete')}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {removing === null ? null : (
        <Modal
          open
          title={t('attachments.delete_title')}
          closeLabel={t('action.close')}
          onClose={() => {
            setRemoving(null);
          }}
          footer={
            <div className="settings-form__actions">
              <Button
                variant="destructive"
                loading={busy}
                onClick={() => {
                  remove(removing);
                }}
              >
                {t('attachments.delete')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setRemoving(null);
                }}
              >
                {t('action.cancel')}
              </Button>
            </div>
          }
        >
          <p>{t('attachments.delete_body', { name: removing.original_name })}</p>
        </Modal>
      )}
    </Card>
  );
}
