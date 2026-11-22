/** 1to1OS Personal — My Car: the shapes the API returns. */

export interface CarStats {
  readonly current_km: number | null;
  readonly last_read_at: string | null;
  readonly days_since_last: number | null;
  readonly stale: boolean;
  readonly status: 'ok' | 'insufficient';
  readonly reason: 'no_readings' | 'need_readings' | 'need_days' | null;
  readonly daily_km: string | null;
  readonly monthly_km: number | null;
  readonly readings_used: number;
  readonly span_days: number;
  readonly trend: { readonly recent_daily_km: string; readonly direction: 'up' | 'down' | 'steady' } | null;
  readonly segment: number;
}

export interface OdometerReading {
  readonly id: string;
  readonly reading_km: number;
  readonly read_at: string;
  readonly segment: number;
  readonly kind: 'normal' | 'reset' | 'replacement';
  readonly source: 'photo' | 'manual' | 'fuel' | 'service';
  readonly note: string | null;
  readonly corrected: boolean;
  readonly unusual: boolean;
  readonly since_previous_km: number | null;
  readonly photo_ids: readonly string[];
}

export interface Vehicle {
  readonly id: string;
  readonly name: string;
  readonly make: string | null;
  readonly model: string | null;
  readonly year: number | null;
  readonly plate: string | null;
  readonly fuel_type: string | null;
  readonly archived: boolean;
  readonly reading_count: number;
  readonly stats: CarStats;
  readonly readings?: readonly OdometerReading[];
}

export const MIN_READINGS = 3;
export const MIN_SPAN_DAYS = 7;

export function dayTime(iso: string, locale: string): string {
  const tag = locale === 'ar' ? 'ar-EG-u-nu-latn' : locale;
  return new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  );
}
