'use client';

import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../../lib/api-client';
import { ageFrom, listPatients, loadMedicalMe, loadStaffOptions } from '../../lib/medical';
import type { MedicalMe, PersonRef } from '../../lib/medical';
import { Badge, Button, Card, DataTable, EmptyState, Field, Input } from '../design-system';
import { Cell, ErrorState, LoadingState, Ltr } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { MedicalPage, MedicalUnavailable, medicalBase, when } from './medical-parts';
import type { Surface } from './medical-parts';
import { PatientDialog } from './patient-dialog';

/** `/admin/patients` and `/app/patients` — the patients this person may open, and nobody else. */
export function PatientsList({ locale, surface }: { readonly locale: Locale; readonly surface: Surface }): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const loadMe = useCallback((signal: AbortSignal) => loadMedicalMe(locale, signal), [locale]);
  const me = useResource(loadMe);
  const access: MedicalMe | null = me.state.status === 'ready' ? me.state.value : null;
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [mine, setMine] = useState(false);
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [doctors, setDoctors] = useState<readonly PersonRef[]>([]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 300);
    return () => {
      window.clearTimeout(handle);
    };
  }, [search]);

  const canView = access?.enabled === true && access.permissions['patients.view'] !== undefined;
  const loadList = useCallback(
    (signal: AbortSignal) =>
      canView ? listPatients(locale, { q: query, mine, archived, page }, signal) : Promise.resolve(null),
    [canView, locale, query, mine, archived, page],
  );
  const patients = useResource(loadList);
  const canManage = access?.permissions['patients.manage'] !== undefined;
  const canAssign = access?.permissions['patients.manage'] === 'all';
  const assignedOnly = access?.permissions['patients.view'] === 'assigned';

  useEffect(() => {
    if (!adding || doctors.length > 0) return;
    loadStaffOptions(locale).then(setDoctors, () => setDoctors([]));
  }, [adding, doctors.length, locale]);

  const base = medicalBase(locale, surface);
  const title = t('medical.patients');

  if (me.state.status === 'loading') return <MedicalPage t={t} crumbs={[{ label: title }]} title={title}><LoadingState t={t} rows={6} /></MedicalPage>;
  if (me.state.status === 'error') {
    return (
      <MedicalPage t={t} crumbs={[{ label: title }]} title={title}>
        <ErrorState t={t} error={me.state.error} onRetry={me.reload} />
      </MedicalPage>
    );
  }
  if (!access?.enabled || !canView) {
    return (
      <MedicalPage t={t} crumbs={[{ label: title }]} title={title}>
        <MedicalUnavailable t={t} reason={access?.enabled ? 'forbidden' : 'disabled'} />
      </MedicalPage>
    );
  }

  const add = canManage ? (
    <Button onClick={() => setAdding(true)}>{t('medical.add_patient')}</Button>
  ) : undefined;
  const result = patients.state.status === 'ready' ? patients.state.value : null;
  const filtered = query !== '' || mine || archived;

  return (
    <MedicalPage
      t={t}
      crumbs={[{ label: title }]}
      title={title}
      description={t(assignedOnly ? 'medical.patients_assigned_help' : 'medical.patients_help')}
      {...(add ? { action: add } : {})}
    >
      <section className="filter-bar medical-filters" aria-label={t('medical.filters')}>
        <div className="filter-bar__search">
          <Field label={t('medical.search_label')}>
            <Input
              type="search"
              value={search}
              maxLength={100}
              placeholder={t('medical.search_placeholder')}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
        </div>
        <div className="medical-toggles" role="group" aria-label={t('medical.filters')}>
          {!assignedOnly && access.employee_id ? (
            <button type="button" className="medical-chip" aria-pressed={mine} onClick={() => { setMine(!mine); setPage(1); }}>
              {t('medical.my_patients')}
            </button>
          ) : null}
          <button type="button" className="medical-chip" aria-pressed={archived} onClick={() => { setArchived(!archived); setPage(1); }}>
            {t('medical.archived')}
          </button>
        </div>
      </section>

      {patients.state.status === 'loading' ? (
        <LoadingState t={t} rows={8} />
      ) : patients.state.status === 'error' ? (
        patients.state.error instanceof ApiError && patients.state.error.status === 403 ? (
          <MedicalUnavailable t={t} reason="forbidden" />
        ) : (
          <ErrorState t={t} error={patients.state.error} onRetry={patients.reload} />
        )
      ) : !result || result.items.length === 0 ? (
        <EmptyState
          title={t(filtered ? 'medical.filtered_empty_title' : 'medical.empty_title')}
          description={t(filtered ? 'medical.filtered_empty_help' : assignedOnly ? 'medical.empty_assigned_help' : 'medical.empty_help')}
          action={filtered ? null : (add ?? null)}
        />
      ) : (
        <>
          <Card className="employees-table medical-table">
            <DataTable
              headers={[
                t('medical.column.patient'),
                t('medical.column.file'),
                t('medical.column.age'),
                t('medical.column.phone'),
                t('medical.column.doctor'),
                t('medical.column.last_visit'),
              ]}
              rows={result.items.map((row) => {
                const age = ageFrom(row.date_of_birth);
                return [
                  <Cell key="name" label={t('medical.column.patient')}>
                    <Link className="person" href={`${base}/patients/${row.id}`}>
                      <span className="avatar" aria-hidden="true">{row.full_name.trim().slice(0, 1)}</span>
                      <span>{row.full_name}</span>
                      {row.archived ? <Badge tone="cancelled">{t('medical.archived_badge')}</Badge> : null}
                    </Link>
                  </Cell>,
                  <Cell key="file" label={t('medical.column.file')}>
                    <span data-card="secondary"><Ltr>{row.file_number}</Ltr></span>
                  </Cell>,
                  <Cell key="age" label={t('medical.column.age')}>
                    {age === null ? '—' : t('medical.years', { count: String(age) })}
                  </Cell>,
                  <Cell key="phone" label={t('medical.column.phone')}>
                    {row.phone ? <Ltr>{row.phone}</Ltr> : '—'}
                  </Cell>,
                  <Cell key="doctor" label={t('medical.column.doctor')}>
                    {row.primary_doctor?.name ?? t('medical.unassigned')}
                  </Cell>,
                  <Cell key="visit" label={t('medical.column.last_visit')}>
                    <span data-card="secondary">{row.last_visit_at ? when(row.last_visit_at, locale) : '—'}</span>
                  </Cell>,
                ];
              })}
            />
          </Card>
          {result.meta.total_pages > 1 ? (
            <nav className="medical-pages" aria-label={t('medical.pages')}>
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                {t('medical.previous')}
              </Button>
              <span>{t('medical.page_of', { page: String(page), total: String(result.meta.total_pages) })}</span>
              <Button variant="ghost" size="sm" disabled={page >= result.meta.total_pages} onClick={() => setPage(page + 1)}>
                {t('medical.next')}
              </Button>
            </nav>
          ) : null}
        </>
      )}

      {adding ? (
        <PatientDialog
          locale={locale}
          patient={null}
          doctors={doctors}
          canAssign={canAssign}
          onClose={() => setAdding(false)}
          onSaved={(saved) => {
            setAdding(false);
            router.push(`${base}/patients/${saved.id}`);
          }}
        />
      ) : null}
    </MedicalPage>
  );
}
