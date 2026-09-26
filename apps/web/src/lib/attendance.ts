/**
 * The attendance screens' pure logic — DOCUMENT 04 B5–B7 and C1–C4,
 * DOCUMENT 12.
 *
 * Kept out of the components for the same reason as `employees.ts`: the parts
 * worth testing are the ones that decide what a screen shows, and they should
 * be testable without rendering anything.
 *
 * Nothing here computes attendance. Lateness, working minutes, overtime and
 * status are the server's answers (DOCUMENT 27 RULES 6 and 12); these
 * functions only choose how to *display* what the server already decided.
 */

export const ATTENDANCE_STATUSES = [
  'present',
  'absent',
  'late',
  'on_leave',
  'half_day',
  'holiday',
  'weekend',
  'pending',
] as const;

export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const CORRECTION_STATUS_VALUES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type CorrectionStatusValue = (typeof CORRECTION_STATUS_VALUES)[number];

export const WORK_MODES = ['office', 'wfh'] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export interface AttendanceRecord {
  readonly id: string;
  readonly date: string;
  readonly employee: {
    readonly id: string;
    readonly employee_code: string;
    readonly first_name: string;
    readonly last_name: string;
    readonly department: {
      readonly id: string;
      readonly name_ar: string;
      readonly name_en: string;
    } | null;
  };
  readonly work_mode: WorkMode | null;
  readonly check_in_at: string | null;
  readonly check_out_at: string | null;
  readonly working_minutes: number | null;
  readonly overtime_minutes: number | null;
  readonly late_minutes: number | null;
  readonly status: AttendanceStatus;
  readonly source: string;
  readonly note: string | null;
}

export interface TodayState {
  readonly date: string;
  readonly is_working_day: boolean;
  readonly is_holiday: boolean;
  readonly scheduled_start_at: string | null;
  readonly scheduled_end_at: string | null;
  readonly record: AttendanceRecord | null;
  readonly can_check_in: boolean;
  readonly can_check_out: boolean;
}

export interface MonthlyCell {
  readonly date: string;
  readonly status: AttendanceStatus | null;
  readonly work_mode: WorkMode | null;
  readonly record_id: string | null;
}

export interface MonthlyRow {
  readonly employee: AttendanceRecord['employee'];
  readonly days: readonly MonthlyCell[];
  readonly totals: Readonly<Record<string, number>>;
}

export interface MonthlyMatrix {
  readonly month: string;
  readonly days: readonly string[];
  readonly rows: readonly MonthlyRow[];
}

export interface CorrectionRequest {
  readonly id: string;
  readonly date: string;
  readonly employee: AttendanceRecord['employee'];
  readonly requested_check_in: string | null;
  readonly requested_check_out: string | null;
  readonly requested_work_mode: WorkMode | null;
  readonly reason: string;
  readonly status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  readonly reviewed_at: string | null;
  readonly review_note: string | null;
  readonly current: AttendanceRecord | null;
}

/**
 * The legend DOCUMENT 04 B6 requires, as a token per status.
 *
 * A token rather than a colour: the value is the design-system variable the
 * cell uses, so the matrix, the chips and the calendar all colour a status the
 * same way and no screen picks its own (DOCUMENT 27 RULE 22).
 */
export const STATUS_TONE: Readonly<Record<AttendanceStatus, string>> = {
  present: 'present',
  late: 'late',
  half_day: 'half-day',
  absent: 'absent',
  on_leave: 'leave',
  holiday: 'holiday',
  weekend: 'weekend',
  pending: 'pending',
};

/** The catalogue key for a status — both languages, never a raw enum value. */
export function statusKey(status: AttendanceStatus): string {
  return `attendance.status.${status}`;
}

export function workModeKey(mode: WorkMode): string {
  return `attendance.mode.${mode}`;
}

/**
 * Minutes as `H:MM`.
 *
 * Digits are rendered in the locale's own numerals by the caller's
 * `Intl.NumberFormat`; this only builds the shape, and always pads the minutes
 * so a column of durations lines up.
 */
