/**
 * `/api/v1/goals` — DOCUMENT 08 §4.8, every row of it.
 *
 * | Method | Endpoint               | Permission           |
 * | ------ | ---------------------- | -------------------- |
 * | GET    | `/goals`               | goal.view            |
 * | POST   | `/goals`               | goal.create          |
 * | GET    | `/goals/{id}`          | goal.view            |
 * | PATCH  | `/goals/{id}`          | goal.update          |
 * | DELETE | `/goals/{id}`          | goal.update (cancel) |
 * | POST   | `/goals/{id}/progress` | goal.update_progress |
 * | GET    | `/goals/{id}/progress` | goal.view (history)  |
 *
 * The guard enforces each permission; the service resolves its scope.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { Locale } from '@ufuq/i18n';

import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/decorators/permissions.decorator.js';
import { collection, single } from '../common/envelope.js';
import type { CollectionResponse, SingleResponse } from '../common/envelope.js';
import { RequestContext } from '../common/request-context.js';
import type { RequestOrigin } from '../common/request-context.js';
import { RequestLocale } from '../common/request-locale.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import {
  CreateGoalDto,
  CreateGoalProgressDto,
  GoalProgressQueryDto,
  ListGoalsQueryDto,
  UpdateGoalDto,
} from './dto/goal.dto.js';
import type { GoalDetailPayload, GoalPayload, GoalProgressPayload } from './goal-payload.js';
import { GoalsService } from './goals.service.js';
import type { GoalProgressWritePayload, GoalWritePayload } from './goals.service.js';

const uuidParam = new ParseUUIDPipe();

@Controller('goals')
export class GoalsController {
  constructor(@Inject(GoalsService) private readonly goals: GoalsService) {}

  @Get()
  @RequirePermission('goal.view')
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListGoalsQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<GoalPayload>> {
    const { items, total } = await this.goals.list(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('goal.create')
  async create(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateGoalDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<GoalWritePayload>> {
    return single(await this.goals.create(ctx, dto, origin), { locale });
  }

  @Get(':id')
  @RequirePermission('goal.view')
  async get(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<GoalDetailPayload>> {
    return single(await this.goals.findOne(ctx, id), { locale });
  }

  @Patch(':id')
  @RequirePermission('goal.update')
  async update(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: UpdateGoalDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<GoalWritePayload>> {
    return single(await this.goals.update(ctx, id, dto, origin), { locale });
  }

  /** Cancels the goal — see `GoalsService.cancel`. */
  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('goal.update')
  async cancel(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestContext() origin: RequestOrigin,
  ): Promise<void> {
    await this.goals.cancel(ctx, id, origin);
  }

  @Post(':id/progress')
  @HttpCode(201)
  @RequirePermission('goal.update_progress')
  async addProgress(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: CreateGoalProgressDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<GoalProgressWritePayload>> {
    return single(await this.goals.addProgress(ctx, id, dto, origin), { locale });
  }

  @Get(':id/progress')
  @RequirePermission('goal.view')
  async listProgress(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Query() query: GoalProgressQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<GoalProgressPayload>> {
    const { items, total } = await this.goals.listProgress(ctx, id, query);
    return collection(items, total, resolvePage(query), { locale });
  }
}
