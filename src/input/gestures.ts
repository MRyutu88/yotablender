// Pointer Events → gestures. Touch is the primary input; mouse is supported for development
// (left = touch, middle = orbit, shift+middle or right = pan, wheel = zoom).
//
//   tap                  quick touch without moving
//   hold                 touch and keep still for HOLD_MS (opens the loupe in Edit Mode)
//   drag                 one finger moves past the slop distance
//   two-finger drag      pan + pinch zoom
//   2-finger tap         undo        3-finger tap   redo
//   2nd finger during a one-finger drag: precision mode (the drag continues)

export interface Pt {
  x: number;
  y: number;
}

export interface GestureHandler {
  /** Whether a hold should open (Edit Mode selection). If false, holds become drags. */
  wantsHold(p: Pt): boolean;
  /** Whether a second finger during a drag should be precision (transforms) or start pan/zoom. */
  dragKeepsSecondFinger(): boolean;
  tap(p: Pt): void;
  holdStart(p: Pt): void;
  holdMove(p: Pt): void;
  holdEnd(p: Pt, cancelled: boolean): void;
  dragStart(start: Pt, p: Pt): void;
  dragMove(p: Pt, precision: boolean): void;
  dragEnd(p: Pt, cancelled: boolean): void;
  pinch(dx: number, dy: number, scale: number, center: Pt): void;
  pinchEnd(): void;
  twoFingerTap(): void;
  threeFingerTap(): void;
  mouseOrbit(dx: number, dy: number): void;
  mousePan(dx: number, dy: number): void;
  wheel(deltaY: number, p: Pt): void;
  /** Any gesture began (used to dismiss transient UI). */
  touchDown?(p: Pt): void;
}

const SLOP = 9; // CSS px before a touch counts as a drag
const HOLD_MS = 190;
const MULTI_TAP_MS = 320;

type State = 'idle' | 'pending' | 'hold' | 'drag' | 'multi' | 'pinch' | 'drain' | 'mouseNav';

interface P {
  id: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
}

export class GestureRecognizer {
  private pts = new Map<number, P>();
  private state: State = 'idle';
  private primary = -1;
  private holdTimer = 0;
  private multiT0 = 0;
  private multiMax = 0;
  private multiMoved = false;
  private lastCenter: Pt = { x: 0, y: 0 };
  private lastSpread = 1;
  private mouseButton = -1;
  private mouseShift = false;

