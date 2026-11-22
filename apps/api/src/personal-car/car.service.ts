/**
 * 1to1OS Personal — My Car, phase A: vehicles and odometer readings.
 *
 * Every reading is one the person confirmed (a photo's OCR is only a
 * suggestion on the device). Readings are checked against the vehicle's
 * history in time order; a reset or replaced odometer starts a new segment.
 * Driving averages are computed from the readings on every read.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { PrismaClient, TenantClient } from '@ufuq/db';

import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { fieldError, isUniqueViolation, notFound, TenantScopedService } from '../company-structure/tenant-scoped.service.js';

import type { CreateReadingDto, CreateVehicleDto, UpdateReadingDto, UpdateVehicleDto } from './car.dto.js';
import { checkReading, drivingStats, formatTenths } from './odometer-rules.js';
import type { DrivingStats, Reading, ReadingProblem } from './odometer-rules.js';


const PHOTO_TYPE = 'odometer_reading';

export interface StatsPayload {
  readonly current_km: number | null;
  readonly last_read_at: string | null;
  readonly days_since_last: number | null;
  readonly stale: boolean;
  readonly status: 'ok' | 'insufficient';
  readonly reason: DrivingStats['reason'];
  readonly daily_km: string | null;
  readonly monthly_km: number | null;
  readonly readings_used: number;
  readonly span_days: number;
  readonly trend: { readonly recent_daily_km: string; readonly direction: 'up' | 'down' | 'steady' } | null;
  readonly segment: number;
}

export interface ReadingPayload {
  readonly id: string;
  readonly reading_km: number;
  readonly read_at: string;
  readonly segment: number;
  readonly kind: 'normal' | 'reset' | 'replacement';
  readonly source: 'photo' | 'manual' | 'fuel' | 'service';
  readonly note: string | null;
  readonly corrected: boolean;
  readonly unusual: boolean;
  /** Km driven since the previous reading in the same segment. */
  readonly since_previous_km: number | null;
  readonly photo_ids: readonly string[];
}

export interface VehiclePayload {
  readonly id: string;
  readonly name: string;
  readonly make: string | null;
  readonly model: string | null;
  readonly year: number | null;
  readonly plate: string | null;
  readonly fuel_type: string | null;
  readonly archived: boolean;
  readonly reading_count: number;
  readonly stats: StatsPayload;
}

export interface VehicleDetailPayload extends VehiclePayload {
  readonly readings: readonly ReadingPayload[];
}

interface VehicleRow {
  readonly id: string;
  readonly name: string;
  readonly make: string | null;
  readonly model: string | null;
  readonly year: number | null;
  readonly plate: string | null;
  readonly fuelType: string | null;
  readonly archivedAt: Date | null;
}

interface ReadingRow {
  readonly id: string;
  readonly readingKm: number;
  readonly readAt: Date;
  readonly segment: number;
  readonly kind: 'normal' | 'reset' | 'replacement';
  readonly source: 'photo' | 'manual' | 'fuel' | 'service';
  readonly note: string | null;
  readonly correctedAt: Date | null;
}

function asReading(row: ReadingRow): Reading {
  return { id: row.id, km: row.readingKm, at: row.readAt, segment: row.segment, kind: row.kind };
}

function statsPayload(stats: DrivingStats): StatsPayload {
  return {
    current_km: stats.current?.km ?? null,
    last_read_at: stats.current?.at.toISOString() ?? null,
    days_since_last: stats.daysSinceLast,
    stale: stats.stale,
    status: stats.status,
    reason: stats.reason,
    daily_km: stats.dailyTenths === null ? null : formatTenths(stats.dailyTenths),
    monthly_km: stats.monthlyKm,
    readings_used: stats.readingsUsed,
    span_days: stats.spanDays,
    trend: stats.trend
      ? { recent_daily_km: formatTenths(stats.trend.recentDailyTenths), direction: stats.trend.direction }
      : null,
    segment: stats.segment,
  };
}

function problemError(problem: ReadingProblem): Error {
  return problem === 'reset_not_latest'
    ? fieldError({ kind: ['reset_not_latest'] })
    : fieldError({ reading_km: [problem] });
}

@Injectable()
export class PersonalCarService extends TenantScopedService {
  constructor(@Inject(PRISMA_CLIENT) prisma: PrismaClient) {
    super(prisma);
  }

  // ---- Vehicles ------------------------------------------------------------

  async vehicles(ctx: AuthContext, includeArchived: boolean): Promise<VehiclePayload[]> {
    return this.tenant(ctx, async (tx) => {
      const rows = await tx.vehicle.findMany({
        where: includeArchived ? {} : { archivedAt: null },
        orderBy: [{ archivedAt: 'asc' }, { createdAt: 'asc' }],
      });
      const now = new Date();
      const out: VehiclePayload[] = [];
      for (const row of rows) {
        const readings = await this.readingRows(tx, row.id);
        out.push(this.vehiclePayload(row, readings, now));
      }
      return out;
    });
  }

