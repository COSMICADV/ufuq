import { normaliseDigits } from '@ufuq/i18n';
import { MIN_PASSWORD_LENGTH } from '@ufuq/auth';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().normalize('NFC') : value;
const email = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const phoneInput = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? normaliseDigits(value.trim()) : value;
// Reject controls/header injection; user prose is escaped at its output boundary.
// eslint-disable-next-line no-control-regex -- refuse control characters in public fields
const singleLine = /^[^\x00-\x1f\x7f<>]+$/u;
export class PublicSubmissionDto {
  @IsOptional() @IsString() @MaxLength(0) website?: string;
  @IsInt() @Min(0) started_at!: number;
}
export class ContactDto extends PublicSubmissionDto {
  @Transform(trim) @IsString() @Length(1, 200) @Matches(singleLine) name!: string;
  @Transform(trim) @IsString() @Length(1, 200) @Matches(singleLine) company!: string;
  @Transform(email) @IsEmail() @MaxLength(255) email!: string;
  @Transform(phoneInput)
  @IsString()
  @Length(5, 40)
  @Matches(/^(?=(?:[^0-9]*[0-9]){5})[+0-9() .-]+$/)
  phone!: string;
  @IsIn(['pricing', 'product', 'support', 'other']) enquiry_type!: string;
  @Transform(trim)
  @IsString()
  @Length(10, 5000)
  // eslint-disable-next-line no-control-regex -- allow tabs/newlines, reject other controls
  @Matches(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+$/u)
  message!: string;
}
export class RegisterDto extends PublicSubmissionDto {
  @Transform(trim) @IsString() @Length(1, 200) @Matches(singleLine) company_name!: string;
  @Transform(trim) @IsString() @Length(1, 200) @Matches(singleLine) admin_name!: string;
  @Transform(email) @IsEmail() @MaxLength(255) email!: string;
  @Transform(phoneInput)
  @IsString()
  @Length(5, 40)
  @Matches(/^(?=(?:[^0-9]*[0-9]){5})[+0-9() .-]+$/)
  phone!: string;
  @IsIn(['1-10', '11-50', '51-200', '201+']) employee_count_range!: string;
  @IsString() @Length(MIN_PASSWORD_LENGTH, 200) password!: string;
}
