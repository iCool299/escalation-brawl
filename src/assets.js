// Loads a character's manifest + strips and turns them into ready-to-play animation objects.
// To swap art, replace the PNG strips / manifest in assets/characters/<name>/ - no code changes needed.
import { CONFIG } from './config.js?v=202611282241';

// Release stamp, taken from this module's own URL (?v=...): every release uses new URLs so browsers never serve stale files.
export const VERSION = new URL(import.meta.url).searchParams.get('v') || 'dev';
const stamp = (u) => u + '?v=' + VERSION;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load ' + src));
    img.src = stamp(src);
  });
}

export async function loadCharacter(baseUrl, id = 'zee') {
  const text = await (await fetch(stamp(baseUrl + id + '.manifest.json'))).text();
  const manifest = JSON.parse(text.replace(/^﻿/, ''));
  const images = {};
  await Promise.all(Object.entries(manifest.strips).map(async ([name, s]) => {
    images[name] = await loadImage(baseUrl + s.file);
  }));
  const anims = {};
  for (const [name, a] of Object.entries(manifest.animations)) {
    const frames = a.to - a.from + 1;
    const active = a.active || [];
    // wind-up frames (before the first hit frame) play faster so attacks connect without a laggy start
    const firstActive = active.length ? Math.min(...active) : 0;
    const starts = [0];
    for (let i = 0; i < frames; i++) {
      const d = (1 / a.fps) / (i < firstActive ? CONFIG.windupSpeed : 1);
      starts.push(starts[i] + d);
    }
    anims[name] = {
      name, img: images[a.strip], cols: manifest.strips[a.strip].cols || 99999, from: a.from, frames, fps: a.fps, loop: !!a.loop,
      loopFrom: a.loopFrom || 0, active, iframes: a.iframes || [], release: a.release || [], pingpong: !!a.pingpong,
      starts, duration: starts[frames],
    };
  }
  return { manifest, anims, cw: manifest.cell.w, ch: manifest.cell.h, anchor: manifest.anchor, scale: manifest.drawScale || 1, silhouettes: new Map(), tints: new Map() };
}

// Red-tinted copy of a frame (same pixels, coloured red), cached. Drawn over the normal sprite for the "got hit" flash.
export function tinted(character, anim, frame, white = false) {
  const key = anim.name + ':' + frame + (white ? ':w' : '');
  let s = character.tints.get(key);
  if (s) return s;
  const { cw, ch } = character;
  s = document.createElement('canvas'); s.width = cw; s.height = ch;
  const c = s.getContext('2d');
  const [sx, sy] = srcOf(anim, frame, cw, ch);
  c.drawImage(anim.img, sx, sy, cw, ch, 0, 0, cw, ch);
  c.globalCompositeOperation = 'source-atop';
  c.fillStyle = white ? 'rgba(255,255,255,0.92)' : 'rgba(255,48,48,0.75)'; c.fillRect(0, 0, cw, ch);
  character.tints.set(key, s);
  return s;
}

// Source rectangle of a frame inside its (grid-packed) strip.
function srcOf(anim, frame, cw, ch) {
  const i = anim.from + frame;
  return [(i % anim.cols) * cw, Math.floor(i / anim.cols) * ch];
}

// Black, half-resolution silhouette of a frame, built once and cached: used as the sprite's cast shadow.
export function silhouette(character, anim, frame) {
  const key = anim.name + ':' + frame;
  let s = character.silhouettes.get(key);
  if (s) return s;
  const { cw, ch } = character, w = cw >> 1, h = ch >> 1;
  s = document.createElement('canvas'); s.width = w; s.height = h;
  const c = s.getContext('2d');
  const [sx, sy] = srcOf(anim, frame, cw, ch);
  c.imageSmoothingQuality = 'high';
  c.drawImage(anim.img, sx, sy, cw, ch, 0, 0, w, h);
  c.globalCompositeOperation = 'source-in';
  c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
  character.silhouettes.set(key, s);
  return s;
}

