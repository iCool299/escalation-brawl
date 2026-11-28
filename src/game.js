// Game world: Zee + enemies, combat resolution, projectiles and all the "juice" (hit flash, sparks, shake, hit-stop, sound).
import { CONFIG } from './config.js?v=202611282249';
import { Enemy } from './enemy.js?v=202611282249';
import { SOFT } from './zee.js?v=202611282249';
import { sfx } from './sfx.js?v=202611282249';
import { drawAnim } from './assets.js?v=202611282249';

const E = CONFIG.enemy;

export class Game {
  constructor(zee, bounds) {
    this.zee = zee; this.bounds = bounds; this.sfx = sfx;
    this.enemies = []; this.shots = []; this.parts = []; this.texts = [];
    this.hitstop = 0; this.shake = 0; this.combo = 0; this.comboT = 0; this.kos = 0;
    this.esc = 0; this.escIdle = 0; this.items = [];     // escalation 0..3, time since the last landed hit, things lying on the floor (iced coffee)
    this.reviveT = 0;
  }

  snapshot() { this.zee.snapshot(); for (const e of this.enemies) e.snapshot(); }

  // how many enemies are in the middle of attacking Zee right now (the rest circle and wait their turn)
  attackerCount() { let n = 0; for (const e of this.enemies) if (e.attacking) n++; return n; }
  get maxAttackers() { return (this.enemies.length > 4 ? E.maxAttackers + 1 : E.maxAttackers) + (this.escLevel >= 3 ? 1 : 0); }

  spawn(id, character) {
    const z = this.zee, VW = CONFIG.camera.viewW, cam = this.camera ? this.camera.x : 0;      // cam = left edge of the visible part of the world
    // walks in from just outside the visible area: first from the side away from her, then alternating edges so a group comes at her from both sides
    this.spawnSide = this.enemies.some((o) => o.state !== 'dead') ? -(this.spawnSide || 1) : (z.x > cam + VW / 2 ? -1 : 1);
    const x = this.spawnSide < 0 ? cam - 40 : cam + VW + 40;
    const y = this.bounds.minY + 10 + Math.random() * (this.bounds.maxY - this.bounds.minY - 20);
    const e = new Enemy(id, character, x, y);
    e.face = x < z.x ? 1 : -1; e.spawnT = 0; e.state = 'idle'; e.entering = true; e.side = Math.sign(e.x - z.x) || 1;
    this.enemies.push(e);
    sfx.spawn();
    return e;
  }

  // ---------- fighting ----------
  hurtZee(dmg, dir, src) {
    const z = this.zee;
    if (!z.takeHit(dmg, dir)) return false;
    this._escHurt();
    this._impact(z.x, z.y, 62, dmg, '#ff5a4a', 1.0); z.squash = 1;
    if (dmg >= 12) this._sweat(z.x, z.y, 70, -dir, 4);
    this.shake = Math.max(this.shake, 3); this.hitstop = Math.max(this.hitstop, 0.06);
    sfx.hurt(); try { navigator.vibrate && navigator.vibrate(25); } catch (e) { /* not supported */ }
    return true;
  }

  fireHeadset(e) { this.shots.push({ x: e.x + e.face * 28, y: e.y, z: 64, vx: e.face * E.headsetSpeed, spin: 0 }); sfx.whoosh(); }
  onThrow() { sfx.whoosh(); this.shake = Math.max(this.shake, 2); }

  _hitEnemy(e, dmg, dir, knock, viaSpecial = false) {
    const r = e.takeHit(dmg, dir, knock);
    if (!r) return false;
    const kill = r === 'kill';
    this._earn(kill ? 'kill' : knock ? 'knock' : 'hit', viaSpecial);
    if (kill) this._maybeCoffee(e);
    this._impact(e.x - dir * 6, e.y, 66, dmg, kill ? '#ffd24a' : '#fff1b0', kill ? 1.4 : knock ? 1.2 : 1);
    if (kill || knock) this._sweat(e.x, e.y, (e.character.manifest.gameHeight || 140) * 0.8, dir, kill ? 7 : 5);
    this.hitstop = Math.max(this.hitstop, kill ? 0.14 : knock ? 0.09 : 0.05);
    this.shake = Math.max(this.shake, kill ? 6 : knock ? 4 : 1.6);
    sfx.hit(kill || knock ? 1.25 : 0.9); if (kill) { sfx.ko(); this.kos++; }
    this.combo++; this.comboT = 1.7;
    return true;
  }

