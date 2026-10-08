/**
 * The employee dashboard's pure rules — DOCUMENT 04 C1.
 *
 * Only the components whose modules exist are built: the attendance card
 * (Phase 6), "My tasks" (Phase 7) and "My goals" (Phase 8). Salary, leave
 * balance and requests arrive with their phases (DOCUMENT 27 RULE 26).
 */

import type { Task } from './tasks';

/** C1 component 3: "the next 3 tasks by deadline". */
export const NEXT_TASKS_LIMIT = 3;

/** C1 component 4 — the nearest-ending active goals; the rest are one tap away. */
export const DASHBOARD_GOALS_LIMIT = 5;

export function isOpenTask(task: Pick<Task, 'status'>): boolean {
  return task.status !== 'completed' && task.status !== 'cancelled';
}

/** Open tasks due on the company's `today` — the same test as C5's "Due today" group. */
export function dueTodayCount(
  tasks: readonly Pick<Task, 'status' | 'deadline'>[],
  today: string,
): number {
  return tasks.filter((task) => isOpenTask(task) && task.deadline === today).length;
}

/**
 * The next open tasks by deadline, from today on. Overdue work is counted
 * separately on the card and listed on `/app/tasks`; dates are `YYYY-MM-DD`,
 * so they order as strings.
 */
export function nextTasks<T extends Pick<Task, 'status' | 'deadline'>>(
  tasks: readonly T[],
  today: string,
  limit: number = NEXT_TASKS_LIMIT,
): T[] {
  return tasks
    .filter(
      (task): task is T & { deadline: string } =>
        isOpenTask(task) && task.deadline !== null && task.deadline >= today,
    )
    .sort((a, b) => (a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0))
    .slice(0, limit);
}

/**
 * C1 "Empty": a new employee with no tasks and no goals sees a welcome card
 * and the attendance action only.
 */
export function isNewcomer(totals: { readonly tasks: number; readonly goals: number }): boolean {
  return totals.tasks === 0 && totals.goals === 0;
}
