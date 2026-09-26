import { IsString, MaxLength, MinLength } from 'class-validator';

/** `POST /auth/change-password` body — DOCUMENT 08 §4.1, DOCUMENT 09 §2: requires the current password. */
export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  currentPassword!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(200)
  newPassword!: string;
}
