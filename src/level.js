// Level = rooms laid out end to end in one continuous world, drawn through separate parallax layers.
//
// WORLD SCALE: 1 world unit = 1 layer pixel. Zee is ~132 units tall. The visible window is 900 x 506 units.
// Vertical layout of the 506-unit-tall world:
//   Y   0 - 205   upper architecture (ceiling, tall windows)
//   Y 205 - 325   background office furniture, doors, wall details (the wall's base line is Y 325)
//   Y 325 - 485   the walkable floor band: the Y of the characters' FEET
//   Y 485 - 506   floor in front of the band (foreground decoration may sit here, never in the band)
//
// LAYERS (tracks), drawn back to front:   far (sky, skyline)  >  arch (walls, windows, floor)  >  props (furniture, doors)
//   >  [characters, effects]  >  fore (foreground decoration, in FRONT of the characters).
// Each track has a parallax speed (1 = scrolls with the world, < 1 = further away and slower, > 1 = closer and faster).
//
// ROOMS: { id, name, width, doorRight: { locked }, art: { far, arch, props, fore } }
//   art.<track> is either a function (ctx, w, h, room) that draws the room's slice of that track in room-local units (the
//   temporary geometry below), or FINAL ART: a URL string (drawn at 1 image pixel = 1 world unit) or an object
//   { src, scale, x, y, smooth }: scale = world units per image pixel, x / y = where its top-left corner goes in the
//   room (world units, y may be negative to crop the top), smooth = true for painted art, false for crisp pixel art.
//   Image art is kept at its own pixel density (never resampled while it is baked into the layer).
//   light: { rim, rimAlpha, rimPx, lightX, lightY, wash, washAlpha, feet } = how Zee and the enemies are lit in this room
//   (rim / wash are [r,g,b]); the game eases from one room's light to the next (see setLight in assets.js).
//   doorRight is the door to the NEXT room: while it is locked the player cannot pass it; no door (or unlocked) = open.
import { CONFIG } from './config.js?v=202611282249';
import { VERSION } from './assets.js?v=202611282249';

const C = CONFIG.camera, F = CONFIG.floor;
export const LAYER_H = 507;                       // layer height in pixels (the view shows 506.25)
const WALL_MARGIN = 40;                           // how close to a wall the characters' feet can get
const TRACKS = [
  { id: 'far',   speed: 0.30, front: false },
  { id: 'arch',  speed: 1.00, front: false },
  { id: 'props', speed: 1.00, front: false },
  { id: 'fore',  speed: 1.12, front: true },
];

export class Level {
  constructor(rooms = []) {
    this.rooms = []; this.width = 0; this._pending = [];
    this.fx = { dof: true, rays: true, refl: true, ao: true, ambient: true, flare: true, bloom: true };      // finishing effects (key N turns them all off to compare)
    this.tracks = TRACKS.map((t) => ({ ...t, canvas: null, res: 1, smooth: false }));
    for (const r of rooms) this.addRoom(r, false);
    this.build();
  }

  get ready() { return Promise.all(this._pending); }          // resolves when every image layer has loaded

  // adds a room at the end of the level (seamless: the world just continues, layers are rebuilt)
  addRoom(room, rebuild = true) {
    room.x0 = this.width; this.rooms.push(room); this.width += room.width;
    if (rebuild) this.build();
  }

  // where the player's feet may go. Rooms joined by an open (or no) door form one big space; a locked door is a wall.
  boundsFor(x) {
    let i = this.rooms.findIndex((r) => x >= r.x0 && x < r.x0 + r.width);
    if (i < 0) i = x < 0 ? 0 : this.rooms.length - 1;
    let a = i, b = i;
    while (a > 0 && !(this.rooms[a - 1].doorRight && this.rooms[a - 1].doorRight.locked)) a--;
    while (b < this.rooms.length - 1 && !(this.rooms[b].doorRight && this.rooms[b].doorRight.locked)) b++;
    return { minX: this.rooms[a].x0 + WALL_MARGIN, maxX: this.rooms[b].x0 + this.rooms[b].width - WALL_MARGIN };
  }

  // every solid object of every room, in world units: { x0, x1, y0, y1, h }  (x0..x1 across, y0..y1 in depth on the floor band,
  // h = how high it is: a character whose feet are higher than h (a jump) passes over it; Infinity = never)
  obstacles() {
    const out = [];
    for (const r of this.rooms) for (const o of (r.obstacles || [])) out.push({ x0: r.x0 + o.x0, x1: r.x0 + o.x1, y0: o.y0 === undefined ? F.top - 20 : o.y0, y1: o.y1, h: o.h === undefined ? Infinity : o.h, name: o.name });
    return out;
  }

  roomAt(x) { return this.rooms.find((r) => x >= r.x0 && x < r.x0 + r.width) || this.rooms[this.rooms.length - 1]; }

