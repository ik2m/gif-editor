/** 時間・フレーム変換などの純粋関数群 */

export type Unit = 'sec' | 'frame';

const EPS = 1e-6;

/** 時刻 t(秒) が属するフレーム番号（0始まり） */
export function timeToFrame(t: number, fps: number): number {
  return Math.max(0, Math.floor(t * fps + EPS));
}

/** フレーム f の開始時刻 */
export function frameToTime(f: number, fps: number): number {
  return f / fps;
}

/** フレーム f を表示するためのシーク位置（フレームの中央） */
export function frameSeekTime(f: number, fps: number): number {
  return (f + 0.5) / fps;
}

/** 範囲の終了時刻(排他) → 含まれる最後のフレーム番号 */
export function endTimeToLastFrame(end: number, start: number, fps: number): number {
  const last = Math.ceil(end * fps - EPS) - 1;
  return Math.max(timeToFrame(start, fps), last);
}

/** 時刻をフレーム境界にスナップ */
export function snapToFrame(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}

/** mm:ss.mmm 形式 */
export function formatClock(t: number): string {
  if (!Number.isFinite(t)) return '--:--.---';
  const sign = t < 0 ? '-' : '';
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${sign}${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const COMMON_FPS = [8, 10, 12, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];

/** 計測値を一般的なfpsに丸める（3%以内なら一般値、それ以外は小数2桁） */
export function snapFps(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 30;
  let best = COMMON_FPS[0];
  for (const c of COMMON_FPS) if (Math.abs(c - raw) < Math.abs(best - raw)) best = c;
  if (Math.abs(best - raw) / best <= 0.03) return best;
  return Math.round(raw * 100) / 100;
}

/** 計測したフレーム間隔(秒)の配列からfpsを推定 */
export function estimateFpsFromDeltas(deltas: number[]): number | null {
  const valid = deltas.filter((d) => d > 0.002 && d < 0.5).sort((a, b) => a - b);
  if (valid.length < 3) return null;
  // フレーム落ちで間隔が倍になるケースがあるため、下側の四分位を採用
  const q = valid[Math.floor((valid.length - 1) * 0.25)];
  return snapFps(1 / q);
}

/** GIF化のためのサンプリング時刻列 [start, end) */
export function sampleTimes(start: number, end: number, fps: number, duration = Infinity): number[] {
  const out: number[] = [];
  const len = end - start;
  if (!(len > 0) || !(fps > 0)) return out;
  const n = Math.max(1, Math.round(len * fps));
  const maxT = Math.max(0, duration - 0.001);
  for (let i = 0; i < n; i++) out.push(Math.min(start + i / fps, maxT));
  return out;
}

/**
 * GIFの遅延はセンチ秒単位。丸め誤差が蓄積しないよう累積値で各フレームの遅延(ms)を計算する。
 */
export function frameDelaysMs(count: number, fps: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = Math.round((i * 100) / fps);
    const b = Math.round(((i + 1) * 100) / fps);
    out.push(Math.max(2, b - a) * 10);
  }
  return out;
}

export interface Span {
  id: number;
  start: number;
  end: number;
}

/** 重なる範囲が見えるよう段（レーン）を割り当てる。作成順に先頭から空いている段へ。 */
export function assignLanes(spans: Span[]): { lanes: Map<number, number>; count: number } {
  const lanes = new Map<number, number>();
  const laneSpans: Span[][] = [];
  for (const s of [...spans].sort((a, b) => a.id - b.id)) {
    let lane = 0;
    while (laneSpans[lane]?.some((o) => s.start < o.end && o.start < s.end)) lane++;
    (laneSpans[lane] ??= []).push(s);
    lanes.set(s.id, lane);
  }
  return { lanes, count: Math.max(1, laneSpans.length) };
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'video';
}
