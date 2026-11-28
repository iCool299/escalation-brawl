// Game shell: loads Zee, runs the loop, draws the placeholder office + HUD, wires pause / touch UI.
import { CONFIG } from './config.js?v=202611282249';
import { loadCharacter, VERSION, LOOK, setLight } from './assets.js?v=202611282249';
import { Input } from './input.js?v=202611282249';
import { Zee } from './zee.js?v=202611282249';
import { Game } from './game.js?v=202611282249';
import { ENEMY_IDS } from './enemy.js?v=202611282249';
import { drawHud as drawArcadeHud } from './hud.js?v=202611282249';
import { Level, qualityDepartment } from './level.js?v=202611282249';
import { Camera } from './camera.js?v=202611282249';
import { unlock } from './sfx.js?v=202611282249';

const { w: W, h: H } = CONFIG.view;
const canvas = document.getElementById('game');
// NOT desynchronized: that low-latency mode can show a frame while it is still being drawn, so the sprites and HUD
// flickered (the screen sometimes showed just the background). Normal buffering only ever shows finished frames.
const ctx = canvas.getContext('2d', { alpha: false });
let k = 1;                                        // device pixels per SCREEN unit (the 640 x 360 logical screen; the canvas renders at display resolution)
let ppu = 1;                                      // device pixels per WORLD unit = k * camera zoom (the world is drawn zoomed out, about 0.71)

const $ = (id) => document.getElementById(id);
const loadedEnemyChars = [];
const input = new Input(document);
let character, zee, game;
const enemyChars = new Map();                     // id -> Promise<character>, loaded on demand (and preloaded in the background)
let paused = false;
let last = performance.now();

// ---------- layout: fit the 16:9 stage to any screen ----------
function resize() {
  const vw = innerWidth, vh = innerHeight;
  let s = Math.min(vw / W, vh / H);
  if (s >= 2) s = Math.floor(s * 2) / 2;          // keep pixels crisp on big screens
  const cssW = Math.round(W * s), cssH = Math.round(H * s);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  document.body.classList.toggle('portrait', vh > vw && vw < 700);
  // render at the real screen resolution (capped) so movement is sub-pixel smooth, not snapped to 640x360 steps
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const cw = Math.max(W, Math.min(1920, Math.round(cssW * dpr)));
  k = cw / W;
  ppu = k * CONFIG.camera.zoom;
  if (character) character.px = ppu;     // device pixels per world unit, used to snap sprites to whole device pixels
  for (const c of loadedEnemyChars) c.px = ppu;
  canvas.width = cw; canvas.height = Math.round(H * k);
  ctx.imageSmoothingEnabled = false;
}
addEventListener('resize', resize); addEventListener('orientationchange', resize); resize();

// ---------- stop iOS/Android page zoom (double-tap, pinch) and rubber-band scrolling ----------
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault());
let lastTap = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - lastTap < 350) e.preventDefault();      // second tap of a double-tap
  lastTap = now;
}, { passive: false });
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1 || true) e.preventDefault(); }, { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault());

// ---------- touch UI ----------
const isTouch = matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).has('touch');
document.body.classList.toggle('touch', isTouch);
const cdButtons = { dodge: $('btn-dodge') };
const specialBtn = $('btn-special');           // only on screen while the special is ready (it is earned by landing hits)
let specialShown = null;

// ---------- pause ----------
function setPaused(p) { paused = p; $('pause-screen').hidden = !p; }
$('btn-pause').addEventListener('pointerdown', (e) => { e.preventDefault(); setPaused(!paused); });
$('resume').addEventListener('click', () => setPaused(false));
document.addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); });


// HUD lives in src/hud.js (arcade panels: portrait, HP, SP, KO)
let hudLast = performance.now();
function drawHud() { const now = performance.now(), dt = Math.min(0.1, (now - hudLast) / 1000); hudLast = now; drawArcadeHud(ctx, zee, game, dt); }
const cdCache = {};
function updateButtons() {       // only touch the DOM when a value actually changed (style writes are expensive on phones)
  const ready = zee.cd.special <= 0;
  if (ready !== specialShown) { specialShown = ready; specialBtn.style.display = ready ? '' : 'none'; }
  for (const [name, el] of Object.entries(cdButtons)) {
    const total = { special: CONFIG.zee.specialCooldown, dodge: CONFIG.zee.dodgeCooldown }[name];
    const left = zee.cd[name] / total;
    const deg = Math.round(left * 120) * 3;     // 3-degree steps
    if (cdCache[name] === deg) continue;
    cdCache[name] = deg;
    el.style.setProperty('--cd', deg + 'deg');
    el.classList.toggle('cooling', left > 0);
  }
}

