import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import { PersonalHealthScheduler } from './health-jobs.js';
import { PersonalHealthController } from './health.controller.js';
import { PersonalHealthService } from './health.service.js';

export interface PersonalHealthModuleOptions {
  readonly scheduler: boolean;
}

/** 1to1OS Personal — Health (phase 1: medical documents and the trash). */
@Module({})
export class PersonalHealthModule {
  static register(options: PersonalHealthModuleOptions): DynamicModule {
    return {
      module: PersonalHealthModule,
      controllers: [PersonalHealthController],
      providers: [PersonalHealthService, ...(options.scheduler ? [PersonalHealthScheduler] : [])],
    };
  }
}
