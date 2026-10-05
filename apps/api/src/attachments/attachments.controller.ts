/**
 * `/api/v1/attachments` — DOCUMENT 08 §4.14, every row of it.
 *
 * | Method | Endpoint            | Authorization                                   |
 * | ------ | ------------------- | ----------------------------------------------- |
 * | POST   | `/attachments`      | the related record's policy — may add a file    |
 * | GET    | `/attachments/{id}` | the related record's policy — may see it        |
 * | DELETE | `/attachments/{id}` | the related record's policy — may remove a file |
 *
 * No `@RequirePermission`: there is no attachment permission in DOCUMENT 02,
 * because a file is exactly as reachable as the record it belongs to. The
 * session guard still requires an authenticated caller, and the service asks
 * the related record's policy every question (DOCUMENT 27 RULE 9 — the check
 * is made where it can be made correctly, not skipped).
 *
 * The download is a raw byte stream, not the JSON envelope: always
 * `Content-Disposition: attachment` (never rendered in the application's
 * origin), `nosniff`, a sandboxing CSP, and `no-store` so a shared machine's
 * cache never keeps a copy.
 */

import {
  Body,
  Catch,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Locale } from '@ufuq/i18n';
import type { Response } from 'express';

import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { single } from '../common/envelope.js';
import type { SingleResponse } from '../common/envelope.js';
import { ERROR_CODES, errorBody } from '../common/errors.js';
import { RequestContext } from '../common/request-context.js';
import type { RequestOrigin } from '../common/request-context.js';
import { RequestLocale } from '../common/request-locale.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import { UploadAttachmentDto } from './dto/attachment.dto.js';
import type { AttachmentPayload } from './attachment-payload.js';
import { AttachmentsService } from './attachments.service.js';
import type { UploadedFile as UploadedFileShape } from './attachments.service.js';

const uuidParam = new ParseUUIDPipe();

/**
 * Multer refuses a file over the configured limit before the handler runs,
 * and Nest reports that as a 413. DOCUMENT 08 §2 reports a bad field as a 422
 * naming the field, so the same refusal reads the same way whichever layer
 * catches it first.
 */
@Catch(PayloadTooLargeException)
class UploadTooLargeFilter implements ExceptionFilter {
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(422)
      .json({ error: errorBody(ERROR_CODES.VALIDATION_FAILED, { file: ['too_large'] }) });
  }
}

@Controller('attachments')
export class AttachmentsController {
  constructor(@Inject(AttachmentsService) private readonly attachments: AttachmentsService) {}

  @Post()
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file'))
  @UseFilters(UploadTooLargeFilter)
  async upload(
    @CurrentUser() ctx: AuthContext,
    @UploadedFile() file: UploadedFileShape | undefined,
    @Body() dto: UploadAttachmentDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<AttachmentPayload>> {
    return single(await this.attachments.upload(ctx, file, dto, origin), { locale });
  }

  @Get(':id')
  async download(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestContext() origin: RequestOrigin,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.attachments.download(ctx, id, origin);
    response.set({
      'Content-Type': file.mimeType,
      'Content-Length': String(file.sizeBytes),
      'Content-Disposition': file.disposition,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
      // Lets a client verify what it received against the recorded digest.
      'Repr-Digest': `sha-256=:${Buffer.from(file.checksum, 'hex').toString('base64')}:`,
    });
    return new StreamableFile(file.stream);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestContext() origin: RequestOrigin,
  ): Promise<void> {
    await this.attachments.remove(ctx, id, origin);
  }
}
