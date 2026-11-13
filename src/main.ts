import './style.css';
import { zipSync } from 'fflate';
import { DEFAULT_SETTINGS, encodeGif, normalizeSettings, outputSize, type GifSettings } from './encoder';
import { estimateFps, supportsFrameCallback } from './fps';
import { Timeline } from './timeline';
import {
  endTimeToLastFrame,
  formatBytes,
  formatClock,
  frameSeekTime,
  frameToTime,
  sampleTimes,
  sanitizeFileName,
  snapToFrame,
  timeToFrame,
  type Unit,
} from './time';

// ---------------------------------------------------------------- 状態

interface GifResult {
  key: string;
  blob: Blob;
  url: string;
}

interface Range {
  id: number;
  start: number;
  end: number;
  color: string;
  /** null のとき共通設定を使う */
  override: GifSettings | null;
  result: GifResult | null;
  job: { controller: AbortController; progress: number; queued: boolean } | null;
  error: string | null;
}

const COLORS = ['#4f8cff', '#ff7a45', '#36c98e', '#c06bff', '#ffc53d', '#ff5c8a', '#2fc6d6', '#9ccc3c'];

const state = {
  url: '' as string,
  fileName: '',
  duration: 0,
  vw: 0,
  vh: 0,
  fps: 30,
  fpsSource: 'default' as 'default' | 'estimated' | 'manual',
  unit: 'sec' as Unit,
  ranges: [] as Range[],
  selectedId: null as number | null,
  markIn: null as number | null,
  markOut: null as number | null,
  global: { ...DEFAULT_SETTINGS } as GifSettings,
  loopId: null as number | null,
  nextId: 1,
};

// ---------------------------------------------------------------- DOM

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const video = $<HTMLVideoElement>('#video');
const fileInput = $<HTMLInputElement>('#file-input');
const fileNameEl = $('#file-name');
const dropHint = $('#drop-hint');
const app = $('#app');
const clockEl = $('#clock');
const playBtn = $<HTMLButtonElement>('#btn-play');
const markInfo = $('#mark-info');
const addBtn = $<HTMLButtonElement>('#btn-add');
const fpsInput = $<HTMLInputElement>('#src-fps');
const fpsNote = $('#fps-note');
const listEl = $('#range-list');
const rangeCount = $('#range-count');
const zipBtn = $<HTMLButtonElement>('#btn-zip');
const zipStatus = $('#zip-status');
const videoInfo = $('#video-info');

/** エクスポート専用の video（プレビューの再生位置を乱さないため） */
const exportVideo = document.createElement('video');
exportVideo.muted = true;
exportVideo.preload = 'auto';
exportVideo.playsInline = true;

const timeline = new Timeline($('#timeline'), {
  onSeek: (t) => seekTo(t),
  onCreate: (a, b) => addRange(a, b),
  onChange: (id, a, b) => updateRange(id, a, b),
  onSelect: (id) => selectRange(id),
});

// ---------------------------------------------------------------- ユーティリティ

const curTime = () => video.currentTime || 0;
const curFrame = () => timeToFrame(curTime(), state.fps);
const findRange = (id: number) => state.ranges.find((r) => r.id === id);
const effective = (r: Range) => normalizeSettings(r.override ?? state.global);
const resultKey = (r: Range) => JSON.stringify([r.start, r.end, effective(r), state.url]);
const isFresh = (r: Range) => !!r.result && r.result.key === resultKey(r);
const hasVideo = () => !!state.url && state.duration > 0;

function fmtPos(t: number): string {
  return state.unit === 'frame' ? `F${timeToFrame(t, state.fps)}` : formatClock(t);
}

function rangeLabel(r: Range): string {
  if (state.unit === 'frame') return `F${timeToFrame(r.start, state.fps)}-F${endTimeToLastFrame(r.end, r.start, state.fps)}`;
  return `${r.start.toFixed(2)}s-${r.end.toFixed(2)}s`;
}

function lengthLabel(start: number, end: number): string {
  const frames = Math.max(0, Math.round((end - start) * state.fps));
  return `${(end - start).toFixed(2)}秒 / ${frames}F`;
}