  // renders every track into its own canvas. A track at speed s is  viewW + (levelW - viewW) * s  wide; each room paints the
  // slice of it that its part of the level scrolls past. Tracks nobody paints are skipped. A track's canvas uses the densest
  // pixel density of its image art (res = pixels per world unit), so the art is stored exactly as delivered.
  build() {
    this._pending = [];
    for (const t of this.tracks) {
      const arts = this.rooms.map((r) => r.art && r.art[t.id]).filter(Boolean);
      if (!arts.length) { t.canvas = null; continue; }
      t.res = Math.max(1, ...arts.map((a) => (a && a.src && a.scale ? 1 / a.scale : 1)));
      t.smooth = arts.some((a) => a && a.smooth);
      const wt = Math.max(C.viewW, Math.round(C.viewW + (this.width - C.viewW) * t.speed));
      const cv = document.createElement('canvas'); cv.width = Math.round(wt * t.res); cv.height = Math.round(LAYER_H * t.res);
      const c = cv.getContext('2d'); c.scale(t.res, t.res);             // from here on everything is in world units
      const edges = this.rooms.map((r) => Math.round(r.x0 * t.speed)); edges.push(wt);
      this.rooms.forEach((room, i) => this._paint(c, t, room, edges[i], edges[i + 1] - edges[i]));
      t.canvas = cv; t.dof = null; t.view = t.viewDof = null;
    }
    this._ready = false;
    Promise.all(this._pending).then(() => { this._bakeDof(); this._ready = true; });
  }

