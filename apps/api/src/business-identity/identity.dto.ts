import { IsEmail, IsIn, IsOptional, IsString, IsUrl, Matches, MaxLength, ValidateIf } from 'class-validator';

import { NoControlCharacters, TrimmedText } from '../company-structure/validation.js';

const COLOR = /^#[0-9a-fA-F]{6}$/;
const PHONE = /^[+0-9 ()-]{3,40}$/;
const URL_OPTIONS = { protocols: ['https', 'http'], require_protocol: true };

/** Every field is optional; `null` clears it. */
export class UpdateIdentityDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @TrimmedText() @IsString() @MaxLength(120) @NoControlCharacters()
  name_ar?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @TrimmedText() @IsString() @MaxLength(120) @NoControlCharacters()
  name_en?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(COLOR)
  primary_color?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(COLOR)
  secondary_color?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @TrimmedText() @Matches(PHONE)
  phone?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @TrimmedText() @Matches(PHONE)
  whatsapp?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @TrimmedText() @IsEmail() @MaxLength(254)
  email?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @TrimmedText() @IsUrl(URL_OPTIONS) @MaxLength(300)
  website?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @TrimmedText() @IsString() @MaxLength(300) @NoControlCharacters()
  address_ar?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @TrimmedText() @IsString() @MaxLength(300) @NoControlCharacters()
  address_en?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @TrimmedText() @IsUrl(URL_OPTIONS) @MaxLength(300)
  instagram?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @TrimmedText() @IsUrl(URL_OPTIONS) @MaxLength(300)
  facebook?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @TrimmedText() @IsUrl(URL_OPTIONS) @MaxLength(300)
  tiktok?: string | null;

  /** Whether receipts print the logo; false prints the business name as text. */
  @IsOptional() @IsIn([true, false])
  print_logo?: boolean;
}

export class UploadLogoDto {
  @IsOptional() @IsIn(['true', 'false'])
  print_logo?: 'true' | 'false';
}

export class OnboardingDto {
  @IsIn(['complete', 'skip'])
  action!: 'complete' | 'skip';
}

export class LogoQueryDto {
  @IsOptional() @IsIn(['main', 'thermal'])
  variant?: 'main' | 'thermal';

  /** Cache-buster only (the logo's version). */
  @IsOptional() @Matches(/^\d{1,9}$/)
  v?: string;
}