// ---------- enemies: spawn button ----------
function enemyChar(id) {
  if (!enemyChars.has(id)) {
    enemyChars.set(id, loadCharacter(`assets/characters/${id}/`, id).then((c) => { c.px = ppu; loadedEnemyChars.push(c); return c; }));
  }
  return enemyChars.get(id);
}
function setupSpawner() {
  const btn = $('btn-spawn');
  let lastId = '';
  const spawn = async () => {
    unlock();
    const pool = ENEMY_IDS.filter((i) => i !== lastId);
    const id = pool[Math.floor(Math.random() * pool.length)]; lastId = id;
    try { game.spawn(id, await enemyChar(id)); } catch (err) { console.error(err); }
  };
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); spawn(); });
  btn.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') e.preventDefault(); });     // Space is the special attack, not a button press
  btn.tabIndex = -1;
  // warm the cache one by one in the background so the first spawn of each type is instant
  (async () => { for (const id of ENEMY_IDS) { try { await enemyChar(id); } catch (e) { /* loaded on demand later */ } } })();
  addEventListener('pointerdown', unlock, { once: true }); addEventListener('keydown', unlock, { once: true });
  window.__spawn = (id) => enemyChar(id).then((c) => game.spawn(id, c));
  // V: toggle the lit "finish" pass (outline, rim light, foot shading, scene wash, colour grade) to compare before / after
  addEventListener('keydown', (e) => { if (e.key === 'v' || e.key === 'V') { LOOK.on = !LOOK.on; window.__look = LOOK.on; } });
  window.__LOOK = LOOK;
}