  _zeeAttacks() {
    const z = this.zee, a = z.attackBox();
    if (!a) return;
    for (const e of this.enemies) {
      if (e.hitId === a.id) continue;
      // a side swing reaches sideways along her facing; a front / back swing reaches down / up the floor (depth is foreshortened)
      if (a.view === 'side') { const dx = (e.x - z.x) * z.face; if (dx < -10 || dx > a.reach || Math.abs(e.y - z.y) > 18) continue; }
      else { const dy = (e.y - z.y) * (a.view === 'front' ? 1 : -1); if (dy < -6 || dy > a.reach * 0.7 || Math.abs(e.x - z.x) > 34) continue; }
      if (z.z > 90 || !e.canBeHit()) continue;
      e.hitId = a.id;
      this._hitEnemy(e, a.dmg, a.view === 'side' ? z.face : (e.x >= z.x ? 1 : -1), a.knock);
    }
    // (papers are resolved below)
  }

  _papers() {
    const z = this.zee;
    for (const p of z.papers) {
      if (p.dead) continue;
      for (const e of this.enemies) {
        if (Math.abs(p.x - e.x) < 24 && Math.abs(p.y - e.y) < 20 && e.canBeHit()) {
          p.dead = true; this._hitEnemy(e, Math.round(CONFIG.zee.barrage.damage * z.dmgMul), Math.sign(p.vx), false, true); break;
        }
      }
    }
  }

  _shots(dt) {
    const z = this.zee, WW = this.level ? this.level.width : CONFIG.view.w;     // headsets fly until they leave the level
    for (const s of this.shots) {
      s.x += s.vx * dt; s.spin += dt * 22;
      if (Math.abs(s.x - z.x) < 16 && Math.abs(s.y - z.y) < 14 && z.z < 50 && this.hurtZee(E.headsetDmg, Math.sign(s.vx), null)) s.dead = true;   // jump over it!
      if (s.x < -30 || s.x > WW + 30) s.dead = true;
    }
    this.shots = this.shots.filter((s) => !s.dead);
  }

  // Bodies are solid: enemies never stand inside each other, and never inside Zee (she gets shoved a little too).
  _separate(dt) {
    const z = this.zee, solid = (e) => !['dead', 'down', 'spawn', 'hold', 'throw'].includes(e.state) && !e.holdingZee && !e.entering;
    const B = 34, ZB = 36, DY = 14;               // ZB just under the enemies' punching distance (attackRange 46 * 0.8)
    for (let i = 0; i < this.enemies.length; i++) {
      const a = this.enemies[i]; if (!solid(a)) continue;
      for (let j = i + 1; j < this.enemies.length; j++) {
        const b = this.enemies[j]; if (!solid(b)) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        if (Math.abs(dy) >= DY || Math.abs(dx) >= B) continue;
        const push = (B - Math.abs(dx)) / 2, s = dx === 0 ? (i % 2 ? 1 : -1) : Math.sign(dx);
        a.x -= s * push; b.x += s * push;
        if (Math.abs(dx) < B * 0.5) { const sy = dy === 0 ? 1 : Math.sign(dy); a.y -= sy * 20 * dt; b.y += sy * 20 * dt; }   // fully stacked: also spread in depth
      }
    }
    if (['held', 'thrown', 'down', 'getup', 'defeat'].includes(z.state) || z.z > 20) return;
    for (const e of this.enemies) {
      if (!solid(e) || e.state === 'grab') continue;
      const dx = e.x - z.x, dy = e.y - z.y;
      if (Math.abs(dy) >= DY || Math.abs(dx) >= ZB) continue;
      const push = ZB - Math.abs(dx), s = dx === 0 ? -(z.face || 1) : Math.sign(dx);
      e.x += s * push * 0.8; z.x -= s * push * 0.2;                // mostly the enemy gives way
    }
  }

