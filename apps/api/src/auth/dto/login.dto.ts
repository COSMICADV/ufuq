import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** `POST /auth/login` body — DOCUMENT 08 §4.1, DOCUMENT 09 §1. */
export class LoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(255)
  email!: string;

  // No length lower bound tied to the password policy here — a too-short
  // password must fail with INVALID_CREDENTIALS like any other wrong
  // password, not with a validation error that confirms the policy exists
  // before authentication has happened.
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;

  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}
