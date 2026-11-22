'use client';

import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';
import { useState } from 'react';

import { ApiError } from '../../lib/api-client';
import { localInput, saveVisit, VISIT_STATUSES } from '../../lib/medical';
import type { PersonRef, Visit, VisitInput, VisitStatus } from '../../lib/medical';
import { Button, Field, Input, Modal, Select, Textarea } from '../design-system';

import { personLabel } from './medical-parts';

/** Book a visit, or update one. The notes field exists only for someone who may write clinical notes. */
export function VisitDialog({
  locale,
  patientId,
  visit,
  doctors,
  clinical,
  defaultDoctor,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly patientId: string;
  readonly visit: Visit | null;
  readonly doctors: readonly PersonRef[];
  readonly clinical: boolean;
  readonly defaultDoctor: string | null;
  readonly onClose: () => void;
  readonly onSaved: (visit: Visit) => void;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const [at, setAt] = useState(visit ? localInput(visit.visit_at) : localInput(new Date(Date.now() + 3_600_000).toISOString()));
  const [doctor, setDoctor] = useState(visit?.doctor?.id ?? defaultDoctor ?? '');
  const [reason, setReason] = useState(visit?.reason ?? '');
  const [status, setStatus] = useState<VisitStatus>(visit?.status ?? 'scheduled');
  const [notes, setNotes] = useState(visit?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const instant = new Date(at);
    if (Number.isNaN(instant.getTime())) {
      setError(t('medical.error.when'));
      return;
    }
    const body: VisitInput = {
      visit_at: instant.toISOString(),
      doctor_id: doctor || null,
      reason: reason.trim() || null,
      status,
      ...(clinical && (visit ? notes !== (visit.notes ?? '') : notes.trim() !== '') ? { notes: notes.trim() || null } : {}),
    };
    setSaving(true);
    setError(null);
    try {
      onSaved(await saveVisit(locale, visit ? { visitId: visit.id } : { patientId }, body));
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.fields.notes
          ? t('medical.error.notes_not_allowed')
          : failure instanceof ApiError && failure.fields.patient
            ? t('medical.error.archived')
            : t('medical.error.save'),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={t(visit ? 'medical.edit_visit' : 'medical.add_visit')}
      onClose={onClose}
      closeLabel={t('medical.close')}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            {t('medical.cancel')}
          </Button>
          <Button type="submit" form="visit-form" loading={saving}>
            {t('medical.save')}
          </Button>
        </>
      }
    >
      <form id="visit-form" className="medical-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="medical-form__row">
          <Field label={t('medical.field.visit_at')} required>
            <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          </Field>
          <Field label={t('medical.field.status')}>
            <Select value={status} onChange={(e) => setStatus(e.target.value as VisitStatus)}>
              {VISIT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`medical.visit_status.${s}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t('medical.field.doctor')}>
          <Select value={doctor} onChange={(e) => setDoctor(e.target.value)}>
            <option value="">{t('medical.unassigned')}</option>
            {doctors
              .filter((d) => d.clinical_role === 'doctor')
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {personLabel(t, d)}
                </option>
              ))}
          </Select>
        </Field>
        <Field label={t('medical.field.reason')}>
          <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {clinical ? (
          <Field label={t('medical.field.clinical_notes')} helper={t('medical.clinical_notes_help')}>
            <Textarea value={notes} rows={5} maxLength={4000} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        ) : (
          <p className="medical-note">{t('medical.no_clinical_access')}</p>
        )}
        {error ? <p className="medical-form__error" role="alert">{error}</p> : null}
      </form>
    </Modal>
  );
}