  // Solid level objects: nobody stands inside a desk, a cabinet, ... Characters slide along the edge (the push goes sideways or
  // to the front, never into the wall) and stop dead against it (thrown / knocked-back enemies included). Feet above an
  // object's height (a jump) pass over it.
  _obstacles() {
    if (!this.level || !this.level.obstacles) return;
    const obs = this._obs || (this._obs = this.level.obstacles());
    const MX = 14, MY = 3;
    const fix = (c, lift) => {
      for (const o of obs) {
        if (lift >= o.h - 4) continue;
        const x0 = o.x0 - MX, x1 = o.x1 + MX, y1 = o.y1 + MY;
        if (c.x <= x0 || c.x >= x1 || c.y >= y1 || c.y <= o.y0) continue;
        const pl = c.x - x0, pr = x1 - c.x, pf = y1 - c.y;
        if (pf <= pl && pf <= pr) { c.y = y1; if (c.vy) c.vy = 0; }
        else if (pl < pr) { c.x = x0; if (c.vx > 0) c.vx = 0; }
        else { c.x = x1; if (c.vx < 0) c.vx = 0; }
      }
    };
    const z = this.zee;
    if (!['held', 'thrown'].includes(z.state)) fix(z, z.z);
    for (const e of this.enemies) if (!['spawn', 'hold', 'throw', 'dead'].includes(e.state) && !e.holdingZee && !e.entering) fix(e, e.z || 0);
  }

  // ---------- main step ----------
  update(dt, input) {
    if (this.hitstop > 0) { this.hitstop -= dt; return; }          // freeze for a beat on impact
    const z = this.zee;
    this._escTick(dt);
    z.update(dt, input, this.bounds);
    this._zeeDust(dt);
    for (const ev of z.events.splice(0)) {
      if (ev.type === 'slam') {
        this._escHurt();
        this._impact(z.x, z.y, 14, ev.dmg, '#ff5a4a', 1.5);
        this._burst(z.x, z.y, 4, 14, ['#d8d2ea', '#9b94b4'], 120, 'dust');
        this.shake = 9; this.hitstop = Math.max(this.hitstop, 0.11); sfx.thud(); try { navigator.vibrate && navigator.vibrate(50); } catch (e) { /* ok */ }
      } else if (ev.type === 'escape') { this._text(z.x, z.y, 90, 'FREE!', '#8be28b'); sfx.hit(0.7); }
    }
    for (const e of this.enemies) e.update(dt, this);
    this._items(dt);
    this._separate(dt);
    this._obstacles();
    this._zeeAttacks(); this._papers(); this._shots(dt);
    this.enemies = this.enemies.filter((e) => !e.remove);
    this.comboT -= dt; if (this.comboT <= 0) this.combo = 0;
    this.shake = Math.max(0, this.shake - dt * 22);
    z.squash = Math.max(0, (z.squash || 0) - dt * 6);
    // sandbox: she gets back up after being knocked out
    if (z.state === 'defeat' && z.done) { this.reviveT += dt; if (this.reviveT > 2.2) { z.hp = CONFIG.zee.maxHp; z.z = 0; z.vz = 0; z._enter('idle'); z.invuln = 1.2; this.reviveT = 0; this.esc = 0; } }
    else this.reviveT = 0;
    // particles
    for (const p of this.parts) {
      p.t += dt; p.x += p.vx * dt; p.z += p.vz * dt; p.vz -= (p.g || 0) * dt; p.vx *= p.drag || 1;
    }
    this.parts = this.parts.filter((p) => p.t < p.life);
    for (const t of this.texts) t.t += dt;
    this.texts = this.texts.filter((t) => t.t < 0.8);
  }