function settingsLabel(s: GifSettings): string {
  const { w, h } = outputSize(state.vw || s.width, state.vh || s.width, s.width);
  return `${s.fps}fps・${w}×${h}・${s.colors}色・${s.loop ? 'ループ' : '1回'}`;
}

function clampRange(start: number, end: number): [number, number] {
  const minLen = 1 / state.fps;
  start = Math.max(0, Math.min(start, state.duration - minLen));
  end = Math.min(state.duration, Math.max(end, start + minLen));
  return [start, end];
}

// ---------------------------------------------------------------- 動画読み込み

async function loadFile(file: File): Promise<void> {
  if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(file.name)) {
    alert('動画ファイルを選択してください');
    return;
  }
  if (state.ranges.length && !confirm('新しい動画を開くと、現在の範囲はすべて削除されます。よろしいですか？')) return;

  for (const r of state.ranges) {
    r.job?.controller.abort();
    if (r.result) URL.revokeObjectURL(r.result.url);
  }
  if (state.url) URL.revokeObjectURL(state.url);

  Object.assign(state, {
    url: URL.createObjectURL(file),
    fileName: file.name,
    duration: 0,
    ranges: [],
    selectedId: null,
    markIn: null,
    markOut: null,
    loopId: null,
    fps: 30,
    fpsSource: 'default',
  });
  fileNameEl.textContent = file.name;
  video.src = state.url;
  exportVideo.src = state.url;
  rebuildList();
  render();

  try {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(new Error()), { once: true });
    });
  } catch {
    alert('この動画はブラウザで再生できない形式です（コーデック非対応の可能性があります）');
    return;
  }
  state.duration = video.duration;
  state.vw = video.videoWidth;
  state.vh = video.videoHeight;
  app.classList.add('has-video');
  render();

  const url = state.url;
  fpsNote.textContent = '推定中…';
  const est = await estimateFps(url);
  if (url !== state.url || state.fpsSource === 'manual') return;
  if (est) {
    state.fps = est;
    state.fpsSource = 'estimated';
  }
  render();
  syncRows();
}

// ---------------------------------------------------------------- 再生操作

function seekTo(t: number): void {
  if (!hasVideo()) return;
  stopLoop();
  const f = timeToFrame(Math.min(t, state.duration), state.fps);
  video.currentTime = Math.min(frameSeekTime(f, state.fps), Math.max(0, state.duration - 0.001));
  timeline.setTime(video.currentTime);
  renderClock();
}

function stepFrame(delta: number): void {
  if (!hasVideo()) return;
  video.pause();
  seekTo(frameToTime(Math.max(0, curFrame() + delta), state.fps));
}

function togglePlay(): void {
  if (!hasVideo()) return;
  if (video.paused) void video.play();
  else video.pause();
}

function toggleLoop(id: number): void {
  if (state.loopId === id) {
    stopLoop();
    video.pause();
    return;
  }
  const r = findRange(id);
  if (!r) return;
  selectRange(id);
  state.loopId = id;
  video.currentTime = r.start;
  void video.play();
  syncRows();
}

function stopLoop(): void {
  if (state.loopId === null) return;
  state.loopId = null;
  syncRows();
}

