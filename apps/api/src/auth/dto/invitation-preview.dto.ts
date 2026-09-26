import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * `POST /auth/invitation-preview` body — DOCUMENT 04 A4.
 *
 * The token travels in the body, not the path: a path segment is written to
 * access logs, proxy logs and browser history by everything it passes through,
 * and DOCUMENT 20 §6 keeps this token out of exactly those places. `POST` for
 * the same reason, not because the call changes anything — it does not.
 */
export class InvitationPreviewDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  token!: string;
}
