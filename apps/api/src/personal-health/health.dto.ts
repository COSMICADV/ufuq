/** `/personal/health` request shapes. */

import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { PaginationQueryDto } from '../company-structure/dto/pagination.dto.js';
import { IsCalendarDate, NoControlCharacters, TrimmedText } from '../company-structure/validation.js';

import { DOCUMENT_CATEGORIES } from './health-rules.js';
import type { DocumentCategory } from './health-rules.js';

export class CreateDocumentDto {
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @NoControlCharacters()
  title!: string;

  @IsIn(DOCUMENT_CATEGORIES)
  category!: DocumentCategory;

  @IsOptional()
  @IsCalendarDate()
  document_date?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateDocumentDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @NoControlCharacters()
  title?: string;

  @IsOptional()
  @IsIn(DOCUMENT_CATEGORIES)
  category?: DocumentCategory;

  /** An empty string clears the date. */
  @IsOptional()
  @IsString()
  document_date?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class ListDocumentsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(DOCUMENT_CATEGORIES)
  category?: DocumentCategory;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** `true` lists the trash instead. */
  @IsOptional()
  @IsIn(['true', 'false'])
  trash?: string;
}
