'use client';

import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchOne, issueKeys } from '../../lib/api-client';
import {
  affectsFutureCalculations,
  CARRY_OVER_POLICIES,
  EMPTY_LEAVE_TYPE_FORM,
  formatDays,
  formFromLeaveType,
  leaveTypeBody,
  typeName,
  validateLeaveTypeForm,
} from '../../lib/leave';
import type { CarryOverPolicy, LeaveType, LeaveTypeForm } from '../../lib/leave';
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
  Toggle,
} from '../design-system';
import { loadSession } from '../employees/use-session';
import {
  Cell,
  describeError,
  ErrorState,
  LoadingState,
  optionalError,
  SuccessNotice,
} from '../settings/screen-states';
import { SettingsHeading } from '../settings/settings-shell';
import { useResource } from '../settings/use-resource';

/**
 * `/admin/settings/leave-types` — DOCUMENT 04 B25 ("Leave types: type name,
 * default allowance, paid/unpaid, requires attachment, carry-over rule"),
 * DOCUMENT 16.
 *
 * - The five seeded types start at a zero allowance; an ADMIN sets them here.
 * - **A change that shapes future balances is confirmed first** (allowance,
 *   paid/unpaid, negative balance, carry-over): balances written from now on
 *   use it; existing balances and decided leave are not rewritten.
 * - Retiring a type is a soft delete: it takes no new requests, and its
 *   history stays.
 * - `GET /leave-types?include_retired=true` lists retired types too, marked.
 */

type Editing = { readonly mode: 'create' } | { readonly mode: 'edit'; readonly type: LeaveType };

