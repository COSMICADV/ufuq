'use client';

import { useCallback, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ApiError, fetchMany, fetchOne, issueKeys } from '../../lib/api-client';
import type { CollectionResult } from '../../lib/api-client';
import { DEFAULT_PER_PAGE, pageFromParams, withPage } from '../../lib/paging';
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
} from '../design-system';
import {
  Cell,
  describeError,
  ErrorState,
  LoadingState,
  optionalError,
  Pagination,
  SuccessNotice,
} from './screen-states';
import { SettingsHeading } from './settings-shell';
import { useResource } from './use-resource';

/**
 * `/admin/settings/positions` — DOCUMENT 08 §4.2, DOCUMENT 06 §3.5.
 *
 * List and create. DOCUMENT 08 §4.2 defines no `PATCH` or `DELETE` for this
 * resource, so this screen offers neither: a row action that produced a 404
 * would be worse than its absence. DOCUMENT 04 B25 describes the screen as a
 * "CRUD list" instead, and that disagreement is recorded in
 * docs/PHASE-4-STATUS.md rather than resolved here (DOCUMENT 27 RULES 2, 35).
 */

const PAGE_KEY = 'page';

interface PositionPayload {
  readonly id: string;
  readonly title_ar: string;
  readonly title_en: string;
  readonly department_id: string | null;
}

interface DepartmentOption {
  readonly id: string;
  readonly name_ar: string;
}

interface PositionForm {
  title_ar: string;
  title_en: string;
  department_id: string;
}

const EMPTY_FORM: PositionForm = { title_ar: '', title_en: '', department_id: '' };

interface ScreenData {
  readonly positions: CollectionResult<PositionPayload>;
  readonly departments: readonly DepartmentOption[];
}

export function PositionsSettings({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams?.toString() ?? '');
  const page = pageFromParams(params, PAGE_KEY);

  const load = useCallback(
    async (signal: AbortSignal): Promise<ScreenData> => {
      // Both requests together: a position's department is a name, not an id,
      // and half a screen is not a state DOCUMENT 11 §2 has a design for.
      const [positions, departments] = await Promise.all([
        fetchMany<PositionPayload>('/positions', {
          locale,
          signal,
          query: { page: String(page), per_page: String(DEFAULT_PER_PAGE) },
        }),
        fetchMany<DepartmentOption>('/departments', {
          locale,
          signal,
          query: { page: '1', per_page: '100' },
        }),
      ]);
      return { positions, departments: departments.items };
    },
    [locale, page],
  );
  const { state, reload } = useResource<ScreenData>(load);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<PositionForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const heading = (
    <SettingsHeading
      title={t('settings.positions')}
      description={t('settings.positions_description')}
    />
  );

  if (state.status === 'loading') {
    return (
      <>
        {heading}
        <LoadingState t={t} rows={5} />
      </>
    );
  }

  if (state.status === 'error') {
    return (
      <>
        {heading}
        <ErrorState error={state.error} t={t} onRetry={reload} />
      </>
    );
  }

  const { positions, departments } = state.value;

  const departmentName = (id: string | null): string => {
    if (id === null) {
      return t('settings.none');
    }
    return departments.find((row) => row.id === id)?.name_ar ?? '…';
  };

  const issueFor = (field: string): string | undefined => {
    const key = fieldIssues[field];
    return key === undefined ? undefined : t(key);
  };

  const open = (): void => {
    setCreating(true);
    setForm(EMPTY_FORM);
    setFieldIssues({});
    setFormError(null);
    setNotice(null);
  };

  const close = (): void => {
    setCreating(false);
    setFieldIssues({});
    setFormError(null);
  };

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSaving(true);
    setFieldIssues({});
    setFormError(null);

    fetchOne<PositionPayload>('/positions', {
      locale,
      method: 'POST',
      body: {
        title_ar: form.title_ar,
        title_en: form.title_en,
        department_id: form.department_id === '' ? null : form.department_id,
      },
    })
      .then(() => {
        setCreating(false);
        setNotice(t('state.created'));
        reload();
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
          setFieldIssues(issueKeys(error));
          setFormError(t('validation.generic'));
          return;
        }
        setFormError(describeError(error, t));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const goToPage = (next: number): string => `${pathname ?? ''}${withPage(params, PAGE_KEY, next)}`;
  const addButton = <Button onClick={open}>{t('settings.add_position')}</Button>;

  return (
    <>
      {heading}
      <SuccessNotice message={notice} t={t} />

      {positions.items.length === 0 ? (
        <EmptyState
          title={t('settings.no_positions')}
          description={t('settings.no_positions_description')}
          action={addButton}
        />
      ) : (
        <Card title={t('settings.positions')} action={addButton}>
          <DataTable
            headers={[t('settings.title_ar'), t('settings.title_en'), t('settings.department')]}
            rows={positions.items.map((row) => [
              <Cell key="ar" label={t('settings.title_ar')}>
                {row.title_ar}
              </Cell>,
              <Cell key="en" label={t('settings.title_en')}>
                {row.title_en}
              </Cell>,
              <Cell key="dept" label={t('settings.department')}>
                {departmentName(row.department_id)}
              </Cell>,
            ])}
          />
          <Pagination
            page={positions.meta.page}
            totalPages={positions.meta.total_pages}
            hrefForPage={goToPage}
            t={t}
          />
        </Card>
      )}

      <Modal
        open={creating}
        title={t('settings.add_position')}
        onClose={close}
        closeLabel={t('action.close')}
      >
        <form className="settings-form" onSubmit={submit} noValidate>
          {formError === null ? null : (
            <div className="settings-form__summary">
              <Alert tone="danger" title={t('validation.generic_title')}>
                {formError}
              </Alert>
            </div>
          )}

          <Field label={t('settings.title_ar')} required {...optionalError(issueFor('title_ar'))}>
            <Input
              value={form.title_ar}
              onChange={(event) => {
                setForm({ ...form, title_ar: event.target.value });
              }}
              maxLength={200}
              required
            />
          </Field>

          <Field label={t('settings.title_en')} required {...optionalError(issueFor('title_en'))}>
            <Input
              value={form.title_en}
              onChange={(event) => {
                setForm({ ...form, title_en: event.target.value });
              }}
              maxLength={200}
              required
            />
          </Field>

          <Field label={t('settings.department')} {...optionalError(issueFor('department_id'))}>
            <Select
              value={form.department_id}
              onChange={(event) => {
                setForm({ ...form, department_id: event.target.value });
              }}
            >
              <option value="">{t('settings.none')}</option>
              {departments.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name_ar}
                </option>
              ))}
            </Select>
          </Field>

          <div className="settings-form__actions">
            <Button type="submit" loading={saving}>
              {saving ? t('state.saving') : t('action.save')}
            </Button>
            <Button type="button" variant="ghost" onClick={close}>
              {t('action.cancel')}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