  async vehicle(ctx: AuthContext, id: string): Promise<VehicleDetailPayload> {
    return this.tenant(ctx, async (tx) => {
      const row = await tx.vehicle.findUnique({ where: { id } });
      if (!row) throw notFound();
      const readings = await this.readingRows(tx, id);
      return this.detail(tx, row, readings);
    });
  }

  async createVehicle(ctx: AuthContext, dto: CreateVehicleDto): Promise<VehicleDetailPayload> {
    return this.tenant(ctx, async (tx) => {
      try {
        const row = await tx.vehicle.create({
          data: {
            id: generateId(),
            companyId: ctx.companyId,
            userId: ctx.userId,
            name: dto.name,
            make: dto.make || null,
            model: dto.model || null,
            year: dto.year ?? null,
            plate: dto.plate || null,
            fuelType: dto.fuel_type || null,
          },
        });
        if (dto.current_km !== undefined) {
          await tx.odometerReading.create({
            data: {
              id: generateId(),
              companyId: ctx.companyId,
              userId: ctx.userId,
              vehicleId: row.id,
              readingKm: dto.current_km,
              readAt: new Date(),
              source: 'manual',
            },
          });
        }
        return this.detail(tx, row, await this.readingRows(tx, row.id));
      } catch (error) {
        if (isUniqueViolation(error)) throw fieldError({ name: ['already_taken'] });
        throw error;
      }
    });
  }

  async updateVehicle(ctx: AuthContext, id: string, dto: UpdateVehicleDto): Promise<VehicleDetailPayload> {
    return this.tenant(ctx, async (tx) => {
      const existing = await tx.vehicle.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw notFound();
      try {
        const row = await tx.vehicle.update({
          where: { id },
          data: {
            ...(dto.name === undefined ? {} : { name: dto.name }),
            ...(dto.make === undefined ? {} : { make: dto.make || null }),
            ...(dto.model === undefined ? {} : { model: dto.model || null }),
            ...(dto.year === undefined ? {} : { year: dto.year }),
            ...(dto.plate === undefined ? {} : { plate: dto.plate || null }),
            ...(dto.fuel_type === undefined ? {} : { fuelType: dto.fuel_type || null }),
          },
        });
        return this.detail(tx, row, await this.readingRows(tx, id));
      } catch (error) {
        if (isUniqueViolation(error)) throw fieldError({ name: ['already_taken'] });
        throw error;
      }
    });
  }

  /** A vehicle with readings is archived (its history kept); an empty one is deleted. */
  async removeVehicle(ctx: AuthContext, id: string): Promise<{ archived: boolean }> {
    return this.tenant(ctx, async (tx) => {
      const row = await tx.vehicle.findUnique({ where: { id }, select: { id: true } });
      if (!row) throw notFound();
      const readings = await tx.odometerReading.count({ where: { vehicleId: id } });
      if (readings > 0) {
        await tx.vehicle.update({ where: { id }, data: { archivedAt: new Date() } });
        return { archived: true };
      }
      await tx.vehicle.delete({ where: { id } });
      return { archived: false };
    });
  }

  async restoreVehicle(ctx: AuthContext, id: string): Promise<void> {
    await this.tenant(ctx, async (tx) => {
      const row = await tx.vehicle.findUnique({ where: { id }, select: { id: true } });
      if (!row) throw notFound();
      await tx.vehicle.update({ where: { id }, data: { archivedAt: null } });
    });
  }

  // ---- Readings ------------------------------------------------------------

  async addReading(ctx: AuthContext, vehicleId: string, dto: CreateReadingDto): Promise<ReadingPayload> {
    return this.tenant(ctx, async (tx) => {
      const vehicle = await tx.vehicle.findUnique({ where: { id: vehicleId }, select: { archivedAt: true } });
      if (!vehicle) throw notFound();
      if (vehicle.archivedAt !== null) throw fieldError({ vehicle_id: ['not_allowed'] });
      const at = new Date(dto.read_at);
      if (at.getTime() > Date.now() + 10 * 60_000) throw fieldError({ read_at: ['invalid'] });
      const history = (await this.readingRows(tx, vehicleId)).map(asReading);
      const kind = dto.kind ?? 'normal';
      const check = checkReading(history, { km: dto.reading_km, at, kind }, dto.confirm_unusual === true);
      if (!check.ok) throw problemError(check.problem);
      const row = await tx.odometerReading.create({
        data: {
          id: generateId(),
          companyId: ctx.companyId,
          userId: ctx.userId,
          vehicleId,
          readingKm: dto.reading_km,
          readAt: at,
          segment: check.segment,
          kind,
          source: dto.source ?? 'manual',
          note: dto.note || null,
        },
      });
      return this.readingPayloads([...history, asReading(row)], [row], new Map())[0] as ReadingPayload;
    });
  }

