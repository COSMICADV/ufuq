'use client';

import { createTranslator, normaliseDigits } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';
import { useState } from 'react';

import { ApiError } from '../../lib/api-client';
import { savePatient } from '../../lib/medical';
import type { PatientDetail, PatientInput, PersonRef } from '../../lib/medical';
import { Button, Field, Input, Modal, Select, Textarea } from '../design-system';

import { personLabel } from './medical-parts';

/** Register a patient, or edit one's file data. */
export function PatientDialog({
  locale,
  patient,
  doctors,
  canAssign,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly patient: PatientDetail | null;
  readonly doctors: readonly PersonRef[];
  /** Only an "all patients" manager picks the primary doctor: it decides who can open the file. */
  readonly canAssign: boolean;
  readonly onClose: () => void;
  readonly onSaved: (patient: PatientDetail) => void;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const [name, setName] = useState(patient?.full_name ?? '');
  const [birth, setBirth] = useState(patient?.date_of_birth ?? '');
  const [gender, setGender] = useState<'' | 'male' | 'female'>(patient?.gender ?? '');
  const [phone, setPhone] = useState(patient?.phone ?? '');
  const [nationalId, setNationalId] = useState(patient?.national_id ?? '');
  const [notes, setNotes] = useState(patient?.notes ?? '');
  const [doctor, setDoctor] = useState(patient?.primary_doctor?.id ?? '');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (name.trim().length < 2) {
      setErrors({ full_name: t('medical.error.name') });
      return;
    }
    const body: PatientInput = {
      full_name: name.trim(),
      date_of_birth: birth || null,
      gender: gender || null,
      phone: normaliseDigits(phone).trim() || null,
      national_id: normaliseDigits(nationalId).trim() || null,
      notes: notes.trim() || null,
      ...(canAssign ? { primary_doctor_id: doctor || null } : {}),
    };
    setSaving(true);
    setErrors({});
    try {
      onSaved(await savePatient(locale, patient?.id ?? null, body));
    } catch (error) {
      const fields = error instanceof ApiError ? error.fields : {};
      const mapped: Record<string, string> = {};
      for (const field of Object.keys(fields)) {
        mapped[field] = t(field === 'phone' ? 'medical.error.phone' : field === 'date_of_birth' ? 'medical.error.birth' : 'medical.error.field');
      }
      setErrors(Object.keys(mapped).length > 0 ? mapped : { form: t('medical.error.save') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={t(patient ? 'medical.edit_patient' : 'medical.add_patient')}
      onClose={onClose}
      closeLabel={t('medical.close')}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            {t('medical.cancel')}
          </Button>
          <Button type="submit" form="patient-form" loading={saving}>
            {t(patient ? 'medical.save' : 'medical.register')}
          </Button>
        </>
      }
    >
      <form id="patient-form" className="medical-form" onSubmit={(event) => void submit(event)} noValidate>
        <Field label={t('medical.field.full_name')} required {...(errors.full_name ? { error: errors.full_name } : {})}>
          <Input value={name} maxLength={160} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="medical-form__row">
          <Field label={t('medical.field.birth')} {...(errors.date_of_birth ? { error: errors.date_of_birth } : {})}>
            <Input type="date" value={birth} max={today} onChange={(e) => setBirth(e.target.value)} />
          </Field>
          <Field label={t('medical.field.gender')}>
            <Select value={gender} onChange={(e) => setGender(e.target.value as '' | 'male' | 'female')}>
              <option value="">{t('medical.unspecified')}</option>
              <option value="female">{t('medical.gender.female')}</option>
              <option value="male">{t('medical.gender.male')}</option>
            </Select>
          </Field>
        </div>
        <div className="medical-form__row">
          <Field label={t('medical.field.phone')} {...(errors.phone ? { error: errors.phone } : {})}>
            <Input value={phone} dir="ltr" inputMode="tel" maxLength={40} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label={t('medical.field.national_id')} {...(errors.national_id ? { error: errors.national_id } : {})}>
            <Input value={nationalId} dir="ltr" maxLength={30} onChange={(e) => setNationalId(e.target.value)} />
          </Field>
        </div>
        {canAssign ? (
          <Field
            label={t('medical.field.primary_doctor')}
            helper={t('medical.primary_doctor_help')}
            {...(errors.primary_doctor_id ? { error: errors.primary_doctor_id } : {})}
          >
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
        ) : null}
        <Field label={t('medical.field.file_notes')} helper={t('medical.file_notes_help')}>
          <Textarea value={notes} rows={3} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {errors.form ? <p className="medical-form__error" role="alert">{errors.form}</p> : null}
      </form>
    </Modal>
  );
}