  // CRISP AT ANY SIZE: the browser would otherwise re-scale the big art every frame with a quality it may lower under load (the background went
  // soft after a while). Instead the art is scaled ONCE to the exact device size of the screen (halving steps + the best filter), and every
  // frame is a plain 1:1 copy at whole device pixels, so it can never change quality. Rebuilt only when the screen size changes.
  setScale(ppu) { if (Math.abs(ppu - (this.ppu || 0)) > 1e-4) this.ppu = ppu; }
  _scaleTo(src, f) {
    let c = src; const w = src.width * f, h = src.height * f;
    while (w < c.width / 2) { const n = this._canvas(Math.round(c.width / 2), Math.round(c.height / 2)), x = n.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, n.width, n.height); c = n; }
    const out = this._canvas(Math.round(w), Math.round(h)), o = out.getContext('2d'); o.imageSmoothingEnabled = true; o.imageSmoothingQuality = 'high'; o.drawImage(c, 0, 0, out.width, out.height);
    return out;
  }

  // DEPTH OF FIELD, baked once when the art has loaded: a softened copy of the wall layer whose opacity fades from 1 (high up, far away:
  // ceiling, windows, skyline) to 0 at Y 340 (the furniture and the floor band stay perfectly sharp). Drawn over the sharp layer = a slight blur
  // that increases with distance. A blur by shrinking and enlarging with smoothing (works in every browser, no canvas filter needed).
  _bakeDof() {
    const t = this.tracks.find((x) => x.id === 'arch');
    if (!t || !t.canvas) return;
    const w = t.canvas.width, h = t.canvas.height;
    const shrink = (src, k) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(src.width / k)); c.height = Math.max(1, Math.round(src.height / k)); const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height); return c; };
    const d = document.createElement('canvas'); d.width = w; d.height = h;
    const dc = d.getContext('2d'); dc.imageSmoothingEnabled = true; dc.imageSmoothingQuality = 'high';
    dc.drawImage(shrink(shrink(t.canvas, 2), 2), 0, 0, w, h);                  // 4x down and back up
    dc.globalCompositeOperation = 'destination-in';
    const g = dc.createLinearGradient(0, 0, 0, h), r = t.res / h;
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(Math.min(1, 240 * r), 'rgba(0,0,0,1)'); g.addColorStop(Math.min(1, 340 * r), 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    dc.fillStyle = g; dc.fillRect(0, 0, w, h);
    t.dof = d;
  }
  _paint(c, t, room, u0, w) {
    const art = room.art && room.art[t.id];
    if (!art || w <= 0) return;
    if (typeof art !== 'function') {                  // final art: an image URL, or { src, scale, x, y, smooth }
      const spec = typeof art === 'string' ? { src: art, scale: 1 } : art;
      this._pending.push(new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          c.save(); c.beginPath(); c.rect(u0, 0, w, LAYER_H); c.clip();
          c.imageSmoothingEnabled = !!spec.smooth; c.imageSmoothingQuality = 'high';
          const k = spec.scale || 1;
          c.drawImage(img, u0 + (spec.x || 0), spec.y || 0, img.width * k, img.height * k);
          c.restore(); resolve();
        };
        img.onerror = () => { console.error('level art failed to load: ' + spec.src); resolve(); };
        img.src = spec.src.startsWith('data:') ? spec.src : spec.src + '?v=' + VERSION;
      }));
      return;
    }
    c.save(); c.translate(u0, 0); c.beginPath(); c.rect(0, 0, w, LAYER_H); c.clip(); art(c, w, LAYER_H, room); c.restore();
  }

  // ctx must already have the camera's world transform. camX = the camera's x in world units (device-pixel aligned).
  // blur = motion blur length in world units (0 = none): the layer is drawn several times shifted along the motion and averaged
  // (tap i is drawn at opacity 1/(i+1), which makes every tap count the same). Closer layers move more, so they smear more.
  drawBack(ctx, camX, blur = 0) { this._draw(ctx, camX, false, blur); }
  drawFront(ctx, camX, blur = 0) { this._draw(ctx, camX, true, blur); }
  _draw(ctx, camX, front, blur) {
    for (const t of this.tracks) {
      if (t.front !== front || !t.canvas) continue;
      ctx.imageSmoothingEnabled = t.smooth; ctx.imageSmoothingQuality = 'high';    // painted art is smoothed; pixel art stays crisp (nearest)
      const maxSx = t.canvas.width / t.res - C.viewW, base = t.speed * camX, b = blur * t.speed;
      const n = b < 0.5 ? 1 : Math.min(7, Math.ceil(b * 1.6) + 1);
      const dof = this.fx.dof && t.dof;
      const p = this.ppu;
      if (this._ready && p) {
        if (t.vppu !== p || !t.view || (t.dof && !t.viewDof)) { t.view = this._scaleTo(t.canvas, p / t.res); t.viewDof = t.dof ? this._scaleTo(t.dof, p / t.res) : null; t.vppu = p; }
        const tr = ctx.getTransform(), vw = Math.round(C.viewW * p), vh = Math.min(t.view.height, Math.round(C.viewH * p));
        const dx = Math.round(tr.e + camX * p), dy = Math.round(tr.f);
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;       // plain 1:1 copy at whole device pixels
        for (let i = 0; i < n; i++) {
          const sx = Math.max(0, Math.min(t.view.width - vw, Math.round((base + (n > 1 ? (i / (n - 1) - 0.5) * b : 0)) * p)));
          ctx.globalAlpha = 1 / (i + 1);
          ctx.drawImage(t.view, sx, 0, vw, vh, dx, dy, vw, vh);
          if (dof && t.viewDof) ctx.drawImage(t.viewDof, sx, 0, vw, vh, dx, dy, vw, vh);
        }
        ctx.restore(); continue;
      }
      for (let i = 0; i < n; i++) {
        const sx = Math.max(0, Math.min(maxSx, base + (n > 1 ? (i / (n - 1) - 0.5) * b : 0)));
        ctx.globalAlpha = 1 / (i + 1);
        ctx.drawImage(t.canvas, sx * t.res, 0, C.viewW * t.res, C.viewH * t.res, camX, 0, C.viewW, C.viewH);
        if (dof) ctx.drawImage(t.dof, sx * t.res, 0, C.viewW * t.res, C.viewH * t.res, camX, 0, C.viewW, C.viewH);
      }
      ctx.globalAlpha = 1;
    }
    ctx.imageSmoothingEnabled = false;
  }

  // ---- helpers for the finishing effects ----
  _canvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; }
  // a soft blur that works everywhere (shrink, then enlarge with smoothing)
  _soften(src, k) {
    const s = this._canvas(src.width / k, src.height / k), sc = s.getContext('2d'); sc.imageSmoothingQuality = 'high'; sc.drawImage(src, 0, 0, s.width, s.height);
    const d = this._canvas(src.width, src.height), dc = d.getContext('2d'); dc.imageSmoothingEnabled = true; dc.imageSmoothingQuality = 'high'; dc.drawImage(s, 0, 0, d.width, d.height);
    return d;
  }

  // SUNLIGHT SHAFTS are painted ONCE into two soft textures (every other shaft in each), already blurred, so they have no hard edges
  // at all; the two textures breathe against each other, so the light slowly shifts. spec: rays: { color, alpha, top, bot, dx, floorY, shafts, motes }
  _rayTex(R) {
    if (R._tex) return R._tex;
    const S = 0.5, [cr, cg, cb] = R.color, lo = Math.min(...R.shafts.map((s) => s.x)) + R.dx - 70, hi = Math.max(...R.shafts.map((s) => s.x + s.w * 1.4)) + 70;
    const top = R.top, H = R.bot - R.top + 30, W = hi - lo;
    const set = (parity) => {
      const c = this._canvas(W * S, H * S), x = c.getContext('2d'); x.scale(S, S); x.translate(-lo, -top);
      const g = x.createLinearGradient(0, top, 0, R.bot);
      g.addColorStop(0, `rgba(${cr},${cg},${cb},0)`); g.addColorStop(0.2, `rgba(${cr},${cg},${cb},0.8)`); g.addColorStop(0.65, `rgba(${cr},${cg},${cb},0.5)`); g.addColorStop(1, `rgba(${cr},${cg},${cb},0.1)`);
      R.shafts.forEach((s, i) => {
        if (i % 2 !== parity) return;
        const grow = 1.4; x.globalAlpha = s.a === undefined ? 1 : s.a; x.fillStyle = g; x.beginPath();
        x.moveTo(s.x, top); x.lineTo(s.x + s.w, top); x.lineTo(s.x + s.w * grow + R.dx, R.bot); x.lineTo(s.x - s.w * (grow - 1) + R.dx, R.bot); x.closePath(); x.fill();
        if (R.floorY) {                                                // where it lands: a soft pool of light on the floor
          x.save(); x.translate(s.x + s.w * 0.5 + R.dx * (R.floorY - top) / (R.bot - top), R.floorY); x.scale(1, 0.22);
          const rx = s.w * 1.2 + 20, rg = x.createRadialGradient(0, 0, 0, 0, 0, rx);
          rg.addColorStop(0, `rgba(${cr},${cg},${cb},0.9)`); rg.addColorStop(1, `rgba(${cr},${cg},${cb},0)`); x.fillStyle = rg; x.beginPath(); x.arc(0, 0, rx, 0, 6.2832); x.fill(); x.restore();
        }
      });
      return this._soften(this._soften(c, 3), 2);                      // heavy blur: no edges, just glow
    };
    return (R._tex = { a: set(0), b: set(1), lo, top, w: W, h: H });
  }

  // Everything that is BEHIND the characters: soft contact shadows under the furniture, the reflection drifting across the window glass,
  // the glow of the ceiling lights (they flicker now and then) and the monitors (a screensaver). room.ambient = { lamps, monitors, glass }.
  drawAmbient(ctx, time, camX) {
    for (const room of this.rooms) {
      if (room.x0 + room.width < camX || room.x0 > camX + C.viewW) continue;
      const A = room.ambient, x0 = room.x0;
      if (this.fx.ao) {                                                // ambient occlusion: a soft dark pool on the floor at the foot of every object
        ctx.save();
        for (const o of (room.obstacles || [])) {
          const base = o.base !== undefined ? o.base : o.y1 - 16, cx = x0 + (o.x0 + o.x1) / 2, rx = (o.x1 - o.x0) / 2 + 12;
          ctx.save(); ctx.translate(cx, base + 1); ctx.scale(1, 0.1);
          const g = ctx.createRadialGradient(0, 0, rx * 0.25, 0, 0, rx);
          g.addColorStop(0, 'rgba(14,26,70,0.42)'); g.addColorStop(0.7, 'rgba(14,26,70,0.2)'); g.addColorStop(1, 'rgba(14,26,70,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rx, 0, 6.2832); ctx.fill(); ctx.restore();
          // the cast shadow: the window light comes from the left, so each object throws a soft shadow along the floor to its right (taller = longer)
          const len = Math.min(o.h === Infinity ? 90 : o.h, 90) * 0.7, ex = x0 + o.x1;
          const sg = ctx.createLinearGradient(ex - 6, 0, ex + len, 0); sg.addColorStop(0, 'rgba(14,26,70,0.2)'); sg.addColorStop(1, 'rgba(14,26,70,0)');
          ctx.fillStyle = sg; ctx.beginPath(); ctx.moveTo(ex - 6, base - 5); ctx.lineTo(ex + len * 0.8, base - 1); ctx.lineTo(ex + len, base + 9); ctx.lineTo(ex - 6, base + 8); ctx.closePath(); ctx.fill();
        }
        ctx.restore();
      }
      if (!A || !this.fx.ambient) continue;
      if (A.monitors) A.monitors.forEach((m, i) => {                  // screensaver: a dim blue screen with a little bouncing badge
        const tri = (v, mx) => { const p = ((v % (2 * mx)) + 2 * mx) % (2 * mx); return p < mx ? p : 2 * mx - p; };
        ctx.save(); ctx.beginPath(); ctx.rect(x0 + m.x, m.y, m.w, m.h); ctx.clip();
        const g = ctx.createLinearGradient(0, m.y, 0, m.y + m.h); g.addColorStop(0, '#16345f'); g.addColorStop(1, '#0c1d3c');
        ctx.globalAlpha = 0.92; ctx.fillStyle = g; ctx.fillRect(x0 + m.x, m.y, m.w, m.h);
        const bx = x0 + m.x + 2 + tri(time * 9 + i * 31, m.w - 14), by = m.y + 2 + tri(time * 6 + i * 17, m.h - 9);
        ctx.globalAlpha = 1; ctx.fillStyle = '#5fb7ff'; ctx.fillRect(bx, by, 12, 6); ctx.fillStyle = '#d6efff'; ctx.fillRect(bx + 1, by + 1, 10, 1.5);
        ctx.restore();
        ctx.save(); ctx.globalCompositeOperation = 'lighter'; const cx = x0 + m.x + m.w / 2, cy = m.y + m.h / 2 + 14, r = m.w * 1.1;      // screen glow on the desk
        const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r); rg.addColorStop(0, 'rgba(110,180,255,0.16)'); rg.addColorStop(1, 'rgba(110,180,255,0)');
        ctx.fillStyle = rg; ctx.fillRect(cx - r, cy - r, r * 2, r * 2); ctx.restore();
      });
      if (A.lamps) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; A.lamps.forEach((l, i) => {
        const h = Math.sin(Math.floor(time * 9 + i * 7) * 12.9898) * 43758.5453, rnd = h - Math.floor(h);      // a rare, short flicker (a different light each time)
        const f = rnd < 0.035 ? 0.35 : 1 - 0.04 * Math.sin(time * 3 + i), cx = x0 + l.x + l.w / 2, r = l.w * 0.85;
        ctx.save(); ctx.translate(cx, l.y + 10); ctx.scale(1, 0.5);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r); g.addColorStop(0, `rgba(190,225,255,${0.2 * f})`); g.addColorStop(1, 'rgba(190,225,255,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.2832); ctx.fill(); ctx.restore();
      }); ctx.restore(); }
      if (A.glass) {                                                   // a faint highlight slowly drifting across the window panes (like clouds / the sky reflecting)
        const G = A.glass; ctx.save(); ctx.beginPath(); ctx.rect(x0 + G.x0, G.y0, G.x1 - G.x0, G.y1 - G.y0); ctx.clip(); ctx.globalCompositeOperation = 'lighter';
        const span = G.x1 - G.x0 + 300;
        for (let b = 0; b < 2; b++) {
          const px = x0 + G.x0 - 150 + (((time * (7 + b * 3) + b * span * 0.5) % span) + span) % span, sk = (G.y1 - G.y0) * 0.5;
          const g = ctx.createLinearGradient(px, 0, px + 110, 0); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.07)'); g.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(px + sk, G.y0); ctx.lineTo(px + 110 + sk, G.y0); ctx.lineTo(px + 110, G.y1); ctx.lineTo(px, G.y1); ctx.closePath(); ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  // Everything IN FRONT of the characters: the sunlight shafts (drawn with "screen", so they only ever brighten and blend into the colours
  // underneath, characters included), lens flares where the light comes in, and drifting dust motes.
  drawLight(ctx, time, camX) {
    for (const room of this.rooms) {
      const R = room.rays;
      if (!R || room.x0 + room.width < camX || room.x0 > camX + C.viewW) continue;
      const x0 = room.x0, [cr, cg, cb] = R.color;
      ctx.save();
      if (this.fx.rays) {
        const T = this._rayTex(R); ctx.globalCompositeOperation = 'screen'; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        const ba = 0.5 + 0.5 * Math.sin(time * 0.35), bb = 0.5 + 0.5 * Math.sin(time * 0.27 + 2.1);        // the two sets breathe slowly, out of step
        ctx.globalAlpha = R.alpha * (0.75 + 0.25 * ba); ctx.drawImage(T.a, x0 + T.lo, T.top, T.w, T.h);
        ctx.globalAlpha = R.alpha * (0.75 + 0.25 * bb); ctx.drawImage(T.b, x0 + T.lo, T.top, T.w, T.h);
        // dust motes: tiny specks drifting in the air, much brighter while inside the light
        ctx.globalCompositeOperation = 'lighter'; const H = R.bot - R.top;
        if (!R._m) { R._m = []; const lo = Math.min(...R.shafts.map((s) => s.x)) + R.dx, hi = Math.max(...R.shafts.map((s) => s.x + s.w)); for (let i = 0; i < (R.motes || 0); i++) R._m.push({ x: lo + Math.random() * (hi - lo), y: R.top + Math.random() * H, ph: Math.random() * 6.28, sp: 2 + Math.random() * 5, r: 0.5 + Math.random() * 0.8 }); R._lo = lo; R._hi = hi; R._t = time; }
        const dt = Math.min(0.1, Math.max(0, time - R._t)); R._t = time;
        for (const m of R._m) {
          m.y += m.sp * 0.35 * dt; m.x += (Math.sin(time * 0.4 + m.ph) * 2.2 - 1.6) * dt;
          if (m.y > R.bot) { m.y = R.top; m.x = R._lo + Math.random() * (R._hi - R._lo); } if (m.x < R._lo - 40) m.x = R._hi;
          let inside = 0.2; for (const s of R.shafts) { const f = (m.y - R.top) / H, a = s.x + R.dx * f, b = a + s.w * (1 + 0.4 * f); if (m.x > a && m.x < b) { inside = 1; break; } }
          ctx.globalAlpha = (0.2 + 0.8 * (0.5 + 0.5 * Math.sin(time * 1.7 + m.ph))) * inside * 0.6 * Math.min(1, (m.y - R.top) / 40);
          ctx.fillStyle = `rgb(${cr},${cg},${cb})`; ctx.beginPath(); ctx.arc(x0 + m.x, m.y, m.r, 0, 6.2832); ctx.fill();
        }
      }
      // lens flares: a soft glow with a thin horizontal streak where the sun comes in, plus faint ghosts mirrored through the middle of the screen
      if (this.fx.flare && room.ambient && room.ambient.flares) {
        ctx.globalCompositeOperation = 'lighter'; const cxv = camX + C.viewW / 2, cyv = C.viewH / 2;
        room.ambient.flares.forEach((f, i) => {
          const fx = x0 + f.x; if (fx < camX - 120 || fx > camX + C.viewW + 120) return;
          const k = (f.s || 1) * (0.8 + 0.2 * Math.sin(time * 0.6 + i * 2));
          const glow = (x, y, r, a) => { const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, `rgba(255,240,205,${a})`); g.addColorStop(1, 'rgba(255,240,205,0)'); ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2); };
          glow(fx, f.y, 46 * k, 0.2 * k); ctx.save(); ctx.translate(fx, f.y); ctx.scale(1, 0.05); glow(0, 0, 150 * k, 0.32 * k); ctx.restore();
          for (const [t, r, a, col] of [[-0.35, 14, 0.08, '160,210,255'], [-0.7, 22, 0.06, '255,210,160'], [-1.1, 9, 0.07, '190,255,220']]) {
            const gx = cxv + (fx - cxv) * t, gy = cyv + (f.y - cyv) * t, g = ctx.createRadialGradient(gx, gy, r * 0.5, gx, gy, r);
            g.addColorStop(0, `rgba(${col},0)`); g.addColorStop(0.75, `rgba(${col},${a * k})`); g.addColorStop(1, `rgba(${col},0)`); ctx.fillStyle = g; ctx.fillRect(gx - r, gy - r, r * 2, r * 2);
          }
        });
      }
      ctx.restore();
    }
  }
}

