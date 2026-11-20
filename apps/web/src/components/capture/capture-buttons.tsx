'use client';

import { useRef } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { Button } from '../design-system';

/**
 * "Take photo" opens the device camera (the browser asks for permission; on a
 * computer it falls back to choosing a file). "Upload" takes existing images
 * or PDFs. Both hand back plain Files.
 */
export function CaptureButtons({
  locale,
  onCamera,
  onFiles,
  multiple = true,
  pdf = true,
  disabled,
}: {
  readonly locale: Locale;
  readonly onCamera: (file: File) => void;
  readonly onFiles: (files: File[]) => void;
  readonly multiple?: boolean;
  readonly pdf?: boolean;
  readonly disabled?: boolean;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const camera = useRef<HTMLInputElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  return (
    <div className="capture-buttons">
      <Button
        type="button"
        disabled={disabled}
        onClick={() => {
          camera.current?.click();
        }}
      >
        {t('capture.take_photo')}
      </Button>
      <Button
        type="button"
        variant="secondary"
        disabled={disabled}
        onClick={() => {
          upload.current?.click();
        }}
      >
        {pdf ? t('capture.upload') : t('capture.upload_image')}
      </Button>
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onCamera(file);
        }}
      />
      <input
        ref={upload}
        type="file"
        accept={pdf ? 'image/jpeg,image/png,image/webp,application/pdf' : 'image/jpeg,image/png,image/webp'}
        multiple={multiple}
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          if (files.length > 0) onFiles(files);
        }}
      />
    </div>
  );
}
