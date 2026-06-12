import { describe, expect, it } from 'vitest';
import {
  computeEloDeltas,
  expectedScore,
  applyDelta,
  ELO_FLOOR,
  K_FACTOR,
} from '../elo.js';

describe('expectedScore', () => {
  it('is 0.5 for equal teams', () => {
    expect(expectedScore(1200, 1200)).toBeCloseTo(0.5);
  });

  it('favors the stronger team', () => {
    expect(expectedScore(1400, 1200)).toBeGreaterThan(0.5);
    expect(expectedScore(1200, 1400)).toBeLessThan(0.5);
  });

  it('is symmetric', () => {
    expect(expectedScore(1300, 1100) + expectedScore(1100, 1300)).toBeCloseTo(1);
  });
});

describe('computeEloDeltas', () => {
  it('equal teams swap K/2 on a win', () => {
    const { team0Delta } = computeEloDeltas([1200, 1200], [1200, 1200], 0);
    expect(team0Delta).toBe(K_FACTOR / 2);
  });

  it('is zero-sum between teams', () => {
    const win = computeEloDeltas([1350, 1250], [1280, 1220], 0);
    const loss = computeEloDeltas([1350, 1250], [1280, 1220], 1);
    expect(win.team0Delta).toBeGreaterThan(0);
    expect(loss.team0Delta).toBeLessThan(0);
  });

  it('upset wins pay more than expected wins', () => {
    const underdogWin = computeEloDeltas([1000, 1000], [1400, 1400], 0);
    const favoriteWin = computeEloDeltas([1400, 1400], [1000, 1000], 0);
    expect(underdogWin.team0Delta).toBeGreaterThan(favoriteWin.team0Delta);
    expect(favoriteWin.team0Delta).toBeGreaterThanOrEqual(1);
  });

  it('uses team averages', () => {
    // 1400+1000 averages to 1200 — same as 1200+1200
    const mixed = computeEloDeltas([1400, 1000], [1200, 1200], 0);
    expect(mixed.team0Delta).toBe(K_FACTOR / 2);
  });
});

describe('applyDelta', () => {
  it('applies the delta', () => {
    expect(applyDelta(1200, 16)).toBe(1216);
    expect(applyDelta(1200, -16)).toBe(1184);
  });

  it('never drops below the floor', () => {
    expect(applyDelta(ELO_FLOOR + 5, -50)).toBe(ELO_FLOOR);
  });
});
