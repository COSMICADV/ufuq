'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { createTranslator, formatDate } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import type { CollectionResult } from '../../lib/api-client';
import {
  activeFilterCount,
  apiQueryForListParams,
  clearedFilters,
  editEmployeePath,
  EMPLOYEE_SORTS,
  EMPLOYEE_STATUSES,
  employeePath,
  employeesPath,
  fullName,
  initials,
  listParamsFromSearch,
  newEmployeePath,
  searchForListParams,
  SORT_ORDERS,
  statusTone,
} from '../../lib/employees';
import type { EmployeeListParams, EmployeeView } from '../../lib/employees';
import { DEFAULT_PER_PAGE } from '../../lib/paging';
import {
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
import { Cell, ErrorState, LoadingState, Ltr, Pagination } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { EmployeesBreadcrumb, EmployeesHeading } from './employees-shell';
import { loadSession } from './use-session';
import type { SessionView } from './use-session';

/**
 * `/admin/employees` — DOCUMENT 04 B2, the List Screen Pattern.
 *
 * - Filters (department, position, status, manager), search and sort are the
 *   DOCUMENT 08 §4.3 set, and live in the URL (DOCUMENT 11 §6). DOCUMENT 04 B2
 *   also lists "work mode", which is an attendance field (Phase 6) that the
 *   employees API has no filter for, so it is not offered.
 * - Loading shows skeleton rows; an error replaces the table body and keeps
 *   the filters visible and populated; truly-empty and filtered-empty are
 *   different screens (DOCUMENT 04 "List Screen Pattern").
 * - Below 1024px the table becomes cards showing the fields that matter for
 *   scanning, not every column (DOCUMENT 22). On mobile the filters move into
 *   a sheet with an apply action.
 */

/** DOCUMENT 11 §8: search debounces at 300ms. */
const SEARCH_DEBOUNCE_MS = 300;
/** DOCUMENT 08 §1: `per_page` maximum — enough options for a filter select. */
const OPTIONS_PAGE_SIZE = '100';

interface Option {
  readonly id: string;
  readonly label: string;
}

interface FilterOptions {
  readonly departments: readonly Option[];
  readonly positions: readonly Option[];
  readonly managers: readonly Option[];
}

interface DepartmentOption {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string;
}

interface PositionOption {
  readonly id: string;
  readonly title_ar: string;
  readonly title_en: string;
}

const NO_OPTIONS: FilterOptions = { departments: [], positions: [], managers: [] };

async function optionsOrEmpty<T>(request: Promise<CollectionResult<T>>): Promise<readonly T[]> {
  // A caller who may list employees but not read settings (a MANAGER, whose
  // scope is their team) still gets a working list — just without the
  // reference-data filters their role cannot load.
  try {
    return (await request).items;
  } catch {
    return [];
  }
}

export function EmployeesList({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const pathname = usePathname() ?? employeesPath(locale);
  const searchParams = useSearchParams();
  const params = listParamsFromSearch(new URLSearchParams(searchParams?.toString() ?? ''));
  const query = searchForListParams(params);

  const navigate = useCallback(
    (next: EmployeeListParams) => {
      router.replace(`${pathname}${searchForListParams(next)}`, { scroll: false });
    },
    [pathname, router],
  );

  const loadEmployees = useCallback(
    (signal: AbortSignal) =>
      fetchMany<EmployeeView>('/employees', {
        locale,
        signal,
        query: apiQueryForListParams(
          listParamsFromSearch(new URLSearchParams(query.slice(1))),
          DEFAULT_PER_PAGE,
        ),
      }),
    [locale, query],
  );
  const employees = useResource<CollectionResult<EmployeeView>>(loadEmployees);

  const loadSessionView = useCallback(
    (signal: AbortSignal) => loadSession(locale, signal),
    [locale],
  );
  const session = useResource<SessionView>(loadSessionView);

  const loadOptions = useCallback(
    async (signal: AbortSignal): Promise<FilterOptions> => {
      const optionsQuery = { per_page: OPTIONS_PAGE_SIZE };
      const [departments, positions, managers] = await Promise.all([
        optionsOrEmpty(
          fetchMany<DepartmentOption>('/departments', { locale, signal, query: optionsQuery }),
        ),
        optionsOrEmpty(
          fetchMany<PositionOption>('/positions', { locale, signal, query: optionsQuery }),
        ),
        optionsOrEmpty(
          fetchMany<EmployeeView>('/employees', {
            locale,
            signal,
            query: { ...optionsQuery, sort: 'name' },
          }),
        ),
      ]);
      return {
        departments: departments.map((d) => ({
          id: d.id,
          label: locale === 'en' ? d.name_en : d.name_ar,
        })),
        positions: positions.map((p) => ({
          id: p.id,
          label: locale === 'en' ? p.title_en : p.title_ar,
        })),
        managers: managers.map((m) => ({ id: m.id, label: fullName(m) })),
      };
    },
    [locale],
  );
  const optionsResource = useResource<FilterOptions>(loadOptions);
  const options =
    optionsResource.state.status === 'ready' ? optionsResource.state.value : NO_OPTIONS;

  // The search box is typed into locally and applied after a pause, so each
  // keystroke is not a request (DOCUMENT 11 §8).
  const [searchDraft, setSearchDraft] = useState(params.search);
  useEffect(() => {
    setSearchDraft(params.search);
  }, [params.search]);
  useEffect(() => {
    if (searchDraft === params.search) {
      return;
    }
    const handle = window.setTimeout(() => {
      navigate({ ...params, search: searchDraft, page: 1 });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(handle);
    };
    // `params` is rebuilt every render; `query`, its serialised form, is the
    // dependency that actually changes when it does.
  }, [searchDraft, query, navigate]);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetDraft, setSheetDraft] = useState<EmployeeListParams>(params);

  const canCreate =
    session.state.status === 'ready' && session.state.value.permissions.has('employee.create');
  const canUpdate =
    session.state.status === 'ready' && session.state.value.permissions.has('employee.update');
  const filterCount = activeFilterCount(params);

  const addAction = canCreate ? (
    <Link className="button button--primary button--md" href={newEmployeePath(locale)}>
      {t('employees.add')}
    </Link>
  ) : undefined;

  const change = (patch: Partial<EmployeeListParams>): void => {
    navigate({ ...params, ...patch, page: 1 });
  };

  return (
    <>
      <EmployeesBreadcrumb label={t('employees.title')} items={[{ label: t('employees.title') }]} />
      <EmployeesHeading
        title={t('employees.title')}
        description={t('employees.description')}
        {...(addAction === undefined ? {} : { action: addAction })}
      />

      <section className="filter-bar" aria-label={t('employees.filters')}>
        <div className="filter-bar__search">
          <Field label={t('employees.search_label')}>
            <Input
              type="search"
              value={searchDraft}
              placeholder={t('employees.search_placeholder')}
              maxLength={100}
              onChange={(event) => {
                setSearchDraft(event.target.value);
              }}
            />
          </Field>
        </div>

        <div className="filter-bar__inline">
          <FilterFields t={t} value={params} options={options} onChange={change} />
        </div>

        <div className="filter-bar__toggle">
          <Button
            variant="secondary"
            onClick={() => {
              setSheetDraft(params);
              setSheetOpen(true);
            }}
          >
            {filterCount > 0
              ? t('employees.active_filters', { count: String(filterCount) })
              : t('employees.filters')}
          </Button>
        </div>

        {filterCount > 0 ? (
          <Button
            variant="ghost"
            onClick={() => {
              setSearchDraft('');
              navigate(clearedFilters(params));
            }}
          >
            {t('employees.clear_filters')}
          </Button>
        ) : null}
      </section>

      {employees.state.status === 'loading' ? (
        <LoadingState t={t} rows={8} />
      ) : employees.state.status === 'error' ? (
        <ErrorState error={employees.state.error} t={t} onRetry={employees.reload} />
      ) : employees.state.value.items.length === 0 ? (
        filterCount > 0 ? (
          <EmptyState
            title={t('employees.filtered_empty_title')}
            description={t('employees.filtered_empty_description')}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setSearchDraft('');
                  navigate(clearedFilters(params));
                }}
              >
                {t('employees.clear_filters')}
              </Button>
            }
          />
        ) : (
          <EmptyState
            title={t('employees.empty_title')}
            description={t('employees.empty_description')}
            action={addAction ?? null}
          />
        )
      ) : (
        <Card className="employees-table">
          <DataTable
            headers={[
              t('employees.column_name'),
              t('employees.column_code'),
              t('employees.column_department'),
              t('employees.column_position'),
              t('employees.column_manager'),
              t('employees.column_status'),
              t('employees.column_joining_date'),
              t('employees.column_actions'),
            ]}
            rows={employees.state.value.items.map((row) => [
              <Cell key="name" label={t('employees.column_name')}>
                <Link className="person" href={employeePath(locale, row.id)}>
                  <span className="avatar" aria-hidden="true">
                    {initials(row)}
                  </span>
                  <span>{fullName(row)}</span>
                </Link>
              </Cell>,
              <Cell key="code" label={t('employees.column_code')}>
                <span data-card="secondary">
                  <Ltr>{row.employee_code}</Ltr>
                </span>
              </Cell>,
              <Cell key="department" label={t('employees.column_department')}>
                {row.department === null
                  ? t('employees.none')
                  : locale === 'en'
                    ? row.department.name_en
                    : row.department.name_ar}
              </Cell>,
              <Cell key="position" label={t('employees.column_position')}>
                {row.position === null
                  ? t('employees.none')
                  : locale === 'en'
                    ? row.position.title_en
                    : row.position.title_ar}
              </Cell>,
              <Cell key="manager" label={t('employees.column_manager')}>
                <span data-card="secondary">
                  {row.manager === null ? t('employees.none') : fullName(row.manager)}
                </span>
              </Cell>,
              <Cell key="status" label={t('employees.column_status')}>
                <Badge tone={statusTone(row.status)}>{t(`employees.status_${row.status}`)}</Badge>
              </Cell>,
              <Cell key="joined" label={t('employees.column_joining_date')}>
                <Ltr>{calendarDate(row.joining_date, locale)}</Ltr>
              </Cell>,
              <Cell key="actions" label={t('employees.column_actions')}>
                <span className="row-actions">
                  <Link
                    className="button button--ghost button--sm"
                    href={employeePath(locale, row.id)}
                  >
                    {t('employees.view')}
                  </Link>
                  {canUpdate ? (
                    <Link
                      className="button button--ghost button--sm"
                      href={editEmployeePath(locale, row.id)}
                    >
                      {t('settings.edit')}
                    </Link>
                  ) : null}
                </span>
              </Cell>,
            ])}
          />
          <Pagination
            page={employees.state.value.meta.page}
            totalPages={employees.state.value.meta.total_pages}
            hrefForPage={(page) => `${pathname}${searchForListParams({ ...params, page })}`}
            t={t}
          />
        </Card>
      )}

      <Modal
        open={sheetOpen}
        title={t('employees.filters')}
        onClose={() => {
          setSheetOpen(false);
        }}
        closeLabel={t('action.close')}
        footer={
          <div className="settings-form__actions">
            <Button
              onClick={() => {
                setSheetOpen(false);
                navigate({ ...sheetDraft, search: params.search, page: 1 });
              }}
            >
              {t('employees.apply_filters')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setSheetOpen(false);
              }}
            >
              {t('action.cancel')}
            </Button>
          </div>
        }
      >
        <div className="settings-form">
          <FilterFields
            t={t}
            value={sheetDraft}
            options={options}
            onChange={(patch) => {
              setSheetDraft({ ...sheetDraft, ...patch });
            }}
          />
        </div>
      </Modal>
    </>
  );
}

