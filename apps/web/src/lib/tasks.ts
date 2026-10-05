/**
 * The task screens' pure half — DOCUMENT 13, DOCUMENT 04 B8–B10 / C5–C6.
 *
 * Kept free of React so the rules that are easy to get subtly wrong — which
 * group a task falls in, which filters survive in the URL, what an optimistic
 * tick shows, which button a transition gets — are tested directly
 * (`tasks.test.ts`).
 *
 * Nothing here decides anything the server decides. Progress, overdue and the
 * transition matrix are the API's (`apps/api/src/tasks/task-rules.ts`); the
 * screens render what it returns. The single exception is the optimistic
 * tick, which must show a number before the response arrives (DOCUMENT 04 C6)
 * and is replaced by the server's value the moment it does.
 */

export const TASK_STATUSES = [
  'not_started',
  'in_progress',
  'on_hold',
  'completed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface PersonRef {
  readonly user_id: string;
  readonly employee_id: string | null;
  readonly name: string;
}

/** `GET /tasks` item — see `apps/api/src/tasks/task-payload.ts`. */
export interface Task {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly assignee: {
    readonly id: string;
    readonly employee_code: string;
    readonly first_name: string;
    readonly last_name: string;
    readonly status: string;
  };
  readonly department: {
    readonly id: string;
    readonly name_ar: string;
    readonly name_en: string;
  } | null;
  readonly priority: TaskPriority;
  readonly status: TaskStatus;
  readonly start_date: string | null;
  readonly deadline: string | null;
  readonly completed_at: string | null;
  readonly progress_percent: string;
  readonly is_overdue: boolean;
  readonly cancelled_reason: string | null;
  readonly checklist_total: number;
  readonly checklist_completed: number;
  readonly allowed_transitions: readonly TaskStatus[];
  readonly created_by: PersonRef;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ChecklistItem {
  readonly id: string;
  readonly title: string;
  readonly is_completed: boolean;
  readonly completed_at: string | null;
  readonly completed_by: PersonRef | null;
  readonly position: number;
}

/** `GET /tasks/{id}`. */
export interface TaskDetail extends Task {
  readonly checklist: readonly ChecklistItem[];
}

export interface ProgressUpdate {
  readonly id: string;
  readonly task_id: string;
  readonly note: string;
  readonly progress_percent_at_time: string;
  readonly author: PersonRef;
  readonly created_at: string;
}

export interface TaskSummary {
  readonly total: number;
  readonly by_status: Readonly<Record<TaskStatus, number>>;
  readonly overdue: number;
  readonly due_today: number;
}

/** DOCUMENT 13 validation limits, mirrored for `maxLength` and inline hints only. */
export const TITLE_MIN_LENGTH = 3;
export const TITLE_MAX_LENGTH = 255;
export const CHECKLIST_TITLE_MAX_LENGTH = 255;
export const NOTE_MAX_LENGTH = 2000;
export const DESCRIPTION_MAX_LENGTH = 5000;
export const REASON_MAX_LENGTH = 1000;

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export function statusKey(status: TaskStatus): string {
  return `tasks.status.${status}`;
}

export function priorityKey(priority: TaskPriority): string {
  return `tasks.priority.${priority}`;
}

/**
 * Status → one of the design system's semantic tones (DOCUMENT 27 RULE 22: no
 * new colours). Overdue is not a status, so it has no entry; it is a separate
 * indicator beside the status.
 */
export const STATUS_TONE: Readonly<
  Record<TaskStatus, 'info' | 'warning' | 'success' | 'cancelled'>
> = {
  not_started: 'info',
  in_progress: 'warning',
  on_hold: 'cancelled',
  completed: 'success',
  cancelled: 'cancelled',
};

export const PRIORITY_TONE: Readonly<
  Record<TaskPriority, 'info' | 'warning' | 'danger' | 'cancelled'>
> = {
  low: 'cancelled',
  medium: 'info',
  high: 'warning',
  urgent: 'danger',
};

/** The API's DECIMAL(5,2) string as a number for a bar or ring — display only. */
export function progressValue(percent: string): number {
  const parsed = Number(percent);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.min(100, Math.max(0, parsed));
}

/** "75.00" → "75", "33.33" → "33.33": the digits a person reads. */
export function formatPercent(percent: string): string {
  return percent.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

export function assigneeName(task: Pick<Task, 'assignee'>): string {
  return `${task.assignee.first_name} ${task.assignee.last_name}`.trim();
}

/**
 * The button a transition is offered as — DOCUMENT 13 rule 4. The same target
 * reads differently by origin: `in_progress` is "Start" from not started,
 * "Resume" from on hold and "Reopen" from completed.
 */
export type TransitionAction = 'start' | 'resume' | 'reopen' | 'complete' | 'hold' | 'cancel';

export function transitionAction(from: TaskStatus, to: TaskStatus): TransitionAction {
  switch (to) {
    case 'in_progress':
      return from === 'completed' ? 'reopen' : from === 'on_hold' ? 'resume' : 'start';
    case 'completed':
      return 'complete';
    case 'on_hold':
      return 'hold';
    case 'cancelled':
      return 'cancel';
    case 'not_started':
      // No documented transition leads back here; listed for exhaustiveness.
      return 'start';
  }
}

/** Cancelling (rule 7) and reopening (rule 4) ask for a reason first. */
export function needsReason(from: TaskStatus, to: TaskStatus): boolean {
  return to === 'cancelled' || (from === 'completed' && to === 'in_progress');
}

// ---------------------------------------------------------------------------
// The employee's grouped list — DOCUMENT 04 C5, DOCUMENT 13 "Mobile behaviour"
// ---------------------------------------------------------------------------

/**
 * DOCUMENT 04 C5: "Due today · Overdue · In progress · Not started ·
 * Completed". On hold and cancelled are not named there; they get their own
 * groups at the end rather than disappearing from the employee's own list.
 */
export const MY_TASK_GROUPS = [
  'due_today',
  'overdue',
  'in_progress',
  'not_started',
  'on_hold',
  'completed',
  'cancelled',
] as const;
export type MyTaskGroup = (typeof MY_TASK_GROUPS)[number];

/**
 * Which group a task belongs to. Each task is in exactly one: an open task due
 * today is "due today" whatever its status, an overdue one is "overdue" (the
 * API's `is_overdue`, never recomputed here), and the rest go by status.
 */
export function myTaskGroup(
  task: Pick<Task, 'status' | 'deadline' | 'is_overdue'>,
  today: string,
): MyTaskGroup {
  const open = task.status !== 'completed' && task.status !== 'cancelled';
  if (open && task.deadline === today) {
    return 'due_today';
  }
  if (task.is_overdue) {
    return 'overdue';
  }
  return task.status;
}

export function groupMyTasks<T extends Pick<Task, 'status' | 'deadline' | 'is_overdue'>>(
  tasks: readonly T[],
  today: string,
): readonly { readonly group: MyTaskGroup; readonly tasks: readonly T[] }[] {
  const buckets = new Map<MyTaskGroup, T[]>(MY_TASK_GROUPS.map((group) => [group, []]));
  for (const task of tasks) {
    buckets.get(myTaskGroup(task, today))?.push(task);
  }
  return MY_TASK_GROUPS.map((group) => ({ group, tasks: buckets.get(group) ?? [] })).filter(
    (entry) => entry.tasks.length > 0,
  );
}

/** The company's calendar day — `YYYY-MM-DD` in its timezone, never the browser's. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// ---------------------------------------------------------------------------
// The optimistic tick — DOCUMENT 04 C6, DOCUMENT 13 "Error states"
// ---------------------------------------------------------------------------

/**
 * The task as it will look once the tick lands, shown immediately and rolled
 * back if the request fails. The progress figure mirrors DOCUMENT 13 rule 2
 * for display only; the server's response replaces this object entirely.
 */
export function applyTick(task: TaskDetail, itemId: string, isCompleted: boolean): TaskDetail {
  const checklist = task.checklist.map((item) =>
    item.id === itemId ? { ...item, is_completed: isCompleted } : item,
  );
  const done = checklist.filter((item) => item.is_completed).length;
  const total = checklist.length;
  // Integer hundredths, rounded half up — no binary-float rounding (RULE 17).
  const hundredths = total === 0 ? null : Math.floor((done * 20_000 + total) / (2 * total));
  const progress =
    hundredths === null
      ? task.progress_percent
      : `${String(Math.floor(hundredths / 100))}.${String(hundredths % 100).padStart(2, '0')}`;
  return {
    ...task,
    checklist,
    checklist_completed: done,
    progress_percent: progress,
    // Rule 5, mirrored: the first tick starts a task that has not started.
    status: isCompleted && task.status === 'not_started' ? 'in_progress' : task.status,
  };
}

// ---------------------------------------------------------------------------
// The checklist builder on the create form — DOCUMENT 04 B10
// ---------------------------------------------------------------------------

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) {
    return [...items];
  }
  const next = [...items];
  const [moved] = next.splice(from, 1) as [T];
  next.splice(to, 0, moved);
  return next;
}

