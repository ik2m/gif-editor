import { assignLanes, snapToFrame, type Span } from './time';

export interface TimelineRange extends Span {
  color: string;
}

export interface TimelineState {
  duration: number;
  fps: number;
  currentTime: number;
  ranges: TimelineRange[];
  selectedId: number | null;
  markIn: number | null;
  markOut: number | null;
}

export interface TimelineCallbacks {
  onSeek(t: number): void;
  onCreate(start: number, end: number): void;
  onChange(id: number, start: number, end: number): void;
  onSelect(id: number): void;
}

type Drag =
  | { kind: 'seek' }
  | { kind: 'create'; anchor: number; x0: number; moved: boolean; previewEl: HTMLElement }
  | { kind: 'move'; id: number; grab: number; len: number; x0: number; moved: boolean }
  | { kind: 'resize'; id: number; edge: 'start' | 'end' };

const LANE_H = 26;
const DRAG_PX = 4;

/** 目盛り・再生ヘッド・範囲（段組み）を描画し、ドラッグ操作を扱うタイムライン */
export class Timeline {
  readonly el: HTMLElement;
  private ruler: HTMLElement;
  private lanesEl: HTMLElement;
  private playhead: HTMLElement;
  private markEl: HTMLElement;
  private state: TimelineState | null = null;
  private drag: Drag | null = null;

