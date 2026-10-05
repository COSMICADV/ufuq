/**
 * `/api/v1/tasks` — DOCUMENT 08 §4.7, every row of it.
 *
 * | Method | Endpoint                              | Permission             |
 * | ------ | ------------------------------------- | ---------------------- |
 * | GET    | `/tasks`                              | task.view              |
 * | POST   | `/tasks`                              | task.create            |
 * | GET    | `/tasks/summary`                      | task.view              |
 * | GET    | `/tasks/{id}`                         | task.view              |
 * | PATCH  | `/tasks/{id}`                         | task.update            |
 * | DELETE | `/tasks/{id}`                         | task.delete (soft)     |
 * | POST   | `/tasks/{id}/status`                  | task.update_status     |
 * | POST   | `/tasks/{id}/progress-updates`        | task.add_progress_note |
 * | GET    | `/tasks/{id}/progress-updates`        | task.view              |
 * | POST   | `/tasks/{id}/checklist`               | task.update            |
 * | PATCH  | `/tasks/{id}/checklist/{itemId}`      | task.update_checklist  |
 * | DELETE | `/tasks/{id}/checklist/{itemId}`      | task.update            |
 *
 * The guard enforces each permission; the service resolves its scope.
 * `PATCH …/checklist/{itemId}` additionally requires `task.update` when it
 * renames or reorders (DOCUMENT 13 "Actions": the list itself is
 * Admin/Manager work, ticking is the assignee's).
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
  ChangeTaskStatusDto,
  CreateChecklistItemDto,
  CreateProgressUpdateDto,
  CreateTaskDto,
  ListTasksQueryDto,
  ProgressUpdatesQueryDto,
  UpdateChecklistItemDto,
  UpdateTaskDto,
} from './dto/task.dto.js';
import type {
  ProgressUpdatePayload,
  TaskDetailPayload,
  TaskPayload,
  TaskWithAttachmentsPayload,
} from './task-payload.js';
import { TasksService } from './tasks.service.js';
import type { TaskSummary } from './tasks.service.js';

const uuidParam = new ParseUUIDPipe();

@Controller('tasks')
export class TasksController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @Get()
  @RequirePermission('task.view')
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListTasksQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<TaskPayload>> {
    const { items, total } = await this.tasks.list(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('task.create')
  async create(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateTaskDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<TaskDetailPayload>> {
    return single(await this.tasks.create(ctx, dto, origin), { locale });
  }

  /** Declared before `:id` so "summary" is never parsed as a task id. */
  @Get('summary')
  @RequirePermission('task.view')
  async summary(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<TaskSummary>> {
    return single(await this.tasks.summary(ctx), { locale });
  }

  @Get(':id')
  @RequirePermission('task.view')
  async get(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<TaskWithAttachmentsPayload>> {
    return single(await this.tasks.findOne(ctx, id), { locale });
  }

  @Patch(':id')
  @RequirePermission('task.update')
  async update(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: UpdateTaskDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<TaskDetailPayload>> {
    return single(await this.tasks.update(ctx, id, dto, origin), { locale });
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('task.delete')
  async remove(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestContext() origin: RequestOrigin,
  ): Promise<void> {
    await this.tasks.remove(ctx, id, origin);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('task.update_status')
  async changeStatus(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: ChangeTaskStatusDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<TaskDetailPayload>> {
    return single(await this.tasks.changeStatus(ctx, id, dto, origin), { locale });
  }

  @Post(':id/progress-updates')
  @HttpCode(201)
  @RequirePermission('task.add_progress_note')
  async addProgressUpdate(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: CreateProgressUpdateDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<ProgressUpdatePayload>> {
    return single(await this.tasks.addProgressUpdate(ctx, id, dto, origin), { locale });
  }

  @Get(':id/progress-updates')
  @RequirePermission('task.view')
  async listProgressUpdates(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Query() query: ProgressUpdatesQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<ProgressUpdatePayload>> {
    const { items, total } = await this.tasks.listProgressUpdates(ctx, id, query);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Post(':id/checklist')
  @HttpCode(201)
  @RequirePermission('task.update')
  async addChecklistItem(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: CreateChecklistItemDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<TaskDetailPayload>> {
    return single(await this.tasks.addChecklistItem(ctx, id, dto, origin), { locale });
  }

  @Patch(':id/checklist/:itemId')
  @RequirePermission('task.update_checklist')
  async updateChecklistItem(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Param('itemId', uuidParam) itemId: string,
    @Body() dto: UpdateChecklistItemDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<TaskDetailPayload>> {
    return single(await this.tasks.updateChecklistItem(ctx, id, itemId, dto, origin), {
      locale,
    });
  }

  @Delete(':id/checklist/:itemId')
  @HttpCode(204)
  @RequirePermission('task.update')
  async removeChecklistItem(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Param('itemId', uuidParam) itemId: string,
    @RequestContext() origin: RequestOrigin,
  ): Promise<void> {
    await this.tasks.removeChecklistItem(ctx, id, itemId, origin);
  }
}
