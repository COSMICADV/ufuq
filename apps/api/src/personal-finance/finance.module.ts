import { Module } from '@nestjs/common';

import { PersonalBudgetsController } from './budgets.controller.js';
import { PersonalBudgetsService } from './budgets.service.js';
import { PersonalFinanceController } from './finance.controller.js';
import { PersonalFinanceService } from './finance.service.js';

/** 1to1OS Personal — Expenses (accounts, categories, transactions, dashboard, budgets). */
@Module({
  controllers: [PersonalFinanceController, PersonalBudgetsController],
  providers: [PersonalFinanceService, PersonalBudgetsService],
})
export class PersonalFinanceModule {}