// ---------- loop ----------
// Logic runs on a fixed 120 Hz step (same behaviour on any device); drawing runs every display refresh
// and interpolates between logic steps, so 60 / 90 / 120 / 144 Hz screens all look smooth.
const level = new Level([qualityDepartment()]);           // Level 1 starts in the Quality Department (1800 units wide); more rooms are added end to end
const camera = new Camera();
const bounds = { minX: 40, maxX: level.width - 40, minY: CONFIG.floor.top, maxY: CONFIG.floor.bottom };   // updated every frame from the level (locked doors are walls)
const STEP = CONFIG.simStep;
// BLOOM: the bright parts of the finished picture (windows, lights, sun shafts) glow softly. The frame is shrunk to 1/4, only its brightest
// parts are kept (brightness / contrast filter), blurred by shrinking again, then added back over the picture. Skipped where the browser has
// no canvas filter support.
const bloomA = document.createElement('canvas'), bloomB = document.createElement('canvas');
const bloomOk = 'filter' in bloomA.getContext('2d');
function bloomPass() {
  if (!bloomOk) return;
  const W = canvas.width, H = canvas.height, aw = Math.max(1, W >> 2), ah = Math.max(1, H >> 2), bw = Math.max(1, W >> 4), bh = Math.max(1, H >> 4);
  if (bloomA.width !== aw || bloomA.height !== ah) { bloomA.width = aw; bloomA.height = ah; bloomB.width = bw; bloomB.height = bh; }
  const a = bloomA.getContext('2d'), b = bloomB.getContext('2d');
  a.setTransform(1, 0, 0, 1, 0, 0); a.clearRect(0, 0, aw, ah); a.imageSmoothingQuality = 'high'; a.filter = 'brightness(0.6) grayscale(1) contrast(10)';
  a.drawImage(canvas, 0, 0, aw, ah); a.filter = 'none';
  b.setTransform(1, 0, 0, 1, 0, 0); b.clearRect(0, 0, bw, bh); b.imageSmoothingQuality = 'high'; b.drawImage(bloomA, 0, 0, bw, bh);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.34; ctx.drawImage(bloomB, 0, 0, W, H);                      // wide glow
  ctx.globalAlpha = 0.16; ctx.drawImage(bloomA, 0, 0, W, H);                      // tight glow
  ctx.restore();
}
let acc = 0, readoutText = '', showSolids = false;
let fxOn = true, blurLen = 0, prevGx = 0;                       // finishing effects: sunlight shafts, depth of field, motion blur
addEventListener('keydown', (e) => {
  if (e.key === 'b' || e.key === 'B') showSolids = !showSolids;
  if (e.key === 'n' || e.key === 'N') { fxOn = !fxOn; for (const k in level.fx) level.fx[k] = fxOn; }       // N: all finishing effects off / on, to compare
});
function frame(now) {
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.1) dt = 0.1;                       // tab was throttled: don't fast-forward
  Object.assign(bounds, level.boundsFor(zee.x));
  const actions = input.queue;
  if (actions.includes('pause')) { input.queue = actions.filter((a) => a !== 'pause'); setPaused(!paused); }
  if (paused) { input.consume(); acc = 0; }
  else {
    acc += dt;
    while (acc >= STEP) { game.snapshot(); game.update(STEP, input); acc -= STEP; }
  }
  const a = paused ? 1 : acc / STEP;
  const zx = zee.px !== undefined ? zee.px + (zee.x - zee.px) * a : zee.x;      // Zee's smoothed position this frame
  camera.update(zx, zee.face, dt, level.width, ppu);
  setLight(level.roomAt(zx).light, dt);                                          // each room has its own light for the characters
  const sx = game.shake > 0 ? (Math.random() - 0.5) * 2 * game.shake : 0, sy = game.shake > 0 ? (Math.random() - 0.5) * 2 * game.shake : 0;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  // WORLD transform: zoomed out and scrolled by the camera (whole device pixels), screen shake on top
  ctx.setTransform(ppu, 0, 0, ppu, Math.round(sx * k) - camera.px, Math.round(sy * k));
  // MOTION BLUR of the world: grows with how fast the camera moves (running) and with the action (attacks, dodges, the special, impacts)
  const camV = Math.abs(camera.gx - prevGx) * (1 / 60) / Math.max(dt, 1 / 240); prevGx = camera.gx;     // world units per 60 Hz frame
  const zs = zee.state, act = (zs === 'attack' ? 1.4 : 0) + (zs === 'dodge' ? 3 : 0) + (zee.animName === 'special' ? 3.5 : 0);
  const target = fxOn ? Math.min(11, camV * 2.4 + act + game.shake * 0.55) : 0;
  blurLen += (target - blurLen) * Math.min(1, dt * (target > blurLen ? 16 : 7));                       // quick to build, slower to fade
  level.setScale(ppu);
  level.drawBack(ctx, camera.gx, blurLen);
  level.drawAmbient(ctx, now / 1000, camera.gx);
  game.draw(ctx, a);
  level.drawLight(ctx, now / 1000, camera.gx);
  level.drawFront(ctx, camera.gx, blurLen);
  if (showSolids) {                                                              // B: draw the solid-object boxes (top edge = back, bottom = front)
    ctx.save(); ctx.font = '9px sans-serif';
    for (const o of level.obstacles()) {
      ctx.fillStyle = o.h === Infinity ? 'rgba(255,40,40,0.35)' : 'rgba(255,200,0,0.35)'; ctx.fillRect(o.x0, o.y0, o.x1 - o.x0, o.y1 - o.y0);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(o.x0, o.y0, o.x1 - o.x0, o.y1 - o.y0);
      ctx.fillStyle = '#fff'; ctx.fillText(`${o.name} h${o.h === Infinity ? '∞' : o.h}`, o.x0 + 3, o.y1 - 3);
    }
    ctx.restore();
  }
  if (level.fx.bloom) bloomPass();
  // SCREEN transform: the HUD stays in screen space, so its size never changes with the camera
  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawHud(); game.drawHud(ctx); updateButtons();
  const text = `${zee.state} | ${zee.animName} ${zee.frame + 1}/${zee.anim.frames} | v${VERSION}`;
  if (text !== readoutText) { readoutText = text; $('readout').textContent = text; }
  requestAnimationFrame(frame);
}

(async function boot() {
  try {
    character = await loadCharacter('assets/characters/zee/');
    character.px = ppu;
    zee = new Zee(character, 260, (CONFIG.floor.top + CONFIG.floor.bottom) / 2);
    game = new Game(zee, bounds);
    game.level = level; game.camera = camera;
    setupSpawner();
    await level.ready;                                  // the room art has loaded
    $('loading').remove();
    requestAnimationFrame((t) => { last = t; frame(t); });
    window.__zee = zee; window.__input = input; window.__game = game; window.__level = level; window.__camera = camera;     // handy for debugging in the console
  } catch (err) {
    $('loading').textContent = 'Could not load assets: ' + err.message + ' (run through a local web server)';
  }
})();