// ---------------------------------------------------------------------------
// Admin list filters — held in the URL (DOCUMENT 11 §6)
// ---------------------------------------------------------------------------

export type TaskView = 'table' | 'board';

export interface TaskFilters {
  readonly view: TaskView;
  readonly status: string;
  readonly priority: string;
  readonly assignee: string;
  readonly department: string;
  readonly overdue: boolean;
  readonly from: string;
  readonly to: string;
  readonly page: number;
}

export const EMPTY_TASK_FILTERS: TaskFilters = {
  view: 'table',
  status: '',
  priority: '',
  assignee: '',
  department: '',
  overdue: false,
  from: '',
  to: '',
  page: 1,
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Filters from a query string. A value that is not one the API would accept is
 * dropped rather than sent, so a hand-edited URL lands on a list instead of on
 * a 422.
 */
export function taskFiltersFromParams(params: URLSearchParams): TaskFilters {
  const read = (key: string): string => params.get(key)?.trim() ?? '';
  const pick = (value: string, allowed: readonly string[]): string =>
    allowed.includes(value) ? value : '';
  const page = Number(read('page'));
  return {
    view: read('view') === 'board' ? 'board' : 'table',
    status: pick(read('status'), TASK_STATUSES),
    priority: pick(read('priority'), TASK_PRIORITIES),
    assignee: UUID.test(read('assignee')) ? read('assignee') : '',
    department: UUID.test(read('department')) ? read('department') : '',
    overdue: read('overdue') === 'true',
    from: DATE.test(read('from')) ? read('from') : '',
    to: DATE.test(read('to')) ? read('to') : '',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** The canonical query string for the screen's URL — defaults are omitted. */
export function searchForTaskFilters(filters: TaskFilters): string {
  const params = new URLSearchParams();
  if (filters.view === 'board') params.set('view', 'board');
  if (filters.status !== '') params.set('status', filters.status);
  if (filters.priority !== '') params.set('priority', filters.priority);
  if (filters.assignee !== '') params.set('assignee', filters.assignee);
  if (filters.department !== '') params.set('department', filters.department);
  if (filters.overdue) params.set('overdue', 'true');
  if (filters.from !== '') params.set('from', filters.from);
  if (filters.to !== '') params.set('to', filters.to);
  if (filters.page > 1) params.set('page', String(filters.page));
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/** The DOCUMENT 08 §4.7 query for `GET /tasks`. */
export function apiQueryForTaskFilters(
  filters: TaskFilters,
  perPage: number,
  status: string = filters.status,
): Record<string, string> {
  return {
    page: String(filters.view === 'board' ? 1 : filters.page),
    per_page: String(perPage),
    ...(status === '' ? {} : { status }),
    ...(filters.priority === '' ? {} : { priority: filters.priority }),
    ...(filters.assignee === '' ? {} : { assignee_employee_id: filters.assignee }),
    ...(filters.department === '' ? {} : { department_id: filters.department }),
    ...(filters.overdue ? { overdue: 'true' } : {}),
    ...(filters.from === '' ? {} : { from: filters.from }),
    ...(filters.to === '' ? {} : { to: filters.to }),
  };
}

/** How many filters are set — the count the mobile filter button shows. */
export function activeTaskFilterCount(filters: TaskFilters): number {
  return [
    filters.status !== '',
    filters.priority !== '',
    filters.assignee !== '',
    filters.department !== '',
    filters.overdue,
    filters.from !== '',
    filters.to !== '',
  ].filter(Boolean).length;
}

export function hasActiveTaskFilters(filters: TaskFilters): boolean {
  return (
    filters.status !== '' ||
    filters.priority !== '' ||
    filters.assignee !== '' ||
    filters.department !== '' ||
    filters.overdue ||
    filters.from !== '' ||
    filters.to !== ''
  );
}

export function tasksPath(locale: string): string {
  return `/${locale}/admin/tasks`;
}

export function taskPath(locale: string, id: string, surface: 'admin' | 'app' = 'admin'): string {
  return `/${locale}/${surface}/tasks/${id}`;
}

// ---------------------------------------------------------------------------
// The employee profile's Tasks tab — DOCUMENT 04 B4 "filterable task list
// scoped to this employee". The tab shares the profile's URL, so its keys are
// prefixed and cannot collide with the profile's own (`notice`, `history_page`).
// ---------------------------------------------------------------------------

export interface EmployeeTaskFilters {
  readonly status: string;
  readonly priority: string;
  readonly overdue: boolean;
  readonly page: number;
}

export const EMPTY_EMPLOYEE_TASK_FILTERS: EmployeeTaskFilters = {
  status: '',
  priority: '',
  overdue: false,
  page: 1,
};

export function employeeTaskFiltersFromParams(params: URLSearchParams): EmployeeTaskFilters {
  const read = (key: string): string => params.get(key)?.trim() ?? '';
  const page = Number(read('task_page'));
  return {
    status: (TASK_STATUSES as readonly string[]).includes(read('task_status'))
      ? read('task_status')
      : '',
    priority: (TASK_PRIORITIES as readonly string[]).includes(read('task_priority'))
      ? read('task_priority')
      : '',
    overdue: read('task_overdue') === 'true',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** The profile URL's query with this tab's keys replaced; other keys are kept. */
export function searchForEmployeeTaskFilters(
  params: URLSearchParams,
  filters: EmployeeTaskFilters,
): string {
  const next = new URLSearchParams(params);
  for (const key of ['task_status', 'task_priority', 'task_overdue', 'task_page']) {
    next.delete(key);
  }
  if (filters.status !== '') next.set('task_status', filters.status);
  if (filters.priority !== '') next.set('task_priority', filters.priority);
  if (filters.overdue) next.set('task_overdue', 'true');
  if (filters.page > 1) next.set('task_page', String(filters.page));
  const query = next.toString();
  return query === '' ? '' : `?${query}`;
}

/**
 * `GET /tasks` for one employee. The assignee is a filter, AND-ed on the
 * server with the caller's own `task.view` scope — so a manager asking about
 * someone outside their team gets an empty list, never their tasks.
 */
export function apiQueryForEmployeeTasks(
  employeeId: string,
  filters: EmployeeTaskFilters,
  perPage: number,
): Record<string, string> {
  return {
    assignee_employee_id: employeeId,
    page: String(filters.page),
    per_page: String(perPage),
    ...(filters.status === '' ? {} : { status: filters.status }),
    ...(filters.priority === '' ? {} : { priority: filters.priority }),
    ...(filters.overdue ? { overdue: 'true' } : {}),
  };
}

/** `/admin/tasks/new`, optionally with the assignee chosen (profile "Assign task"). */
export function newTaskPath(locale: string, assigneeId?: string): string {
  const base = `/${locale}/admin/tasks/new`;
  return assigneeId === undefined ? base : `${base}?assignee=${encodeURIComponent(assigneeId)}`;
}
