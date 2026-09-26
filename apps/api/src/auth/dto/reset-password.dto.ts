import { IsString, MaxLength, MinLength } from 'class-validator';

/** `POST /auth/reset-password` body — DOCUMENT 08 §4.1, DOCUMENT 09 §2. */
export class ResetPasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  token!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(200)
  newPassword!: string;
}
