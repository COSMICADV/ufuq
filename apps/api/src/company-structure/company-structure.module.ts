/**
 * Phase 4 — company structure (DOCUMENT 25 Phase 4).
 *
 * `AuthModule` is imported for `AuditDispatcher`: DOCUMENT 21 requires the
 * audit record to be written once the change it documents has committed, and
 * never for one that rolled back, and that service is the one place that
 * knows how. The alternative — a second
 * copy here — is exactly the duplication DOCUMENT 27 RULE 6 forbids, and it
 * would make "was this audited?" a question with two answers.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';

import { CompanyStructureController } from './company-structure.controller.js';
import { CompanyService } from './company.service.js';
import { DepartmentsService } from './departments.service.js';
import { HolidaysService } from './holidays.service.js';
import { PositionsService } from './positions.service.js';
import { WorkSchedulesService } from './work-schedules.service.js';

@Module({
  imports: [AuthModule],
  controllers: [CompanyStructureController],
  providers: [
    CompanyService,
    DepartmentsService,
    PositionsService,
    WorkSchedulesService,
    HolidaysService,
  ],
})
export class CompanyStructureModule {}
