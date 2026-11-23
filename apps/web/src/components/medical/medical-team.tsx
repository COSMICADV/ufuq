'use client';

import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';
import { useCallback, useState } from 'react';

import { ApiError } from '../../lib/api-client';
import { CLINICAL_ROLES, loadMedicalMe, loadStaff, PERMISSION_GROUPS, saveStaff } from '../../lib/medical';
import type { ClinicalRole, Grant, MedicalPermission, MedicalScope, StaffList, StaffMember } from '../../lib/medical';
import { Badge, Button, Card, DataTable, Field, Input, Modal, Select } from '../design-system';
import { Cell, ErrorState, LoadingState, Ltr } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { DocumentCategories } from './document-categories';
import { MedicalPage, MedicalUnavailable } from './medical-parts';

function accessSummary(t: Translator, member: StaffMember): string {
  if (member.is_admin) return t('medical.team.full_access');
  if (member.permissions.length === 0) return t('medical.team.no_access');
  const all = member.permissions.filter((g) => g.scope === 'all').length;
  return all === member.permissions.length
    ? t('medical.team.summary_all', { count: String(member.permissions.length) })
    : t('medical.team.summary_mixed', { count: String(member.permissions.length) });
}

/** `/…/medical-team` — who is on the medical team, and what each one may open. */
export function MedicalTeam({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const loadMe = useCallback((signal: AbortSignal) => loadMedicalMe(locale, signal), [locale]);
  const me = useResource(loadMe);
  const allowed = me.state.status === 'ready' && me.state.value.enabled && me.state.value.permissions['staff.manage'] !== undefined;
  const load = useCallback((signal: AbortSignal) => (allowed ? loadStaff(locale, signal) : Promise.resolve(null)), [allowed, locale]);
  const staff = useResource(load);
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const title = t('medical.team.title');
  const crumbs = [{ label: title }];

  if (me.state.status === 'loading') return <MedicalPage t={t} crumbs={crumbs} title={title}><LoadingState t={t} rows={6} /></MedicalPage>;
  if (me.state.status === 'error') {
    return <MedicalPage t={t} crumbs={crumbs} title={title}><ErrorState t={t} error={me.state.error} onRetry={me.reload} /></MedicalPage>;
  }
  if (!allowed) {
    return (
      <MedicalPage t={t} crumbs={crumbs} title={title}>
        <MedicalUnavailable t={t} reason={me.state.value.enabled ? 'forbidden' : 'disabled'} />
      </MedicalPage>
    );
  }
  const list: StaffList | null = staff.state.status === 'ready' ? staff.state.value : null;
  const selfId = me.state.value.employee_id;
  const isAdmin = me.state.value.admin;

  return (
    <MedicalPage t={t} crumbs={crumbs} title={title} description={t('medical.team.help')}>
      {notice ? <p className="medical-notice" role="status">{notice}</p> : null}
      <p className="medical-callout">{t('medical.team.default_rule')}</p>
      {staff.state.status === 'loading' ? (
        <LoadingState t={t} rows={6} />
      ) : staff.state.status === 'error' ? (
        <ErrorState t={t} error={staff.state.error} onRetry={staff.reload} />
      ) : list ? (
        <Card className="employees-table medical-table">
          <DataTable
            headers={[t('medical.team.employee'), t('medical.team.role'), t('medical.team.access'), '']}
            rows={list.staff.map((member) => [
              <Cell key="name" label={t('medical.team.employee')}>
                <span className="person">
                  <span className="avatar" aria-hidden="true">{member.name.slice(0, 1)}</span>
                  <span>
                    {member.name}
                    <small className="medical-muted"> <Ltr>{member.employee_code}</Ltr></small>
                  </span>
                </span>
              </Cell>,
              <Cell key="role" label={t('medical.team.role')}>
                {member.clinical_role ? (
                  <span>
                    {t(`medical.role.${member.clinical_role}`)}
                    {member.specialty ? <span className="medical-muted"> · {member.specialty}</span> : null}
                  </span>
                ) : member.is_admin ? (
                  <Badge tone="info">{t('medical.team.admin')}</Badge>
                ) : (
                  <span className="medical-muted">{t('medical.team.not_on_team')}</span>
                )}
              </Cell>,
              <Cell key="access" label={t('medical.team.access')}>
                <span data-card="secondary">{accessSummary(t, member)}</span>
              </Cell>,
              <Cell key="edit" label="">
                {member.is_admin || (!isAdmin && member.id === selfId) ? null : (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(member)}>
                    {t('medical.team.edit')}
                  </Button>
                )}
              </Cell>,
            ])}
          />
        </Card>
      ) : null}
      {me.state.value.permissions['categories.manage'] ? <DocumentCategories locale={locale} /> : null}
      {editing && list ? (
        <StaffDialog
          locale={locale}
          member={editing}
          presets={list.presets}
          canGrantStaff={isAdmin}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            staff.reload();
            setNotice(t('medical.saved'));
          }}
        />
      ) : null}
    </MedicalPage>
  );
}

