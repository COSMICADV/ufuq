import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';

import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { MedicalController } from './medical.controller.js';
import { MedicalService } from './medical.service.js';

/** 1to1OS Business — Medical (phase M0: patients, visits, the medical team and its permissions). */
@Module({
  imports: [AuthModule],
  controllers: [MedicalController, DocumentsController],
  providers: [MedicalService, DocumentsService],
})
export class MedicalModule {}
