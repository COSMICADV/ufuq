/**
 * `/performance-config` and `/employees/{id}/performance` request shapes —
 * DOCUMENT 08 §4.2 and §4.3, DOCUMENT 14 "Validation".
 *
 * The three groups are only checked to be objects here. What is inside them
 * is validated by `parsePerformanceConfig` — the one definition of a valid
 * version-1 configuration, also applied to the stored row before every
 * calculation — which reports every problem by its path (`weights.task`) and
 * a sum that is not one as `must_sum_to_one`. A missing group is reported
 * there as `required`, in the same vocabulary, which is why each is optional
 * to the whitelist.
 */

import { IsObject, IsOptional, Matches } from 'class-validator';

/** PATCH /performance-config — the whole model, replaced together. */
export class UpdatePerformanceConfigDto {
  @IsOptional()
  @IsObject()
  weights?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  attendance?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  task?: Record<string, unknown>;
}

/** GET /employees/{id}/performance — `?month=YYYY-MM`, the company's current month by default. */
export class EmployeePerformanceQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'invalid' })
  month?: string;
}
