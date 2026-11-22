import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { PaginationQueryDto } from '../company-structure/dto/pagination.dto.js';
import { IsCalendarDate, NoControlCharacters, TrimmedText } from '../company-structure/validation.js';

import { CLINICAL_ROLES, MEDICAL_PERMISSIONS } from './medical-rules.js';
import type { ClinicalRoleKey, MedicalPermissionKey, MedicalScope } from './medical-rules.js';

export class GrantDto {
  @IsIn(MEDICAL_PERMISSIONS)
  key!: MedicalPermissionKey;

  @IsIn(['all', 'assigned'])
  scope!: MedicalScope;
}

export class UpdateStaffDto {
  /** null removes the employee from the medical team (and every grant). */
  @ValidateIf((_, v) => v !== null)
  @IsIn(CLINICAL_ROLES)
  clinical_role!: ClinicalRoleKey | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @TrimmedText()
  @IsString()
  @MaxLength(80)
  @NoControlCharacters()
  specialty?: string | null;

  @IsArray()
  @ArrayMaxSize(MEDICAL_PERMISSIONS.length)
  @ValidateNested({ each: true })
  @Type(() => GrantDto)
  permissions!: GrantDto[];
}

class PatientFields {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsCalendarDate()
  date_of_birth?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(['male', 'female'])
  gender?: 'male' | 'female' | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @TrimmedText()
  @IsString()
  @MaxLength(40)
  @Matches(/^[+0-9 ()-]*$/)
  phone?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @TrimmedText()
  @IsString()
  @MaxLength(30)
  @NoControlCharacters()
  national_id?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @TrimmedText()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  primary_doctor_id?: string | null;
}

export class CreatePatientDto extends PatientFields {
  @TrimmedText()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  @NoControlCharacters()
  full_name!: string;
}

export class UpdatePatientDto extends PatientFields {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  @NoControlCharacters()
  full_name?: string;
}

export class CareTeamDto {
  @IsArray()
  @ArrayMaxSize(30)
  @IsUUID('all', { each: true })
  employee_ids!: string[];
}

export const VISIT_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled'] as const;

class VisitFields {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  doctor_id?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @TrimmedText()
  @IsString()
  @MaxLength(300)
  @NoControlCharacters()
  reason?: string | null;

  /** The clinical notes: only with `visits.clinical`. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @TrimmedText()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;

  @IsOptional()
  @IsIn(VISIT_STATUSES)
  status?: (typeof VISIT_STATUSES)[number];
}

export class CreateVisitDto extends VisitFields {
  @IsDateString({ strict: true })
  visit_at!: string;
}

export class UpdateVisitDto extends VisitFields {
  @IsOptional()
  @IsDateString({ strict: true })
  visit_at?: string;
}

export class ListPatientsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  archived?: 'true' | 'false';

  @IsOptional()
  @IsIn(['true', 'false'])
  mine?: 'true' | 'false';
}

export class ListVisitsQueryDto {
  @IsDateString({ strict: true })
  from!: string;

  @IsDateString({ strict: true })
  to!: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  mine?: 'true' | 'false';
}
