// Unified input: keyboard on PC/laptop, floating joystick + buttons on touch devices.
// The game only reads: input.axis (x,y in -1..1), input.run, and input.consume() (one-shot actions).
import { CONFIG } from './config.js?v=202611282241';

export class Input {
  constructor(root = document) {
    this.keys = new Set();
    this.queue = [];
    this.touchAxis = { x: 0, y: 0 };
    this.touchRun = false;
    this.touchHeld = new Set();            // on-screen buttons currently pressed
    this.lastDevice = 'keyboard';
    this._bindKeyboard();
    this._bindTouch(root);
  }

  get axis() {
    const k = CONFIG.keys;
    const has = (list) => list.some((key) => this.keys.has(key));
    let x = (has(k.right) ? 1 : 0) - (has(k.left) ? 1 : 0);
    let y = (has(k.down) ? 1 : 0) - (has(k.up) ? 1 : 0);
    if (x || y) { const l = Math.hypot(x, y); return { x: x / l, y: y / l }; }
    return this.touchAxis;
  }
  get run() { return CONFIG.keys.run.some((key) => this.keys.has(key)) || this.touchRun; }
  get moving() { const a = this.axis; return Math.abs(a.x) > 0.01 || Math.abs(a.y) > 0.01; }

  // Is this action's key / touch button being held right now? (used for variable jump height)
  held(action) {
    return (CONFIG.keys[action] || []).some((k) => this.keys.has(k)) || this.touchHeld.has(action);
  }

  consume() { const q = this.queue; this.queue = []; return q; }
  push(action) { this.queue.push(action); }

  _bindKeyboard() {
    const actionFor = (key) => {
      for (const [action, list] of Object.entries(CONFIG.keys)) {
        if (['left', 'right', 'up', 'down', 'run'].includes(action)) continue;
        if (list.includes(key)) return action;
      }
      return null;
    };
    const prevent = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ']);
    // Letters are normalised to lower case: with Shift held the browser reports 'D' on press but 'd' on release
    // if Shift was let go first, which used to leave a "stuck" key and make Zee keep walking by herself.
    const norm = (k) => (k.length === 1 ? k.toLowerCase() : k);
    addEventListener('keydown', (e) => {
      if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
      this.lastDevice = 'keyboard';
      if (prevent.has(e.key)) e.preventDefault();
      if (e.repeat) return;
      const k = norm(e.key);
      this.keys.add(k);
      const action = actionFor(k);
      if (action) this.push(action);
    });
    addEventListener('keyup', (e) => { this.keys.delete(norm(e.key)); });
    addEventListener('blur', () => { this.keys.clear(); this.touchHeld.clear(); this.touchAxis = { x: 0, y: 0 }; });
  }

  _bindTouch(root) {
    const zone = root.getElementById('stick-zone');
    const stick = root.getElementById('stick');
    const knob = root.getElementById('stick-knob');
    const radius = 56;
    let stickId = null, origin = null;

    const update = (e) => {
      let dx = e.clientX - origin.x, dy = e.clientY - origin.y;
      const len = Math.hypot(dx, dy) || 1;
      const m = Math.min(1, len / radius);
      dx = (dx / len) * m; dy = (dy / len) * m;
      const dead = 0.18;
      const mag = Math.hypot(dx, dy);
      if (mag < dead) { this.touchAxis = { x: 0, y: 0 }; this.touchRun = false; }
      else { this.touchAxis = { x: dx, y: dy }; this.touchRun = mag >= CONFIG.zee.runThreshold; }
      knob.style.transform = `translate(${dx * radius}px, ${dy * radius}px)`;
    };
    zone.addEventListener('pointerdown', (e) => {
      if (stickId !== null) return;
      this.lastDevice = 'touch';
      // the joystick never moves: its centre is always the fixed base, wherever on the left side the thumb lands
      const r = stick.getBoundingClientRect();
      stickId = e.pointerId; origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      try { zone.setPointerCapture(e.pointerId); } catch (_) { /* synthetic or already-released pointer */ }
      stick.classList.add('on'); update(e); e.preventDefault();
    });
    zone.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) { update(e); e.preventDefault(); } });
    const end = (e) => {
      if (e.pointerId !== stickId) return;
      stickId = null; this.touchAxis = { x: 0, y: 0 }; this.touchRun = false;
      stick.classList.remove('on'); knob.style.transform = '';
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);

    root.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => {
        this.lastDevice = 'touch';
        e.preventDefault(); btn.classList.add('down');
        this.touchHeld.add(btn.dataset.action);
        this.push(btn.dataset.action);
      });
      const up = () => { btn.classList.remove('down'); this.touchHeld.delete(btn.dataset.action); };
      btn.addEventListener('pointerup', up); btn.addEventListener('pointercancel', up); btn.addEventListener('pointerleave', up);
    });
    // block the browser's own touch gestures (scroll, zoom, long-press menu) on the game surface
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