// THE character shadow (Zee and every enemy use this one function, so there is exactly one shadow per character, built from three layers):
//   1. a wide, very soft pool of cool blue-black under the body (ambient occlusion),
//   2. a small darker contact core right under the feet,
//   3. a cast shadow from the character's own silhouette, falling away from the window light (LOOK.lightX) and drawn in three slightly
//      wider, fainter passes so its edge is soft (a penumbra) instead of a hard cut-out.
// Everything shrinks and fades as the character rises (jumps), the way a real shadow does.  lying = a long body on the floor.
const POOL = (() => {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(10,16,44,0.9)'); r.addColorStop(0.5, 'rgba(10,16,44,0.4)'); r.addColorStop(1, 'rgba(10,16,44,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64); return c;
})();
export function drawShadow(ctx, character, anim, frame, x, y, lift, face, lying, strength = 1) {
  const fade = Math.max(0.25, 1 - lift / 170) * strength, w = (lying ? 46 : 27) * (1 - Math.min(0.4, lift / 300));
  ctx.save();
  ctx.globalAlpha = 0.7 * fade; ctx.drawImage(POOL, x - w * 1.15, y - w * 0.3, w * 2.3, w * 0.6);              // 1. pool
  ctx.globalAlpha = 0.6 * fade; ctx.drawImage(POOL, x - w * 0.5, y - w * 0.1, w, w * 0.2);                     // 2. contact core
  const sil = silhouette(character, anim, frame), dw = character.cw * character.scale, dh = character.ch * character.scale;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  for (const [sk, wd, a] of [[1, 1, 0.2], [1.14, 1.07, 0.13], [1.3, 1.15, 0.08]]) {                            // 3. cast shadow, soft edge
    ctx.save(); ctx.translate(x, y); ctx.transform(1, 0, 0.5 * LOOK.lightX * sk, 0.3, 0, 0); ctx.scale(face * wd, 1);
    ctx.globalAlpha = a * fade; ctx.drawImage(sil, -character.anchor.x * character.scale, -character.anchor.y * character.scale, dw, dh); ctx.restore();
  }
  ctx.restore();
}

// Which frame (0-based inside the animation) is showing at time t.
export function frameAt(anim, t) {
  const { starts, frames } = anim;
  if (anim.pingpong && frames > 2) {                       // 0 1 2 1 0 1 2 ... : always seamless, no jump back to the start
    const p = Math.floor(t * anim.fps) % (2 * frames - 2);
    return p < frames ? p : 2 * frames - 2 - p;
  }
  if (t >= anim.duration) {
    if (!anim.loop) return frames - 1;
    const loopStart = starts[anim.loopFrom];
    t = loopStart + ((t - anim.duration) % (anim.duration - loopStart));
  }
  let f = 0;
  while (f < frames - 1 && t >= starts[f + 1]) f++;
  return f;
}