function tick(): void {
  if (state.loopId !== null && !video.paused) {
    const r = findRange(state.loopId);
    if (!r) stopLoop();
    else if (video.currentTime >= r.end || video.currentTime < r.start - 0.05 || video.ended) {
      video.currentTime = r.start;
      if (video.paused) void video.play();
    }
  }
  if (!video.paused) {
    timeline.setTime(video.currentTime);
    renderClock();
  }
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- 範囲操作

function setMark(which: 'in' | 'out'): void {
  if (!hasVideo()) return;
  const f = curFrame();
  if (which === 'in') state.markIn = frameToTime(f, state.fps);
  else state.markOut = Math.min(state.duration, frameToTime(f + 1, state.fps));
  render();
}

function addFromMarks(): void {
  if (!hasVideo()) return;
  let a = state.markIn ?? curTime();
  let b = state.markOut ?? state.duration;
  if (b < a) [a, b] = [b, a];
  if (b - a < 1 / state.fps - 1e-9) {
    alert('開始点と終了点の間隔が短すぎます');
    return;
  }
  addRange(a, b);
  state.markIn = null;
  state.markOut = null;
  render();
}

function addRange(start: number, end: number): void {
  if (!hasVideo()) return;
  [start, end] = clampRange(start, end);
  const id = state.nextId++;
  state.ranges.push({
    id,
    start,
    end,
    color: COLORS[(id - 1) % COLORS.length],
    override: null,
    result: null,
    job: null,
    error: null,
  });
  state.selectedId = id;
  rebuildList();
  render();
  listEl.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function updateRange(id: number, start: number, end: number): void {
  const r = findRange(id);
  if (!r) return;
  [r.start, r.end] = clampRange(start, end);
  r.error = null;
  render();
  syncRows();
}

function deleteRange(id: number): void {
  const i = state.ranges.findIndex((r) => r.id === id);
  if (i < 0) return;
  const [r] = state.ranges.splice(i, 1);
  r.job?.controller.abort();
  if (r.result) URL.revokeObjectURL(r.result.url);
  if (state.loopId === id) state.loopId = null;
  if (state.selectedId === id) state.selectedId = state.ranges[Math.min(i, state.ranges.length - 1)]?.id ?? null;
  rebuildList();
  render();
}

function selectRange(id: number): void {
  if (state.selectedId === id) return;
  state.selectedId = id;
  render();
  syncRows();
}

// ---------------------------------------------------------------- GIF 生成

let queue: Promise<unknown> = Promise.resolve();

/** 範囲の GIF を（必要なら）生成する。生成は直列に実行される。 */
function generate(r: Range): Promise<GifResult | null> {
  if (isFresh(r)) return Promise.resolve(r.result);
  if (r.job && !r.job.controller.signal.aborted) return waitJob(r);
  const controller = new AbortController();
  const job = { controller, progress: 0, queued: true };
  r.job = job;
  r.error = null;
  const release = () => {
    if (r.job === job) r.job = null;
    syncRows();
  };
  // 待機中に中止された場合はすぐに表示を戻す
  controller.signal.addEventListener('abort', () => job.queued && release());
  syncRows();

  const p = queue.then(async () => {
    if (controller.signal.aborted || !findRange(r.id)) {
      release();
      return null;
    }
    job.queued = false;
    syncRows();
    const key = resultKey(r);
    const s = effective(r);
    try {
      const blob = await encodeGif(
        exportVideo,
        r.start,
        r.end,
        s,
        (p) => {
          job.progress = p;
          syncRow(r);
        },
        controller.signal,
        state.fps,
      );
      if (r.result) URL.revokeObjectURL(r.result.url);
      r.result = { key, blob, url: URL.createObjectURL(blob) };
      return r.result;
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        r.error = e instanceof Error ? e.message : String(e);
        console.error(e);
      }
      return null;
    } finally {
      release();
    }
  });
  queue = p.catch(() => undefined);
  jobPromises.set(r.id, p);
  return p;
}

const jobPromises = new Map<number, Promise<GifResult | null>>();
const waitJob = (r: Range) => jobPromises.get(r.id) ?? Promise.resolve(null);

function fileNameFor(r: Range): string {
  const base = sanitizeFileName(state.fileName.replace(/\.[^.]+$/, ''));
  const idx = String(state.ranges.indexOf(r) + 1).padStart(2, '0');
  return `${base}_${idx}_${rangeLabel(r)}.gif`;
}

function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function exportOne(r: Range): Promise<void> {
  const res = await generate(r);
  if (res && findRange(r.id)) download(res.blob, fileNameFor(r));
}

let zipping = false;
async function exportZip(): Promise<void> {
  if (zipping || !state.ranges.length) return;
  zipping = true;
  syncToolbar();
  try {
    const targets = [...state.ranges];
    const results = await Promise.all(targets.map((r) => generate(r)));
    const files: Record<string, Uint8Array> = {};
    let ok = 0;
    for (let i = 0; i < targets.length; i++) {
      const res = results[i];
      if (!res || !findRange(targets[i].id)) continue;
      files[fileNameFor(targets[i])] = new Uint8Array(await res.blob.arrayBuffer());
      ok++;
    }
    if (!ok) {
      zipStatus.textContent = '出力できるGIFがありません';
      return;
    }
    const zip = zipSync(files, { level: 0 });
    const base = sanitizeFileName(state.fileName.replace(/\.[^.]+$/, ''));
    download(new Blob([zip], { type: 'application/zip' }), `${base}_gifs.zip`);
    zipStatus.textContent = ok < targets.length ? `${ok}/${targets.length}件を出力（失敗・中止あり）` : `${ok}件を出力しました`;
  } finally {
    zipping = false;
    syncToolbar();
  }
}

function cancelAll(): void {
  for (const r of state.ranges) r.job?.controller.abort();
}

// ---------------------------------------------------------------- 描画

function render(): void {
  timeline.render({
    duration: state.duration,
    fps: state.fps,
    currentTime: curTime(),
    ranges: state.ranges,
    selectedId: state.selectedId,
    markIn: state.markIn,
    markOut: state.markOut,
  });
  renderClock();
  if (document.activeElement !== fpsInput) fpsInput.value = String(state.fps);
  fpsNote.textContent =
    state.fpsSource === 'estimated'
      ? '（自動推定）'
      : state.fpsSource === 'manual'
        ? '（手動設定）'
        : supportsFrameCallback(video)
          ? '（既定値）'
          : '（既定値・このブラウザは推定非対応）';
  document.querySelectorAll<HTMLButtonElement>('[data-unit]').forEach((b) => b.classList.toggle('active', b.dataset.unit === state.unit));
  videoInfo.textContent = hasVideo() ? `${state.vw}×${state.vh} ・ ${formatClock(state.duration)} ・ 約${Math.round(state.duration * state.fps)}フレーム` : '';

  const { markIn, markOut } = state;
  markInfo.textContent =
    markIn === null && markOut === null
      ? '開始点・終了点は未設定'
      : `開始 ${markIn === null ? '—' : fmtPos(markIn)} ／ 終了 ${markOut === null ? '—' : state.unit === 'frame' ? `F${timeToFrame(markOut, state.fps) - 1}` : formatClock(markOut)}` +
        (markIn !== null && markOut !== null && markOut > markIn ? `（${lengthLabel(markIn, markOut)}）` : '');
  addBtn.disabled = !hasVideo();
  syncToolbar();
}

function renderClock(): void {
  const t = curTime();
  clockEl.textContent = hasVideo() ? `${formatClock(t)}  |  F${curFrame()}` : '--:--.---  |  F-';
}

function syncToolbar(): void {
  rangeCount.textContent = String(state.ranges.length);
  const busy = state.ranges.some((r) => r.job);
  zipBtn.disabled = !state.ranges.length || zipping;
  zipBtn.textContent = zipping ? 'ZIP作成中…' : 'すべてZIPで出力';
  $<HTMLButtonElement>('#btn-cancel-all').hidden = !busy;
  playBtn.textContent = video.paused ? '▶' : '❚❚';
}

// ---- 範囲リスト（入力中のフォーカスを失わないよう、構造変更時のみ再構築し、値は個別に同期する）

interface RowRefs {
  root: HTMLElement;
  len: HTMLElement;
  start: HTMLInputElement;
  end: HTMLInputElement;
  startUnit: HTMLElement;
  endUnit: HTMLElement;
  loopBtn: HTMLButtonElement;
  overrideChk: HTMLInputElement;
  overrideBox: HTMLElement;
  summary: HTMLElement;
  ov: SettingsInputs;
  exportBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
  progress: HTMLProgressElement;
  status: HTMLElement;
  thumb: HTMLImageElement;
}
const rows = new Map<number, RowRefs>();

interface SettingsInputs {
  fps: HTMLInputElement;
  width: HTMLInputElement;
  colors: HTMLSelectElement;
  loop: HTMLInputElement;
}

const settingsFieldsHtml = `
  <label>FPS <input type="number" data-k="fps" min="1" max="50" step="1"></label>
  <label>横幅(px) <input type="number" data-k="width" min="16" max="4096" step="1"></label>
  <label>色数 <select data-k="colors">
    <option value="256">256色</option><option value="128">128色</option><option value="64">64色</option>
    <option value="32">32色</option><option value="16">16色</option><option value="8">8色</option>
  </select></label>
  <label class="chk"><input type="checkbox" data-k="loop"> ループ</label>`;

function bindSettings(box: HTMLElement, get: () => GifSettings, onChange: () => void): SettingsInputs {
  const q = <T extends Element>(k: string) => box.querySelector<T & HTMLElement>(`[data-k="${k}"]`)! as unknown as T;
  const inputs: SettingsInputs = {
    fps: q<HTMLInputElement>('fps'),
    width: q<HTMLInputElement>('width'),
    colors: q<HTMLSelectElement>('colors'),
    loop: q<HTMLInputElement>('loop'),
  };
  const apply = () => {
    const s = get();
    s.fps = Number(inputs.fps.value) || s.fps;
    s.width = Number(inputs.width.value) || s.width;
    s.colors = Number(inputs.colors.value);
    s.loop = inputs.loop.checked;
    onChange();
  };
  inputs.fps.addEventListener('input', apply);
  inputs.width.addEventListener('input', apply);
  inputs.colors.addEventListener('change', apply);
  inputs.loop.addEventListener('change', apply);
  const fix = () => {
    Object.assign(get(), normalizeSettings(get()));
    writeSettings(inputs, get());
    onChange();
  };
  inputs.fps.addEventListener('change', fix);
  inputs.width.addEventListener('change', fix);
  return inputs;
}

function writeSettings(inputs: SettingsInputs, s: GifSettings): void {
  if (document.activeElement !== inputs.fps) inputs.fps.value = String(s.fps);
  if (document.activeElement !== inputs.width) inputs.width.value = String(s.width);
  inputs.colors.value = String(s.colors);
  inputs.loop.checked = s.loop;
}

function rebuildList(): void {
  rows.clear();
  listEl.innerHTML = '';
  if (!state.ranges.length) {
    listEl.innerHTML = `<p class="empty">${hasVideo() ? 'タイムラインの下段をドラッグするか、I / O キーで開始点・終了点を決めて「範囲を追加」してください。' : '動画を読み込むと範囲を追加できます。'}</p>`;
  }
  state.ranges.forEach((r) => listEl.appendChild(buildRow(r)));
  syncRows();
  syncToolbar();
}

function buildRow(r: Range): HTMLElement {
  const root = document.createElement('div');
  root.className = 'range-row';
  root.dataset.id = String(r.id);
  root.style.setProperty('--c', r.color);
  root.innerHTML = `
    <div class="row-head">
      <span class="swatch"></span>
      <span class="len"></span>
      <span class="spacer"></span>
      <button class="btn small" data-a="loop" title="この範囲をループ再生">▶ ループ</button>
      <button class="btn small ghost" data-a="del" title="削除">✕</button>
    </div>
    <div class="row-times">
      <label>開始 <input type="number" data-a="start" step="any" min="0"><em data-u="start"></em></label>
      <button class="btn small ghost" data-a="set-start" title="現在位置を開始にする">⇤ 現在位置</button>
      <label>終了 <input type="number" data-a="end" step="any" min="0"><em data-u="end"></em></label>
      <button class="btn small ghost" data-a="set-end" title="現在位置（を含むフレーム）を終了にする">現在位置 ⇥</button>
    </div>
    <div class="row-settings">
      <label class="chk"><input type="checkbox" data-a="override"> 個別設定</label>
      <span class="summary"></span>
      <div class="settings-grid override-box">${settingsFieldsHtml}</div>
    </div>
    <div class="row-out">
      <button class="btn primary" data-a="export">GIF出力</button>
      <button class="btn small ghost" data-a="cancel">中止</button>
      <progress max="1" value="0"></progress>
      <span class="status"></span>
    </div>
    <img class="thumb" alt="">`;
  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const overrideBox = q('.override-box');
  const refs: RowRefs = {
    root,
    len: q('.len'),
    start: q('[data-a="start"]'),
    end: q('[data-a="end"]'),
    startUnit: q('[data-u="start"]'),
    endUnit: q('[data-u="end"]'),
    loopBtn: q('[data-a="loop"]'),
    overrideChk: q('[data-a="override"]'),
    overrideBox,
    summary: q('.summary'),
    ov: bindSettings(
      overrideBox,
      () => (r.override ??= { ...state.global }),
      () => syncRow(r),
    ),
    exportBtn: q('[data-a="export"]'),
    cancelBtn: q('[data-a="cancel"]'),
    progress: q('progress'),
    status: q('.status'),
    thumb: q('.thumb'),
  };
  rows.set(r.id, refs);

  root.addEventListener('pointerdown', () => selectRange(r.id));
  root.addEventListener('focusin', () => selectRange(r.id));
  refs.loopBtn.onclick = () => toggleLoop(r.id);
  q<HTMLButtonElement>('[data-a="del"]').onclick = () => deleteRange(r.id);
  q<HTMLButtonElement>('[data-a="set-start"]').onclick = () => updateRange(r.id, frameToTime(curFrame(), state.fps), r.end);
  q<HTMLButtonElement>('[data-a="set-end"]').onclick = () => updateRange(r.id, r.start, frameToTime(curFrame() + 1, state.fps));
  refs.exportBtn.onclick = () => void exportOne(r);
  refs.cancelBtn.onclick = () => r.job?.controller.abort();
  refs.overrideChk.onchange = () => {
    r.override = refs.overrideChk.checked ? { ...state.global } : null;
    syncRow(r);
  };

  const onTimeInput = (which: 'start' | 'end', commit: boolean) => {
    const el = which === 'start' ? refs.start : refs.end;
    const v = Number(el.value);
    if (el.value === '' || !Number.isFinite(v)) return;
    let t: number;
    if (state.unit === 'frame') t = frameToTime(Math.round(v) + (which === 'end' ? 1 : 0), state.fps);
    else t = v;
    if (which === 'start') {
      if (!commit && t >= r.end) return;
      updateRange(r.id, t, Math.max(r.end, t + 1 / state.fps));
    } else {
      if (!commit && t <= r.start) return;
      updateRange(r.id, Math.min(r.start, t - 1 / state.fps), t);
    }
    if (!video.paused) video.pause();
    stopLoop();
    seekTo(which === 'start' ? r.start : r.end - 1 / state.fps);
  };
  refs.start.addEventListener('input', () => onTimeInput('start', false));
  refs.end.addEventListener('input', () => onTimeInput('end', false));
  refs.start.addEventListener('change', () => {
    onTimeInput('start', true);
    syncRow(r, true);
  });
  refs.end.addEventListener('change', () => {
    onTimeInput('end', true);
    syncRow(r, true);
  });
  return root;
}

function syncRows(): void {
  state.ranges.forEach((r) => syncRow(r));
  syncToolbar();
}

function syncRow(r: Range, force = false): void {
  const refs = rows.get(r.id);
  if (!refs) return;
  const idx = state.ranges.indexOf(r) + 1;
  refs.root.classList.toggle('selected', r.id === state.selectedId);
  refs.root.querySelector('.swatch')!.textContent = `#${idx}`;
  refs.len.textContent = lengthLabel(r.start, r.end);

  const frameMode = state.unit === 'frame';
  for (const [el, val] of [
    [refs.start, frameMode ? String(timeToFrame(r.start, state.fps)) : r.start.toFixed(3)],
    [refs.end, frameMode ? String(endTimeToLastFrame(r.end, r.start, state.fps)) : r.end.toFixed(3)],
  ] as const) {
    el.step = frameMode ? '1' : '0.001';
    if (force || document.activeElement !== el) el.value = val;
  }
  refs.startUnit.textContent = frameMode ? 'F' : '秒';
  refs.endUnit.textContent = frameMode ? 'F' : '秒';

  const looping = state.loopId === r.id;
  refs.loopBtn.textContent = looping ? '■ 停止' : '▶ ループ';
  refs.loopBtn.classList.toggle('active', looping);

  refs.overrideChk.checked = !!r.override;
  refs.overrideBox.hidden = !r.override;
  if (r.override) writeSettings(refs.ov, r.override);
  const eff = effective(r);
  const frames = sampleTimes(r.start, r.end, eff.fps, state.duration).length;
  refs.summary.textContent = `${r.override ? '' : '共通設定：'}${settingsLabel(eff)}・${frames}枚`;

  const fresh = isFresh(r);
  const job = r.job;
  refs.exportBtn.disabled = !!job;
  refs.exportBtn.textContent = fresh ? 'ダウンロード' : 'GIF出力';
  refs.cancelBtn.hidden = !job;
  refs.progress.hidden = !job;
  if (job) refs.progress.value = job.progress;
  refs.status.className = 'status';
  if (job) refs.status.textContent = job.queued ? '待機中…' : `生成中 ${Math.round(job.progress * 100)}%`;
  else if (r.error) {
    refs.status.textContent = `エラー: ${r.error}`;
    refs.status.classList.add('err');
  } else if (r.result) {
    refs.status.textContent = fresh ? `${formatBytes(r.result.blob.size)}` : `${formatBytes(r.result.blob.size)}（変更あり・再生成が必要）`;
    if (!fresh) refs.status.classList.add('stale');
  } else refs.status.textContent = '';

  if (r.result) {
    if (refs.thumb.getAttribute('src') !== r.result.url) refs.thumb.src = r.result.url;
    refs.thumb.hidden = false;
    refs.thumb.classList.toggle('stale', !fresh);
  } else {
    refs.thumb.hidden = true;
    refs.thumb.removeAttribute('src');
  }
}

// ---------------------------------------------------------------- イベント

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void loadFile(f);
  fileInput.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  app.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) app.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  app.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (f) void loadFile(f);
});
dropHint.addEventListener('click', () => fileInput.click());