// ======================================================================================================================
// TEMPORARY ART: simple geometry in the right proportions, until the final level art is ready.
// ======================================================================================================================
const BASE = F.top - 2;                           // the wall's base line, where furniture stands

function farArt(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, 0, F.top); g.addColorStop(0, '#2aa8ff'); g.addColorStop(0.6, '#8fd8ff'); g.addColorStop(1, '#e2f6ff');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  const cloud = (x, y, s) => { ctx.fillStyle = 'rgba(255,255,255,0.96)'; for (const [dx, dy, r] of [[0, 0, 26], [30, -10, 32], [64, 0, 28], [34, 8, 30]]) { ctx.beginPath(); ctx.arc(x + dx * s, y + dy * s, r * s, 0, 6.283); ctx.fill(); } };
  for (let i = 0; i * 260 < w; i++) cloud(40 + i * 260 + ((i * 97) % 70), 50 + ((i * 53) % 90), 0.8 + ((i * 31) % 5) / 10);
  const cols = ['#ffb3c7', '#ffd59e', '#a8e6cf', '#c3b1ff', '#ffe9a8', '#9fd8ff'];
  for (let x = 0, i = 0; x < w; i++) {              // pastel skyline
    const bw = 60 + ((i * 37) % 50), bh = 70 + ((i * 53) % 110);
    ctx.fillStyle = cols[i % cols.length]; ctx.fillRect(x, F.top - bh, bw, bh);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (let wy = F.top - bh + 10; wy < F.top - 10; wy += 16) for (let wx = x + 8; wx < x + bw - 8; wx += 14) ctx.fillRect(wx, wy, 6, 8);
    x += bw + 6;
  }
}

