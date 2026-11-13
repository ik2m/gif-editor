import { describe, expect, it } from 'vitest';
import {
  assignLanes,
  endTimeToLastFrame,
  estimateFpsFromDeltas,
  formatClock,
  frameDelaysMs,
  sampleTimes,
  snapFps,
  timeToFrame,
} from './time';

describe('time utils', () => {
  it('timeToFrame は浮動小数誤差に強い', () => {
    expect(timeToFrame(31 / 30, 30)).toBe(31);
    expect(timeToFrame(0.1, 10)).toBe(1);
    expect(timeToFrame(-1, 30)).toBe(0);
  });

  it('終了時刻から最終フレーム（含む）を求める', () => {
    expect(endTimeToLastFrame(1, 0, 30)).toBe(29);
    expect(endTimeToLastFrame(10 / 30, 9 / 30, 30)).toBe(9);
    expect(endTimeToLastFrame(0.5, 0.5, 30)).toBe(15);
  });

  it('snapFps は一般的な値に丸める', () => {
    expect(snapFps(29.9)).toBe(29.97);
    expect(snapFps(24.3)).toBe(24);
    expect(snapFps(59.7)).toBe(59.94);
    expect(snapFps(37.123)).toBe(37.12);
  });

  it('フレーム落ちを含む間隔列から fps を推定', () => {
    const d = [1 / 30, 1 / 30, 2 / 30, 1 / 30, 1 / 30, 3 / 30, 1 / 30];
    expect(estimateFpsFromDeltas(d)).toBe(30);
    expect(estimateFpsFromDeltas([0.04])).toBeNull();
  });

  it('sampleTimes は [start,end) を fps 間隔で返す', () => {
    expect(sampleTimes(1, 2, 10)).toHaveLength(10);
    expect(sampleTimes(1, 2, 10)[0]).toBe(1);
    expect(sampleTimes(0, 0.01, 10)).toHaveLength(1);
    expect(sampleTimes(2, 1, 10)).toHaveLength(0);
    expect(Math.max(...sampleTimes(0, 5, 10, 3))).toBeLessThan(3);
  });

  it('遅延は累積で丸め、合計が正確になる', () => {
    const d = frameDelaysMs(15, 15);
    expect(d.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(frameDelaysMs(3, 50)).toEqual([20, 20, 20]);
  });

  it('重なる範囲は別の段に置く', () => {
    const { lanes, count } = assignLanes([
      { id: 1, start: 0, end: 5 },
      { id: 2, start: 3, end: 8 },
      { id: 3, start: 6, end: 9 },
    ]);
    expect(count).toBe(2);
    expect(lanes.get(1)).toBe(0);
    expect(lanes.get(2)).toBe(1);
    expect(lanes.get(3)).toBe(0);
  });

  it('formatClock', () => {
    expect(formatClock(61.5)).toBe('01:01.500');
  });
});
