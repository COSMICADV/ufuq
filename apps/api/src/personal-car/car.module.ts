import { Module } from '@nestjs/common';

import { PersonalCarController } from './car.controller.js';
import { PersonalCarService } from './car.service.js';

/** 1to1OS Personal — My Car (phase A: vehicles, odometer readings, driving averages). */
@Module({
  controllers: [PersonalCarController],
  providers: [PersonalCarService],
})
export class PersonalCarModule {}