  async updateReading(ctx: AuthContext, id: string, dto: UpdateReadingDto): Promise<ReadingPayload> {
    return this.tenant(ctx, async (tx) => {
      const existing = await tx.odometerReading.findUnique({ where: { id } });
      if (!existing) throw notFound();
      const at = dto.read_at ? new Date(dto.read_at) : existing.readAt;
      if (at.getTime() > Date.now() + 10 * 60_000) throw fieldError({ read_at: ['invalid'] });
      const km = dto.reading_km ?? existing.readingKm;
      const history = (await this.readingRows(tx, existing.vehicleId)).map(asReading);
      const check = checkReading(history, { km, at, kind: existing.kind, excludeId: id }, dto.confirm_unusual === true);
      if (!check.ok) throw problemError(check.problem);
      const row = await tx.odometerReading.update({
        where: { id },
        data: {
          readingKm: km,
          readAt: at,
          ...(existing.kind === 'normal' ? { segment: check.segment } : {}),
          ...(dto.note === undefined ? {} : { note: dto.note || null }),
          ...(km !== existing.readingKm || at.getTime() !== existing.readAt.getTime() ? { correctedAt: new Date() } : {}),
        },
      });
      const all = (await this.readingRows(tx, existing.vehicleId)).map(asReading);
      const photos = await this.photos(tx, [id]);
      return this.readingPayloads(all, [row], photos)[0] as ReadingPayload;
    });
  }

  /** Removes a reading; a reset can only go while nothing was read after it. */
  async removeReading(ctx: AuthContext, id: string): Promise<void> {
    await this.tenant(ctx, async (tx) => {
      const row = await tx.odometerReading.findUnique({ where: { id } });
      if (!row) throw notFound();
      if (row.kind !== 'normal') {
        const later = await tx.odometerReading.count({
          where: { vehicleId: row.vehicleId, readAt: { gt: row.readAt } },
        });
        if (later > 0) throw fieldError({ kind: ['reset_not_latest'] });
      }
      await tx.odometerReading.delete({ where: { id } });
      await tx.attachment.updateMany({
        where: { relatedType: PHOTO_TYPE, relatedId: id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    });
  }

  // ---- Internals -----------------------------------------------------------

  private readingRows(tx: TenantClient, vehicleId: string): Promise<ReadingRow[]> {
    return tx.odometerReading.findMany({
      where: { vehicleId },
      orderBy: [{ readAt: 'asc' }, { segment: 'asc' }],
    });
  }

  private async photos(tx: TenantClient, ids: readonly string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (ids.length === 0) return map;
    const rows = await tx.attachment.findMany({
      where: { relatedType: PHOTO_TYPE, relatedId: { in: [...ids] }, deletedAt: null },
      select: { id: true, relatedId: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const row of rows) map.set(row.relatedId, [...(map.get(row.relatedId) ?? []), row.id]);
    return map;
  }

  private vehiclePayload(row: VehicleRow, readings: readonly ReadingRow[], now: Date): VehiclePayload {
    return {
      id: row.id,
      name: row.name,
      make: row.make,
      model: row.model,
      year: row.year,
      plate: row.plate,
      fuel_type: row.fuelType,
      archived: row.archivedAt !== null,
      reading_count: readings.length,
      stats: statsPayload(drivingStats(readings.map(asReading), now)),
    };
  }

  private async detail(tx: TenantClient, row: VehicleRow, readings: readonly ReadingRow[]): Promise<VehicleDetailPayload> {
    const all = readings.map(asReading);
    const photos = await this.photos(
      tx,
      readings.map((r) => r.id),
    );
    // Newest first for the history list.
    const payloads = this.readingPayloads(all, readings, photos).reverse();
    return { ...this.vehiclePayload(row, readings, new Date()), readings: payloads };
  }

  private readingPayloads(
    all: readonly Reading[],
    rows: readonly ReadingRow[],
    photos: ReadonlyMap<string, string[]>,
  ): ReadingPayload[] {
    const stats = drivingStats(all, new Date());
    const unusual = new Set(stats.unusual);
    const sorted = [...all].sort((a, b) => a.at.getTime() - b.at.getTime() || a.segment - b.segment);
    return rows.map((row) => {
      const index = sorted.findIndex((r) => r.id === row.id);
      const previous = index > 0 ? sorted[index - 1] : undefined;
      const since =
        previous && previous.segment === row.segment && row.kind === 'normal' ? row.readingKm - previous.km : null;
      return {
        id: row.id,
        reading_km: row.readingKm,
        read_at: row.readAt.toISOString(),
        segment: row.segment,
        kind: row.kind,
        source: row.source,
        note: row.note,
        corrected: row.correctedAt !== null,
        unusual: unusual.has(row.id),
        since_previous_km: since,
        photo_ids: photos.get(row.id) ?? [],
      };
    });
  }
}
