// Arcade HUD (early-2000s style): angled panels with white outlines, glossy bars, bold italic type.
// Built from separate pieces drawn in game units, so it scales with the canvas at any resolution.
// Top-left: portrait + HP bar + SP meter. Bottom-left: KO counter. All values come from the live game state.
import { CONFIG } from './config.js?v=202611282241';
import { VERSION } from './assets.js?v=202611282241';

const portrait = new Image();
portrait.src = 'assets/ui/zee_portrait.png?v=' + VERSION;

const FONT = (px) => `italic 900 ${px}px "Arial Black", "Segoe UI Black", "Helvetica Neue", Arial, sans-serif`;
const SCALE = 1.2;                        // HUD size relative to the 640x360 stage (the stage itself scales to the screen)
const NAVY = '#0e1630', NAVY2 = '#1b2650', WHITE = '#f4f6ff';

// smoothed display values
let hpShown = 1, hpGhost = 1, spShown = 0, hitT = 0, lastHp = null, spPrev = 0, spFlash = 0;

// slanted panel: the top edge is shifted right by `s` (a parallelogram with slightly rounded corners)
function slant(ctx, x, y, w, h, s, r = 2) {
  const p = [[x + s, y], [x + w, y], [x + w - s, y + h], [x, y + h]];
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = p[i], [bx, by] = p[(i + 1) % 4], [cx, cy] = p[(i + 2) % 4];
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    if (i === 0) ctx.moveTo(mx, my);
    ctx.arcTo(bx, by, (bx + cx) / 2, (by + cy) / 2, r);
  }
  ctx.closePath();
}
// white-outlined navy panel with a soft drop shadow
function panel(ctx, x, y, w, h, s, fill = NAVY, line = WHITE, lw = 1.6) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowOffsetY = 1.5; ctx.shadowBlur = 3;
  slant(ctx, x, y, w, h, s); ctx.fillStyle = fill; ctx.fill();
  ctx.restore();
  slant(ctx, x, y, w, h, s); ctx.lineWidth = lw; ctx.strokeStyle = line; ctx.stroke();
}
function label(ctx, text, x, y, px, fill, stroke = NAVY, lw = 2.4, align = 'left') {
  ctx.font = FONT(px); ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.lineWidth = lw; ctx.strokeStyle = stroke; ctx.strokeText(text, x, y);
  ctx.fillStyle = fill; ctx.fillText(text, x, y);
}
// glossy fill: vertical gradient + a light streak on the top third
function gloss(ctx, x, y, w, h, s, top, bottom) {
  if (w <= 0.5) return;
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, top); g.addColorStop(1, bottom);
  slant(ctx, x, y, w, h, s, 1.5); ctx.fillStyle = g; ctx.fill();
  ctx.save(); slant(ctx, x, y, w, h, s, 1.5); ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(x, y + 0.6, w + s, h * 0.3);
  ctx.restore();
}
const HP_COLORS = (p) => p > 0.5 ? ['#d4ff4a', '#5fc41c'] : p > 0.25 ? ['#ffe45a', '#f0a010'] : ['#ff7a66', '#d8282c'];

