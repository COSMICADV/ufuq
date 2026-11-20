import { Module } from '@nestjs/common';

import { PersonalFinanceController } from './finance.controller.js';
import { PersonalFinanceService } from './finance.service.js';

/** 1to1OS Personal — Expenses (accounts, categories, transactions, dashboard). */
@Module({
  controllers: [PersonalFinanceController],
  providers: [PersonalFinanceService],
})
export class PersonalFinanceModule {}
