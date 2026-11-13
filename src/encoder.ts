import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { frameDelaysMs, sampleTimes } from './time';

export interface GifSettings {
  /** 出力フレームレート */
  fps: number;
  /** 出力横幅(px)。元動画より大きい場合は元サイズ */
  width: number;
  /** 無限ループするか */
  loop: boolean;
  /** パレット色数 (2-256) */
  colors: number;
}

export const DEFAULT_SETTINGS: GifSettings = { fps: 15, width: 480, loop: true, colors: 256 };

export function normalizeSettings(s: GifSettings): GifSettings {
  return {
    fps: clamp(Number(s.fps) || DEFAULT_SETTINGS.fps, 1, 50),
    width: Math.round(clamp(Number(s.width) || DEFAULT_SETTINGS.width, 16, 4096)),
    loop: !!s.loop,
    colors: Math.round(clamp(Number(s.colors) || 256, 2, 256)),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function outputSize(videoW: number, videoH: number, width: number): { w: number; h: number } {
  const w = Math.max(1, Math.min(width, videoW));
  const h = Math.max(1, Math.round((w * videoH) / videoW));
  return { w, h };
}

function seek(video: HTMLVideoElement, t: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('中止しました', 'AbortError'));
    let timer = 0;
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('動画のシークに失敗しました'));
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('中止しました', 'AbortError'));
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort);
    timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('シークがタイムアウトしました'));
    }, 10000);
    video.currentTime = t;
  });
}

/**
 * 動画の [start, end) を GIF にエンコードする。
 * video はプレビュー用とは別の要素を渡すこと（シークで再生位置を動かすため）。
 */
export async function encodeGif(
  video: HTMLVideoElement,
  start: number,
  end: number,
  settings: GifSettings,
  onProgress?: (ratio: number) => void,
  signal?: AbortSignal,
  /** 元動画のfps。フレーム境界ちょうどへのシークは直前のフレームが表示されることがあるため、半フレーム後ろを取得する */
  sourceFps?: number,
): Promise<Blob> {
  const s = normalizeSettings(settings);
  const { w, h } = outputSize(video.videoWidth, video.videoHeight, s.width);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas を初期化できません');
  ctx.imageSmoothingQuality = 'high';

  const times = sampleTimes(start, end, s.fps, video.duration);
  if (times.length === 0) throw new Error('範囲が空です');
  const delays = frameDelaysMs(times.length, s.fps);
  const gif = GIFEncoder();

  for (let i = 0; i < times.length; i++) {
    const t = sourceFps ? Math.min(times[i] + 0.5 / sourceFps, end - 1e-4, video.duration - 1e-3) : times[i];
    await seek(video, Math.max(0, t), signal);
    ctx.drawImage(video, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const palette = quantize(data, s.colors, { format: 'rgb565' });
    const index = applyPalette(data, palette, 'rgb565');
    gif.writeFrame(index, w, h, { palette, delay: delays[i], repeat: s.loop ? 0 : -1 });
    onProgress?.((i + 1) / times.length);
    // UI を固めないよう定期的に制御を返す
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}
