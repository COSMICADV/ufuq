'use client';

import { createTranslator, normaliseDigits } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../../lib/api-client';
import { advanceVisit, checkIn, listPatients, loadMedicalMe, loadQueue, nextPatient, savePatient } from '../../lib/medical';
import type { MedicalMe, Patient, PersonRef, Queue, Visit } from '../../lib/medical';
import { BrandMark } from '../brand/brand-mark';
import { Button, Field, Input, Modal, Select } from '../design-system';
import { ErrorState, LoadingState, Ltr } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { day, MedicalPage, MedicalUnavailable, medicalBase, viewZone, VisitStatusBadge, when } from './medical-parts';
import type { Surface } from './medical-parts';

const REFRESH_MS = 20_000;

function minutesSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

function clock(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : locale, { hour: 'numeric', minute: '2-digit', timeZone: viewZone() }).format(
    new Date(iso),
  );
}

function QueueCard({
  t,
  locale,
  base,
  visit,
  now,
  canManage,
  onAction,
}: {
  readonly t: Translator;
  readonly locale: Locale;
  readonly base: string;
  readonly visit: Visit;
  readonly now: number;
  readonly canManage: boolean;
  readonly onAction: (visit: Visit, to: 'start' | 'finish' | 'no-show') => void;
}): React.JSX.Element {
  const waited = minutesSince(visit.checked_in_at, now);
  return (
    <li className="queue-card" data-status={visit.status}>
      <span className="queue-card__number" aria-label={t('medical.queue.number')}>
        {visit.queue_number ?? '—'}
      </span>
      <div className="queue-card__body">
        <Link href={`${base}/patients/${visit.patient.id}`} className="queue-card__name">
          {visit.patient.full_name}
        </Link>
        <span className="queue-card__meta">
          <Ltr>{visit.patient.file_number}</Ltr>
          {visit.doctor ? <span>{visit.doctor.name}</span> : null}
          {visit.status === 'waiting' && waited !== null ? <span>{t('medical.queue.waiting_for', { minutes: String(waited) })}</span> : null}
          {visit.status === 'scheduled' ? <span>{clock(visit.visit_at, locale)}</span> : null}
          {visit.status === 'completed' || visit.status === 'no_show' ? <VisitStatusBadge t={t} status={visit.status} /> : null}
        </span>
        {visit.reason ? <span className="queue-card__reason">{visit.reason}</span> : null}
      </div>
      {canManage ? (
        <div className="queue-card__actions">
          {visit.status === 'waiting' ? (
            <>
              <Button size="sm" onClick={() => onAction(visit, 'start')}>
                {t('medical.queue.call_in')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onAction(visit, 'no-show')}>
                {t('medical.queue.no_show')}
              </Button>
            </>
          ) : visit.status === 'in_progress' ? (
            <Button size="sm" variant="secondary" onClick={() => onAction(visit, 'finish')}>
              {t('medical.queue.finish')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The number slip: what reception hands the patient (prints on 58/80 mm paper). */
function Ticket({
  locale,
  visit,
  onClose,
}: {
  readonly locale: Locale;
  readonly visit: Visit;
  readonly onClose: () => void;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const print = (): void => {
    document.documentElement.classList.add('printing-ticket');
    const done = (): void => {
      document.documentElement.classList.remove('printing-ticket');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  };
  return (
    <Modal
      open
      title={t('medical.queue.checked_in')}
      onClose={onClose}
      closeLabel={t('medical.close')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('medical.close')}
          </Button>
          <Button onClick={print}>{t('medical.queue.print_ticket')}</Button>
        </>
      }
    >
      <div className="queue-ticket" role="group" aria-label={t('medical.queue.ticket')}>
        <BrandMark locale={locale} className="queue-ticket__brand" />
        <span className="queue-ticket__label">{t('medical.queue.your_number')}</span>
        <strong className="queue-ticket__number">{visit.queue_number}</strong>
        <span className="queue-ticket__doctor">{visit.doctor?.name}</span>
        <span>{visit.patient.full_name}</span>
        <span className="queue-ticket__time">{visit.checked_in_at ? when(visit.checked_in_at, locale) : null}</span>
      </div>
    </Modal>
  );
}

function CheckInDialog({
  locale,
  doctors,
  defaultDoctor,
  appointment,
  onClose,
  onDone,
}: {
  readonly locale: Locale;
  readonly doctors: readonly PersonRef[];
  readonly defaultDoctor: string | null;
  readonly appointment: Visit | null;
  readonly onClose: () => void;
  readonly onDone: (visit: Visit) => void;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const [mode, setMode] = useState<'find' | 'new'>('find');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly Patient[]>([]);
  const [patient, setPatient] = useState<Pick<Patient, 'id' | 'full_name' | 'file_number'> | null>(appointment ? appointment.patient : null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [doctor, setDoctor] = useState(appointment?.doctor?.id ?? defaultDoctor ?? doctors[0]?.id ?? '');
  const [reason, setReason] = useState(appointment?.reason ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'find' || patient || query.trim().length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const handle = window.setTimeout(() => {
      listPatients(locale, { q: query.trim(), mine: false, archived: false, page: 1 }, controller.signal).then(
        (r) => setResults(r.items.slice(0, 8)),
        () => setResults([]),
      );
    }, 250);
    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [locale, mode, patient, query]);

  const submit = async (): Promise<void> => {
    if (!doctor) {
      setError(t('medical.queue.error_doctor'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let target = patient;
      if (!target) {
        if (mode !== 'new' || name.trim().length < 2) {
          setError(t('medical.queue.error_patient'));
          setBusy(false);
          return;
        }
        target = await savePatient(locale, null, { full_name: name.trim(), phone: normaliseDigits(phone).trim() || null });
      }
      onDone(
        await checkIn(locale, {
          patient_id: target.id,
          doctor_id: doctor,
          ...(appointment ? { visit_id: appointment.id } : {}),
          reason: reason.trim() || null,
        }),
      );
    } catch (failure) {
      setBusy(false);
      const fields = failure instanceof ApiError ? failure.fields : {};
      setError(
        fields.patient_id?.includes('already_taken')
          ? t('medical.queue.error_already')
          : fields.patient
            ? t('medical.error.archived')
            : fields.phone
              ? t('medical.error.phone')
              : t('medical.error.save'),
      );
    }
  };

  return (
    <Modal
      open
      title={t('medical.queue.check_in')}
      onClose={busy ? () => undefined : onClose}
      closeLabel={t('medical.close')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('medical.cancel')}
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            {t('medical.queue.give_number')}
          </Button>
        </>
      }
    >
      <div className="medical-form">
        {patient ? (
          <p className="doc-target">
            <span>{t('medical.queue.patient')}</span>
            <strong>{patient.full_name}</strong>
            <Ltr>{patient.file_number}</Ltr>
            {appointment ? null : (
              <Button variant="ghost" size="sm" onClick={() => setPatient(null)}>
                {t('medical.queue.change')}
              </Button>
            )}
          </p>
        ) : (
          <>
            <div className="medical-toggles" role="group">
              <button type="button" className="medical-chip" aria-pressed={mode === 'find'} onClick={() => setMode('find')}>
                {t('medical.queue.existing')}
              </button>
              <button type="button" className="medical-chip" aria-pressed={mode === 'new'} onClick={() => setMode('new')}>
                {t('medical.queue.new_patient')}
              </button>
            </div>
            {mode === 'find' ? (
              <>
                <Field label={t('medical.search_label')}>
                  <Input type="search" value={query} placeholder={t('medical.search_placeholder')} onChange={(e) => setQuery(e.target.value)} autoFocus />
                </Field>
                {results.length > 0 ? (
                  <ul className="queue-results">
                    {results.map((r) => (
                      <li key={r.id}>
                        <button type="button" onClick={() => setPatient(r)}>
                          <strong>{r.full_name}</strong>
                          <span>
                            <Ltr>{r.file_number}</Ltr>
                            {r.phone ? (
                              <>
                                {' · '}
                                <Ltr>{r.phone}</Ltr>
                              </>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : query.trim().length >= 2 ? (
                  <p className="medical-muted">{t('medical.queue.no_results')}</p>
                ) : null}
              </>
            ) : (
              <div className="medical-form__row">
                <Field label={t('medical.field.full_name')} required>
                  <Input value={name} maxLength={160} onChange={(e) => setName(e.target.value)} autoFocus />
                </Field>
                <Field label={t('medical.field.phone')}>
                  <Input value={phone} dir="ltr" inputMode="tel" maxLength={40} onChange={(e) => setPhone(e.target.value)} />
                </Field>
              </div>
            )}
          </>
        )}
        <div className="medical-form__row">
          <Field label={t('medical.field.doctor')} required>
            <Select value={doctor} onChange={(e) => setDoctor(e.target.value)}>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.specialty ? ` — ${d.specialty}` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('medical.field.reason')}>
            <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
        {error ? (
          <p className="medical-form__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** `/…/queue` — reception's day: check-in and numbers; the doctor's queue and «next patient». */
export function ReceptionQueue({ locale, surface }: { readonly locale: Locale; readonly surface: Surface }): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const base = medicalBase(locale, surface);
  const loadMe = useCallback((signal: AbortSignal) => loadMedicalMe(locale, signal), [locale]);
  const me = useResource(loadMe);
  const access: MedicalMe | null = me.state.status === 'ready' ? me.state.value : null;
  const canView = access?.enabled === true && access.permissions['visits.view'] !== undefined;
  const [doctorFilter, setDoctorFilter] = useState<string | null>(null);
  const loadDay = useCallback(
    (signal: AbortSignal) => (canView ? loadQueue(locale, doctorFilter, signal) : Promise.resolve(null)),
    [canView, locale, doctorFilter],
  );
  const queue = useResource(loadDay);
  const [now, setNow] = useState(() => Date.now());
  const [checkingIn, setCheckingIn] = useState<Visit | 'walk-in' | null>(null);
  const [ticket, setTicket] = useState<Visit | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { refresh } = queue;

  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
      refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const title = t('medical.queue.title');
  const crumbs = [{ label: title }];
  if (me.state.status === 'loading') return <MedicalPage t={t} crumbs={crumbs} title={title}><LoadingState t={t} rows={6} /></MedicalPage>;
  if (me.state.status === 'error') {
    return <MedicalPage t={t} crumbs={crumbs} title={title}><ErrorState t={t} error={me.state.error} onRetry={me.reload} /></MedicalPage>;
  }
  if (!canView) {
    return (
      <MedicalPage t={t} crumbs={crumbs} title={title}>
        <MedicalUnavailable t={t} reason={access?.enabled ? 'forbidden' : 'disabled'} />
      </MedicalPage>
    );
  }

  const day0: Queue | null = queue.state.status === 'ready' ? queue.state.value : null;
  const canManage = access?.permissions['visits.manage'] !== undefined;
  const allDoctors = access?.permissions['visits.view'] === 'all';
  const isDoctor = day0?.doctors.some((d) => d.id === access?.employee_id) ?? false;
  const of = (status: Visit['status'][]): Visit[] => (day0?.visits ?? []).filter((v) => status.includes(v.status));
  const waiting = of(['waiting']);
  const inRoom = of(['in_progress']);
  const done = of(['completed', 'no_show']);
  const appointments = of(['scheduled']);

  const act = async (visit: Visit, to: 'start' | 'finish' | 'no-show'): Promise<void> => {
    try {
      await advanceVisit(locale, visit.id, to);
      queue.refresh();
      if (to === 'start' && isDoctor && visit.doctor?.id === access?.employee_id) router.push(`${base}/patients/${visit.patient.id}`);
    } catch {
      setNotice(t('medical.error.save'));
    }
  };
  const callNext = async (): Promise<void> => {
    try {
      const visit = await nextPatient(locale);
      if (!visit) {
        setNotice(t('medical.queue.nobody_waiting'));
        return;
      }
      router.push(`${base}/patients/${visit.patient.id}`);
    } catch {
      setNotice(t('medical.error.save'));
    }
  };

  const column = (key: string, list: readonly Visit[], empty: string): React.JSX.Element => (
    <section className="queue-column" aria-labelledby={`queue-${key}`}>
      <h2 id={`queue-${key}`}>
        {t(`medical.queue.column_${key}`)} <span className="queue-column__count">{list.length}</span>
      </h2>
      {list.length === 0 ? (
        <p className="medical-muted">{t(empty)}</p>
      ) : (
        <ul className="queue-list">
          {list.map((v) => (
            <QueueCard key={v.id} t={t} locale={locale} base={base} visit={v} now={now} canManage={canManage} onAction={(x, to) => void act(x, to)} />
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <MedicalPage
      t={t}
      crumbs={crumbs}
      title={title}
      {...(day0 ? { description: t('medical.queue.today', { date: day(day0.date, locale) }) } : {})}
      action={
        <div className="medical-actions">
          {isDoctor && canManage ? <Button onClick={() => void callNext()}>{t('medical.queue.next_patient')}</Button> : null}
          {day0?.can_check_in ? (
            <Button variant={isDoctor ? 'secondary' : 'primary'} onClick={() => setCheckingIn('walk-in')}>
              {t('medical.queue.check_in')}
            </Button>
          ) : null}
        </div>
      }
    >
      {notice ? (
        <p className="medical-notice" role="status">
          {notice}
        </p>
      ) : null}
      {allDoctors && day0 && day0.doctors.length > 1 ? (
        <div className="medical-toggles queue-doctors" role="group" aria-label={t('medical.queue.doctor_filter')}>
          <button type="button" className="medical-chip" aria-pressed={doctorFilter === null} onClick={() => setDoctorFilter(null)}>
            {t('medical.queue.all_doctors')}
          </button>
          {day0.doctors.map((d) => (
            <button key={d.id} type="button" className="medical-chip" aria-pressed={doctorFilter === d.id} onClick={() => setDoctorFilter(d.id)}>
              {d.name}
            </button>
          ))}
        </div>
      ) : null}
      {queue.state.status === 'loading' ? (
        <LoadingState t={t} rows={6} />
      ) : queue.state.status === 'error' ? (
        <ErrorState t={t} error={queue.state.error} onRetry={queue.reload} />
      ) : (
        <>
          <div className="queue-board">
            {column('waiting', waiting, 'medical.queue.empty_waiting')}
            {column('in_room', inRoom, 'medical.queue.empty_in_room')}
            {column('done', done, 'medical.queue.empty_done')}
          </div>
          {appointments.length > 0 ? (
            <section className="queue-appointments" aria-labelledby="queue-appointments">
              <h2 id="queue-appointments">{t('medical.queue.appointments')}</h2>
              <ul className="queue-list">
                {appointments.map((v) => (
                  <li key={v.id} className="queue-card" data-status="scheduled">
                    <span className="queue-card__number queue-card__number--time">{clock(v.visit_at, locale)}</span>
                    <div className="queue-card__body">
                      <Link href={`${base}/patients/${v.patient.id}`} className="queue-card__name">
                        {v.patient.full_name}
                      </Link>
                      <span className="queue-card__meta">
                        <Ltr>{v.patient.file_number}</Ltr>
                        {v.doctor ? <span>{v.doctor.name}</span> : null}
                      </span>
                    </div>
                    {day0?.can_check_in ? (
                      <div className="queue-card__actions">
                        <Button size="sm" variant="secondary" onClick={() => setCheckingIn(v)}>
                          {t('medical.queue.arrived')}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
      {checkingIn && day0 ? (
        <CheckInDialog
          locale={locale}
          doctors={day0.doctors}
          defaultDoctor={doctorFilter}
          appointment={checkingIn === 'walk-in' ? null : checkingIn}
          onClose={() => setCheckingIn(null)}
          onDone={(visit) => {
            setCheckingIn(null);
            setTicket(visit);
            queue.refresh();
          }}
        />
      ) : null}
      {ticket ? <Ticket locale={locale} visit={ticket} onClose={() => setTicket(null)} /> : null}
    </MedicalPage>
  );
}