export function drawHud(ctx, zee, game, dt) {
  const maxHp = CONFIG.zee.maxHp, hp = Math.max(0, zee.hp), pct = hp / maxHp;
  // animate: the bar eases to the new value, a white "damage" chunk drains behind it, the frame flashes on a hit
  if (lastHp !== null && hp < lastHp) hitT = 0.35;
  lastHp = hp; hitT = Math.max(0, hitT - dt);
  hpShown += (pct - hpShown) * Math.min(1, dt * 12);
  hpGhost = pct > hpGhost ? pct : Math.max(pct, hpGhost - dt * 0.5);
  const sp = Math.min(1, 1 - zee.cd.special / CONFIG.zee.specialCooldown);
  spShown += (sp - spShown) * Math.min(1, dt * 8);
  if (sp > spPrev + 0.001) spFlash = 0.3;          // the meter flashes white whenever a hit charges it
  spPrev = sp; spFlash = Math.max(0, spFlash - dt);

  // the whole top-left group is scaled up from its corner (one knob for size)
  ctx.save(); ctx.scale(SCALE, SCALE);
  // ---- portrait ----
  const px = 6, py = 5, pw = 50, ph = 40, ps = 9;
  panel(ctx, px, py, pw, ph, ps, NAVY, hitT > 0 ? '#ff6a5a' : WHITE, 2.2);
  if (portrait.complete && portrait.naturalWidth) {
    ctx.save(); slant(ctx, px + 1.6, py + 1.6, pw - 3.2, ph - 3.2, ps - 1); ctx.clip();
    const iw = pw + 4, ih = iw * portrait.naturalHeight / portrait.naturalWidth;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(portrait, px - 2, py + ph - ih + 2, iw, ih);
    ctx.restore();
  }

  // ---- HP bar ----
  const hx = 60, hy = 9, hw = 196, hh = 13, hs = 5;
  panel(ctx, hx, hy, hw, hh, hs);
  label(ctx, 'HP', hx + 7, hy + hh / 2 + 0.5, 9, WHITE);
  const bx = hx + 25, by = hy + 3, bw = hw - 32, bh = hh - 6;
  slant(ctx, bx, by, bw, bh, 3, 1.5); ctx.fillStyle = '#060a18'; ctx.fill();
  if (hpGhost > hpShown + 0.002) { slant(ctx, bx, by, Math.max(3, bw * hpGhost), bh, 3, 1.5); ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1; }
  const [c1, c2] = HP_COLORS(hpShown);
  gloss(ctx, bx, by, Math.max(hpShown > 0.001 ? 3 : 0, bw * hpShown), bh, 3, c1, c2);
  label(ctx, `${Math.ceil(hp)} / ${maxHp}`, bx + bw - 4, by + bh / 2 + 0.5, 7, WHITE, NAVY, 2.2, 'right');

  // ---- SP meter: four cyan segments ----
  const sx = 56, sy = 25, sw = 168, sh = 10, ss = 4;
  panel(ctx, sx, sy, sw, sh, ss);
  label(ctx, 'SP', sx + 7, sy + sh / 2 + 0.5, 8, WHITE);
  const segX = sx + 24, segW = (sw - 32) / 4, segY = sy + 2.5, segH = sh - 5;
  const ready = sp >= 1, pulse = ready ? 0.75 + 0.25 * Math.sin(performance.now() / 150) : 1;
  for (let i = 0; i < 4; i++) {
    const x = segX + i * segW, fill = Math.max(0, Math.min(1, spShown * 4 - i));
    slant(ctx, x, segY, segW - 2, segH, 2.5, 1.5); ctx.fillStyle = '#1d347a'; ctx.fill();
    if (fill > 0) {
      ctx.globalAlpha = pulse; gloss(ctx, x, segY, (segW - 2) * fill, segH, 2.5, '#9dfbff', '#14bfe0');
      if (spFlash > 0) { ctx.globalAlpha = Math.min(1, spFlash * 2.5); gloss(ctx, x, segY, (segW - 2) * fill, segH, 2.5, '#ffffff', '#c6f8ff'); }
      ctx.globalAlpha = 1;
    }
  }
  if (ready) {                                                   // ready: soft cyan glow around the meter
    ctx.save(); ctx.globalAlpha = 0.35 * pulse; ctx.shadowColor = '#4fe9ff'; ctx.shadowBlur = 8;
    slant(ctx, sx, sy, sw, sh, ss); ctx.strokeStyle = '#7ff4ff'; ctx.lineWidth = 1.2; ctx.stroke(); ctx.restore();
  }

  ctx.restore();

  // ---- KO counter (bottom-left, scaled from the bottom-left corner) ----
  ctx.save(); ctx.translate(0, CONFIG.view.h); ctx.scale(SCALE, SCALE);
  const kx = 6, ky = -22, kw = 88, kh = 16, ks = 6;
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowOffsetY = 1.5; ctx.shadowBlur = 3;
  slant(ctx, kx, ky, kw, kh, ks, 3); ctx.fillStyle = '#ff8a1c'; ctx.fill(); ctx.restore();
  slant(ctx, kx + 3, ky + 2.6, kw - 9, kh - 5.2, ks - 1, 2); ctx.fillStyle = NAVY; ctx.fill();
  const kg = ctx.createLinearGradient(0, ky + 4, 0, ky + kh - 4); kg.addColorStop(0, '#ffe45a'); kg.addColorStop(1, '#f39a12');
  label(ctx, 'KO', kx + 13, ky + kh / 2 + 0.5, 10, kg, NAVY, 2.2);
  label(ctx, String(game.kos), kx + 56, ky + kh / 2 + 0.5, 10, WHITE, NAVY, 2.2);

  // (the escalation mechanic still runs, see game.js; it just has no bar. The level-up text and embers show it.)
  ctx.restore();
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
}
