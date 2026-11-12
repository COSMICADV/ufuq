import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().normalize('NFC') : value;

/** The studio's record for one code; its shape is checked by `cleanRecord`. */
export class QrSaveDto {
  @IsObject() rec!: Record<string, unknown>;
}

/** What the web app's `/q/{slug}` route knows about the visitor besides the headers. */
export class QrScanDto {
  @IsOptional() @IsBoolean() unique?: boolean;
  @IsOptional() @IsString() @Matches(/^[A-Za-z]{2}$/) country?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) city?: string;
}

export class QrEventDto {
  @Transform(trim) @IsString() @Length(1, 120) name!: string;
}

export class QrFeedbackDto {
  @IsInt() @Min(1) @Max(5) stars!: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) text?: string;
}
