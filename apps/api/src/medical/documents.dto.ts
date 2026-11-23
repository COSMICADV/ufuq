import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

import { IsCalendarDate, NoControlCharacters, TrimmedText } from '../company-structure/validation.js';

import { DEFAULT_CATEGORY_KEYS, DOCUMENT_KINDS } from './document-rules.js';
import type { DocumentKind } from './document-rules.js';

export class CreateDocumentDto {
  /**
   * The file number the uploader sees on screen. The document is refused
   * unless it matches the patient in the URL — a guard against filing a
   * page into the wrong patient's record.
   */
  @TrimmedText() @IsString() @MaxLength(20) @Matches(/^[A-Za-z0-9-]+$/)
  patient_file_number!: string;

  @IsOptional() @IsIn(DEFAULT_CATEGORY_KEYS)
  category_key?: string;

  @IsOptional() @IsUUID()
  custom_category_id?: string;

  @TrimmedText() @IsString() @MinLength(1) @MaxLength(200) @NoControlCharacters()
  title!: string;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsCalendarDate()
  document_date?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID()
  visit_id?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @TrimmedText() @IsString() @MaxLength(2000)
  notes?: string | null;

  @IsOptional() @IsIn(['upload', 'camera'])
  source?: 'upload' | 'camera';
}

export class UpdateDocumentDto {
  @IsOptional() @IsIn(DEFAULT_CATEGORY_KEYS)
  category_key?: string;

  @IsOptional() @IsUUID()
  custom_category_id?: string;

  @IsOptional() @TrimmedText() @IsString() @MinLength(1) @MaxLength(200) @NoControlCharacters()
  title?: string;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsCalendarDate()
  document_date?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID()
  visit_id?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @TrimmedText() @IsString() @MaxLength(2000)
  notes?: string | null;
}

export class ListDocumentsQueryDto {
  @IsOptional() @IsIn(DOCUMENT_KINDS)
  kind?: DocumentKind;

  @IsOptional() @IsIn(['true', 'false'])
  archived?: 'true' | 'false';
}

export class CategoryDto {
  @TrimmedText() @IsString() @MinLength(1) @MaxLength(80) @NoControlCharacters()
  name_ar!: string;

  @TrimmedText() @IsString() @MinLength(1) @MaxLength(80) @NoControlCharacters()
  name_en!: string;

  @IsIn(DOCUMENT_KINDS)
  kind!: DocumentKind;
}

export class UpdateCategoryDto {
  @IsOptional() @TrimmedText() @IsString() @MinLength(1) @MaxLength(80) @NoControlCharacters()
  name_ar?: string;

  @IsOptional() @TrimmedText() @IsString() @MinLength(1) @MaxLength(80) @NoControlCharacters()
  name_en?: string;

  @IsOptional() @IsIn([true, false])
  archived?: boolean;
}