export function LeaveTypesSettings({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, types] = await Promise.all([
        loadSession(locale, signal),
        fetchOne<readonly LeaveType[]>('/leave-types', {
          locale,
          signal,
          query: { include_retired: 'true' },
        }),
      ]);
      return { session, types };
    },
    [locale],
  );
  const resource = useResource(load);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [form, setForm] = useState<LeaveTypeForm>(EMPTY_LEAVE_TYPE_FORM);
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<LeaveType | null>(null);
  const [retireError, setRetireError] = useState<string | null>(null);

  const heading = (
    <SettingsHeading title={t('settings.leave_types')} description={t('leave.types_description')} />
  );
  if (resource.state.status === 'loading') {
    return (
      <>
        {heading}
        <LoadingState t={t} rows={5} />
      </>
    );
  }
  if (resource.state.status === 'error') {
    return (
      <>
        {heading}
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      </>
    );
  }
  const { session, types } = resource.state.value;
  const canConfigure = session.permissions.has('leave.configure_types');

  const open = (next: Editing): void => {
    setEditing(next);
    setForm(next.mode === 'edit' ? formFromLeaveType(next.type) : EMPTY_LEAVE_TYPE_FORM);
    setIssues({});
    setFormError(null);
    setConfirming(false);
  };
  const set = (patch: Partial<LeaveTypeForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const save = (confirmed: boolean): void => {
    if (editing === null) return;
    const found = validateLeaveTypeForm(form);
    setIssues(found);
    if (Object.keys(found).length > 0) return;
    if (
      editing.mode === 'edit' &&
      !confirmed &&
      affectsFutureCalculations(formFromLeaveType(editing.type), form)
    ) {
      setConfirming(true);
      return;
    }
    setSaving(true);
    setFormError(null);
    fetchOne<LeaveType>(
      editing.mode === 'edit' ? `/leave-types/${editing.type.id}` : '/leave-types',
      {
        locale,
        method: editing.mode === 'edit' ? 'PATCH' : 'POST',
        body: leaveTypeBody(form),
      },
    )
      .then(() => {
        setEditing(null);
        setConfirming(false);
        setNotice(editing.mode === 'edit' ? t('leave.type_saved') : t('state.created'));
        resource.reload();
      })
      .catch((error: unknown) => {
        setConfirming(false);
        if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
          setIssues(issueKeys(error));
          setFormError(t('validation.generic'));
          return;
        }
        setFormError(describeError(error, t));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const retire = (): void => {
    if (retiring === null) return;
    setSaving(true);
    setRetireError(null);
    fetchOne<LeaveType>(`/leave-types/${retiring.id}`, { locale, method: 'DELETE' })
      .then(() => {
        setRetiring(null);
        setNotice(t('leave.type_retired'));
        resource.reload();
      })
      .catch((error: unknown) => {
        setRetireError(describeError(error, t));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const issue = (field: string): string | undefined =>
    issues[field] === undefined ? undefined : t(issues[field]);

  const headers = [
    t('leave.col_type'),
    t('leave.col_allowance'),
    t('leave.col_paid'),
    t('leave.col_attachment'),
    t('leave.col_carry_over'),
    t('leave.col_status'),
    '',
  ];

  return (
    <>
      {heading}
      <SuccessNotice message={notice} t={t} />
      {canConfigure ? (
        <div className="tasks-toolbar">
          <Button
            onClick={() => {
              open({ mode: 'create' });
            }}
          >
            {t('leave.new_type')}
          </Button>
        </div>
      ) : null}
      {types.length === 0 ? (
        <EmptyState
          title={t('leave.types_empty_title')}
          description={t('leave.types_empty')}
          action={null}
        />
      ) : (
        <Card className="tasks-table">
          <DataTable
            headers={headers}
            rows={types.map((type) => [
              <Cell key="name" label={headers[0] as string}>
                <span dir="auto">{typeName(type, locale)}</span>
              </Cell>,
              <Cell key="allowance" label={headers[1] as string}>
                <span dir="ltr">{formatDays(type.default_days_per_year)}</span>
              </Cell>,
              <Cell key="paid" label={headers[2] as string}>
                {type.is_paid ? t('leave.paid') : t('leave.unpaid')}
                {type.allows_negative_balance ? ` · ${t('leave.negative_allowed')}` : ''}
              </Cell>,
              <Cell key="attachment" label={headers[3] as string}>
                {type.requires_attachment ? t('leave.attachment_required') : '—'}
              </Cell>,
              <Cell key="carry" label={headers[4] as string}>
                <CarryOverLabel type={type} t={t} />
              </Cell>,
              <Cell key="status" label={headers[5] as string}>
                <Badge tone={type.is_active ? 'success' : 'cancelled'}>
                  {type.is_active ? t('leave.type_active') : t('leave.type_retired_label')}
                </Badge>
              </Cell>,
              <Cell key="actions" label="">
                {canConfigure && type.is_active ? (
                  <span className="tasks-card__chips">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        open({ mode: 'edit', type });
                      }}
                    >
                      {t('settings.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive-ghost"
                      onClick={() => {
                        setRetiring(type);
                        setRetireError(null);
                      }}
                    >
                      {t('leave.retire')}
                    </Button>
                  </span>
                ) : null}
              </Cell>,
            ])}
          />
        </Card>
      )}

      <Modal
        open={editing !== null}
        title={editing?.mode === 'edit' ? t('leave.edit_type') : t('leave.new_type')}
        closeLabel={t('action.close')}
        onClose={() => {
          setEditing(null);
        }}
        footer={
          <>
            <Button
              loading={saving}
              onClick={() => {
                save(confirming);
              }}
            >
              {confirming ? t('leave.confirm_save') : t('action.save')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setEditing(null);
              }}
            >
              {t('action.cancel')}
            </Button>
          </>
        }
      >
        <div className="tasks-form__grid">
          {formError === null ? null : (
            <Alert tone="danger" title={t('validation.generic_title')}>
              {formError}
            </Alert>
          )}
          {confirming ? (
            <Alert tone="warning" title={t('leave.future_title')}>
              {t('leave.future_warning')}
            </Alert>
          ) : null}
          <Field label={t('leave.name_ar')} required {...optionalError(issue('name_ar'))}>
            <Input
              dir="rtl"
              value={form.name_ar}
              maxLength={100}
              onChange={(event) => {
                set({ name_ar: event.target.value });
              }}
            />
          </Field>
          <Field label={t('leave.name_en')} required {...optionalError(issue('name_en'))}>
            <Input
              dir="ltr"
              value={form.name_en}
              maxLength={100}
              onChange={(event) => {
                set({ name_en: event.target.value });
              }}
            />
          </Field>
          <Field
            label={t('leave.col_allowance')}
            helper={t('leave.allowance_helper')}
            {...optionalError(issue('default_days_per_year'))}
          >
            <Input
              dir="ltr"
              inputMode="decimal"
              value={form.default_days_per_year}
              onChange={(event) => {
                set({ default_days_per_year: event.target.value });
              }}
            />
          </Field>
          <Toggle
            label={t('leave.paid')}
            checked={form.is_paid}
            onChange={(event) => {
              set({ is_paid: event.target.checked });
            }}
          />
          <Toggle
            label={t('leave.attachment_required')}
            checked={form.requires_attachment}
            onChange={(event) => {
              set({ requires_attachment: event.target.checked });
            }}
          />
          <Toggle
            label={t('leave.negative_allowed')}
            checked={form.allows_negative_balance}
            onChange={(event) => {
              set({ allows_negative_balance: event.target.checked });
            }}
          />
          <Field label={t('leave.col_carry_over')}>
            <Select
              value={form.carry_over_policy}
              onChange={(event) => {
                set({ carry_over_policy: event.target.value as CarryOverPolicy });
              }}
            >
              {CARRY_OVER_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {t(`leave.carry_${policy}`)}
                </option>
              ))}
            </Select>
          </Field>
          {form.carry_over_policy === 'capped' ? (
            <Field
              label={t('leave.carry_cap')}
              required
              {...optionalError(issue('carry_over_cap'))}
            >
              <Input
                dir="ltr"
                inputMode="decimal"
                value={form.carry_over_cap}
                onChange={(event) => {
                  set({ carry_over_cap: event.target.value });
                }}
              />
            </Field>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={retiring !== null}
        title={t('leave.retire_title')}
        closeLabel={t('action.close')}
        onClose={() => {
          setRetiring(null);
        }}
        footer={
          <>
            <Button variant="destructive" loading={saving} onClick={retire}>
              {t('leave.retire')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setRetiring(null);
              }}
            >
              {t('action.cancel')}
            </Button>
          </>
        }
      >
        {retireError === null ? null : (
          <Alert tone="danger" title={t('requests.action_failed')}>
            {retireError}
          </Alert>
        )}
        <p>
          {t('leave.retire_body', { name: retiring === null ? '' : typeName(retiring, locale) })}
        </p>
      </Modal>
    </>
  );
}

function CarryOverLabel({
  type,
  t,
}: {
  readonly type: LeaveType;
  readonly t: Translator;
}): React.JSX.Element {
  if (type.carry_over_policy === 'capped' && type.carry_over_cap !== null) {
    return <span>{t('leave.carry_capped_at', { days: formatDays(type.carry_over_cap) })}</span>;
  }
  return <span>{t(`leave.carry_${type.carry_over_policy}`)}</span>;
}