video.addEventListener('play', syncToolbar);
video.addEventListener('pause', () => {
  // 一時停止位置をフレーム中央に揃え、表示中のフレームと I/O で記録されるフレームを一致させる
  if (hasVideo() && !video.seeking) video.currentTime = Math.min(frameSeekTime(curFrame(), state.fps), Math.max(0, state.duration - 0.001));
  syncToolbar();
  timeline.setTime(video.currentTime);
  renderClock();
});
video.addEventListener('seeked', () => {
  timeline.setTime(video.currentTime);
  renderClock();
});
video.addEventListener('click', togglePlay);

$('#btn-first').onclick = () => {
  video.pause();
  seekTo(0);
};
$('#btn-prev').onclick = () => stepFrame(-1);
$('#btn-next').onclick = () => stepFrame(1);
playBtn.onclick = togglePlay;
$('#btn-in').onclick = () => setMark('in');
$('#btn-out').onclick = () => setMark('out');
addBtn.onclick = addFromMarks;
$('#btn-clear-mark').onclick = () => {
  state.markIn = state.markOut = null;
  render();
};
zipBtn.onclick = () => void exportZip();
$('#btn-cancel-all').onclick = cancelAll;

document.querySelectorAll<HTMLButtonElement>('[data-unit]').forEach((b) =>
  b.addEventListener('click', () => {
    state.unit = b.dataset.unit as Unit;
    render();
    syncRows();
  }),
);

