/**
 * `/requests` request shapes — DOCUMENT 08 §4.9, DOCUMENT 04 B13 / C9.
 *
 * What is deliberately not writable: `employee_id` (a request is always the
 * caller's own — `request.create` is `self` for every role, DOCUMENT 02),
 * `status`, the reviewer and the review time, and `company_id`, ever
 * (DOCUMENT 08 §1's critical rule). The whitelist turns an attempt to send any
 * of them into a 422.
 */

import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import { PaginationQueryDto } from '../../company-structure/dto/pagination.dto.js';
import {
  IsCalendarDate,
  NoControlCharacters,
  TrimmedText,
} from '../../company-structure/validation.js';
import {
  DESCRIPTION_MAX_LENGTH,
  REQUEST_CATEGORIES,
  REQUEST_STATUSES,
  RESPONSE_MAX_LENGTH,
  SUBJECT_MAX_LENGTH,
} from '../request-rules.js';
import type { RequestCategoryValue, RequestStatusValue } from '../request-rules.js';

/** GET /requests — DOCUMENT 08 §4.9: category, status, employee_id, date range. */
export class ListRequestsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(REQUEST_CATEGORIES)
  category?: RequestCategoryValue;

  @IsOptional()
  @IsIn(REQUEST_STATUSES)
  status?: RequestStatusValue;

  @IsOptional()
  @IsUUID()
  employee_id?: string;

  /** Submitted on or after this day, in the company's timezone. */
  @IsOptional()
  @IsCalendarDate()
  from?: string;

  /** Submitted on or before this day, in the company's timezone. */
  @IsOptional()
  @IsCalendarDate()
  to?: string;

  /**
   * DOCUMENT 04 B1 widget 7 "Pending requests … with inline approve/reject":
   * `true` narrows to the requests the caller may decide — their
   * `request.review` scope, never their own (OD-03). The same population as
   * `GET /requests/pending-count`, inside the caller's scope like every other
   * filter (the precedent is `GET /tasks?needs_reassignment=true`).
   */
  @IsOptional()
  @IsIn(['true'])
  reviewable?: 'true';
}

/**
 * POST /requests. Every category is accepted by the validator so that a
 * specialised one is refused with its own explanation
 * (`REQUEST_CATEGORY_SPECIALISED`) rather than a bare "invalid".
 */
export class CreateRequestDto {
  @IsIn(REQUEST_CATEGORIES)
  category!: RequestCategoryValue;

  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(SUBJECT_MAX_LENGTH)
  @NoControlCharacters({ message: 'subject must not contain control characters' })
  subject!: string;

  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(DESCRIPTION_MAX_LENGTH)
  description!: string;

  /** Task category only: the task the request is about, in the caller's task scope. */
  @IsOptional()
  @IsUUID()
  task_id?: string;
}

/** POST /requests/{id}/approve — the response is optional on approval. */
export class ApproveRequestDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(RESPONSE_MAX_LENGTH)
  @NoControlCharacters({ message: 'admin_response must not contain control characters' })
  admin_response?: string;
}

/** POST /requests/{id}/reject — "reject requires a reason" (DOCUMENT 04 B13). */
export class RejectRequestDto {
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(RESPONSE_MAX_LENGTH)
  @NoControlCharacters({ message: 'admin_response must not contain control characters' })
  admin_response!: string;
}
