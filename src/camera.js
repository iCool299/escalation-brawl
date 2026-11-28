// The world camera. The world is drawn through a zoomed-out camera (CONFIG.camera.zoom, about 0.71): 900 x 506 world units
// are visible and rendered into the 640 x 360 screen. The camera follows Zee horizontally (with a little look-ahead in the
// direction she faces) and is clamped to the level. It never scrolls vertically: the world is exactly one screen tall.
import { CONFIG } from './config.js?v=202611282249';

export class Camera {
  constructor() { this.x = 0; this.px = 0; this.gx = 0; this.look = 0; this.ready = false; }

  // zx = Zee's (interpolated) x in world units, face = her facing (-1 / 1), dt = frame time (s),
  // levelW = total level width, ppu = device pixels per world unit
  update(zx, face, dt, levelW, ppu) {
    const C = CONFIG.camera, maxX = Math.max(0, levelW - C.viewW);
    this.look += ((face || 1) * C.lookAhead - this.look) * (1 - Math.exp(-dt * 2.5));
    const target = Math.max(0, Math.min(maxX, zx + this.look - C.viewW / 2));
    this.x = this.ready ? this.x + (target - this.x) * (1 - Math.exp(-dt * C.follow)) : target;
    this.ready = true;
    this.x = Math.max(0, Math.min(maxX, this.x));
    // snap to whole device pixels so sprites and backgrounds never shimmer against each other while scrolling
    this.px = Math.round(this.x * ppu);   // device pixels
    this.gx = this.px / ppu;              // the same position in world units
  }
}
