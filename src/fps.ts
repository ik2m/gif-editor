import { estimateFpsFromDeltas } from './time';

type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback(cb: (now: number, meta: { mediaTime: number }) => void): number;
};

export function supportsFrameCallback(v: HTMLVideoElement): v is RVFCVideo {
  return 'requestVideoFrameCallback' in v;
}

/**
 * ブラウザは動画のfpsを公開していないため、ミュート再生してフレーム表示時刻の間隔から推定する。
 * 推定できない場合は null。
 */
export async function estimateFps(url: string, timeoutMs = 4000): Promise<number | null> {
  const v = document.createElement('video');
  if (!supportsFrameCallback(v)) return null;
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  // 合成されないとフレームコールバックが来ないブラウザがあるため、ごく小さく DOM に置く
  Object.assign(v.style, {
    position: 'fixed',
    right: '0',
    bottom: '0',
    width: '2px',
    height: '2px',
    opacity: '0.01',
    pointerEvents: 'none',
  });
  document.body.appendChild(v);
  v.src = url;

  const mediaTimes: number[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      v.addEventListener('loadeddata', () => resolve(), { once: true });
      v.addEventListener('error', () => reject(new Error('load error')), { once: true });
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const onFrame = (_: number, meta: { mediaTime: number }) => {
        mediaTimes.push(meta.mediaTime);
        if (mediaTimes.length >= 40 || v.ended) {
          clearTimeout(timer);
          resolve();
        } else {
          v.requestVideoFrameCallback(onFrame);
        }
      };
      v.requestVideoFrameCallback(onFrame);
      v.addEventListener('ended', () => {
        clearTimeout(timer);
        resolve();
      });
      v.play().catch(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch {
    return null;
  } finally {
    v.pause();
    v.removeAttribute('src');
    v.load();
    v.remove();
  }
  const deltas: number[] = [];
  for (let i = 1; i < mediaTimes.length; i++) deltas.push(mediaTimes[i] - mediaTimes[i - 1]);
  return estimateFpsFromDeltas(deltas);
}
