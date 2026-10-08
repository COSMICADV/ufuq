/**
 * The audit log screen's pure half — DOCUMENT 21 "UI", DOCUMENT 08 §4.16.
 *
 * Kept free of React so the rules that are easy to get subtly wrong — which
 * filters survive in the URL, what is sent to the API, how a change is laid
 * out field by field — are tested directly.
 */

/** `GET /audit-logs` and `/audit-logs/entity/{type}/{id}` item — see `apps/api/src/audit`. */
export interface AuditEntry {
  readonly id: string;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly actor: {
    readonly id: string;
    readonly name: string | null;
    readonly email: string;
    readonly is_system: boolean;
  };
  readonly old_values: unknown;
  readonly new_values: unknown;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
  readonly created_at: string;
}

/**
 * Every action the product records today, as DOCUMENT 21 spells it — the
 * options of the action filter, and the keys `audit.action.*` translates.
 * Later phases add to both together.
 */
export const AUDIT_ACTIONS = [
  'login.success',
  'login.failed',
  'login.locked',
  'logout',
  'password.changed',
  'password.reset_requested',
  'password.reset_completed',
  'invitation.sent',
  'invitation.accepted',
  'session.revoked',
  'permission.denied',
  'tenancy.violation_attempt',
  'settings.company_updated',
  'settings.schedule_changed',
  'employee.created',
  'employee.updated',
  'employee.deactivated',
  'employee.activated',
  'employee.manager_changed',
  'employee.department_changed',
  'employee.role_changed',
  'attendance.checked_in',
  'attendance.checked_out',
  'attendance.adjusted_by_admin',
  'attendance.correction_requested',
  'attendance.correction_approved',
  'attendance.correction_rejected',
  'attendance.generated_by_system',
  'task.created',
  'task.updated',
  'task.reassigned',
  'task.deadline_changed',
  'task.status_changed',
  'task.cancelled',
  'task.deleted',
  'task.reopened',
  'checklist.item_added',
  'checklist.item_deleted',
  'attachment.uploaded',
  'attachment.deleted',
  'attachment.accessed',
  'goal.created',
  'goal.updated',
  'goal.progress_updated',
  'goal.target_changed',
  'goal.cancelled',
  'settings.performance_weights_changed',
  'request.submitted',
  'request.approved',
  'request.rejected',
  'request.cancelled',
] as const;

/** The record kinds the product audits today — the entity-type filter's options. */
export const AUDIT_ENTITY_TYPES = [
  'user',
  'session',
  'company',
  'work_schedule',
  'holiday',
  'employee',
  'attendance_record',
  'attendance_correction_request',
  'task',
  'attachment',
  'goal',
  'performance_config',
  'request',
] as const;

/** Translation key for an action — dots are the catalogue's path separator. */
export function actionKey(action: string): string {
  return `audit.action.${action.replace(/\./g, '__')}`;
}

export function entityTypeKey(type: string): string {
  return `audit.entity.${type}`;
}

export function isKnownAction(action: string): boolean {
  return (AUDIT_ACTIONS as readonly string[]).includes(action);
}

export function isKnownEntityType(type: string): boolean {
  return (AUDIT_ENTITY_TYPES as readonly string[]).includes(type);
}

/** The documented filters (DOCUMENT 21 "API requirements"), as held in the URL. */
export interface AuditFilters {
  readonly user_id: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly action: string;
  readonly from: string;
  readonly to: string;
}

export const FILTER_KEYS = ['user_id', 'entity_type', 'entity_id', 'action', 'from', 'to'] as const;

export const EMPTY_FILTERS: AuditFilters = {
  user_id: '',
  entity_type: '',
  entity_id: '',
  action: '',
  from: '',
  to: '',
};

/**
 * Filters from a query string — DOCUMENT 11 §6: "filters persist in the URL".
 * Missing parameters are empty, which means "not filtered".
 */
export function filtersFromParams(params: URLSearchParams): AuditFilters {
  const read = (key: (typeof FILTER_KEYS)[number]): string => params.get(key)?.trim() ?? '';
  return {
    user_id: read('user_id'),
    entity_type: read('entity_type'),
    entity_id: read('entity_id'),
    action: read('action'),
    from: read('from'),
    to: read('to'),
  };
}

export function hasFilters(filters: AuditFilters): boolean {
  return FILTER_KEYS.some((key) => filters[key] !== '');
}

/**
 * The URL for a new set of filters. The page is dropped: page 4 of the old
 * result set means nothing in the new one.
 */
export function withFilters(params: URLSearchParams, filters: AuditFilters): string {
  const next = new URLSearchParams(params);
  next.delete('page');
  for (const key of FILTER_KEYS) {
    if (filters[key] === '') {
      next.delete(key);
    } else {
      next.set(key, filters[key]);
    }
  }
  const query = next.toString();
  return query === '' ? '' : `?${query}`;
}

/** The API query for a page of the log. Empty filters are not sent at all. */
export function auditQuery(
  filters: AuditFilters,
  page: number,
  perPage: number,
): Record<string, string> {
  const query: Record<string, string> = { page: String(page), per_page: String(perPage) };
  for (const key of FILTER_KEYS) {
    if (filters[key] !== '') {
      query[key] = filters[key];
    }
  }
  return query;
}

export interface FieldChange {
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
}

function display(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The technical detail view — DOCUMENT 21 "UI": old and new values, one row
 * per field. The record stores only changed fields (DOCUMENT 21 rule 4), so a
 * field present on one side only was added or cleared, and is shown as such
 * rather than dropped.
 */
export function fieldChanges(oldValues: unknown, newValues: unknown): readonly FieldChange[] {
  const before = asRecord(oldValues);
  const after = asRecord(newValues);
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return fields.map((field) => ({
    field,
    before: display(before[field]),
    after: display(after[field]),
  }));
}

/** A short, stable form of an id for display; the full id stays available. */
export function shortId(id: string): string {
  return id.slice(-8);
}

/**
 * The audit log screen, pre-filtered — how an entity history panel hands off
 * to the full, filterable log. Route segments stay English (DOCUMENT 03 §9).
 */
export function auditLogPath(locale: string, filters: Partial<AuditFilters> = {}): string {
  return `/${locale}/admin/settings/audit-log${withFilters(new URLSearchParams(), {
    ...EMPTY_FILTERS,
    ...filters,
  })}`;
}

/** `GET /audit-logs/entity/{type}/{id}` — DOCUMENT 21 rule 5. */
export function entityHistoryPath(entityType: string, entityId: string): string {
  return `/audit-logs/entity/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`;
}
