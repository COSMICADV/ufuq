/**
 * `POST /attachments` form fields — DOCUMENT 08 §4.14. The file itself is the
 * multipart part named `file`; these are the other parts.
 *
 * `company_id` is not a field and never will be (DOCUMENT 08 §1): the global
 * whitelist turns one into a 422. The record the file belongs to is named by
 * type and id, and that record's own policy decides whether the caller may
 * reach it.
 */

import { IsIn, IsUUID } from 'class-validator';

import { RELATED_TYPES } from '../attachment-policy.js';
import type { RelatedType } from '../attachment-policy.js';

export class UploadAttachmentDto {
  @IsIn(RELATED_TYPES)
  related_type!: RelatedType;

  @IsUUID()
  related_id!: string;
}
