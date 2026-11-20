'use client';

import { useEffect, useRef, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { FULL_CROP, loadBitmap, preparePhoto, render } from '../../lib/image-prep';
import type { Crop, Rotation } from '../../lib/image-prep';
import { Button } from '../design-system';

type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'move';
const MIN = 0.08;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Preview one photo before it is kept: rotate it, drag the corners to crop
 * it, retake it, or use it. Shared by receipts (Expenses) and, later, health
 * documents. Produces the prepared JPEG and its canvas (for on-device OCR).
 */
export function PhotoEditor({
  locale,
  file,
  onUse,
  onRetake,
  onCancel,
}: {
  readonly locale: Locale;
  readonly file: Blob;
  readonly onUse: (result: { blob: Blob; canvas: HTMLCanvasElement }) => void;
  readonly onRetake?: (() => void) | undefined;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [crop, setCrop] = useState<Crop>(FULL_CROP);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ handle: Handle; x: number; y: number; start: Crop } | null>(null);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const bitmap = await loadBitmap(file);
        // A light preview: the full photo, rotated, at most 1200px.
        const canvas = render(bitmap, rotation, FULL_CROP);
        bitmap.close();
        const blob = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob(resolve, 'image/jpeg', 0.8);
        });
        if (cancelled || !blob) return;
        url = URL.createObjectURL(blob);
        setPreview(url);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file, rotation]);

  const turn = (by: 90 | -90): void => {
    setRotation((r) => (((r + by + 360) % 360) as Rotation));
    setCrop(FULL_CROP);
  };

  const onPointerDown = (handle: Handle) => (event: React.PointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    (event.target as Element).setPointerCapture(event.pointerId);
    drag.current = { handle, x: event.clientX, y: event.clientY, start: crop };
  };

  const onPointerMove = (event: React.PointerEvent): void => {
    const active = drag.current;
    const box = frame.current?.getBoundingClientRect();
    if (!active || !box) return;
    // Pointer movement in screen space; the frame is never mirrored (dir=ltr).
    const dx = (event.clientX - active.x) / box.width;
    const dy = (event.clientY - active.y) / box.height;
    const s = active.start;
    let { x, y, w, h } = s;
    if (active.handle === 'move') {
      x = clamp(s.x + dx, 0, 1 - s.w);
      y = clamp(s.y + dy, 0, 1 - s.h);
    } else {
      if (active.handle.includes('w')) {
        x = clamp(s.x + dx, 0, s.x + s.w - MIN);
        w = s.w + (s.x - x);
      }
      if (active.handle.includes('e')) w = clamp(s.w + dx, MIN, 1 - s.x);
      if (active.handle.includes('n')) {
        y = clamp(s.y + dy, 0, s.y + s.h - MIN);
        h = s.h + (s.y - y);
      }
      if (active.handle.includes('s')) h = clamp(s.h + dy, MIN, 1 - s.y);
    }
    setCrop({ x, y, w, h });
  };

  const onPointerUp = (): void => {
    drag.current = null;
  };

  const use = async (): Promise<void> => {
    setBusy(true);
    try {
      onUse(await preparePhoto(file, rotation, crop));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="photo-editor">
      {failed ? (
        <p className="fin-form__error" role="alert">
          {t('capture.error_image')}
        </p>
      ) : null}
      <div className="photo-editor__stage" dir="ltr">
        {preview ? (
          <div
            ref={frame}
            className="photo-editor__frame"
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <img src={preview} alt={t('capture.preview')} draggable={false} />
            <div
              className="photo-editor__crop"
              style={{
                left: `${String(crop.x * 100)}%`,
                top: `${String(crop.y * 100)}%`,
                width: `${String(crop.w * 100)}%`,
                height: `${String(crop.h * 100)}%`,
              }}
              onPointerDown={onPointerDown('move')}
              aria-label={t('capture.crop')}
            >
              {(['nw', 'ne', 'sw', 'se'] as const).map((handle) => (
                <span
                  key={handle}
                  className={`photo-editor__handle photo-editor__handle--${handle}`}
                  onPointerDown={onPointerDown(handle)}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="fin-loading photo-editor__loading" aria-busy="true" />
        )}
      </div>
      <div className="photo-editor__tools">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            turn(-90);
          }}
        >
          ↺ {t('capture.rotate_left')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            turn(90);
          }}
        >
          ↻ {t('capture.rotate_right')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setCrop(FULL_CROP);
          }}
        >
          {t('capture.reset_crop')}
        </Button>
      </div>
      <div className="fin-form__actions">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('capture.cancel')}
        </Button>
        {onRetake ? (
          <Button type="button" variant="secondary" onClick={onRetake}>
            {t('capture.retake')}
          </Button>
        ) : null}
        <Button
          type="button"
          loading={busy}
          disabled={!preview}
          onClick={() => {
            void use();
          }}
        >
          {t('capture.use')}
        </Button>
      </div>
    </div>
  );
}
