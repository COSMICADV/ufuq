'use client';

import { useCallback, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ApiError, fetchMany, issueKeys, sendNoContent, fetchOne } from '../../lib/api-client';
import type { CollectionResult } from '../../lib/api-client';
import { fullName } from '../../lib/employees';
import { DEFAULT_PER_PAGE, pageFromParams, withPage } from '../../lib/paging';
import {
  Alert,
  Badge,
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
 * `/admin/settings/departments` — DOCUMENT 04 B25 ("CRUD list; deletion
 * blocked while employees are assigned"), DOCUMENT 08 §4.2.
 *
 * All four states (DOCUMENT 11 §2): skeleton rows while loading, an empty
 * state that offers the action which resolves it, an error card with retry,
 * and a success notice in a live region. Removal is destructive, so it asks
 * first and the confirmation can be cancelled (DOCUMENT 26 §9).
 *
 * The page number lives in the URL (DOCUMENT 11 §6), so a page survives a
 * refresh and can be linked to.
 *
 * Phase 5 adds the department manager (DOCUMENT 06 §3.4
 * `manager_employee_id`), chosen from the company's active employees.
 */

const PAGE_KEY = 'page';
/** DOCUMENT 08 §1: `per_page` maximum — enough options for a select. */
const MANAGER_OPTIONS_PAGE_SIZE = '100';

interface DepartmentPayload {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string;
  readonly parent_id: string | null;
  readonly manager_employee_id: string | null;
  readonly status: string;
}

interface ManagerOption {
  readonly id: string;
  readonly first_name: string;
  readonly last_name: string;
}

interface DepartmentForm {
  name_ar: string;
  name_en: string;
  parent_id: string;
  manager_employee_id: string;
  status: string;
}

const EMPTY_FORM: DepartmentForm = {
  name_ar: '',
  name_en: '',
  parent_id: '',
  manager_employee_id: '',
  status: 'active',
};

type Editing = { readonly mode: 'create' } | { readonly mode: 'edit'; readonly id: string };

export function DepartmentsSettings({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams?.toString() ?? '');
  const page = pageFromParams(params, PAGE_KEY);

  const load = useCallback(
    (signal: AbortSignal) =>
      fetchMany<DepartmentPayload>('/departments', {
        locale,
        signal,
        query: { page: String(page), per_page: String(DEFAULT_PER_PAGE) },
      }),
    [locale, page],
  );
  const { state, reload } = useResource<CollectionResult<DepartmentPayload>>(load);

  // The manager options are secondary to this screen: if they cannot be
  // loaded, departments still list and save, and the select offers "None".
  const loadManagers = useCallback(
    async (signal: AbortSignal): Promise<readonly ManagerOption[]> => {
      try {
        const result = await fetchMany<ManagerOption>('/employees', {
          locale,
          signal,
          query: { per_page: MANAGER_OPTIONS_PAGE_SIZE, status: 'active', sort: 'name' },
        });
        return result.items;
      } catch {
        return [];
      }
    },
    [locale],
  );
  const managers = useResource<readonly ManagerOption[]>(loadManagers);
  const managerOptions = managers.state.status === 'ready' ? managers.state.value : [];

  const [editing, setEditing] = useState<Editing | null>(null);
  const [form, setForm] = useState<DepartmentForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<DepartmentPayload | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const heading = (
    <SettingsHeading
      title={t('settings.departments')}
      description={t('settings.departments_description')}
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

  const { items, meta } = state.value;
  const nameOf = (id: string | null): string => {
    if (id === null) {
      return t('settings.none');
    }
    const parent = items.find((row) => row.id === id);
    // A parent on another page is not in `items`; showing "—" would be a lie,
    // so the screen says nothing rather than something wrong.
    return parent ? parent.name_ar : '…';
  };
  const managerNameOf = (id: string | null): string => {
    if (id === null) {
      return t('settings.none');
    }
    const manager = managerOptions.find((option) => option.id === id);
    return manager ? fullName(manager) : '…';
  };

  const openCreate = (): void => {
    setEditing({ mode: 'create' });
    setForm(EMPTY_FORM);
    setFieldIssues({});
    setFormError(null);
    setNotice(null);
  };

  const openEdit = (row: DepartmentPayload): void => {
    setEditing({ mode: 'edit', id: row.id });
    setForm({
      name_ar: row.name_ar,
      name_en: row.name_en,
      parent_id: row.parent_id ?? '',
      manager_employee_id: row.manager_employee_id ?? '',
      status: row.status,
    });
    setFieldIssues({});
    setFormError(null);
    setNotice(null);
  };

  const close = (): void => {
    setEditing(null);
    setFieldIssues({});
    setFormError(null);
  };

  const issueFor = (field: string): string | undefined => {
    const key = fieldIssues[field];
    return key === undefined ? undefined : t(key);
  };

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (editing === null) {
      return;
    }
    setSaving(true);
    setFieldIssues({});
    setFormError(null);

    const body = {
      name_ar: form.name_ar,
      name_en: form.name_en,
      // An empty select means "top level" / "no manager" — an explicit null,
      // not an omission.
      parent_id: form.parent_id === '' ? null : form.parent_id,
      manager_employee_id: form.manager_employee_id === '' ? null : form.manager_employee_id,
      status: form.status,
    };

    const request =
      editing.mode === 'create'
        ? fetchOne<DepartmentPayload>('/departments', { locale, method: 'POST', body })
        : fetchOne<DepartmentPayload>(`/departments/${editing.id}`, {
            locale,
            method: 'PATCH',
            body,
          });

    request
      .then(() => {
        setEditing(null);
        setNotice(editing.mode === 'create' ? t('state.created') : t('state.success'));
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

  const confirmRemove = (): void => {
    if (removing === null) {
      return;
    }
    setSaving(true);
    setRemoveError(null);

    sendNoContent(`/departments/${removing.id}`, { locale, method: 'DELETE' })
      .then(() => {
        setRemoving(null);
        setNotice(t('state.deleted'));
        reload();
      })
      .catch((error: unknown) => {
        setRemoveError(describeError(error, t));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const goToPage = (next: number): string => `${pathname ?? ''}${withPage(params, PAGE_KEY, next)}`;

  const addButton = <Button onClick={openCreate}>{t('settings.add_department')}</Button>;

  return (
    <>
      {heading}
      <SuccessNotice message={notice} t={t} />

      {items.length === 0 ? (
        <EmptyState
          title={t('settings.no_departments')}
          description={t('settings.no_departments_description')}
          action={addButton}
        />
      ) : (
        <Card title={t('settings.departments')} action={addButton}>
          <DataTable
            headers={[
              t('settings.name_ar'),
              t('settings.name_en'),
              t('settings.parent'),
              t('settings.department_manager'),
              t('settings.status'),
              t('settings.actions'),
            ]}
            rows={items.map((row) => [
              <Cell key="ar" label={t('settings.name_ar')}>
                {row.name_ar}
              </Cell>,
              <Cell key="en" label={t('settings.name_en')}>
                {row.name_en}
              </Cell>,
              <Cell key="parent" label={t('settings.parent')}>
                {nameOf(row.parent_id)}
              </Cell>,
              <Cell key="manager" label={t('settings.department_manager')}>
                {managerNameOf(row.manager_employee_id)}
              </Cell>,
              <Cell key="status" label={t('settings.status')}>
                {/* Colour is never the only carrier of meaning — the chip
                    always includes its text (DOCUMENT 11 §10). */}
                <Badge tone={row.status === 'active' ? 'success' : 'cancelled'}>
                  {t(`settings.status_${row.status}`)}
                </Badge>
              </Cell>,
              <Cell key="actions" label={t('settings.actions')}>
                <span className="row-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      openEdit(row);
                    }}
                  >
                    {t('settings.edit')}
                  </Button>
                  <Button
                    variant="destructive-ghost"
                    size="sm"
                    onClick={() => {
                      setRemoving(row);
                      setRemoveError(null);
                      setNotice(null);
                    }}
                  >
                    {t('action.delete')}
                  </Button>
                </span>
              </Cell>,
            ])}
          />
          <Pagination page={meta.page} totalPages={meta.total_pages} hrefForPage={goToPage} t={t} />
        </Card>
      )}

      <Modal
        open={editing !== null}
        title={
          editing?.mode === 'edit' ? t('settings.edit_department') : t('settings.add_department')
        }
        onClose={close}
        closeLabel={t('action.close')}
      >
        <form className="settings-form" onSubmit={submit} noValidate id="department-form">
          {formError === null ? null : (
            <div className="settings-form__summary">
              <Alert tone="danger" title={t('validation.generic_title')}>
                {formError}
              </Alert>
            </div>
          )}

          <Field label={t('settings.name_ar')} required {...optionalError(issueFor('name_ar'))}>
            <Input
              value={form.name_ar}
              onChange={(event) => {
                setForm({ ...form, name_ar: event.target.value });
              }}
              maxLength={200}
              required
            />
          </Field>

          <Field label={t('settings.name_en')} required {...optionalError(issueFor('name_en'))}>
            <Input
              value={form.name_en}
              onChange={(event) => {
                setForm({ ...form, name_en: event.target.value });
              }}
              maxLength={200}
              required
            />
          </Field>

          <Field label={t('settings.parent')} {...optionalError(issueFor('parent_id'))}>
            <Select
              value={form.parent_id}
              onChange={(event) => {
                setForm({ ...form, parent_id: event.target.value });
              }}
            >
              <option value="">{t('settings.none')}</option>
              {items
                .filter((candidate) => editing?.mode !== 'edit' || candidate.id !== editing.id)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name_ar}
                  </option>
                ))}
            </Select>
          </Field>

          <Field
            label={t('settings.department_manager')}
            {...optionalError(issueFor('manager_employee_id'))}
          >
            <Select
              value={form.manager_employee_id}
              onChange={(event) => {
                setForm({ ...form, manager_employee_id: event.target.value });
              }}
            >
              <option value="">{t('settings.none')}</option>
              {managerOptions.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {fullName(candidate)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('settings.status')} required {...optionalError(issueFor('status'))}>
            <Select
              value={form.status}
              onChange={(event) => {
                setForm({ ...form, status: event.target.value });
              }}
            >
              <option value="active">{t('settings.status_active')}</option>
              <option value="inactive">{t('settings.status_inactive')}</option>
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

      <Modal
        open={removing !== null}
        title={t('settings.delete_department')}
        onClose={() => {
          setRemoving(null);
        }}
        closeLabel={t('action.close')}
        footer={
          <div className="settings-form__actions">
            <Button variant="destructive" loading={saving} onClick={confirmRemove}>
              {t('action.confirm')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setRemoving(null);
              }}
            >
              {t('action.cancel')}
            </Button>
          </div>
        }
      >
        <p>
          {removing === null
            ? ''
            : t('settings.delete_department_confirm', { name: removing.name_ar })}
        </p>
        {removeError === null ? null : (
          /* Not a validation summary — nothing in this dialog is a field.
             The title names the outcome and the body says what to do next
             (DOCUMENT 11 §11). */
          <Alert tone="danger" title={t('state.action_blocked')}>
            {removeError}
          </Alert>
        )}
      </Modal>
    </>
  );
}
