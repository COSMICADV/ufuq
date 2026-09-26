/**
 * `?page=&per_page=` — DOCUMENT 08 §1, "max 100".
 *
 * DOCUMENT 08 §4.2 documents no filters and no sort whitelist for the settings
 * collections, so none is offered: an undocumented query parameter is a
 * feature nobody asked for (DOCUMENT 27 RULE 2). Pagination is different — it
 * is a global convention in §1 and §2's collection envelope cannot be built
 * without it.
 */

import { IsInt, IsOptional, Max, Min } from 'class-validator';

import { NumericInput } from '../validation.js';

export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 100;

export class PaginationQueryDto {
  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(1)
  @Max(MAX_PER_PAGE)
  per_page?: number;
}

export interface ResolvedPage {
  readonly page: number;
  readonly perPage: number;
  readonly skip: number;
  readonly take: number;
}

export function resolvePage(query: PaginationQueryDto): ResolvedPage {
  const page = query.page ?? 1;
  const perPage = query.per_page ?? DEFAULT_PER_PAGE;
  return { page, perPage, skip: (page - 1) * perPage, take: perPage };
}