  // ---------- effects ----------
  _impact(x, y, z, dmg, color, size) {
    this._burst(x, y, z, 9, [color, '#ffffff'], 190 * size, 'spark');
    this.parts.push({ type: 'ring', x, y, z, vx: 0, vz: 0, t: 0, life: 0.18, r: 22 * size, color });
    this.parts.push({ type: 'star', x, y, z, vx: 0, vz: 0, t: 0, life: 0.12, r: 13 * size, color });
    this._text(x, y, z + 20, String(dmg), color);
  }
  _burst(x, y, z, n, colors, speed, type) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, s = speed * (0.35 + Math.random() * 0.65);
      const dust = type === 'dust';
      this.parts.push({ type, x, y, z, vx: Math.cos(a) * s, vz: dust ? Math.abs(Math.sin(a)) * s * 0.4 : Math.sin(a) * s * 0.8, t: 0, life: dust ? 0.5 + Math.random() * 0.3 : 0.22 + Math.random() * 0.12, color: colors[i % colors.length], g: dust ? 0 : 500, drag: dust ? 0.96 : 0.9 });
    }
  }
  // ---------- earned special + escalation ----------
  get escLevel() { return Math.floor(this.esc); }
  get escMul() { return 1 + CONFIG.escalation.enemyAggr * this.escLevel; }
  // every landed hit charges the special (the barrage's own hits don't, or it would refill itself) and builds escalation
  _earn(kind, viaSpecial) {
    const S = CONFIG.special, X = CONFIG.escalation;
    if (!viaSpecial) this.zee.addSpecial(kind === 'kill' ? S.perKill : kind === 'knock' ? S.perKnock : S.perHit);
    this._escAdd(kind === 'kill' ? X.perKill : kind === 'knock' ? X.perKnock : X.perHit);
    this.escIdle = 0;
  }
  _escAdd(d) {
    const before = this.escLevel; this.esc = Math.min(CONFIG.escalation.max, this.esc + d);
    if (this.escLevel > before) {
      const z = this.zee;
      this._text(z.x, z.y, 96, 'ESCALATION ' + this.escLevel + '!', this.escLevel >= 3 ? '#ff5a3c' : '#ffb03c');
      this._burst(z.x, z.y, 30, 14, ['#ffb03c', '#ffffff'], 170, 'spark');
      this.shake = Math.max(this.shake, 3); sfx.levelup();
    }
  }
  // Zee got hurt: she gets a little special charge back (comeback), but loses one escalation level
  _escHurt() {
    const z = this.zee, X = CONFIG.escalation;
    z.addSpecial(CONFIG.special.perHurt);
    if (this.esc > 0) {
      const before = this.escLevel; this.esc = Math.max(0, this.esc - X.hurtLoss);
      if (this.escLevel < before) this._text(z.x, z.y, 96, 'ESCALATION DOWN', '#9aa3c9');
    }
    this.escIdle = 0;
  }
  _escTick(dt) {
    const z = this.zee, X = CONFIG.escalation, L = this.escLevel;
    z.dmgMul = 1 + X.zeeDmg * L; z.chargeMul = 1 + X.chargeBonus * L;
    this.escIdle += dt;
    if (this.escIdle > X.idleAfter && this.enemies.length && this.esc > 0) this.esc = Math.max(0, this.esc - X.decay * dt);   // fighting stopped: it cools off
    if (L >= 2 && z.state !== 'defeat' && Math.random() < dt * (L >= 3 ? 14 : 7)) {                                            // embers rising off her at level 2+
      this.parts.push({ type: 'ember', x: z.x + (Math.random() - 0.5) * 16, y: z.y, z: z.z + 8 + Math.random() * 40, vx: (Math.random() - 0.5) * 10, vz: 28 + Math.random() * 30, t: 0, life: 0.6, color: L >= 3 ? '#ff4a2a' : '#ffb03c' });
    }
  }

  // ---------- iced coffee ----------
  _maybeCoffee(e) {
    const K = CONFIG.coffee, z = this.zee, b = this.bounds;
    if (this.items.filter((i) => i.type === 'coffee').length >= K.maxOnFloor) return;
    let p = z.hp <= K.lowHpPct * CONFIG.zee.maxHp ? K.chanceLow : K.chance;
    if (e.heavy) p += K.heavyBonus;
    if (Math.random() < p) this.items.push({ type: 'coffee', x: Math.max(b.minX + 12, Math.min(b.maxX - 12, e.x)), y: Math.max(b.minY, Math.min(b.maxY, e.y)), z: 26, vz: 190, t: 0, msgT: -9 });
  }
  _items(dt) {
    const z = this.zee, K = CONFIG.coffee, maxHp = CONFIG.zee.maxHp;
    const canPick = !['defeat', 'down', 'getup', 'held', 'thrown'].includes(z.state) && z.z < 30;
    for (const it of this.items) {
      it.t += dt;
      if (it.z > 0 || it.vz > 0) { it.vz -= 900 * dt; it.z += it.vz * dt; if (it.z <= 0) { it.z = 0; it.vz = it.vz < -120 ? -it.vz * 0.35 : 0; } }   // pops out and bounces once
      if (!canPick || it.t < 0.35 || Math.abs(it.x - z.x) > K.pickupX || Math.abs(it.y - z.y) > K.pickupY) continue;
      if (z.hp >= maxHp) { if (it.t - it.msgT > 1.6) { it.msgT = it.t; this._text(z.x, z.y, 84, 'HP FULL', '#9aa3c9'); } continue; }   // stays on the floor for later
      const got = Math.min(K.heal, maxHp - z.hp); z.hp += got; it.gone = true;
      this._text(z.x, z.y, 88, '+' + got + ' HP', '#8be28b');
      this._burst(z.x, z.y, 36, 12, ['#8be28b', '#ffffff'], 140, 'spark'); sfx.coffee();
    }
    this.items = this.items.filter((it) => !it.gone);               // a coffee never vanishes: it waits until Zee drinks it
  }
  // an iced coffee drawn in code: clear cup, milk and coffee, ice cubes, lid and an orange straw, glowing and bobbing
  _drawItem(ctx, it) {
    const bob = it.z + (it.z <= 0 ? 4 + Math.sin(it.t * 5) * 1.6 : 4), x = Math.round(it.x), y = Math.round(it.y - bob);
    ctx.globalAlpha = 0.5; ctx.drawImage(SOFT, it.x - 8, it.y - 2.5, 16, 5);
    ctx.globalAlpha = 0.18 + 0.12 * (0.5 + 0.5 * Math.sin(it.t * 6)); ctx.fillStyle = '#9dfbff';
    ctx.beginPath(); ctx.ellipse(x, y - 6, 11, 13, 0, 0, 6.283); ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = '#10101a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x + 1, y - 13); ctx.lineTo(x + 4, y - 21); ctx.stroke();
    ctx.strokeStyle = '#ff8a1c'; ctx.lineWidth = 1.4; ctx.stroke();
    const cup = (inset, fill) => {
      ctx.beginPath(); ctx.moveTo(x - 6 + inset, y - 12 + inset); ctx.lineTo(x + 6 - inset, y - 12 + inset);
      ctx.lineTo(x + 4.6 - inset, y + 1 - inset); ctx.lineTo(x - 4.6 + inset, y + 1 - inset); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    };
    cup(0, '#10101a'); cup(1, '#d6ecf7');
    ctx.save(); ctx.beginPath(); ctx.moveTo(x - 5, y - 12); ctx.lineTo(x + 5, y - 12); ctx.lineTo(x + 3.6, y); ctx.lineTo(x - 3.6, y); ctx.closePath(); ctx.clip();
    ctx.fillStyle = '#c99a6a'; ctx.fillRect(x - 6, y - 10, 12, 4);
    ctx.fillStyle = '#6b3f23'; ctx.fillRect(x - 6, y - 6, 12, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillRect(x - 3.5, y - 9.5, 3, 3); ctx.fillRect(x + 1, y - 7.5, 3, 3); ctx.fillRect(x - 2, y - 4, 3, 3);
    ctx.restore();
    ctx.fillStyle = '#10101a'; ctx.fillRect(x - 7, y - 14, 14, 3.4); ctx.fillStyle = '#f4f6ff'; ctx.fillRect(x - 6, y - 13.2, 12, 1.8);
    const tw = Math.max(0, Math.sin(it.t * 7)); ctx.globalAlpha = tw; ctx.fillStyle = '#ffffff';   // twinkle so it catches the eye
    ctx.fillRect(x + 7, y - 17, 1.6, 5); ctx.fillRect(x + 5.3, y - 15.3, 5, 1.6); ctx.globalAlpha = 1;
  }

  // sweat drops flung off on a heavy hit (away from the punch)
  _sweat(x, y, z, dir, n) {
    for (let i = 0; i < n; i++) this.parts.push({ type: 'drop', x, y, z: z + Math.random() * 10, vx: dir * (50 + Math.random() * 90), vz: 90 + Math.random() * 110, t: 0, life: 0.45, color: '#cfe8ff', g: 520, drag: 0.98 });
  }
  // dust puffs on the floor: footsteps (small) and bodies / landings (big)
  footDust(x, y, size = 1) {
    for (let i = 0; i < 2; i++) this.parts.push({ type: 'puff', x: x + (Math.random() - 0.5) * 6, y: y + (Math.random() - 0.5) * 2, z: 1, vx: (Math.random() - 0.5) * 22, vz: 6 + Math.random() * 8, t: 0, life: 0.35 + Math.random() * 0.15, size: 4 * size, color: '#bdb6cf', drag: 0.94 });
  }
  floorDust(x, y, size = 1) {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * 6.283, s = (40 + Math.random() * 50) * size;
      this.parts.push({ type: 'puff', x: x + Math.cos(a) * 10 * size, y, z: 2, vx: Math.cos(a) * s, vz: 8 + Math.random() * 18, t: 0, life: 0.5 + Math.random() * 0.25, size: 7 * size, color: '#c7c0d8', drag: 0.93 });
    }
    this.shake = Math.max(this.shake, 2 * size);
  }
  _zeeDust(dt) {
    const z = this.zee, prevZ = this._zz ?? 0, px = this._zx ?? z.x;
    this._zz = z.z; this._zx = z.x;
    if (prevZ > 6 && z.z <= 0.5 && !['held', 'thrown'].includes(z.state)) this.floorDust(z.x, z.y, 0.6);          // landing from a jump
    if (z.z <= 0.5 && (z.state === 'run' || z.state === 'walk')) {
      this._zStep = (this._zStep || 0) + Math.abs(z.x - px);
      if (this._zStep > (z.state === 'run' ? 26 : 44)) { this._zStep = 0; this.footDust(z.x - z.face * 8, z.y, z.state === 'run' ? 1 : 0.6); }
    }
    const lying = z.animName === 'knockdown' && z.frame >= z.anim.frames - 3;
    if (lying && !this._zLanded) this.floorDust(z.x, z.y, 1.1);
    this._zLanded = lying || (this._zLanded && z.state === 'down');
  }
  // floating numbers never pile up: a new one that would land on a fresh one is lifted above it
  _text(x, y, z, text, color) {
    let zz = z;
    for (let tries = 0; tries < 6; tries++) {
      const clash = this.texts.some((t) => t.t < 0.4 && Math.abs(t.x - x) < 18 && Math.abs((t.y - t.z - t.t * 34) - (y - zz)) < 11);
      if (!clash) break; zz += 12;
    }
    this.texts.push({ x, y, z: zz, t: 0, text, color });
  }

  // ---------- drawing ----------
  // FLOOR REFLECTIONS on a glossy floor: each character is mirrored around their feet, faded out over ~130 units, at the room's `reflect` strength.
  _reflections(ctx, alpha) {
    const lv = this.level; if (!lv || !lv.fx.refl) return;
    const z = this.zee, k = (lv.roomAt(z.x) || {}).reflect || 0; if (k <= 0) return;
    const T = this._rt || (this._rt = (() => { const c = document.createElement('canvas'); c.width = 380; c.height = 180; return c; })()), t = T.getContext('2d');
    const one = (c, held) => {
      if (!c.character || held) return;
      const x = c.px !== undefined ? c.px + (c.x - c.px) * alpha : c.x, y = c.py !== undefined ? c.py + (c.y - c.py) * alpha : c.y, lift = Math.max(0, c.z || 0);
      t.setTransform(1, 0, 0, 1, 0, 0); t.globalCompositeOperation = 'source-over'; t.clearRect(0, 0, T.width, T.height);
      t.setTransform(1, 0, 0, -1, 190 - x, y);                                    // mirror around the feet (y), centred on x
      const fade = c.state === 'spawn' ? 1 - c.spawnT / 0.5 : 1;
      drawAnim(t, c.character, c.anim, c.frame, x, y - lift, /_(front|back)$/.test(c.anim.name) ? 1 : c.face, fade);
      t.setTransform(1, 0, 0, 1, 0, 0); t.globalCompositeOperation = 'destination-in';
      const g = t.createLinearGradient(0, 0, 0, 140); g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)'); t.fillStyle = g; t.fillRect(0, 0, T.width, 180);
      ctx.save(); ctx.globalAlpha = k; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(T, x - 190, y + 1); ctx.restore();
    };
    one(z, z.state === 'held');
    for (const e of this.enemies) one(e, e.state === 'dead');
  }

  draw(ctx, alpha) {
    const z = this.zee;
    this._reflections(ctx, alpha);
    for (const it of this.items) this._drawItem(ctx, it);
    const list = [{ y: z.py !== undefined ? z.py + (z.y - z.py) * alpha : z.y, d: () => this._scaled(ctx, z, alpha, () => z.draw(ctx, alpha)) }];
    for (const e of this.enemies) list.push({ y: e.py !== undefined ? e.py + (e.y - e.py) * alpha : e.y, d: () => this._scaled(ctx, e, alpha, () => e.draw(ctx, alpha)) });
    list.sort((a, b) => a.y - b.y);
    for (const it of list) it.d();
    this._drawShots(ctx);
    for (const p of this.parts) this._drawPart(ctx, p);
    ctx.font = 'bold 11px ui-monospace, Consolas, monospace'; ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = '#10101a';
    for (const t of this.texts) {
      const k = t.t / 0.8; ctx.globalAlpha = 1 - k * k;
      const yy = t.y - t.z - t.t * 34; ctx.strokeText(t.text, t.x, yy); ctx.fillStyle = t.color; ctx.fillText(t.text, t.x, yy);
    }
    ctx.globalAlpha = 1; ctx.textAlign = 'left';
  }

  // depth: further back (higher on screen) = a little smaller; plus a short squash on a hit, both around the feet
  _scaled(ctx, c, alpha, draw) {
    const b = this.bounds, x = c.px !== undefined ? c.px + (c.x - c.px) * alpha : c.x, y = c.py !== undefined ? c.py + (c.y - c.py) * alpha : c.y;
    const depth = 1 + ((y - (b.minY + b.maxY) / 2) / ((b.maxY - b.minY) / 2)) * 0.06, q = c.squash || 0;
    if (Math.abs(depth - 1) < 0.002 && q < 0.01) return draw();
    ctx.save(); ctx.translate(x, y); ctx.scale(depth * (1 + 0.1 * q), depth * (1 - 0.08 * q)); ctx.translate(-x, -y); draw(); ctx.restore();
  }

  _drawShots(ctx) {
    for (const s of this.shots) {
      ctx.globalAlpha = 0.5; ctx.drawImage(SOFT, s.x - 8, s.y - 2, 16, 5); ctx.globalAlpha = 1;
      ctx.save(); ctx.translate(s.x, s.y - s.z); ctx.rotate(s.spin);
      ctx.strokeStyle = '#10101a'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 0, 6, Math.PI, 0); ctx.stroke();        // headband outline
      ctx.fillStyle = '#10101a'; ctx.fillRect(-9, -2, 5, 8); ctx.fillRect(4, -2, 5, 8);                                  // ear cups outline
      ctx.strokeStyle = '#3b3b4d'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 6, Math.PI, 0); ctx.stroke();
      ctx.fillStyle = '#5a5a72'; ctx.fillRect(-8, -1, 3, 6); ctx.fillRect(5, -1, 3, 6);
      ctx.restore();
    }
  }

  _drawPart(ctx, p) {
    const k = p.t / p.life, py = p.y - p.z;
    if (p.type === 'ring') {
      ctx.globalAlpha = 1 - k; ctx.strokeStyle = p.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(p.x, py, p.r * k + 3, (p.r * k + 3) * 0.7, 0, 0, 6.283); ctx.stroke();
    } else if (p.type === 'spark') {
      ctx.globalAlpha = 1 - k; ctx.strokeStyle = p.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p.x, py); ctx.lineTo(p.x - p.vx * 0.045, py + p.vz * 0.045); ctx.stroke();
    } else if (p.type === 'star') {                          // white impact star at the point of contact
      const r = p.r * (0.6 + k * 0.8), w = r * 0.28;
      ctx.globalAlpha = 1 - k; ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.moveTo(p.x - r, py); ctx.lineTo(p.x, py - w); ctx.lineTo(p.x + r, py); ctx.lineTo(p.x, py + w); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(p.x, py - r * 0.8); ctx.lineTo(p.x + w, py); ctx.lineTo(p.x, py + r * 0.8); ctx.lineTo(p.x - w, py); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = (1 - k) * 0.7; ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, py, w * 1.3, 0, 6.283); ctx.fill();
    } else if (p.type === 'ember') {
      ctx.globalAlpha = 1 - k; ctx.fillStyle = p.color; ctx.fillRect(p.x - 1, py - 1, 2, 2);
    } else if (p.type === 'drop') {
      ctx.globalAlpha = 1 - k; ctx.fillStyle = p.color; ctx.beginPath(); ctx.ellipse(p.x, py, 1.4, 2.4, Math.atan2(-p.vz, p.vx) + 1.57, 0, 6.283); ctx.fill();
    } else if (p.type === 'puff') {
      const r = p.size * (0.5 + k * 0.9); ctx.globalAlpha = 0.42 * (1 - k); ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.ellipse(p.x, py, r, r * 0.7, 0, 0, 6.283); ctx.fill();
    } else {
      ctx.globalAlpha = 0.5 * (1 - k); ctx.fillStyle = p.color; const s = 3 + k * 5; ctx.fillRect(p.x - s / 2, py - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }

  drawHud(ctx) {
    if (this.combo >= 2) {
      const pop = 1 + Math.max(0, this.comboT - 1.45) * 2.5;
      ctx.save(); ctx.translate(CONFIG.view.w - 16, 34); ctx.scale(pop, pop); ctx.textAlign = 'right';
      ctx.font = 'bold 20px ui-monospace, Consolas, monospace'; ctx.lineWidth = 4; ctx.strokeStyle = '#10101a';
      const t = this.combo + ' HITS'; ctx.strokeText(t, 0, 0); ctx.fillStyle = this.combo >= 5 ? '#ffd24a' : '#fff'; ctx.fillText(t, 0, 0);
      ctx.restore();
    }
  }
}

