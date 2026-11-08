'use client';

/**
 * Choose files — or a whole folder — before a task exists. The files wait
 * here and are uploaded as soon as the task is saved (`task-form.tsx`).
 *
 * Files the server would refuse (a type it does not take, or too large) are
 * shown with the reason and are not sent, so one stray file in a folder does
 * not spoil the rest. A folder keeps its structure in each file's name.
 */

import { useRef } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import {
  ACCEPT_ATTRIBUTE,
  fileProblem,
  formatBytes,
  MAX_UPLOADS_PER_BATCH,
  uploadName,
} from '../../lib/attachments';
import { Button } from '../design-system';
import { Ltr } from '../settings/screen-states';

export function AttachmentPicker({
  files,
  onChange,
  locale,
  t,
}: {
  readonly files: readonly File[];
  readonly onChange: (files: readonly File[]) => void;
  readonly locale: Locale;
  readonly t: Translator;
}): React.JSX.Element {
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);

  const add = (list: FileList | null, input: HTMLInputElement | null): void => {
    if (list === null) return;
    const known = new Set(files.map((f) => uploadName(f)));
    const next = [...files];
    for (const file of Array.from(list)) {
      // Hidden system files in a folder (".DS_Store", "Thumbs.db") are noise.
      if (file.name.startsWith('.') || file.name === 'Thumbs.db') continue;
      if (!known.has(uploadName(file))) {
        known.add(uploadName(file));
        next.push(file);
      }
    }
    onChange(next);
    if (input !== null) input.value = '';
  };

  const ready = files.filter((f) => fileProblem(f) === null);
  const overLimit = ready.length > MAX_UPLOADS_PER_BATCH;

  return (
    <fieldset className="tasks-builder attachment-picker">
      <legend>{t('attachments.title')}</legend>
      <p className="tasks-muted">{t('attachments.picker_intro')}</p>
      <input
        ref={filePicker}
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        hidden
        onChange={(event) => {
          add(event.target.files, event.target);
        }}
      />
      <input
        ref={folderPicker}
        type="file"
        multiple
        hidden
        // Non-standard but supported by every current browser: pick a folder.
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(event) => {
          add(event.target.files, event.target);
        }}
      />
      <div className="attachment-picker__buttons">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            filePicker.current?.click();
          }}
        >
          {t('attachments.add_files')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            folderPicker.current?.click();
          }}
        >
          {t('attachments.add_folder')}
        </Button>
      </div>
      <p className="field__helper">{t('attachments.hint')}</p>

      {files.length > 0 ? (
        <ul className="attachment-picker__list" aria-label={t('attachments.picked_label')}>
          {files.map((file, index) => {
            const problem = fileProblem(file);
            return (
              <li
                key={`${uploadName(file)}-${String(index)}`}
                className={`attachment-picker__item${problem === null ? '' : ' attachment-picker__item--skipped'}`}
              >
                <span className="attachment-picker__name" dir="auto">
                  {uploadName(file)}
                </span>
                <span className="attachment-picker__meta">
                  {problem === null ? (
                    <Ltr>{formatBytes(file.size, locale)}</Ltr>
                  ) : (
                    t(
                      problem === 'too_large'
                        ? 'attachments.skip_too_large'
                        : 'attachments.skip_type',
                    )
                  )}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('attachments.remove_picked', { name: uploadName(file) })}
                  onClick={() => {
                    onChange(files.filter((_, i) => i !== index));
                  }}
                >
                  ×
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {files.length > 0 ? (
        <p className="field__helper">
          {t('attachments.picked_summary', {
            ready: String(Math.min(ready.length, MAX_UPLOADS_PER_BATCH)),
            skipped: String(files.length - ready.length),
          })}
        </p>
      ) : null}
      {overLimit ? (
        <p className="field__helper attachment-picker__warning">
          {t('attachments.over_limit', { max: String(MAX_UPLOADS_PER_BATCH) })}
        </p>
      ) : null}
    </fieldset>
  );
}