function archArt(ctx, w, h) {
  ctx.fillStyle = '#ffe3c8'; ctx.fillRect(0, 0, w, 205);                       // upper wall
  ctx.fillStyle = '#9ee3d6'; ctx.fillRect(0, 205, w, F.top - 205);              // lower wall (furniture band)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 203, w, 4);                        // chair rail
  ctx.fillStyle = '#f6f8ff'; ctx.fillRect(0, 0, w, 24); ctx.fillStyle = '#d7dff5'; ctx.fillRect(0, 24, w, 4);   // ceiling
  ctx.fillStyle = '#fffbe0'; for (let x = 80; x < w - 100; x += 300) ctx.fillRect(x, 6, 120, 10);                // ceiling lights
  for (let x = 70; x + 150 <= w - 40; x += 250) {                               // tall windows: glass is cut out so the far layer shows through
    ctx.fillStyle = '#ffffff'; ctx.fillRect(x - 8, 40, 166, 158);
    ctx.clearRect(x, 48, 150, 140);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(x + 73, 48, 4, 140); ctx.fillRect(x, 112, 150, 4);
    ctx.fillStyle = '#e9d5bb'; ctx.fillRect(x - 14, 196, 178, 8);
  }
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, F.top - 8, w, 8); ctx.fillStyle = '#cdb99d'; ctx.fillRect(0, F.top - 2, w, 2);   // baseboard
  const fl = ctx.createLinearGradient(0, F.top, 0, h); fl.addColorStop(0, '#d9d3e8'); fl.addColorStop(1, '#c4bcd9');
  ctx.fillStyle = fl; ctx.fillRect(0, F.top, w, h - F.top);                     // floor (calm: lower contrast than the characters)
  ctx.strokeStyle = 'rgba(70,60,110,0.10)'; ctx.lineWidth = 1;
  for (let y = F.top + 32; y < h; y += 32) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke(); }
  for (let x = 0; x < w; x += 90) { ctx.beginPath(); ctx.moveTo(x + 0.5, F.top); ctx.lineTo(x + 0.5, h); ctx.stroke(); }
}