export function formatDuration(minutes: number | null): string | null {
  if (minutes === null) return null;
  const whole = Math.max(0, Math.trunc(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${String(hours)}:${String(rest).padStart(2, '0')}`;
}

/** `YYYY-MM` for the month a `YYYY-MM-DD` falls in. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** The month before or after a `YYYY-MM`, for the month stepper. */
export function shiftMonth(month: string, delta: number): string {
  const [year, index] = month.split('-').map(Number) as [number, number];
  const moved = new Date(Date.UTC(year, index - 1 + delta, 1));
  return `${String(moved.getUTCFullYear()).padStart(4, '0')}-${String(
    moved.getUTCMonth() + 1,
  ).padStart(2, '0')}`;
}

/** `YYYY-MM` is the only month shape the API accepts (DOCUMENT 08 §4.4). */
export function isMonth(value: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return false;
  const index = Number(match[2]);
  return index >= 1 && index <= 12;
}

export function isDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

export interface BoardFilters {
  readonly date: string;
  readonly departmentId: string;
  readonly status: string;
  readonly workMode: string;
}

/** The daily board's filters, read from the URL — DOCUMENT 04 B5. */
export function boardFiltersFromParams(params: URLSearchParams, today: string): BoardFilters {
  const date = params.get('date') ?? '';
  return {
    date: isDate(date) ? date : today,
    departmentId: params.get('department_id') ?? '',
    status: params.get('status') ?? '',
    workMode: params.get('work_mode') ?? '',
  };
}

/** How many filters are narrowing the board — drives the "clear" affordance. */
export function activeFilterCount(filters: BoardFilters): number {
  return [filters.departmentId, filters.status, filters.workMode].filter((v) => v !== '').length;
}

/**
 * The board's filters as an API query string.
 *
 * The date is always sent: DOCUMENT 08 §4.4 requires a window, and an
 * unbounded attendance list is a table scan that grows forever.
 */
export function boardQuery(filters: BoardFilters, page: number, perPage: number): string {
  const query = new URLSearchParams({
    date: filters.date,
    page: String(page),
    per_page: String(perPage),
  });
  if (filters.departmentId !== '') query.set('department_id', filters.departmentId);
  if (filters.status !== '') query.set('status', filters.status);
  if (filters.workMode !== '') query.set('work_mode', filters.workMode);
  return query.toString();
}

/** The same filters back into the browser URL, so a board is linkable. */
export function boardUrlQuery(filters: BoardFilters, today: string): string {
  const query = new URLSearchParams();
  if (filters.date !== today) query.set('date', filters.date);
  if (filters.departmentId !== '') query.set('department_id', filters.departmentId);
  if (filters.status !== '') query.set('status', filters.status);
  if (filters.workMode !== '') query.set('work_mode', filters.workMode);
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

/**
 * Whether a correction may still be filed for a date — DOCUMENT 12 rule 13.
 *
 * The window is the company's own setting (`correction_window_days`), which
 * reaches the browser through `GET /auth/me`. The server decides for real (and
 * returns `CORRECTION_WINDOW_CLOSED` when it disagrees); this is only so the
 * history does not offer an action that is certain to be refused.
 *
 * `DEFAULT_CORRECTION_WINDOW_DAYS` is the column's default, used only when a
 * screen has not loaded the session yet — never as a second opinion about what
 * a company's window is.
 */
export const DEFAULT_CORRECTION_WINDOW_DAYS = 7;

export function withinCorrectionWindow(date: string, today: string, windowDays: number): boolean {
  if (!isDate(date) || !isDate(today)) return false;
  const a = Date.parse(`${date}T00:00:00.000Z`);
  const b = Date.parse(`${today}T00:00:00.000Z`);
  if (a >= b) return false;
  return (b - a) / 86_400_000 <= windowDays;
}

/**
 * The calendar grid for a month — DOCUMENT 04 C3.
 *
 * Leading nulls pad the first row so the first day sits under its weekday.
 * The week starts on Sunday, matching `work_schedule_days.day_of_week`, so the
 * calendar's columns and the schedule's rows mean the same thing.
 */
export function calendarGrid(month: string, cells: readonly MonthlyCell[]): (MonthlyCell | null)[] {
  if (!isMonth(month)) return [];
  const [year, index] = month.split('-').map(Number) as [number, number];
  const leading = new Date(Date.UTC(year, index - 1, 1)).getUTCDay();
  return [...(Array.from({ length: leading }, () => null) as null[]), ...cells];
}

/** The status counts for a set of cells — the chips DOCUMENT 04 C2 shows. */
export function summarise(
  cells: readonly { readonly status: AttendanceStatus | null }[],
): Record<AttendanceStatus, number> {
  const counts = Object.fromEntries(ATTENDANCE_STATUSES.map((s) => [s, 0])) as Record<
    AttendanceStatus,
    number
  >;
  for (const cell of cells) {
    if (cell.status !== null) {
      counts[cell.status] += 1;
    }
  }
  return counts;
}