fpsInput.addEventListener('change', () => {
  const v = Number(fpsInput.value);
  if (!(v > 0 && v <= 240)) {
    fpsInput.value = String(state.fps);
    return;
  }
  state.fps = v;
  state.fpsSource = 'manual';
  // 範囲はフレーム境界に合わせ直す
  for (const r of state.ranges) [r.start, r.end] = clampRange(snapToFrame(r.start, v), snapToFrame(r.end, v));
  render();
  syncRows();
});

const globalBox = $('#global-settings');
globalBox.innerHTML = settingsFieldsHtml;
const globalInputs = bindSettings(
  globalBox,
  () => state.global,
  () => syncRows(),
);
writeSettings(globalInputs, state.global);

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const step = e.shiftKey ? Math.max(1, Math.round(state.fps)) : 1;
  switch (e.key) {
    case ' ':
    case 'k':
      togglePlay();
      break;
    case 'ArrowLeft':
    case ',':
      stepFrame(-step);
      break;
    case 'ArrowRight':
    case '.':
      stepFrame(step);
      break;
    case 'i':
    case 'I':
      setMark('in');
      break;
    case 'o':
    case 'O':
      setMark('out');
      break;
    case 'Enter':
      if (t.closest('button')) return;
      addFromMarks();
      break;
    case 'Escape':
      state.markIn = state.markOut = null;
      render();
      break;
    case 'Delete':
    case 'Backspace':
      if (state.selectedId !== null) deleteRange(state.selectedId);
      break;
    case 'l':
    case 'L':
      if (state.selectedId !== null) toggleLoop(state.selectedId);
      break;
    default:
      return;
  }
  e.preventDefault();
});

rebuildList();
render();
requestAnimationFrame(tick);