/** A DATE is a calendar day, so it is formatted as one — in UTC, never shifted by a zone. */
function calendarDate(value: string, locale: Locale): string {
  return formatDate(new Date(`${value}T00:00:00.000Z`), { locale, timeZone: 'UTC' });
}

function FilterFields({
  t,
  value,
  options,
  onChange,
}: {
  readonly t: Translator;
  readonly value: EmployeeListParams;
  readonly options: FilterOptions;
  readonly onChange: (patch: Partial<EmployeeListParams>) => void;
}): React.JSX.Element {
  return (
    <>
      {options.departments.length > 0 || value.department_id !== '' ? (
        <Field label={t('employees.department')}>
          <Select
            value={value.department_id}
            onChange={(event) => {
              onChange({ department_id: event.target.value });
            }}
          >
            <option value="">{t('employees.all')}</option>
            {options.departments.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {options.positions.length > 0 || value.position_id !== '' ? (
        <Field label={t('employees.position')}>
          <Select
            value={value.position_id}
            onChange={(event) => {
              onChange({ position_id: event.target.value });
            }}
          >
            <option value="">{t('employees.all')}</option>
            {options.positions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <Field label={t('employees.column_status')}>
        <Select
          value={value.status}
          onChange={(event) => {
            onChange({ status: event.target.value as EmployeeListParams['status'] });
          }}
        >
          <option value="">{t('employees.all')}</option>
          {EMPLOYEE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(`employees.status_${status}`)}
            </option>
          ))}
        </Select>
      </Field>

      {options.managers.length > 0 || value.manager_id !== '' ? (
        <Field label={t('employees.manager')}>
          <Select
            value={value.manager_id}
            onChange={(event) => {
              onChange({ manager_id: event.target.value });
            }}
          >
            <option value="">{t('employees.all')}</option>
            {options.managers.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <Field label={t('employees.sort')}>
        <Select
          value={value.sort}
          onChange={(event) => {
            onChange({ sort: event.target.value as EmployeeListParams['sort'] });
          }}
        >
          {EMPLOYEE_SORTS.map((sort) => (
            <option key={sort} value={sort}>
              {t(`employees.sort_${sort}`)}
            </option>
          ))}
        </Select>
      </Field>

      <Field label={t('employees.order')}>
        <Select
          value={value.order}
          onChange={(event) => {
            onChange({ order: event.target.value as EmployeeListParams['order'] });
          }}
        >
          {SORT_ORDERS.map((order) => (
            <option key={order} value={order}>
              {t(`employees.order_${order}`)}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
}
