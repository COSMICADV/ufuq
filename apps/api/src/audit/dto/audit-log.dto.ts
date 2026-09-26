/**
 * `GET /audit-logs` query string — DOCUMENT 21 "API requirements", DOCUMENT 08
 * §4.16: "filters for user, entity type, entity id, action, and date range".
 *
 * Nothing else is offered. DOCUMENT 08 documents no sort whitelist for this
 * endpoint, so the order is fixed (newest first) rather than a parameter
 * nobody asked for (DOCUMENT 27 RULE 2).
 *
 * The date range is a pair of calendar days, read in the **company's**
 * timezone (DOCUMENT 08 §1: "company timezone in presentation"): an admin
 * asking for "the 3rd" means the company's 3rd, not UTC's.
 */

import { IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

import { PaginationQueryDto } from '../../company-structure/dto/pagination.dto.js';
import { IsCalendarDate } from '../../company-structure/validation.js';
import { AUDIT_ACTION_VALUES } from '../audit-actions.js';

/**
 * `entity_type` is VARCHAR(50) and written by the service layer, never by a
 * client, as lowercase snake_case (`attendance_record`). Later phases add
 * types, so the shape is validated rather than a closed list.
 */
export const ENTITY_TYPE_PATTERN = /^[a-z][a-z_]{0,49}$/;

export class ListAuditLogsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  user_id?: string;

  @IsOptional()
  @IsString()
  @Matches(ENTITY_TYPE_PATTERN)
  entity_type?: string;

  @IsOptional()
  @IsUUID()
  entity_id?: string;

  @IsOptional()
  @IsIn(AUDIT_ACTION_VALUES)
  action?: string;

  @IsOptional()
  @IsCalendarDate()
  from?: string;

  @IsOptional()
  @IsCalendarDate()
  to?: string;
}

/** `GET /audit-logs/entity/{type}/{id}` — only pagination in the query string. */
export class EntityHistoryQueryDto extends PaginationQueryDto {}
