'use client';

import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';
import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../../lib/api-client';
import { ageFrom, loadPatient, loadPatientVisits, loadStaffOptions, setArchived, setCareTeam } from '../../lib/medical';
import type { PatientDetail, PersonRef, Visit } from '../../lib/medical';
import { Badge, Button, Card, EmptyState, Modal } from '../design-system';
import { ErrorState, LoadingState, Ltr } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { day, MedicalPage, medicalBase, personLabel, VisitStatusBadge, when } from './medical-parts';
import type { Surface } from './medical-parts';
import { PatientDialog } from './patient-dialog';
import { PatientDocuments } from './patient-documents';
import { VisitDialog } from './visit-dialog';

/** `/…/patients/:id` — the patient's file: data, care team and visits. */
export function PatientProfile({
  locale,
  surface,
  patientId,
}: {
  readonly locale: Locale;
  readonly surface: Surface;
  readonly patientId: string;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const base = medicalBase(locale, surface);
  const load = useCallback((signal: AbortSignal) => loadPatient(locale, patientId, signal), [locale, patientId]);
  const patient = useResource(load);
  const [staff, setStaff] = useState<readonly PersonRef[]>([]);
  const [editing, setEditing] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [visitDialog, setVisitDialog] = useState<Visit | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const value = patient.state.status === 'ready' ? patient.state.value : null;

  const loadVisits = useCallback(
    (signal: AbortSignal) => (value?.can.view_visits ? loadPatientVisits(locale, patientId, signal) : Promise.resolve([])),
    [value?.can.view_visits, locale, patientId],
  );
  const visits = useResource(loadVisits);

  useEffect(() => {
    if (!value || staff.length > 0) return;
    if (!(value.can.manage || value.can.manage_visits || value.can.assign)) return;
    loadStaffOptions(locale).then(setStaff, () => setStaff([]));
  }, [value, staff.length, locale]);

  const crumbs = [{ label: t('medical.patients'), href: `${base}/patients` }];
  if (patient.state.status === 'loading') {
    return <MedicalPage t={t} crumbs={crumbs} title={t('medical.patients')}><LoadingState t={t} rows={6} /></MedicalPage>;
  }
  if (patient.state.status === 'error') {
    const missing = patient.state.error instanceof ApiError && [403, 404].includes(patient.state.error.status);
    return (
      <MedicalPage t={t} crumbs={crumbs} title={t('medical.patients')}>
        {missing ? (
          <EmptyState title={t('medical.not_found_title')} description={t('medical.not_found_help')} action={null} />
        ) : (
          <ErrorState t={t} error={patient.state.error} onRetry={patient.reload} />
        )}
      </MedicalPage>
    );
  }
  const p = patient.state.value;
  const age = ageFrom(p.date_of_birth);

  const toggleArchive = async (): Promise<void> => {
    try {
      patient.replace(await setArchived(locale, p.id, !p.archived));
      setNotice(t(p.archived ? 'medical.restored' : 'medical.archived_done'));
    } catch {
      setNotice(t('medical.error.save'));
    }
  };

  return (
    <MedicalPage
      t={t}
      crumbs={[...crumbs, { label: p.full_name }]}
      title={p.full_name}
      action={
        p.can.manage ? (
          <div className="medical-actions">
            {!p.archived ? (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                {t('medical.edit_patient')}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => void toggleArchive()}>
              {t(p.archived ? 'medical.restore' : 'medical.archive')}
            </Button>
          </div>
        ) : undefined
      }
    >
      {notice ? (
        <p className="medical-notice" role="status">
          {notice}
        </p>
      ) : null}
      <section className="medical-summary" aria-label={t('medical.summary')}>
        <div>
          <span>{t('medical.column.file')}</span>
          <strong><Ltr>{p.file_number}</Ltr></strong>
        </div>
        <div>
          <span>{t('medical.column.age')}</span>
          <strong>{age === null ? '—' : t('medical.years', { count: String(age) })}</strong>
        </div>
        <div>
          <span>{t('medical.field.gender')}</span>
          <strong>{p.gender ? t(`medical.gender.${p.gender}`) : '—'}</strong>
        </div>
        <div>
          <span>{t('medical.field.primary_doctor')}</span>
          <strong>{p.primary_doctor?.name ?? t('medical.unassigned')}</strong>
        </div>
        {p.archived ? <Badge tone="cancelled">{t('medical.archived_badge')}</Badge> : null}
      </section>

      <div className="medical-grid">
        <Card title={t('medical.file_data')}>
          <dl className="medical-facts">
            <div>
              <dt>{t('medical.field.birth')}</dt>
              <dd>{p.date_of_birth ? day(p.date_of_birth, locale) : '—'}</dd>
            </div>
            <div>
              <dt>{t('medical.field.phone')}</dt>
              <dd>{p.phone ? <Ltr>{p.phone}</Ltr> : '—'}</dd>
            </div>
            <div>
              <dt>{t('medical.field.national_id')}</dt>
              <dd>{p.national_id ? <Ltr>{p.national_id}</Ltr> : '—'}</dd>
            </div>
            <div>
              <dt>{t('medical.field.file_notes')}</dt>
              <dd className="medical-pre">{p.notes ?? '—'}</dd>
            </div>
            <div>
              <dt>{t('medical.registered')}</dt>
              <dd>{when(p.created_at, locale)}</dd>
            </div>
          </dl>
        </Card>

        <Card
          title={t('medical.care_team')}
          action={
            p.can.assign && !p.archived ? (
              <Button variant="ghost" size="sm" onClick={() => setTeamOpen(true)}>
                {t('medical.edit_team')}
              </Button>
            ) : undefined
          }
        >
          <p className="medical-note">{t('medical.care_team_help')}</p>
          <ul className="medical-people">
            {p.primary_doctor ? (
              <li>
                <span>{personLabel(t, p.primary_doctor)}</span>
                <Badge tone="info">{t('medical.primary')}</Badge>
              </li>
            ) : null}
            {p.care_team.map((member) => (
              <li key={member.id}>
                <span>{personLabel(t, member)}</span>
              </li>
            ))}
            {!p.primary_doctor && p.care_team.length === 0 ? <li className="medical-muted">{t('medical.no_team')}</li> : null}
          </ul>
        </Card>
      </div>

      {p.can.view_visits ? (
        <Card
          className="medical-visits"
          title={t('medical.visits_count', { count: String(p.visit_count) })}
          action={
            p.can.manage_visits && !p.archived ? (
              <Button size="sm" onClick={() => setVisitDialog('new')}>
                {t('medical.add_visit')}
              </Button>
            ) : undefined
          }
        >
          {visits.state.status === 'loading' ? (
            <LoadingState t={t} rows={3} />
          ) : visits.state.status === 'error' ? (
            <ErrorState t={t} error={visits.state.error} onRetry={visits.reload} />
          ) : visits.state.value.length === 0 ? (
            <p className="medical-muted">{t('medical.no_visits')}</p>
          ) : (
            <ol className="medical-timeline">
              {visits.state.value.map((v) => (
                <li key={v.id}>
                  <div className="medical-timeline__head">
                    <strong>{when(v.visit_at, locale)}</strong>
                    <VisitStatusBadge t={t} status={v.status} />
                    {p.can.manage_visits && !p.archived ? (
                      <Button variant="ghost" size="sm" onClick={() => setVisitDialog(v)}>
                        {t('medical.edit')}
                      </Button>
                    ) : null}
                  </div>
                  <p>
                    {v.reason ?? t('medical.no_reason')}
                    {v.doctor ? <span className="medical-muted"> · {v.doctor.name}</span> : null}
                  </p>
                  {v.notes !== undefined ? (
                    v.notes ? <p className="medical-pre medical-clinical">{v.notes}</p> : null
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </Card>
      ) : null}

      {p.can.documents || p.can.labs || p.can.imaging || p.can.upload_documents ? (
        <PatientDocuments
          locale={locale}
          patient={p}
          visits={visits.state.status === 'ready' ? visits.state.value : []}
        />
      ) : null}

      {editing ? (
        <PatientDialog
          locale={locale}
          patient={p}
          doctors={staff}
          canAssign={p.can.assign}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            patient.replace(saved);
            setNotice(t('medical.saved'));
          }}
        />
      ) : null}
      {teamOpen ? (
        <CareTeamDialog
          locale={locale}
          patient={p}
          staff={staff}
          onClose={() => setTeamOpen(false)}
          onSaved={(saved) => {
            setTeamOpen(false);
            patient.replace(saved);
            setNotice(t('medical.saved'));
          }}
        />
      ) : null}
      {visitDialog ? (
        <VisitDialog
          locale={locale}
          patientId={p.id}
          visit={visitDialog === 'new' ? null : visitDialog}
          doctors={staff}
          clinical={p.can.clinical}
          defaultDoctor={p.primary_doctor?.id ?? null}
          onClose={() => setVisitDialog(null)}
          onSaved={() => {
            setVisitDialog(null);
            patient.refresh();
            visits.reload();
            setNotice(t('medical.saved'));
          }}
        />
      ) : null}
    </MedicalPage>
  );
}

function CareTeamDialog({
  locale,
  patient,
  staff,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly patient: PatientDetail;
  readonly staff: readonly PersonRef[];
  readonly onClose: () => void;
  readonly onSaved: (patient: PatientDetail) => void;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(patient.care_team.map((m) => m.id)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = staff.filter((s) => s.id !== patient.primary_doctor?.id);
  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await setCareTeam(locale, patient.id, [...chosen]));
    } catch {
      setError(t('medical.error.save'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      title={t('medical.edit_team')}
      onClose={onClose}
      closeLabel={t('medical.close')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('medical.cancel')}
          </Button>
          <Button loading={saving} onClick={() => void save()}>
            {t('medical.save')}
          </Button>
        </>
      }
    >
      <p className="medical-note">{t('medical.team_dialog_help')}</p>
      {candidates.length === 0 ? (
        <p className="medical-muted">{t('medical.no_staff')}</p>
      ) : (
        <ul className="medical-checklist">
          {candidates.map((s) => (
            <li key={s.id}>
              <label>
                <input
                  type="checkbox"
                  checked={chosen.has(s.id)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(s.id);
                    else next.delete(s.id);
                    setChosen(next);
                  }}
                />
                <span>{personLabel(t, s)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="medical-form__error" role="alert">{error}</p> : null}
    </Modal>
  );
}