// x, y may be fractional: the canvas is rendered at display resolution so motion stays smooth.
// Frames are stored at 2x, so they are drawn at `scale` (0.5) game units per sprite pixel with smoothing on.
// ---------- lit rendering ("finish" pass, toggle with V) ----------
// One light for everyone: matching dark outline, a rim of light on the side facing the windows, darker towards the feet,
// a soft scene colour wash and a per-character colour grade so the whole cast shares one look.
export const LOOK = {
  on: true,
  lightX: -1, lightY: -0.55,                        // light comes from the back-top-left (the windows), in world space
  rim: 'rgb(215,232,255)', rimAlpha: 0.72, rimPx: 5,
  outline: '#0d0812', outlinePx: 3,
  feet: 0.42,                                    // how much darker the legs get towards the floor
  wash: 'rgba(60,70,130,0.16)',                  // scene colour wash (per level later)
  grade: { zee: '', default: 'saturate(0.9) contrast(1.04)' },   // enemies brought to Zee's saturation
};
// Per-room lighting: eases the lit look toward a room's light settings (rim / wash colours are [r,g,b] so they can blend).
const LIGHT = { rim: [215, 232, 255], wash: [60, 70, 130], washAlpha: 0.16, ready: false };
export function setLight(light, dt) {
  if (!light) return;
  const k = LIGHT.ready ? 1 - Math.exp(-dt * 3) : 1; LIGHT.ready = true;                 // the first call snaps, then it eases over ~0.5 s
  const mix = (a, b) => a + (b - a) * k;
  for (const key of ['lightX', 'lightY', 'rimAlpha', 'rimPx', 'feet']) if (light[key] !== undefined) LOOK[key] = mix(LOOK[key], light[key]);
  if (light.rim) LIGHT.rim = LIGHT.rim.map((v, i) => mix(v, light.rim[i]));
  if (light.wash) LIGHT.wash = LIGHT.wash.map((v, i) => mix(v, light.wash[i]));
  if (light.washAlpha !== undefined) LIGHT.washAlpha = mix(LIGHT.washAlpha, light.washAlpha);
  LOOK.rim = 'rgb(' + LIGHT.rim.map(Math.round).join(',') + ')';
  LOOK.wash = 'rgba(' + LIGHT.wash.map(Math.round).join(',') + ',' + LIGHT.washAlpha.toFixed(3) + ')';
}
let S1, S2;
function scratch(w, h) {
  if (!S1 || S1.width < w || S1.height < h) {
    for (const k of [0, 1]) { const c = document.createElement('canvas'); c.width = w; c.height = h; if (k) S2 = c; else S1 = c; }
  }
  const a = S1.getContext('2d'), b = S2.getContext('2d');
  a.setTransform(1, 0, 0, 1, 0, 0); b.setTransform(1, 0, 0, 1, 0, 0);
  a.globalCompositeOperation = b.globalCompositeOperation = 'source-over'; a.globalAlpha = b.globalAlpha = 1; a.filter = b.filter = 'none';
  a.clearRect(0, 0, w, h); b.clearRect(0, 0, w, h);
  return [a, b];
}
// builds the finished frame in S1 (cell-sized, unflipped). face decides which side the world light hits.
function litFrame(character, anim, frame, face) {
  const { cw, ch } = character, L = LOOK, [sx, sy] = srcOf(anim, frame, cw, ch), p = L.outlinePx;
  const W = cw + 2 * p, H = ch + 2 * p;
  const [a, b] = scratch(W, H);
  // B = dark silhouette (for the outline)
  b.drawImage(anim.img, sx, sy, cw, ch, p, p, cw, ch);
  b.globalCompositeOperation = 'source-in'; b.fillStyle = L.outline; b.fillRect(0, 0, W, H);
  // A = outline (silhouette stamped around), then the colour-graded sprite on top
  for (const [dx, dy] of [[-p, 0], [p, 0], [0, -p], [0, p]]) a.drawImage(S2, dx, dy);
  a.filter = L.grade[character.manifest.character] ?? L.grade.default;
  a.drawImage(anim.img, sx, sy, cw, ch, p, p, cw, ch);
  a.filter = 'none';
  // rim light: the sprite's own edge band on the side facing the light
  const lx = L.lightX * face, ly = L.lightY, r = L.rimPx;
  b.globalCompositeOperation = 'source-over'; b.clearRect(0, 0, W, H);
  b.drawImage(anim.img, sx, sy, cw, ch, p, p, cw, ch);
  b.globalCompositeOperation = 'source-in'; b.fillStyle = L.rim; b.fillRect(0, 0, W, H);
  b.globalCompositeOperation = 'destination-out'; b.drawImage(anim.img, sx, sy, cw, ch, p - lx * r, p - ly * r, cw, ch);
  a.globalCompositeOperation = 'source-atop'; a.globalAlpha = L.rimAlpha; a.drawImage(S2, 0, 0); a.globalAlpha = 1;
  // darker towards the feet + scene wash (only on the character's pixels)
  const g = a.createLinearGradient(0, ch * 0.45, 0, ch);
  g.addColorStop(0, 'rgba(10,6,20,0)'); g.addColorStop(1, `rgba(10,6,20,${L.feet})`);
  a.fillStyle = g; a.fillRect(0, 0, W, H);
  a.fillStyle = L.wash; a.fillRect(0, 0, W, H);
  a.globalCompositeOperation = 'source-over';
  return p;
}

