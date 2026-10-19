/**
 * Notification centre and settings payloads — DOCUMENT 08 §4.13, DOCUMENT 19
 * rule 10.
 */

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { NumericInput } from '../../company-structure/validation.js';
import { FEED_MAX_PAGE_SIZE, NOTIFICATION_TYPES, V1_CHANNELS } from '../notification-catalogue.js';

const BOOLEAN_STRINGS = ['true', 'false'] as const;
const TYPE_KEYS = NOTIFICATION_TYPES.map((definition) => definition.type);

/** GET /notifications — newest first, paged, bounded. */
export class NotificationFeedQueryDto {
  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(1)
  @Max(FEED_MAX_PAGE_SIZE)
  per_page?: number;

  /** `?unread=true` lists only unread notifications. */
  @IsOptional()
  @IsIn(BOOLEAN_STRINGS)
  unread?: (typeof BOOLEAN_STRINGS)[number];
}

export class NotificationPreferenceDto {
  @IsIn(TYPE_KEYS)
  type!: (typeof TYPE_KEYS)[number];

  /** V1 delivers in the app only; email and push are not offered. */
  @IsIn(V1_CHANNELS)
  channel!: (typeof V1_CHANNELS)[number];

  @IsBoolean()
  enabled!: boolean;
}

/** PATCH /settings/notifications — per-event channel toggles. */
export class UpdateNotificationSettingsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TYPE_KEYS.length * V1_CHANNELS.length)
  @ValidateNested({ each: true })
  @Type(() => NotificationPreferenceDto)
  preferences!: NotificationPreferenceDto[];
}