function StaffDialog({
  locale,
  member,
  presets,
  canGrantStaff,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly member: StaffMember;
  readonly presets: StaffList['presets'];
  readonly canGrantStaff: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const [role, setRole] = useState<ClinicalRole | ''>(member.clinical_role ?? '');
  const [specialty, setSpecialty] = useState(member.specialty ?? '');
  const [grants, setGrants] = useState<ReadonlyMap<MedicalPermission, MedicalScope>>(
    new Map(member.permissions.map((g) => [g.key, g.scope])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseRole = (next: ClinicalRole | ''): void => {
    setRole(next);
    // A new role proposes its usual access; nothing is granted until saved.
    setGrants(new Map(next ? presets[next].map(([key, scope]) => [key, scope] as const) : []));
  };
  const setOne = (key: MedicalPermission, scope: MedicalScope | ''): void => {
    const next = new Map(grants);
    if (scope) next.set(key, scope);
    else next.delete(key);
    setGrants(next);
  };
  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const permissions: Grant[] = role ? [...grants].map(([key, scope]) => ({ key, scope })) : [];
      await saveStaff(locale, member.id, {
        clinical_role: role || null,
        specialty: role ? specialty.trim() || null : null,
        permissions,
      });
      onSaved();
    } catch (failure) {
      setError(
        failure instanceof ApiError && Object.keys(failure.fields).length > 0
          ? t('medical.team.error_not_allowed')
          : t('medical.error.save'),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={t('medical.team.edit_title', { name: member.name })}
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
      <div className="medical-form">
        <div className="medical-form__row">
          <Field label={t('medical.team.role')}>
            <Select value={role} onChange={(e) => chooseRole(e.target.value as ClinicalRole | '')}>
              <option value="">{t('medical.team.not_on_team')}</option>
              {CLINICAL_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`medical.role.${r}`)}
                </option>
              ))}
            </Select>
          </Field>
          {role ? (
            <Field label={t('medical.team.specialty')}>
              <Input value={specialty} maxLength={80} onChange={(e) => setSpecialty(e.target.value)} />
            </Field>
          ) : null}
        </div>
        {role ? (
          <>
            <p className="medical-note">{t('medical.team.preset_help')}</p>
            <div className="medical-matrix">
              {PERMISSION_GROUPS.map(([group, keys]) => (
                <fieldset key={group}>
                  <legend>{t(`medical.team.group.${group}`)}</legend>
                  {keys.map((key) => {
                    const locked = key === 'staff.manage' && !canGrantStaff;
                    return (
                      <label key={key} className="medical-matrix__row">
                        <span>
                          {t(`medical.permission.${key.replace('.', '_')}`)}
                        </span>
                        <Select
                          value={grants.get(key) ?? ''}
                          disabled={locked}
                          onChange={(e) => setOne(key, e.target.value as MedicalScope | '')}
                        >
                          <option value="">{t('medical.scope.none')}</option>
                          {key === 'staff.manage' || key === 'categories.manage' ? null : (
                            <option value="assigned">{t('medical.scope.assigned')}</option>
                          )}
                          <option value="all">{t('medical.scope.all')}</option>
                        </Select>
                      </label>
                    );
                  })}
                </fieldset>
              ))}
            </div>
          </>
        ) : (
          <p className="medical-note">{t('medical.team.remove_help')}</p>
        )}
        {error ? <p className="medical-form__error" role="alert">{error}</p> : null}
      </div>
    </Modal>
  );
}
