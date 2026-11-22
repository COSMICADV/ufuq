'use client';

import { useEffect, useRef, useState } from 'react';
import { createTranslator, normaliseDigits } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ApiError, fetchOne } from '../../../lib/api-client';
import type { OdometerReading, Vehicle } from '../../../lib/car';
import { nowLocalInput } from '../../../lib/finance';
import { recogniseDigits } from '../../../lib/ocr';
import { groupKm, odometerCandidates } from '../../../lib/odometer-reader';
import { releasePage, toPage, uploadPage } from '../../../lib/receipts';
import type { Page } from '../../../lib/receipts';
import { PhotoEditor } from '../../capture/photo-editor';
import { Button, Field, Input, Modal, Select, Textarea } from '../../design-system';

type Step = 'photo' | 'reading' | 'details';

/**
 * Add (or correct) one odometer reading. With a photo: camera → crop tight
 * around the digits → the device reads them → the person confirms or
 * corrects the number → save. Without one: type the number. Nothing the OCR
 * suggested is saved until the person confirms it.
 */
export function ReadingDialog({
  locale,
  open,
  vehicle,
  editing,
  withCamera,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly open: boolean;
  readonly vehicle: Vehicle;
  readonly editing: OdometerReading | null;
  readonly withCamera: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element | null {
  const t = createTranslator(locale);
  const camera = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('details');
  const [file, setFile] = useState<File | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [reading, setReading] = useState(false);
  const [candidates, setCandidates] = useState<number[]>([]);
  const [km, setKm] = useState('');
  const [when, setWhen] = useState(nowLocalInput());
  const [kind, setKind] = useState<'normal' | 'reset' | 'replacement'>('normal');
  const [note, setNote] = useState('');
  const [unusual, setUnusual] = useState(false);
  const [confirmUnusual, setConfirmUnusual] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const opened = useRef(false);

  const lastKm = vehicle.stats.current_km;

  useEffect(() => {
    if (!open) {
      opened.current = false;
      return;
    }
    if (opened.current) return;
    opened.current = true;
    setFile(null);
    setPage((old) => {
      if (old) releasePage(old);
      return null;
    });
    setCandidates([]);
    setError('');
    setUnusual(false);
    setConfirmUnusual(false);
    setKind('normal');
    if (editing) {
      setStep('details');
      setKm(String(editing.reading_km));
      setWhen(nowLocalInput(new Date(editing.read_at)));
      setNote(editing.note ?? '');
    } else {
      setKm('');
      setWhen(nowLocalInput());
      setNote('');
      setStep(withCamera ? 'photo' : 'details');
      if (withCamera) {
        setTimeout(() => {
          camera.current?.click();
        }, 80);
      }
    }
  }, [open, editing, withCamera]);

  const read = async (prepared: { blob: Blob; canvas: HTMLCanvasElement }, original: File): Promise<void> => {
    setPage(await toPage(original, prepared));
    setFile(null);
    setStep('reading');
    setReading(true);
    try {
      const texts = await recogniseDigits(prepared.canvas);
      const found = odometerCandidates(texts, lastKm);
      setCandidates(found);
      setKm(found[0] !== undefined ? String(found[0]) : '');
    } catch {
      setCandidates([]);
    } finally {
      setReading(false);
      setStep('details');
    }
  };

  const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const digits = normaliseDigits(km).replace(/[,\s٬]/g, '');
    if (!/^\d{1,7}$/.test(digits)) {
      setError(t('car.error.km'));
      return;
    }
    if (unusual && !confirmUnusual) {
      setError(t('car.error.confirm_unusual'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const body = {
        reading_km: Number(digits),
        read_at: new Date(when).toISOString(),
        note,
        ...(confirmUnusual ? { confirm_unusual: true } : {}),
      };
      const saved = editing
        ? await fetchOne<OdometerReading>(`/personal/car/readings/${editing.id}`, { locale, method: 'PATCH', body })
        : await fetchOne<OdometerReading>(`/personal/car/vehicles/${vehicle.id}/readings`, {
            locale,
            method: 'POST',
            body: { ...body, kind, source: page ? 'photo' : 'manual' },
          });
      if (page && !editing) {
        try {
          await uploadPage(locale, 'odometer_reading', saved.id, page, 'odometer.jpg');
        } catch {
          // The reading is saved; a lost photo is not worth blocking it.
        }
      }
      onSaved();
      onClose();
    } catch (failure) {
      const issue =
        failure instanceof ApiError ? (failure.fields['reading_km']?.[0] ?? failure.fields['kind']?.[0] ?? failure.fields['read_at']?.[0]) : undefined;
      if (issue === 'unusual') {
        setUnusual(true);
        setError(t('car.error.unusual'));
      } else if (issue) {
        setError(t(`car.error.${issue === 'invalid' ? 'future' : issue}`));
      } else setError(t('finance.error.generic'));
    } finally {
      setSaving(false);
    }
  };

  const cameraInput = (
    <input
      ref={camera}
      type="file"
      accept="image/*"
      capture="environment"
      hidden
      onChange={(event) => {
        const picked = event.target.files?.[0];
        event.target.value = '';
        if (picked) setFile(picked);
      }}
    />
  );

  if (file) {
    return (
      <Modal open={open} title={t('car.crop_title')} closeLabel={t('finance.close')} onClose={onClose}>
        <p className="fin-note">{t('car.crop_help')}</p>
        <PhotoEditor
          locale={locale}
          file={file}
          onCancel={() => {
            setFile(null);
            setStep('details');
          }}
          onRetake={() => {
            setFile(null);
            setTimeout(() => {
              camera.current?.click();
            }, 60);
          }}
          onUse={(result) => {
            void read(result, file);
          }}
        />
        {cameraInput}
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      title={editing ? t('car.edit_reading') : t('car.add_reading')}
      closeLabel={t('finance.close')}
      onClose={onClose}
    >
      {cameraInput}
      {step === 'photo' ? (
        <div className="car-photo-step">
          <p>{t('car.photo_help')}</p>
          <div className="capture-buttons">
            <Button
              type="button"
              onClick={() => {
                camera.current?.click();
              }}
            >
              {t('car.take_photo')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setStep('details');
              }}
            >
              {t('car.type_instead')}
            </Button>
          </div>
        </div>
      ) : step === 'reading' || reading ? (
        <div className="receipt-reading" role="status">
          <span>{t('car.reading_photo')}</span>
          <span className="fin-loading car-reading-bar" aria-hidden="true" />
        </div>
      ) : (
        <form
          className="fin-form"
          noValidate
          onSubmit={(event) => {
            void save(event);
          }}
        >
          {page?.url ? <img className="car-photo-preview" src={page.url} alt={t('car.photo_alt')} /> : null}
          {page ? (
            candidates.length > 0 ? (
              <div className="car-candidates">
                <p>{t('car.ocr_found')}</p>
                <div>
                  {candidates.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="fin-chip"
                      aria-pressed={km === String(c)}
                      aria-checked={km === String(c)}
                      onClick={() => {
                        setKm(String(c));
                        setUnusual(false);
                        setConfirmUnusual(false);
                      }}
                    >
                      <bdi dir="ltr">{groupKm(c)}</bdi>
                    </button>
                  ))}
                </div>
                <small>{t('car.ocr_check')}</small>
              </div>
            ) : (
              <p className="fin-note">{t('car.ocr_nothing')}</p>
            )
          ) : null}
          <Field label={t('car.field.km')} required>
            <Input
              className="fin-amount"
              inputMode="numeric"
              dir="ltr"
              value={km}
              placeholder={lastKm !== null ? groupKm(lastKm) : '0'}
              onChange={(event) => {
                setKm(event.target.value);
                setUnusual(false);
                setConfirmUnusual(false);
              }}
            />
          </Field>
          {lastKm !== null && !editing ? (
            <small className="fin-muted">{t('car.last_was', { km: groupKm(lastKm) })}</small>
          ) : null}
          <Field label={t('car.field.when')} required>
            <Input
              type="datetime-local"
              value={when}
              onChange={(event) => {
                setWhen(event.target.value);
              }}
            />
          </Field>
          {editing ? null : (
            <Field label={t('car.field.kind')}>
              <Select
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as typeof kind);
                }}
              >
                <option value="normal">{t('car.kind.normal')}</option>
                <option value="reset">{t('car.kind.reset')}</option>
                <option value="replacement">{t('car.kind.replacement')}</option>
              </Select>
            </Field>
          )}
          {kind !== 'normal' ? <p className="fin-note">{t('car.kind_help')}</p> : null}
          <Field label={t('finance.field.notes')}>
            <Textarea
              rows={2}
              maxLength={300}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </Field>
          {unusual ? (
            <label className="budget-toggle">
              <input
                type="checkbox"
                checked={confirmUnusual}
                onChange={(event) => {
                  setConfirmUnusual(event.target.checked);
                  setError('');
                }}
              />
              <span>
                <strong>{t('car.confirm_unusual')}</strong>
              </span>
            </label>
          ) : null}
          {error ? (
            <p className="fin-form__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="fin-form__actions">
            {!editing && !page ? (
              <Button
                type="button"
                variant="ghost"
                className="fin-form__delete"
                onClick={() => {
                  camera.current?.click();
                }}
              >
                {t('car.take_photo')}
              </Button>
            ) : null}
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('finance.cancel')}
            </Button>
            <Button type="submit" loading={saving}>
              {t('car.confirm_save')}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
