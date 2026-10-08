/**
 * Phase 9 — the Requests Centre (DOCUMENT 25 Phase 9, DOCUMENT 08 §4.9).
 *
 * `CorrectionsService` is provided here as well as in the attendance module,
 * as `SystemActorService` is in the goals module: it is stateless, and the
 * Requests Centre decides an attendance row by delegating to it (OD-09) rather
 * than holding a second copy of its rules. `AttachmentsService` comes from the
 * global attachments module.
 *
 * `REQUEST_EVENT_SINK` is the Phase 15 seam: notifications replace the
 * deferred sink here, and nothing that submits or decides a request changes.
 */

import { Module } from '@nestjs/common';

import { CorrectionsService } from '../attendance/corrections.service.js';
import { AuthModule } from '../auth/auth.module.js';

import {
  DeferredRequestEventSink,
  REQUEST_EVENT_SINK,
  RequestEventPublisher,
} from './request-events.js';
import { RequestsController } from './requests.controller.js';
import { RequestsService } from './requests.service.js';

@Module({
  imports: [AuthModule],
  controllers: [RequestsController],
  providers: [
    RequestsService,
    CorrectionsService,
    RequestEventPublisher,
    { provide: REQUEST_EVENT_SINK, useClass: DeferredRequestEventSink },
  ],
})
export class RequestsModule {}
