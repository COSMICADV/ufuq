/**
 * Task attachments — who may see, add and remove them (Phase 7 addendum,
 * approved 2026-10-05).
 *
 * Expressed entirely through the task's own scope rules (`taskScopeWhere`),
 * so an attachment can never reach further than the task it belongs to:
 *
 *   - **view** — the task is in the caller's `task.view` scope. Otherwise 404,
 *     the approved Phase 7 decision for tasks: an employee is never told that
 *     a colleague's task, or its files, exist.
 *   - **upload** — DOCUMENT 13 gives "Upload attachment" to the employee on
 *     their own task; Admin and Manager upload wherever their `task.update`
 *     scope reaches (`company` / `team`). No new permission is invented.
 *   - **delete** — for V1, Admin/Manager only: `task.update` scope over the
 *     task. An assignee cannot remove a file, not even one they uploaded.
 */

import { Injectable } from '@nestjs/common';
import type { TenantClient } from '@ufuq/db';
import type { PermissionKey } from '@ufuq/auth';

import type { AuthContext } from '../auth/auth-context.js';
import type { AttachmentPolicy } from '../attachments/attachment-policy.js';
import { AppException } from '../common/app-exception.js';

import { taskScopeWhere } from './task-query.js';

@Injectable()
export class TaskAttachmentPolicy implements AttachmentPolicy {
  readonly relatedType = 'task' as const;
  readonly sensitive = false;

  canView(tx: TenantClient, ctx: AuthContext, taskId: string): Promise<boolean> {
    return this.reaches(tx, ctx, taskId, 'task.view');
  }

  async canUpload(tx: TenantClient, ctx: AuthContext, taskId: string): Promise<boolean> {
    if (ctx.callerEmployeeId !== null) {
      const own = await tx.task.findFirst({
        where: { id: taskId, deletedAt: null, assigneeEmployeeId: ctx.callerEmployeeId },
        select: { id: true },
      });
      if (own !== null) return true;
    }
    return this.reaches(tx, ctx, taskId, 'task.update');
  }

  canDelete(tx: TenantClient, ctx: AuthContext, taskId: string): Promise<boolean> {
    return this.reaches(tx, ctx, taskId, 'task.update');
  }

  /** Does `permission`'s scope reach this live task? A missing permission is simply "no". */
  private async reaches(
    tx: TenantClient,
    ctx: AuthContext,
    taskId: string,
    permission: PermissionKey,
  ): Promise<boolean> {
    let scope;
    try {
      scope = taskScopeWhere(ctx, permission);
    } catch (error) {
      // `taskScopeWhere` refuses a caller who lacks the permission, or whose
      // self/team scope has no employee record to resolve against.
      if (error instanceof AppException) return false;
      throw error;
    }
    const row = await tx.task.findFirst({
      where: { AND: [{ id: taskId, deletedAt: null }, scope] },
      select: { id: true },
    });
    return row !== null;
  }
}
