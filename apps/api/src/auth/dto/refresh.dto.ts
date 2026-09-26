import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * `POST /auth/refresh` body — mobile only (OD-02). Rotates the access and
 * refresh tokens for a session; see the Phase 3 report for why this endpoint
 * exists beyond DOCUMENT 08 §4.1's literal table.
 */
export class RefreshDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  refreshToken!: string;
}