function door(ctx, x, locked) {                    // 74 x 150 units: taller than Zee (132), so it reaches above the 205 line
  ctx.fillStyle = '#7a5a46'; ctx.fillRect(x - 6, BASE - 156, 86, 156);
  ctx.fillStyle = locked ? '#e0707a' : '#4fc3d9'; ctx.fillRect(x, BASE - 150, 74, 150);
  ctx.fillStyle = '#bfeef7'; ctx.fillRect(x + 14, BASE - 128, 46, 58);
  ctx.fillStyle = '#ffd24a'; ctx.fillRect(x + 60, BASE - 72, 6, 14);
  ctx.fillStyle = '#1f9d55'; ctx.fillRect(x + 12, BASE - 176, 50, 13);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 10px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('EXIT', x + 37, BASE - 166);
}
function desk(ctx, x) {                            // 140 wide, 56 tall (about 0.45 of Zee's height)
  ctx.fillStyle = '#8fb8ff'; ctx.fillRect(x - 8, BASE - 96, 6, 96);                                  // cubicle partition
  ctx.fillStyle = '#d9a066'; ctx.fillRect(x + 6, BASE - 48, 128, 48);
  ctx.fillStyle = '#b8824a'; ctx.fillRect(x + 66, BASE - 46, 2, 44);
  ctx.fillStyle = '#f2c48e'; ctx.fillRect(x, BASE - 56, 140, 8);
  ctx.fillStyle = '#c9ccd6'; ctx.fillRect(x + 60, BASE - 66, 20, 10);
  ctx.fillStyle = '#2b3a6b'; ctx.fillRect(x + 36, BASE - 106, 68, 42);
  ctx.fillStyle = '#16204a'; ctx.fillRect(x + 39, BASE - 103, 62, 36);
  const bars = ['#5fcf6a', '#e8c34a', '#e2574c', '#5fcf6a', '#5fcf6a'];                              // a little score graph on the monitor
  bars.forEach((c, i) => { const bh = 8 + ((i * 13) % 20); ctx.fillStyle = c; ctx.fillRect(x + 45 + i * 11, BASE - 70 - bh, 7, bh); });
  ctx.fillStyle = '#eef0f6'; ctx.fillRect(x + 44, BASE - 60, 52, 4);                                 // keyboard
}
function propsArt(ctx, w, h) {
  door(ctx, 70, false); door(ctx, w - 144, true);
  for (let i = 0; i < 5; i++) desk(ctx, 230 + i * 250);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(1000, 214, 190, 82); ctx.fillStyle = '#7a5a46'; ctx.fillRect(996, 210, 198, 4); ctx.fillRect(996, 296, 198, 4);   // whiteboard
  ctx.fillStyle = '#2b3a6b'; ctx.font = 'bold 15px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('SCORES', 1095, 236);
  [['#5fcf6a', 120], ['#e8c34a', 96], ['#e2574c', 62], ['#5fcf6a', 138]].forEach(([c, len], i) => { ctx.fillStyle = c; ctx.fillRect(1016, 246 + i * 12, len, 8); });
  ctx.fillStyle = '#aab4cf'; ctx.fillRect(1300, BASE - 104, 58, 104); ctx.fillStyle = '#8a95b4'; for (let i = 0; i < 3; i++) ctx.fillRect(1306, BASE - 98 + i * 33, 46, 28);   // filing cabinet
  ctx.fillStyle = '#e9f4ff'; ctx.fillRect(1420, BASE - 66, 32, 66); ctx.fillStyle = '#5ab8ff'; ctx.fillRect(1424, BASE - 100, 24, 34);   // water cooler
  const poster = (x, c, t) => { ctx.fillStyle = '#ffffff'; ctx.fillRect(x, 216, 38, 50); ctx.fillStyle = c; ctx.font = 'bold 22px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(t, x + 19, 248); };
  poster(180, '#e2574c', 'F'); poster(470, '#5fcf6a', 'A+'); poster(740, '#e8c34a', 'B'); poster(1500, '#5fcf6a', 'A');
  for (const x of [190, 1260]) { ctx.fillStyle = '#c0724a'; ctx.fillRect(x, BASE - 24, 28, 24); ctx.fillStyle = '#3fae5a'; for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.ellipse(x + 14 + (i - 2) * 7, BASE - 40 - (i % 2) * 8, 6, 18, (i - 2) * 0.3, 0, 6.283); ctx.fill(); } }   // plants
}
function foreArt(ctx, w, h) {                      // foreground: ceiling lamps at the top and a shaded floor edge at the bottom; nothing inside the fighting band
  for (let x = 140; x < w; x += 330) {
    ctx.strokeStyle = '#6b6580'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 32); ctx.stroke();
    ctx.fillStyle = '#ffd24a'; ctx.beginPath(); ctx.moveTo(x - 22, 50); ctx.lineTo(x - 10, 30); ctx.lineTo(x + 10, 30); ctx.lineTo(x + 22, 50); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,240,170,0.35)'; ctx.fillRect(x - 14, 50, 28, 4);
  }
  const g = ctx.createLinearGradient(0, F.bottom + 2, 0, h); g.addColorStop(0, 'rgba(40,30,70,0)'); g.addColorStop(1, 'rgba(40,30,70,0.35)');
  ctx.fillStyle = g; ctx.fillRect(0, F.bottom + 2, w, h - F.bottom - 2);
}

