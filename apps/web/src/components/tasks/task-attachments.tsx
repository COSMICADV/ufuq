'use client';

import { useRef, useState } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, sendNoContent, uploadForm } from '../../lib/api-client';
import {
  ACCEPT_ATTRIBUTE,
  downloadUrl,
  formatBytes,
  typeLabel,
  uploadErrorKey,
} from '../../lib/attachments';
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
  taskId,
  initial,
  locale,
  t,
  timeZone,
}: {
  readonly taskId: string;
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

  const upload = (file: File): void => {
    const form = new FormData();
    form.append('related_type', 'task');
    form.append('related_id', taskId);
    form.append('file', file, file.name);
    setUploading(true);
    setError(null);
    uploadForm<Attachment>('/attachments', form, { locale })
      .then((created) => {
        setItems((current) => [created, ...current]);
        setNotice(t('attachments.uploaded'));
      })
      .catch(refused)
      .finally(() => {
        setUploading(false);
        if (picker.current !== null) picker.current.value = '';
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
        accept={ACCEPT_ATTRIBUTE}
        // Opened by the button below; hidden so there is one control, not two.
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) upload(file);
        }}
      />
      <Button
        variant="secondary"
        loading={uploading}
        onClick={() => {
          picker.current?.click();
        }}
      >
        {uploading ? t('attachments.uploading') : t('attachments.upload')}
      </Button>
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