  constructor(
    container: HTMLElement,
    private cb: TimelineCallbacks,
  ) {
    this.el = container;
    this.el.classList.add('timeline');
    this.el.innerHTML = `
      <div class="tl-ruler" title="クリック/ドラッグでシーク"></div>
      <div class="tl-lanes" title="空き部分をドラッグして範囲を作成"></div>
      <div class="tl-mark"></div>
      <div class="tl-playhead"></div>`;
    this.ruler = this.el.querySelector('.tl-ruler')!;
    this.lanesEl = this.el.querySelector('.tl-lanes')!;
    this.playhead = this.el.querySelector('.tl-playhead')!;
    this.markEl = this.el.querySelector('.tl-mark')!;
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('pointermove', (e) => this.onMove(e));
    this.el.addEventListener('pointerup', (e) => this.onUp(e));
    this.el.addEventListener('pointercancel', () => this.cancelDrag());
    new ResizeObserver(() => this.renderRuler()).observe(this.el);
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  render(state: TimelineState): void {
    const durationChanged = this.state?.duration !== state.duration;
    this.state = state;
    if (durationChanged) this.renderRuler();
    this.renderRanges();
    this.renderPlayhead();
  }

  /** 再生中の頻繁な更新用（再生ヘッドだけ動かす） */
  setTime(t: number): void {
    if (!this.state) return;
    this.state.currentTime = t;
    this.renderPlayhead();
  }

  private pct(t: number): string {
    const d = this.state?.duration || 1;
    return `${(Math.min(Math.max(t, 0), d) / d) * 100}%`;
  }

  private timeAt(clientX: number): number {
    const s = this.state!;
    const rect = this.el.getBoundingClientRect();
    const r = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.min(s.duration, snapToFrame(r * s.duration, s.fps));
  }

  private renderRuler(): void {
    const s = this.state;
    if (!s || !s.duration) {
      this.ruler.innerHTML = '';
      return;
    }
    const width = this.el.clientWidth || 600;
    const targetTicks = Math.max(2, Math.floor(width / 80));
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    const step = steps.find((st) => s.duration / st <= targetTicks) ?? 3600;
    let html = '';
    for (let t = 0; t <= s.duration + 1e-9; t += step) {
      const label = step < 1 ? t.toFixed(1) : t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : `${Math.round(t)}s`;
      html += `<span class="tl-tick" style="left:${this.pct(t)}"><i>${label}</i></span>`;
    }
    this.ruler.innerHTML = html;
  }

  private renderRanges(): void {
    const s = this.state!;
    const { lanes, count } = assignLanes(s.ranges);
    // 重なる範囲もドラッグで作れるよう、常に空の段を1つ下に用意する
    const laneCount = s.ranges.length ? count + 1 : 1;
    this.lanesEl.style.height = `${laneCount * LANE_H + 6}px`;
    const existing = new Map<number, HTMLElement>();
    this.lanesEl.querySelectorAll<HTMLElement>('.tl-range').forEach((el) => existing.set(Number(el.dataset.id), el));
    for (const r of s.ranges) {
      let el = existing.get(r.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'tl-range';
        el.dataset.id = String(r.id);
        el.innerHTML = `<span class="tl-handle" data-edge="start"></span><span class="tl-label"></span><span class="tl-handle" data-edge="end"></span>`;
        this.lanesEl.appendChild(el);
      }
      existing.delete(r.id);
      const idx = s.ranges.indexOf(r) + 1;
      el.style.left = this.pct(r.start);
      el.style.width = `calc(${this.pct(r.end)} - ${this.pct(r.start)})`;
      el.style.top = `${3 + (lanes.get(r.id) ?? 0) * LANE_H}px`;
      el.style.setProperty('--c', r.color);
      el.classList.toggle('selected', r.id === s.selectedId);
      el.querySelector('.tl-label')!.textContent = `#${idx}`;
    }
    existing.forEach((el) => el.remove());

    const { markIn, markOut } = s;
    if (markIn !== null || markOut !== null) {
      const a = markIn ?? markOut!;
      const b = markOut ?? markIn!;
      this.markEl.style.display = 'block';
      this.markEl.style.left = this.pct(Math.min(a, b));
      this.markEl.style.width = `calc(${this.pct(Math.max(a, b))} - ${this.pct(Math.min(a, b))})`;
      this.markEl.classList.toggle('point', markIn === null || markOut === null || a === b);
    } else {
      this.markEl.style.display = 'none';
    }
  }

  private renderPlayhead(): void {
    if (!this.state) return;
    this.playhead.style.left = this.pct(this.state.currentTime);
  }

  private onDown(e: PointerEvent): void {
    const s = this.state;
    if (!s || !s.duration || e.button !== 0) return;
    const target = e.target as HTMLElement;
    const t = this.timeAt(e.clientX);
    const rangeEl = target.closest<HTMLElement>('.tl-range');
    if (target.classList.contains('tl-handle') && rangeEl) {
      const id = Number(rangeEl.dataset.id);
      this.cb.onSelect(id);
      this.drag = { kind: 'resize', id, edge: target.dataset.edge as 'start' | 'end' };
    } else if (rangeEl) {
      const id = Number(rangeEl.dataset.id);
      const r = s.ranges.find((x) => x.id === id)!;
      this.cb.onSelect(id);
      this.drag = { kind: 'move', id, grab: t - r.start, len: r.end - r.start, x0: e.clientX, moved: false };
    } else if (target.closest('.tl-lanes')) {
      const previewEl = document.createElement('div');
      previewEl.className = 'tl-create';
      this.lanesEl.appendChild(previewEl);
      this.drag = { kind: 'create', anchor: t, x0: e.clientX, moved: false, previewEl };
    } else {
      this.drag = { kind: 'seek' };
      this.cb.onSeek(t);
    }
    this.el.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  private onMove(e: PointerEvent): void {
    const s = this.state;
    const d = this.drag;
    if (!s || !d) return;
    const t = this.timeAt(e.clientX);
    const minLen = 1 / s.fps;
    switch (d.kind) {
      case 'seek':
        this.cb.onSeek(t);
        break;
      case 'create': {
        if (!d.moved && Math.abs(e.clientX - d.x0) < DRAG_PX) return;
        d.moved = true;
        const a = Math.min(d.anchor, t);
        const b = Math.max(d.anchor, t);
        d.previewEl.style.left = this.pct(a);
        d.previewEl.style.width = `calc(${this.pct(b)} - ${this.pct(a)})`;
        break;
      }
      case 'move': {
        if (!d.moved && Math.abs(e.clientX - d.x0) < DRAG_PX) return;
        d.moved = true;
        const start = Math.min(Math.max(0, snapToFrame(t - d.grab, s.fps)), Math.max(0, s.duration - d.len));
        this.cb.onChange(d.id, start, start + d.len);
        break;
      }
      case 'resize': {
        const r = s.ranges.find((x) => x.id === d.id);
        if (!r) return;
        if (d.edge === 'start') this.cb.onChange(d.id, Math.min(t, r.end - minLen), r.end);
        else this.cb.onChange(d.id, r.start, Math.max(t, r.start + minLen));
        break;
      }
    }
  }

  private onUp(e: PointerEvent): void {
    const s = this.state;
    const d = this.drag;
    this.drag = null;
    if (!s || !d) return;
    const t = this.timeAt(e.clientX);
    if (d.kind === 'create') {
      d.previewEl.remove();
      if (d.moved) {
        const a = Math.min(d.anchor, t);
        const b = Math.max(d.anchor, t);
        if (b - a >= 1 / s.fps - 1e-9) this.cb.onCreate(a, b);
      } else {
        this.cb.onSeek(t);
      }
    } else if (d.kind === 'move' && !d.moved) {
      const r = s.ranges.find((x) => x.id === d.id);
      if (r) this.cb.onSeek(r.start);
    }
  }

  private cancelDrag(): void {
    if (this.drag?.kind === 'create') this.drag.previewEl.remove();
    this.drag = null;
  }
}