export function drawAnim(ctx, character, anim, frame, x, y, face, alpha = 1, tint = 0, glow = 0) {
  // lit look for everything except faint motion-trail ghosts (a threshold that solid sprites never cross, so the look never blinks on and off)
  if (LOOK.on && alpha > 0.4) return drawLit(ctx, character, anim, frame, x, y, face, alpha, tint, glow);
  const { cw, ch, anchor, scale } = character;
  const [sx, sy] = srcOf(anim, frame, cw, ch);
  const dw = cw * scale, dh = ch * scale, ax = anchor.x * scale, ay = anchor.y * scale;
  // Snap to whole device pixels: a sprite drawn at a fractional position gets re-filtered every frame, which makes thin
  // lines and shading shimmer ("changing lines") while she moves. Whole-pixel positions keep every frame crisp and stable.
  const px = character.px || 1;
  x = Math.round(x * px) / px; y = Math.round(y * px) / px;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  if (alpha !== 1) ctx.globalAlpha = alpha;
  // hit flash: a quick white pop for the first instant, then a light red that fades (never a solid red silhouette)
  const pop = tint > 0.9, red = tint > 0.01 ? tinted(character, anim, frame, pop) : null, ta = pop ? 0.6 :Math.min(1, tint) * 0.5;
  if (face < 0) {
    ctx.save();
    ctx.translate(x, y); ctx.scale(-1, 1);
    ctx.drawImage(anim.img, sx, sy, cw, ch, -ax, -ay, dw, dh);
    if (red) { ctx.globalAlpha = alpha * ta; ctx.drawImage(red, 0, 0, cw, ch, -ax, -ay, dw, dh); }
    ctx.restore();
  } else {
    ctx.drawImage(anim.img, sx, sy, cw, ch, x - ax, y - ay, dw, dh);
    if (red) { ctx.globalAlpha = alpha * ta; ctx.drawImage(red, 0, 0, cw, ch, x - ax, y - ay, dw, dh); }
  }
  if (alpha !== 1 || red) ctx.globalAlpha = 1;
}

function drawLit(ctx, character, anim, frame, x, y, face, alpha, tint, glow = 0) {
  const { cw, ch, anchor, scale } = character;
  const p = litFrame(character, anim, frame, face);
  const px = character.px || 1;
  x = Math.round(x * px) / px; y = Math.round(y * px) / px;
  const W = cw + 2 * p, H = ch + 2 * p, ax = (anchor.x + p) * scale, ay = (anchor.y + p) * scale;
  const pop = tint > 0.9, red = tint > 0.01 ? tinted(character, anim, frame, pop) : null, ta = pop ? 0.6 : Math.min(1, tint) * 0.5;
  const [sx, sy] = srcOf(anim, frame, cw, ch);
  ctx.save();
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.translate(x, y); if (face < 0) ctx.scale(-1, 1);
  ctx.globalAlpha = alpha;
  ctx.drawImage(S1, 0, 0, W, H, -ax, -ay, W * scale, H * scale);
  if (red) { ctx.globalAlpha = alpha * ta; ctx.drawImage(red, 0, 0, cw, ch, -anchor.x * scale, -anchor.y * scale, cw * scale, ch * scale); }
  if (glow > 0.01) { ctx.globalAlpha = alpha * glow; ctx.drawImage(tinted(character, anim, frame, true), 0, 0, cw, ch, -anchor.x * scale, -anchor.y * scale, cw * scale, ch * scale); }   // soft white glow (invulnerable)
  ctx.restore();
}

