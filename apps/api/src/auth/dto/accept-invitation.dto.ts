import { Equals, IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';

/** `POST /auth/accept-invitation` body — DOCUMENT 08 §4.1, DOCUMENT 09 §6. */
export class AcceptInvitationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  token!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(200)
  password!: string;

  /**
   * DOCUMENT 04 A4's terms checkbox. Enforced here and not only in the browser:
   * a gate that the page draws but the API does not apply is decoration, and
   * this endpoint is public, so anything that matters about the request has to
   * be checked on this side of it. `false` and a missing field are both 422
   * with `accept_terms` named, which is what the page needs to mark the box.
   */
  @IsBoolean()
  @Equals(true)
  accept_terms!: boolean;
}
