import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

/** `POST /auth/forgot-password` body — DOCUMENT 08 §4.1: always 200, always the same message. */
export class ForgotPasswordDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(255)
  email!: string;
}
