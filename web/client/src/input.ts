/** Keyboard/mouse and touch input, reduced to "move vector + attack + potion" intents. */
export class Input {
  private keys = new Set<string>();
  private joy = { x: 0, z: 0, pointer: -1 };
  private attackHeld = false;
  private attackQueued = false;
  private potionQueued = false;
  /** Pointer position in normalized device coordinates, or null if the mouse never moved over the canvas. */
  aimNdc: { x: number; y: number } | null = null;
  lastDevice: 'mouse' | 'touch' = matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse';
  enabled = false;
  onKey: (key: string) => void = () => {};
  /** Fired immediately when the movement vector may have changed, so input is not delayed until the next frame. */
  onMoveChange: () => void = () => {};
  /** Fired immediately on an attack / potion press. */
  onAction: () => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      this.onKey(k);
      if (!this.enabled) return;
      this.keys.add(k);
      if (k === ' ') {
        this.attackQueued = true;
        e.preventDefault();
      }
      if (k === 'q') this.potionQueued = true;
      if (k.startsWith('arrow')) e.preventDefault();
      this.lastDevice = 'mouse';
      if (!e.repeat) {
        this.onMoveChange();
        if (k === ' ' || k === 'q') this.onAction();
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
      this.onMoveChange();
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.attackHeld = false;
    });

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.aimNdc = { x: (e.clientX / window.innerWidth) * 2 - 1, y: -(e.clientY / window.innerHeight) * 2 + 1 };
      this.lastDevice = 'mouse';
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button === 0 && this.enabled) {
        this.aimNdc = { x: (e.clientX / window.innerWidth) * 2 - 1, y: -(e.clientY / window.innerHeight) * 2 + 1 };
        this.attackHeld = true;
        this.attackQueued = true;
        this.onAction();
      }
    });
    window.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse') this.attackHeld = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.bindJoystick();
    this.bindTouchButton('btn-attack', () => {
      this.attackHeld = true;
      this.attackQueued = true;
    }, () => (this.attackHeld = false));
    this.bindTouchButton('btn-potion', () => (this.potionQueued = true));
  }

  private bindJoystick() {
    const pad = document.getElementById('joystick')!;
    const knob = document.getElementById('joystick-knob')!;
    const update = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect();
      const max = r.width / 2;
      let dx = e.clientX - (r.left + max);
      let dy = e.clientY - (r.top + max);
      const len = Math.hypot(dx, dy);
      if (len > max) {
        dx = (dx / len) * max;
        dy = (dy / len) * max;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const mag = Math.min(1, len / max);
      // 15% dead zone, then full analog range
      const scale = mag < 0.15 ? 0 : (mag - 0.15) / 0.85 / Math.max(mag, 1e-6);
      this.joy.x = (dx / max) * scale;
      this.joy.z = (dy / max) * scale;
      this.onMoveChange();
    };
    const reset = () => {
      this.joy = { x: 0, z: 0, pointer: -1 };
      knob.style.transform = '';
      this.onMoveChange();
    };
    pad.addEventListener('pointerdown', (e) => {
      pad.setPointerCapture(e.pointerId);
      this.joy.pointer = e.pointerId;
      this.lastDevice = 'touch';
      update(e);
    });
    pad.addEventListener('pointermove', (e) => e.pointerId === this.joy.pointer && update(e));
    pad.addEventListener('pointerup', reset);
    pad.addEventListener('pointercancel', reset);
  }

  private bindTouchButton(id: string, down: () => void, up?: () => void) {
    const el = document.getElementById(id)!;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      this.lastDevice = e.pointerType === 'mouse' ? 'mouse' : 'touch';
      if (this.enabled) {
        down();
        this.onAction();
      }
    });
    if (up) {
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }
  }

  /** Movement intent in world space (x = east, z = south), length <= 1. */
  move(): { x: number; z: number } {
    if (!this.enabled) return { x: 0, z: 0 };
    let x = 0;
    let z = 0;
    const k = this.keys;
    if (k.has('w') || k.has('arrowup')) z -= 1;
    if (k.has('s') || k.has('arrowdown')) z += 1;
    if (k.has('a') || k.has('arrowleft')) x -= 1;
    if (k.has('d') || k.has('arrowright')) x += 1;
    x += this.joy.x;
    z += this.joy.z;
    const len = Math.hypot(x, z);
    return len > 1 ? { x: x / len, z: z / len } : { x, z };
  }

  /** True once per press, and continuously while the attack button/mouse is held. */
  wantsAttack() {
    const v = this.attackQueued || this.attackHeld;
    this.attackQueued = false;
    return v && this.enabled;
  }

  wantsPotion() {
    const v = this.potionQueued;
    this.potionQueued = false;
    return v && this.enabled;
  }

  reset() {
    this.keys.clear();
    this.attackHeld = this.attackQueued = this.potionQueued = false;
  }
}
