import { normaliseDigits } from '@ufuq/i18n';

/**
 * Turns the digits the on-device OCR saw on an odometer photo into candidate
 * readings, best first. A candidate is only ever a suggestion: the person
 * confirms or corrects it before anything is saved.
 *
 * Odometers print 4–7 digits; trip meters and clocks print fewer, or carry a
 * decimal point (`123.4`), so those rank lower or are dropped.
 */
export function odometerCandidates(
  texts: readonly string[],
  lastKm: number | null = null,
): number[] {
  const scores = new Map<number, number>();
  for (const raw of texts) {
    const text = normaliseDigits(raw).replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
    // Digit runs, allowing spaces or separators a display draws between digits.
    for (const match of text.matchAll(/\d(?:[\s,.'’]?\d)*/g)) {
      // A run with spaces may be one display (`0 4 1 5 2 0`) or several numbers.
      const parts = /\s/.test(match[0]) ? [match[0], ...match[0].split(/\s+/)] : [match[0]];
      for (const value of parts) {
        if (/\d\.\d$/.test(value)) continue; // a trip meter's tenths
        const digits = value.replace(/\D/g, '');
        if (digits.length < 3 || digits.length > 7) continue;
        const km = Number(digits);
        let score = digits.length >= 4 ? 10 + digits.length : digits.length;
        // A value just above the last reading is the most plausible.
        if (lastKm !== null) {
          if (km >= lastKm && km - lastKm <= 20_000) score += 20;
          else if (km < lastKm) score -= 15;
        }
        scores.set(km, (scores.get(km) ?? 0) + score);
      }
    }
  }
  return [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])
    .map(([km]) => km)
    .slice(0, 4);
}

/** "41520" → "41,520" in Latin digits, for the confirm step. */
export function groupKm(km: number): string {
  return String(km).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