  constructor(
    private el: HTMLElement,
    private h: GestureHandler,
  ) {
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.cancel);
    el.addEventListener('lostpointercapture', this.lost);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private local(e: PointerEvent | WheelEvent): Pt {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private down = (e: PointerEvent) => {
    e.preventDefault();
    const p = this.local(e);
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (e.pointerType === 'mouse') {
      if (e.button === 1 || e.button === 2) {
        this.state = 'mouseNav';
        this.mouseButton = e.button;
        this.mouseShift = e.shiftKey;
        this.pts.set(e.pointerId, { id: e.pointerId, ...p, sx: p.x, sy: p.y });
        return;
      }
    }
    this.pts.set(e.pointerId, { id: e.pointerId, x: p.x, y: p.y, sx: p.x, sy: p.y });
    const n = this.pts.size;
    if (n === 1) {
      this.h.touchDown?.(p);
      this.state = 'pending';
      this.primary = e.pointerId;
      clearTimeout(this.holdTimer);
      // Mouse gets a longer hold so normal clicks never open the loupe.
      this.holdTimer = window.setTimeout(
        () => {
          if (this.state === 'pending' && this.h.wantsHold(p)) {
            this.state = 'hold';
            const cur = this.pts.get(this.primary);
            this.h.holdStart(cur ? { x: cur.x, y: cur.y } : p);
          }
        },
        e.pointerType === 'mouse' ? 450 : HOLD_MS,
      );
      return;
    }
    clearTimeout(this.holdTimer);
    if (this.state === 'drag') {
      if (this.h.dragKeepsSecondFinger()) return; // precision finger
      // Orbit/box drags hand over to pan/zoom.
      const cur = this.pts.get(this.primary)!;
      this.h.dragEnd({ x: cur.x, y: cur.y }, true);
      this.beginPinch();
      return;
    }
    if (this.state === 'hold') {
      const cur = this.pts.get(this.primary)!;
      this.h.holdEnd({ x: cur.x, y: cur.y }, true);
    }
    if (this.state === 'pending' || this.state === 'hold') {
      this.state = 'multi';
      this.multiT0 = performance.now();
      this.multiMax = n;
      this.multiMoved = false;
      this.resetPinchBaseline();
      return;
    }
    if (this.state === 'multi') {
      this.multiMax = Math.max(this.multiMax, n);
      this.resetPinchBaseline();
    } else if (this.state === 'pinch') {
      this.resetPinchBaseline();
    }
  };

  private move = (e: PointerEvent) => {
    const pt = this.pts.get(e.pointerId);
    if (!pt) return;
    e.preventDefault();
    const p = this.local(e);
    const dx = p.x - pt.x, dy = p.y - pt.y;
    pt.x = p.x;
    pt.y = p.y;
    switch (this.state) {
      case 'mouseNav':
        if (this.mouseButton === 2 || this.mouseShift || e.shiftKey) this.h.mousePan(dx, dy);
        else this.h.mouseOrbit(dx, dy);
        return;
      case 'pending':
        if (Math.hypot(p.x - pt.sx, p.y - pt.sy) > SLOP) {
          clearTimeout(this.holdTimer);
          this.state = 'drag';
          this.h.dragStart({ x: pt.sx, y: pt.sy }, p);
          this.h.dragMove(p, false);
        }
        return;
      case 'hold':
        if (e.pointerId === this.primary) this.h.holdMove(p);
        return;
      case 'drag':
        if (e.pointerId === this.primary) this.h.dragMove(p, this.pts.size > 1 || e.shiftKey);
        return;
      case 'multi': {
        const moved = [...this.pts.values()].some((q) => Math.hypot(q.x - q.sx, q.y - q.sy) > SLOP * 1.5);
        if (moved && this.pts.size >= 2) {
          this.multiMoved = true;
          this.state = 'pinch';
          this.resetPinchBaseline();
        }
        return;
      }
      case 'pinch':
        this.stepPinch();
        return;
    }
  };

  private up = (e: PointerEvent) => this.release(e, false);
  private cancel = (e: PointerEvent) => this.release(e, true);
  private lost = (e: PointerEvent) => {
    if (this.pts.has(e.pointerId)) this.release(e, true);
  };

  private release(e: PointerEvent, cancelled: boolean) {
    const pt = this.pts.get(e.pointerId);
    if (!pt) return;
    const p = { x: pt.x, y: pt.y };
    this.pts.delete(e.pointerId);
    switch (this.state) {
      case 'mouseNav':
        this.state = 'idle';
        break;
      case 'pending':
        clearTimeout(this.holdTimer);
        this.state = 'idle';
        if (!cancelled) this.h.tap(p);
        break;
      case 'hold':
        this.state = 'idle';
        this.h.holdEnd(p, cancelled);
        break;
      case 'drag':
        if (e.pointerId === this.primary) {
          this.h.dragEnd(p, cancelled);
          this.state = this.pts.size ? 'drain' : 'idle';
        }
        break;
      case 'multi':
        if (this.pts.size === 0) {
          const quick = performance.now() - this.multiT0 < MULTI_TAP_MS * 1.6;
          if (!cancelled && quick && !this.multiMoved) {
            if (this.multiMax >= 3) this.h.threeFingerTap();
            else if (this.multiMax === 2) this.h.twoFingerTap();
          }
          this.state = 'idle';
        }
        break;
      case 'pinch':
        if (this.pts.size < 2) {
          this.h.pinchEnd();
          this.state = this.pts.size ? 'drain' : 'idle';
        } else this.resetPinchBaseline();
        break;
      case 'drain':
        if (this.pts.size === 0) this.state = 'idle';
        break;
      default:
        if (this.pts.size === 0) this.state = 'idle';
    }
  }

  private beginPinch() {
    this.state = 'pinch';
    this.resetPinchBaseline();
  }

  private centerSpread(): { c: Pt; s: number } {
    const ps = [...this.pts.values()];
    const c = { x: 0, y: 0 };
    for (const q of ps) {
      c.x += q.x / ps.length;
      c.y += q.y / ps.length;
    }
    let s = 0;
    for (const q of ps) s += Math.hypot(q.x - c.x, q.y - c.y) / ps.length;
    return { c, s: Math.max(s, 1) };
  }

  private resetPinchBaseline() {
    const { c, s } = this.centerSpread();
    this.lastCenter = c;
    this.lastSpread = s;
  }

  private stepPinch() {
    if (this.pts.size < 2) return;
    const { c, s } = this.centerSpread();
    this.h.pinch(c.x - this.lastCenter.x, c.y - this.lastCenter.y, s / this.lastSpread, c);
    this.lastCenter = c;
    this.lastSpread = s;
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.h.wheel(e.deltaY * (e.deltaMode === 1 ? 33 : 1), this.local(e));
  };
}
