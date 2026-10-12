/**
 * `/positions` — DOCUMENT 08 §4.2, DOCUMENT 06 §3.5.
 *
 * `GET` and `POST` only: DOCUMENT 08 §4.2 lists no `/positions/{id}` row.
 * DOCUMENT 04 B25 describes the screen as a "CRUD list", which does not agree;
 * the disagreement is recorded in docs/PHASE-4-STATUS.md rather than settled
 * here by writing endpoints the API specification does not define
 * (DOCUMENT 27 RULES 2 and 35).
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient } from '@ufuq/db';

import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';

import type { ResolvedPage } from './dto/pagination.dto.js';
import type { CreatePositionDto } from './dto/position.dto.js';
import { positionPayload } from './payloads.js';
import type { PositionPayload } from './payloads.js';
import { fieldError, TenantScopedService } from './tenant-scoped.service.js';

export interface PositionList {
  readonly items: readonly PositionPayload[];
  readonly total: number;
}

@Injectable()
export class PositionsService extends TenantScopedService {
  /** Explicit, so Nest resolves exactly this: the base constructor's optional audit dispatcher is not injectable. This service writes no audit. */
  constructor(@Inject(PRISMA_CLIENT) prisma: PrismaClient) {
    super(prisma);
  }

  async list(ctx: AuthContext, page: ResolvedPage): Promise<PositionList> {
    return this.tenant(ctx, async (tx) => {
      const where: Prisma.PositionWhereInput = { deletedAt: null };
      const [rows, total] = await Promise.all([
        tx.position.findMany({
          where,
          // `title_ar` is not unique here (DOCUMENT 06 §3.5 declares no
          // constraint on it), so `id` breaks the tie and keeps paging stable:
          // ids are UUID v7 and therefore ordered by creation time.
          orderBy: [{ titleAr: 'asc' }, { id: 'asc' }],
          skip: page.skip,
          take: page.take,
        }),
        tx.position.count({ where }),
      ]);
      return { items: rows.map(positionPayload), total };
    });
  }

  async create(ctx: AuthContext, dto: CreatePositionDto): Promise<PositionPayload> {
    return this.tenant(ctx, async (tx) => {
      const departmentId = dto.department_id ?? null;
      if (departmentId !== null) {
        // DOCUMENT 08 §5.3 — the reference is checked before the write, and a
        // department belonging to another company is invisible to this query,
        // so it fails as "not_found" without confirming it exists elsewhere.
        const department = await tx.department.findFirst({
          where: { id: departmentId, deletedAt: null },
        });
        if (!department) {
          throw fieldError({ department_id: ['not_found'] });
        }
      }

      const row = await tx.position.create({
        data: {
          id: generateId(),
          companyId: ctx.companyId,
          titleAr: dto.title_ar,
          titleEn: dto.title_en,
          departmentId,
        },
      });
      return positionPayload(row);
    });
  }
}
