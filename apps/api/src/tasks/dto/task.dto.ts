/**
 * `/tasks` request shapes — DOCUMENT 08 §4.7, DOCUMENT 13 "Validation",
 * DOCUMENT 08 §5.
 *
 * What is deliberately not writable:
 *
 *   - `status` and `progress_percent` on create or PATCH. Status moves only
 *     through `POST /tasks/{id}/status`, where the transition matrix is
 *     enforced; progress is derived and never free-typed (DOCUMENT 06 §1.3,
 *     OD-10). The whitelist turns an attempt to send either into a 422.
 *   - `goal_id`: goals are Phase 8 (see docs/PHASE-7-STATUS.md).
 *   - `company_id`, ever (DOCUMENT 08 §1's critical rule).
 */

import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../company-structure/dto/pagination.dto.js';
import {
  IsCalendarDate,
  NoControlCharacters,
  NumericInput,
  TrimmedText,
} from '../../company-structure/validation.js';
import { TASK_PRIORITIES, TASK_STATUSES } from '../task-rules.js';
import type { TaskPriorityValue, TaskStatusValue } from '../task-rules.js';

/** DOCUMENT 13 validation: "Title required, 3–255 characters". */
export const TASK_TITLE_MIN_LENGTH = 3;
export const TASK_TITLE_MAX_LENGTH = 255;
/** DOCUMENT 13 validation: "Checklist item title required, maximum 255 characters". */
export const CHECKLIST_TITLE_MAX_LENGTH = 255;
/** DOCUMENT 13 validation: "Progress note maximum 2000 characters". */
export const PROGRESS_NOTE_MAX_LENGTH = 2000;
/**
 * `description` is TEXT and DOCUMENT 13 sets no limit; a bound keeps TEXT
 * from being an unbounded hole (DOCUMENT 08 §5 "maximum lengths").
 */
export const DESCRIPTION_MAX_LENGTH = 5000;
/** Same reasoning as the attendance reasons (Phase 6). */
export const REASON_MAX_LENGTH = 1000;
/** Items that may arrive with `POST /tasks` (FLOW 09 "checklist items 0..n"). */
export const CREATE_CHECKLIST_MAX_ITEMS = 100;

/** `?overdue=true|false` arrives as a string. */
const BOOLEAN_STRINGS = ['true', 'false'] as const;

/** POST /tasks — DOCUMENT 05 FLOW 09, DOCUMENT 04 B10. */
export class CreateTaskDto {
  @TrimmedText()
  @IsString()
  @MinLength(TASK_TITLE_MIN_LENGTH)
  @MaxLength(TASK_TITLE_MAX_LENGTH)
  @NoControlCharacters()
  title!: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @IsUUID(undefined, { message: 'invalid' })
  assignee_employee_id!: string;

  /** Omitted → the assignee's department (DOCUMENT 04 B10 "auto from assignee, overridable"). */
  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  department_id?: string | null;

  @IsIn(TASK_PRIORITIES)
  priority!: TaskPriorityValue;

  @IsOptional()
  @IsCalendarDate({ message: 'invalid' })
  start_date?: string | null;

  /** A past deadline is allowed — back-dated work (DOCUMENT 13 edge cases). */
  @IsOptional()
  @IsCalendarDate({ message: 'invalid' })
  deadline?: string | null;

  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map((item: unknown) => (typeof item === 'string' ? item.trim() : item))
      : value,
  )
  @IsArray()
  @ArrayMaxSize(CREATE_CHECKLIST_MAX_ITEMS)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(CHECKLIST_TITLE_MAX_LENGTH, { each: true })
  @NoControlCharacters({ each: true })
  checklist?: string[];
}

/** PATCH /tasks/{id} — edit, reassign, change deadline, change priority. */
export class UpdateTaskDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(TASK_TITLE_MIN_LENGTH)
  @MaxLength(TASK_TITLE_MAX_LENGTH)
  @NoControlCharacters()
  title?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  assignee_employee_id?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  department_id?: string | null;

  @IsOptional()
  @IsIn(TASK_PRIORITIES)
  priority?: TaskPriorityValue;

  @IsOptional()
  @IsCalendarDate({ message: 'invalid' })
  start_date?: string | null;

  @IsOptional()
  @IsCalendarDate({ message: 'invalid' })
  deadline?: string | null;
}

/** POST /tasks/{id}/status — DOCUMENT 13 rules 4, 6, 7. */
export class ChangeTaskStatusDto {
  @IsIn(TASK_STATUSES)
  status!: TaskStatusValue;

  /** Required when cancelling (rule 7) or reopening (rule 4); the service says which. */
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(REASON_MAX_LENGTH)
  @NoControlCharacters()
  reason?: string;

  /**
   * Rule 6: completing with open checklist items "is allowed but requires
   * confirmation naming the count". The first attempt is refused with the
   * count; this flag is the confirmation — the `NON_WORKING_DAY` pattern.
   */
  @IsOptional()
  @IsBoolean()
  confirm_open_items?: boolean;
}

/** POST /tasks/{id}/checklist — appended (FLOW 11). */
export class CreateChecklistItemDto {
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(CHECKLIST_TITLE_MAX_LENGTH)
  @NoControlCharacters()
  title!: string;
}

/**
 * PATCH /tasks/{id}/checklist/{itemId}. `is_completed` is a tick or untick
 * (`task.update_checklist`); `title` and `position` edit and reorder the list,
 * which DOCUMENT 13 gives to Admin/Manager — the service requires
 * `task.update` for those two.
 */
export class UpdateChecklistItemDto {
  @IsOptional()
  @IsBoolean()
  is_completed?: boolean;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(CHECKLIST_TITLE_MAX_LENGTH)
  @NoControlCharacters()
  title?: string;

  /** Zero-based target index; a value past the end moves the item last. */
  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(0)
  position?: number;
}

/** POST /tasks/{id}/progress-updates — DOCUMENT 13 validation. */
export class CreateProgressUpdateDto {
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(PROGRESS_NOTE_MAX_LENGTH)
  note!: string;
}

/**
 * GET /tasks — DOCUMENT 08 §4.7 filters: status, priority, assignee,
 * department, overdue, date range (`from`/`to` on the deadline), plus
 * `needs_reassignment` for DOCUMENT 13's dashboard list. `goal_id`
 * arrives with goals in Phase 8. DOCUMENT 08 documents no sort whitelist for
 * this endpoint, so the order is fixed (deadline first).
 */
export class ListTasksQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(TASK_STATUSES)
  status?: TaskStatusValue;

  @IsOptional()
  @IsIn(TASK_PRIORITIES)
  priority?: TaskPriorityValue;

  @IsOptional()
  @IsUUID()
  assignee_employee_id?: string;

  @IsOptional()
  @IsUUID()
  department_id?: string;

  @IsOptional()
  @IsIn(BOOLEAN_STRINGS)
  overdue?: (typeof BOOLEAN_STRINGS)[number];

  @IsOptional()
  @IsCalendarDate()
  from?: string;

  @IsOptional()
  @IsCalendarDate()
  to?: string;

  /**
   * DOCUMENT 13 edge case "Assignee deactivated with open tasks": the tasks
   * remain and "surface in a 'tasks needing reassignment' list on the admin
   * dashboard". `true` narrows to exactly those — open tasks whose assignee is
   * no longer active — inside the caller's scope like every other filter.
   */
  @IsOptional()
  @IsIn(['true'])
  needs_reassignment?: 'true';
}

/** GET /tasks/{id}/progress-updates — DOCUMENT 08 §1 pagination only. */
export class ProgressUpdatesQueryDto extends PaginationQueryDto {}