// A temporary room (simple geometry in the right proportions) for tests, and for rooms that have no final art yet
export function tempRoom(id, name, width) {
  return { id, name, width, doorRight: { locked: true }, art: { far: farArt, arch: archArt, props: propsArt, fore: foreArt } };
}

// R01 Quality Department: final art, a single 2000 x 667 px image (assets/levels/r01_quality_department.webp).
// SCALE: 0.78 world units per image pixel, so furniture is at real size next to Zee (132 units = 169 image px): desk ~ 60 units,
// chair back ~ 78, filing cabinet ~ 100. The room is 2000 * 0.78 = 1560 units wide. y puts the image's bottom edge on the bottom of
// the view (Y 506.25), which crops the top ~18 px (the very top of the ceiling) and puts the wall / floor line (image y ~484)
// at Y ~364 and the furniture feet (image y ~491) at Y ~369, which is where CONFIG.floor.top (366) comes from.
// The window view, furniture and the door are painted into this one image, so for now it is one layer (no parallax in the windows).
// TWO DOORS (painted in, both shrunk to a real 0.9 x 2.1 m door, 96 x 215 px, foot at image y 497 = world Y ~374, 168 tall = 1.27x Zee):
//   right door: frame x 1840-1935 in the image = world x 1435-1509; left door: frame x 50-145 = world x 39-113. Card readers beside them.
//   (Which door connects to R02 is decided later; the other is part of the wall for now.)
const R01_SCALE = 0.78, R01_W = 2000, R01_H = 667;
export function qualityDepartment() {
  return {
    id: 'R01', name: 'Quality Department', width: Math.round(R01_W * R01_SCALE), doorRight: { locked: true },
    art: { arch: { src: 'assets/levels/r01_quality_department.webp', scale: R01_SCALE, y: C.viewH - R01_H * R01_SCALE, smooth: true } },
    // SUNLIGHT SHAFTS from the tall windows (glass spans x 273-1018, Y 80-298). The floor patches painted in the art slant down-left, so the shafts do too.
    rays: {
      color: [255, 244, 214], alpha: 0.42, top: 84, bot: 478, dx: -150, floorY: 440, motes: 70,
      shafts: [{ x: 292, w: 46, a: 0.8 }, { x: 372, w: 34, a: 0.6 }, { x: 436, w: 70, a: 1 }, { x: 540, w: 38, a: 0.7 }, { x: 604, w: 62, a: 0.95 }, { x: 690, w: 44, a: 0.6 }, { x: 760, w: 80, a: 1 }, { x: 866, w: 38, a: 0.7 }, { x: 930, w: 56, a: 0.85 }],
    },
    // FLOOR: glossy tiles, so the characters get a mirror image under their feet (0 = matte, 1 = mirror).
    reflect: 0.32,
    // AMBIENT LIFE (world units, measured from the art): ceiling lights (x, y, w), monitor screens, the window glass, and where the sun flares.
    ambient: {
      lamps: [{ x: 447, y: 52, w: 175 }, { x: 1009, y: 50, w: 139 }, { x: 1377, y: 50, w: 121 }],
      monitors: [{ x: 392, y: 264, w: 57, h: 31 }, { x: 755, y: 263, w: 51, h: 31 }],
      glass: { x0: 273, y0: 80, x1: 1018, y1: 298 },
      flares: [{ x: 440, y: 98, s: 1 }, { x: 790, y: 92, s: 1.2 }, { x: 960, y: 100, s: 0.8 }],
    },
    // SOLID OBJECTS (room-local world units; measured from the art, press B in the game to see the boxes). Everything stands against the
    // back wall, so each box covers the object's footprint plus a little depth (y1 = the front edge). h = height: Zee's full jump
    // reaches ~115, so desks, chairs, pots and counters can be jumped over; the pillar, the printer and the tall cabinet cannot.
    obstacles: [
      { name: 'pillar',        x0: 168,  x1: 273,  y1: 392, h: Infinity },
      { name: 'plant pot',     x0: 199,  x1: 242,  y1: 394, h: 45 },
      { name: 'desk 1 + chair', x0: 328, x1: 534,  y1: 390, h: 55 },
      { name: 'printer',       x0: 581,  x1: 647,  y1: 388, h: 80 },
      { name: 'desk 2 + chair', x0: 686, x1: 897,  y1: 390, h: 55 },
      { name: 'tall cabinet',  x0: 917,  x1: 983,  y1: 388, h: Infinity },
      { name: 'low cabinet',   x0: 1002, x1: 1127, y1: 386, h: 50 },
      { name: 'counter',       x0: 1197, x1: 1334, y1: 386, h: 55 },
    ],
    // LIGHT (read from the art): a bright, cool white-blue room (floor ~ rgb 131,165,210, walls ~ 136,173,218, sky ~ 96,173,234).
    // Sunlight comes through the tall windows on the LEFT (top-left, matching how the sprites are shaded; the bright sun patches are on
    // the left of the floor), so the rim light is a soft warm white against a cool blue ambient. The floor is bright and glossy, so legs
    // are shaded less than usual.
    light: { rim: [255, 242, 208], rimAlpha: 0.6, rimPx: 4, lightX: -1, lightY: -0.5, wash: [92, 148, 232], washAlpha: 0.13, feet: 0.22 },
  };
}
