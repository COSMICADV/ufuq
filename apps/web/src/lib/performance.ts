/**
 * The performance screens' pure half — DOCUMENT 14 "Performance", DOCUMENT 04
 * B25 "Performance" and B4 "performance snapshot".
 *
 * The settings screen shows the live sum of the weights so a save that the
 * API will refuse can be seen coming ("Settings save blocked with the current
 * sum shown", DOCUMENT 14 "Error states"). The sum is computed in integer
 * ten-thousandths — the weights' own scale — never in binary floating point
 * (DOCUMENT 27 RULE 17). The API remains the authority.
 */

export const COMPONENTS = ['attendance', 'task', 'goal'] as const;
export type Component = (typeof COMPONENTS)[number];

/** `GET /performance-config`. */
export interface PerformanceConfig {
  readonly schema_version: number;
  readonly weights: Readonly<Record<Component, string>>;
  readonly attendance: { readonly late_penalty: string; readonly absence_penalty: string };
  readonly task: { readonly completion_weight: string; readonly on_time_weight: string };
  readonly updated_at: string;
  readonly updated_by: { readonly name: string } | null;
}

export interface PerformanceForm {
  weights: Record<Component, string>;
  late_penalty: string;
  absence_penalty: string;
  completion_weight: string;
  on_time_weight: string;
}

export function formFromConfig(config: PerformanceConfig): PerformanceForm {
  return {
    weights: { ...config.weights },
    late_penalty: config.attendance.late_penalty,
    absence_penalty: config.attendance.absence_penalty,
    completion_weight: config.task.completion_weight,
    on_time_weight: config.task.on_time_weight,
  };
}

export function bodyFromForm(form: PerformanceForm): Record<string, unknown> {
  return {
    weights: { ...form.weights },
    attendance: { late_penalty: form.late_penalty, absence_penalty: form.absence_penalty },
    task: { completion_weight: form.completion_weight, on_time_weight: form.on_time_weight },
  };
}

const WEIGHT_PLACES = 4;
const WEIGHT = /^(\d+)(?:\.(\d{1,4}))?$/;
const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/** Arabic-Indic and Persian digits to Latin, as the API does (DOCUMENT 08 §5.5). */
function latinDigits(value: string): string {
  return value.replace(ARABIC_DIGITS, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/** A weight as ten-thousandths, or null when it is not a valid weight string. */
export function weightUnits(value: string): number | null {
  const match = WEIGHT.exec(latinDigits(value.trim()));
  if (match === null) {
    return null;
  }
  const fraction = (match[2] ?? '').padEnd(WEIGHT_PLACES, '0');
  return Number(match[1]) * 10 ** WEIGHT_PLACES + Number(fraction);
}

/**
 * The sum of some weights as a four-place string ("0.9000"), or null when one
 * of them cannot be read. `isWhole` says whether it is exactly 1.
 */
export function weightSum(values: readonly string[]): {
  readonly sum: string | null;
  readonly isWhole: boolean;
} {
  const units = values.map(weightUnits);
  if (units.some((unit) => unit === null)) {
    return { sum: null, isWhole: false };
  }
  const total = (units as number[]).reduce((a, b) => a + b, 0);
  const whole = Math.floor(total / 10 ** WEIGHT_PLACES);
  const fraction = String(total % 10 ** WEIGHT_PLACES).padStart(WEIGHT_PLACES, '0');
  return { sum: `${String(whole)}.${fraction}`, isWhole: total === 10 ** WEIGHT_PLACES };
}

// ---------------------------------------------------------------------------
// One employee's month — `GET /employees/{id}/performance`
// ---------------------------------------------------------------------------

export interface EmployeePerformance {
  readonly employee_id: string;
  readonly month: string;
  readonly is_provisional: boolean;
  readonly components: {
    readonly attendance: {
      readonly score: string | null;
      readonly weight: string;
      readonly effective_weight: string | null;
      readonly no_data_reason: 'no_working_days' | 'schedule_incomplete' | 'no_records' | null;
    };
    readonly task: {
      readonly score: string | null;
      readonly weight: string;
      readonly effective_weight: string | null;
      readonly completion_rate: string | null;
      readonly on_time_rate: string | null;
    };
    readonly goal: {
      readonly score: string | null;
      readonly weight: string;
      readonly effective_weight: string | null;
    };
  };
  readonly overall: string | null;
}

/**
 * A score for display, or null for "no data" — DOCUMENT 14: a component with
 * no data is shown as "لا توجد بيانات", never as 0%.
 */
export function scoreText(score: string | null): string | null {
  if (score === null) {
    return null;
  }
  return `${score.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}%`;
}

/** `YYYY-MM` for the month a date falls in. */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}
