import { describe, expect, it } from 'vitest';

import { groupKm, odometerCandidates } from './odometer-reader';

describe('odometerCandidates', () => {
  it('prefers the odometer over a trip meter and a clock', () => {
    expect(odometerCandidates(['TRIP 123.4 km\n41520 km\n10:45'])[0]).toBe(41520);
  });
  it('reads digits split by the display, and Arabic-Indic digits', () => {
    expect(odometerCandidates(['0 4 1 5 2 0'])[0]).toBe(41520);
    expect(odometerCandidates(['٤١٥٢٠'])[0]).toBe(41520);
  });
  it('fixes letters OCR confuses with digits', () => {
    expect(odometerCandidates(['4l52O'])[0]).toBe(41520);
  });
  it('ranks a value just above the last reading first', () => {
    expect(odometerCandidates(['91520 41620'], 41500)[0]).toBe(41620);
  });
  it('returns nothing when nothing looks like an odometer', () => {
    expect(odometerCandidates(['ABS  12  P'])).toEqual([]);
  });
  it('groups for display', () => {
    expect(groupKm(1234567)).toBe('1,234,567');
  });
});
