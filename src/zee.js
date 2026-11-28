// Zee: the player character. A small state machine driven by input actions.
// Movement, combat timing, and animation selection live here; art comes from the manifest (assets.js).
import { CONFIG } from './config.js?v=202611282249';
import { frameAt, drawAnim, drawShadow, LOOK } from './assets.js?v=202611282249';

const C = CONFIG.zee;
// Front and back sheets are drawn as seen by the camera, so they are never mirrored (her badge and hand stay on the correct side).
export const faceFor = (anim, face) => (/_(front|back)$/.test(anim.name) ? 1 : face);
const FREE = new Set(['idle', 'walk', 'run', 'makeup']);

// A soft round shadow blob, drawn once and reused for Zee's contact shadow and the paper shadows (no per-frame gradients).
export const SOFT = (() => {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(0,0,0,0.85)'); r.addColorStop(0.55, 'rgba(0,0,0,0.38)'); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  return c;
})();
const TRAIL_LAGS = [2, 4, 6];            // history samples (60 per second) used for the motion-blur ghosts
const TRAIL_ALPHA = [0.2, 0.11, 0.05];
const SMEAR_TIME = 0.07;                 // seconds the previous frame lingers as a smear on swings / rolls
const SMEAR_STATES = new Set(['attack', 'dodge']);
const SIDE_ONLY = new Set(['hurt', 'down', 'getup', 'held', 'thrown', 'interact', 'victory', 'defeat']);
const XFADE_TIME = 0.12;                 // switching animation: the last pose fades out under the new one, so the change never pops

export class Zee {
  constructor(character, x, y) {
    this.character = character;
    this.anims = character.anims;
    this.x = x; this.y = y; this.z = 0; this.vz = 0; this.vx = 0;
    this.face = 1;
    this.hp = C.maxHp;
    this.invuln = 0;
    this.cd = { special: C.specialCooldown * 0.5, dodge: 0 };   // special: seconds-equivalent still missing from a full meter (starts half charged)
    this.dmgMul = 1; this.chargeMul = 1;                  // set by the game from the escalation level
    this.papers = [];             // Printout Barrage projectiles
    this.barrageFrame = -1;
    this.blur = 0;                // 0..1 motion-blur strength, follows her real speed
    this.trail = [];              // recent positions (newest first) for the blur ghosts
    this._trailT = 0; this._key = ''; this.smear = null;
    this.state = 'idle';
    this.view = 'side';          // which way she is turned: 'side', 'front' or 'back'
    this.idleTime = 0;
    this.queued = false;
    this.phase = '';
    this.flash = 0;               // red hit-flash timer
    this.attackId = 0;            // changes with every swing so one swing hits each enemy once
    this.holder = null;           // the enemy holding her
    this.events = [];             // things the game layer reacts to (e.g. slam)
    this._play('idle');
  }

  // ---------- melee hitbox for the current swing (or null) ----------
  attackBox() {
    const a = C.attacks[this.move];
    if (!a || !this.anim.active.includes(this.frame)) return null;
    if (this.state !== 'attack' && !(this.state === 'jump' && this.move === 'jump_kick')) return null;
    const view = this.anim.name.endsWith('_front') ? 'front' : this.anim.name.endsWith('_back') ? 'back' : 'side';     // which way this swing goes
    return { view, id: this.attackId, ...a, dmg: Math.round(a.dmg * this.dmgMul) };
  }

  // charge the special meter by a share of a full meter (escalation makes it charge faster)
  addSpecial(frac) { this.cd.special = Math.max(0, this.cd.special - frac * C.specialCooldown * this.chargeMul); }

  // ---------- being grabbed and thrown ----------
  canBeGrabbed() {
    return !['held', 'thrown', 'down', 'getup', 'defeat', 'dodge', 'hurt'].includes(this.state) && this.invuln <= 0 && this.z <= 20;
  }
  getGrabbed(holder) {
    this.holder = holder; this.vx = 0; this.vz = 0; this.struggle = 0;
    this._enter('held', 'idle');
  }
  _held(dt, input, actions) {
    const h = this.holder;
    if (!h || !h.holdingZee) { this.holder = null; return this._fall(0, false); }
    this.x = h.x + h.face * 36; this.y = h.y + 1; this.z = 0; this.face = -h.face;     // she is drawn inside the grabber's own animation
    for (const a of actions) if (a === 'light' || a === 'jump' || a === 'dodge' || a === 'special') { this.struggle++; h.joltAt = performance.now(); }
    if (this.struggle >= C.escapeMash) { h.breakFree(); this.events.push({ type: 'escape' }); this.x = h.x + h.face * 66; this.z = 45; this.px = this.x; this.pz = 45; this._fall(-h.face * 120, false); }
  }
  // flung by the holder; lands as a slam that costs a share of her HP
  throwAway(dir, x, z) {
    this.holder = null; this._fall(dir * CONFIG.enemy.throwSpeed, true);
    this.x = x; this.z = z; this.vz = CONFIG.enemy.throwLift; this.face = dir;
    this.px = this.x; this.pz = this.z;                    // no interpolation across the jump from "inside the grab" to "in the air"
  }
  _fall(vx, slam) {
    this.vx = vx; this.vz = 80; this.slam = slam; this.holder = null;
    this._enter('thrown', 'thrown');
  }
  _thrown(dt) {
    this.x += this.vx * dt; this.vz -= C.gravity * dt; this.z += this.vz * dt;
    if (this.z <= 0 && this.vz < 0) {
      this.z = 0; this.vz = 0;
      if (this.slam) {
        const dmg = Math.round(C.maxHp * CONFIG.enemy.throwDamagePct);
        this.hp = Math.max(0, this.hp - dmg); this.flash = 0.3;
        this.events.push({ type: 'slam', dmg });
        // she lands belly-first and slides a little, face-down (never on her back)
        const dir = Math.sign(this.vx) || this.face;
        this.prone = true; this.finalDefeat = this.hp <= 0; this.vx = dir * 70; this.face = dir;
        this._enter('down', 'prone_land');
      } else {                                               // broke free: a soft landing, still face-down, no damage
        this.prone = true; this.finalDefeat = false; this.vx = (Math.sign(this.vx) || this.face) * 40;
        this._enter('down', 'prone_land');
      }
    }
  }

  // ---------- animation helpers ----------
  // The version of an animation for the way she is turned ('side', 'front' = facing the camera, 'back' = facing away).
  // Falls back to the side version while a front / back sheet doesn't exist yet.
  _dir(base) { const n = base + '_' + this.view; return this.view !== 'side' && this.anims[n] ? n : base; }

  // the current animation without its _front / _back ending (the name the combat rules use)
  get move() { return this.animName.replace(/_(front|back)$/, ''); }

  // turn toward a held direction: mostly up = back, mostly down = front, a real sideways push = side (no input keeps the current one)
  // hysteresis: turning to front / back needs a clearly vertical push, turning back to the side a clearly sideways one, so a diagonal never flickers
  _turn(a) {
    const ax = Math.abs(a.x), ay = Math.abs(a.y);
    if (this.view === 'side') { if (ay > 0.2 && ay > ax * 1.4) this.view = a.y > 0 ? 'front' : 'back'; }
    else if (ax > 0.2 && ax > ay * 1.0) this.view = 'side';
    else if (ay > 0.2) this.view = a.y > 0 ? 'front' : 'back';
  }

  _play(name) {
    if (this.anim && name !== this.animName) this.xfade = { anim: this.anim, frame: this.frame, t: 0 };     // blend out of the previous animation
    this.anim = this.anims[name]; this.animName = name; this.t = 0;
  }
  get frame() { return frameAt(this.anim, this.t); }
  get done() { return this.t >= this.anim.duration; }
  get cooldowns() { return { special: C.specialCooldown, dodge: C.dodgeCooldown }; }

  // ---------- Printout Barrage ----------
  _fire() {
    const B = C.barrage;
    for (let i = 0; i < B.perFrame; i++) {
      this.papers.push({
        x: this.x + this.face * 34, y: this.y, z: 70 + Math.random() * 22 - 8,
        vx: this.face * (B.speed + Math.random() * 60), vz: (Math.random() - 0.5) * B.spread,
        spin: Math.random() * 6.28, t: 0,
      });
    }
  }
  _updatePapers(dt) {
    for (const p of this.papers) { p.t += dt; p.x += p.vx * dt; p.vz -= 55 * dt; p.z = Math.max(4, p.z + p.vz * dt); p.spin += dt * 14; }
    this.papers = this.papers.filter((p) => !p.dead && p.t < C.barrage.life && p.x > (this.bounds ? this.bounds.minX : 0) - 80 && p.x < (this.bounds ? this.bounds.maxX : 640) + 80);
  }

  // ---------- main update ----------
  update(dt, input, bounds) {
    this.bounds = bounds;
    this.t += dt;
    this.cd.dodge = Math.max(0, this.cd.dodge - dt);
    this.cd.special = Math.max(0, this.cd.special - dt * C.specialCooldown * CONFIG.special.trickle * this.chargeMul);   // the special is earned by hitting (addSpecial); this is only a slow trickle
    this.invuln = Math.max(0, this.invuln - dt);
    this.flash = Math.max(0, this.flash - dt);
    const actions = input.consume();
    this._updatePapers(dt);

    for (const a of actions) this._dev(a);

    switch (this.state) {
      case 'idle': case 'walk': case 'run': case 'makeup': this._free(dt, input, actions); break;
      case 'attack': this._attack(dt, input, actions); break;
      case 'jump': this._jump(dt, input, actions); break;
      case 'dodge': this._dodge(dt); break;
      case 'hurt': this._hurt(dt); break;
      case 'held': this._held(dt, input, actions); break;
      case 'thrown': this._thrown(dt); break;
      case 'down': this._down(dt); break;
      case 'getup': if (this.done) this._enter('idle'); break;
      case 'defeat': break;
      case 'victory': if (input.moving || actions.some((a) => !a.startsWith('dev_'))) this._enter('idle'); break;
      case 'interact': if (this.done) this._enter('idle'); break;
    }
    this._clamp(bounds);
    this._visuals(dt);
  }

  // Motion-blur bookkeeping: blur strength from real speed, a short position history, and the previous frame for smears.
  _visuals(dt) {
    if (this.px !== undefined) {
      const v = Math.hypot(this.x - this.px, this.y - this.py) / dt;
      // walk (110 px/s) barely registers, a full run (220 px/s) gives a gentle trail
      const target = Math.min(0.5, Math.max(0, (v - 100) / 260));
      this.blur += (target - this.blur) * Math.min(1, dt * 18);
    }
    this._trailT += dt;
    if (this._trailT >= 1 / 60) {
      this._trailT -= 1 / 60;
      this.trail.unshift({ x: this.x, y: this.y, lift: Math.max(0, this.z), anim: this.anim, frame: this.frame, face: this.face });
      if (this.trail.length > 7) this.trail.pop();
    }
    const key = this.animName + ':' + this.frame;
    if (key !== this._key) { if (this._ka) this.smear = { anim: this._ka, frame: this._kf, t: 0 }; this._key = key; this._ka = this.anim; this._kf = this.frame; }
    if (this.smear) this.smear.t += dt;
    if (this.xfade) { this.xfade.t += dt; if (this.xfade.t > XFADE_TIME) this.xfade = null; }
  }

  // ---------- state transitions ----------
  _enter(state, anim) {
    if (SIDE_ONLY.has(state)) this.view = 'side';      // these moves only exist side-on: the idle after them matches
    this.state = state; this.phase = ''; this.queued = false; this.idleTime = 0;
    if (state !== 'down' && state !== 'getup' && state !== 'defeat') this.prone = false;
    if (state === 'attack') this.attackId++;
    if (state === 'idle') this._play(this._dir('idle'));
    else if (anim) this._play(anim);
  }

  _dev(a) {
    if (a === 'dev_hurt') this.takeHit(10, -this.face);
    if (a === 'dev_knockdown') this._knockdown(-this.face);
    if (a === 'dev_defeat') { this.hp = 0; this._knockdown(-this.face, true); }
    if (a === 'dev_victory') this._enter('victory', 'victory');
    if (a === 'dev_revive') { this.hp = C.maxHp; this.z = 0; this.vz = 0; this._enter('idle'); }
  }

  takeHit(dmg, dir = -this.face) {
    if (this.invuln > 0 || ['defeat', 'down', 'getup', 'held', 'thrown'].includes(this.state)) return false;
    this.hp = Math.max(0, this.hp - dmg);
    this.flash = 0.22;
    this.invuln = C.invulnerabilityAfterHit;
    this.vx = dir * 90;
    if (this.hp <= 0) { this._knockdown(dir, true); return true; }
    this.z = 0; this.vz = 0;
    this._enter('hurt', 'hurt');
    return true;
  }

  _knockdown(dir, thenDefeat = false) {
    this.vx = dir * 70; this.z = 0; this.vz = 0;
    this.finalDefeat = thenDefeat;
    this._enter('down', 'knockdown');
  }

  // ---------- grounded movement + action intake ----------
  _free(dt, input, actions) {
    const a = input.axis;
    for (const act of actions) {
      if (act === 'jump') return this._startJump(a);
      if (act === 'light') return this._startAttack('punch_1', a);
      if (act === 'special' && this.cd.special <= 0) { this.cd.special = C.specialCooldown; this.view = 'side'; return this._startAttack('special', { x: a.x, y: 0 }); }
      if (act === 'dodge' && this.cd.dodge <= 0) return this._startDodge(a);
      if (act === 'interact') return this._enter('interact', 'interact');
    }
    if (input.moving) {
      const running = input.run;
      const speed = running ? C.runSpeed : C.walkSpeed;
      this.x += a.x * speed * dt;
      this.y += a.y * speed * C.depthSpeedFactor * dt;
      if (Math.abs(a.x) > 0.05) this.face = a.x > 0 ? 1 : -1;
      // mostly up the screen = facing away, mostly down = facing the camera, any real sideways push = side view; kept when she stops
      this._turn(a);
      const want = running ? 'run' : 'walk', clip = this._dir(want);
      if (this.state !== want || this.animName !== clip) { this.state = want; this._play(clip); }
      this.idleTime = 0;
    } else {
      if (this.state === 'walk' || this.state === 'run') { this.state = 'idle'; this._play(this._dir('idle')); }
      if (this.state === 'idle') {
        this.idleTime += dt;
        // start the makeup at the top of the idle loop (no pop mid-sway)
        if (this.idleTime > C.makeupIdleDelay && this.frame === 0 && (this.view === 'side' || this.anims['idle_makeup_' + this.view])) { this.state = 'makeup'; this._play(this._dir('idle_makeup')); }
      } else if (this.state === 'makeup' && this.done) {
        this.state = 'idle'; this.idleTime = 0; this._play(this._dir('idle'));
      }
    }
    if (Math.abs(this.vx) > 1) { this.x += this.vx * dt; this.vx *= Math.pow(0.02, dt); } else this.vx = 0;
  }

  // ---------- attacks ----------
  _startAttack(name, axis) {
    if (Math.abs(axis.x) > 0.3) this.face = axis.x > 0 ? 1 : -1;
    this._turn(axis);
    this._enter('attack', this._dir(name));
  }

  _attack(dt, input, actions) {
    const name = this.move;
    const f = this.frame;
    const lastActive = this.anim.active.length ? Math.max(...this.anim.active) : this.anim.frames - 1;
    // Printout Barrage: spit out paper on every hit frame of the special
    if (name === 'special') {
      if (this.anim.active.includes(f) && this.barrageFrame !== f) { this.barrageFrame = f; this._fire(); }
    } else this.barrageFrame = -1;
    // chain the light combo: punch_1 -> punch_2 -> punch_3
    if (actions.includes('light') && (name === 'punch_1' || name === 'punch_2')) this.queued = true;
    // forward step while swinging
    const lunge = C.lunge[name] || 0;
    const st = this.anim.starts;
    if (lunge && f >= 1 && f <= lastActive) {
      const step = (lunge / (st[lastActive + 1] - st[1])) * dt, view = this.anim.name.endsWith('_front') ? 1 : this.anim.name.endsWith('_back') ? -1 : 0;
      if (view) this.y += view * step * C.depthSpeedFactor; else this.x += this.face * step;
    }
    const next = name === 'punch_1' ? 'punch_2' : name === 'punch_2' ? 'punch_3' : null;
    if (this.queued && next && f > lastActive) { this.queued = false; this._turn(input.axis); this._enter('attack', this._dir(next)); return; }
    // recovery frames can be cancelled into a dodge or jump so the controls never feel stuck
    if (f > lastActive) {
      for (const act of actions) {
        if (act === 'jump') return this._startJump(input.axis);
        if (act === 'dodge' && this.cd.dodge <= 0) return this._startDodge(input.axis);
      }
    }
    if (this.done) this._enter('idle');
  }

  // ---------- jump ----------
  _startJump(axis) { if (axis) this._turn(axis); this.state = 'jump'; this.phase = 'start'; this.airKick = false; this._play(this._dir('jump_start')); }

  _jump(dt, input, actions) {
    const a = input.axis;
    if (this.phase === 'start') {
      if (this.t >= C.jumpStartTime) { this.phase = 'air'; this.vz = C.jumpVelocity; this._play(this._dir('jump_rise')); }
      return;
    }
    if (this.phase === 'air') {
      // variable jump height: releasing the button early cuts the rise short (a tap = small hop, hold = full jump)
      if (!input.held('jump') && this.vz > C.jumpCutVelocity) this.vz = C.jumpCutVelocity;
      this.vz -= C.gravity * dt; this.z += this.vz * dt;
      const speed = (input.run ? C.runSpeed : C.walkSpeed) * C.airControl;
      this.x += a.x * speed * dt; this.y += a.y * speed * C.depthSpeedFactor * dt * 0.7;
      if (Math.abs(a.x) > 0.05) this.face = a.x > 0 ? 1 : -1;
      if (actions.includes('light') && !this.airKick) { this.airKick = true; this.attackId++; this._turn(a); this._play(this._dir('jump_kick')); }
      if (!this.airKick) {
        const want = this._dir(this.vz > 0 ? 'jump_rise' : 'jump_fall');
        if (this.animName !== want) this._play(want);
      }
      if (this.z <= 0 && this.vz < 0) { this.z = 0; this.vz = 0; this.phase = 'land'; this._play(this._dir('jump_land')); }
      return;
    }
    if (this.phase === 'land' && this.done) this._enter('idle');
  }

  // ---------- dodge roll ----------
  _startDodge(axis) {
    this.cd.dodge = C.dodgeCooldown;
    let dx = axis.x, dy = axis.y;
    if (Math.abs(dx) < 0.2 && Math.abs(dy) < 0.2) { dx = this.view === 'side' ? this.face : 0; dy = this.view === 'front' ? 1 : this.view === 'back' ? -1 : 0; }     // no direction held: roll the way she is turned
    const l = Math.hypot(dx, dy) || 1;
    this.dodgeDir = { x: dx / l, y: dy / l };
    if (Math.abs(dx) > 0.2) this.face = dx > 0 ? 1 : -1;
    this._turn(this.dodgeDir);
    this._enter('dodge', this._dir('dodge'));
  }

  _dodge(dt) {
    const f = this.frame;
    if (this.anim.iframes.includes(f)) this.invuln = Math.max(this.invuln, 0.08);
    const speed = C.dodgeDistance / this.anim.duration;
    this.x += this.dodgeDir.x * speed * dt;
    this.y += this.dodgeDir.y * speed * C.depthSpeedFactor * dt;
    if (this.done) this._enter('idle');
  }

  // ---------- reactions ----------
  _hurt(dt) {
    this.x += this.vx * dt; this.vx *= Math.pow(0.02, dt);
    if (this.done) this._enter('idle');
  }

  _down(dt) {
    this.x += this.vx * dt; this.vx *= Math.pow(0.05, dt);
    if (this.prone) {                                        // lying face-down after being thrown
      if (this.animName === 'prone_land' && this.done) this._play('prone_lie');
      else if (this.animName === 'prone_lie' && this.t >= C.proneHold) {
        if (this.finalDefeat) { this.state = 'defeat'; return; }          // stays lying face-down (the sandbox gets her back up shortly)
        this.state = 'getup'; this._play('get_up_prone'); this.invuln = 1.4;
      }
      return;
    }
    if (this.animName === 'knockdown' && this.done) {
      if (this.finalDefeat) { this.state = 'defeat'; return; }          // the very same knockdown, then she stays lying on its last frame
      if (this.t >= this.anim.duration + C.knockdownHold) { this.state = 'getup'; this._play('get_up'); this.invuln = 1.4; }
    }
  }

  _clamp(b) {
    const m = (this.prone || this.state === 'thrown') ? 38 : 0;          // her lying body is long: keep it on screen
    this.x = Math.max(b.minX + m, Math.min(b.maxX - m, this.x));
    this.y = Math.max(b.minY, Math.min(b.maxY, this.y));
  }

  // ---------- drawing ----------
  // remember where she was before the next logic step, so drawing can interpolate (smooth at any refresh rate)
  snapshot() { this.px = this.x; this.py = this.y; this.pz = this.z; }

  draw(ctx, alpha = 1) {
    if (this.px === undefined) this.snapshot();
    if (this.state === 'held') { this._drawPapers(ctx); return; }          // the grabber's animation already draws her
    const x = this.px + (this.x - this.px) * alpha;
    const y = this.py + (this.y - this.py) * alpha;
    const lift = Math.max(0, this.pz + (this.z - this.pz) * alpha);
    this._drawShadow(ctx, x, y, lift);
    // motion blur: faint ghosts along her recent path while she moves fast
    if (this.blur > 0.06) {
      for (let i = 0; i < TRAIL_LAGS.length; i++) {
        const h = this.trail[TRAIL_LAGS[i]];
        if (h) drawAnim(ctx, this.character, h.anim, h.frame, h.x, h.y - h.lift, faceFor(h.anim, h.face), TRAIL_ALPHA[i] * this.blur);
      }
    }
    // swing / roll smear: the previous frame lingers for a moment, which blurs fast poses together
    // animation switch: the previous pose dissolves under the new one for a moment (no pop in size or position)
    const xf = this.xfade;
    if (xf && !['held', 'thrown'].includes(this.state)) drawAnim(ctx, this.character, xf.anim, xf.frame, x, y - lift, faceFor(xf.anim, this.face), 0.55 * (1 - xf.t / XFADE_TIME));
    const s = this.smear;
    if (s && s.t < SMEAR_TIME && (SMEAR_STATES.has(this.state) || this.move === 'jump_kick')) {
      drawAnim(ctx, this.character, s.anim, s.frame, x, y - lift, faceFor(s.anim, this.face), 0.32 * (1 - s.t / SMEAR_TIME));
    }
    // soft pulse while invulnerable after a hit (she never vanishes completely)
    const blink = this.flash <= 0 && this.invuln > 0 && this.state !== 'dodge';
    // invulnerable: she stays fully solid with a gentle white glow pulsing over her (no see-through blinking)
    drawAnim(ctx, this.character, this.anim, this.frame, x, y - lift, faceFor(this.anim, this.face), 1, this.flash * 6, blink ? 0.14 + 0.12 * Math.cos(this.invuln * 14) : 0);
    this._drawPapers(ctx);
  }

  _drawShadow(ctx, x, y, lift) {
    drawShadow(ctx, this.character, this.anim, this.frame, x, y, lift, faceFor(this.anim, this.face), this.state === 'down' || this.state === 'getup' || this.state === 'defeat');
  }

  _drawPapers(ctx) {
    for (const p of this.papers) {
      const fade = Math.min(1, (C.barrage.life - p.t) * 5);
      // shadow on the floor under the flying sheet: shrinks and fades the higher it is
      const hs = Math.max(0, 1 - p.z / 170);
      ctx.globalAlpha = 0.5 * fade * hs;
      ctx.drawImage(SOFT, p.x - 9, p.y - 2.5, 18, 5);
      const dir = Math.sign(p.vx);
      // motion-blur streak behind the sheet
      for (let i = 2; i >= 0; i--) {
        ctx.save();
        ctx.globalAlpha = fade * (i === 0 ? 1 : 0.2 / i);
        ctx.translate(p.x - dir * i * 6, p.y - p.z); ctx.rotate(Math.sin(p.spin) * 0.5);
        ctx.fillStyle = '#10101a'; ctx.fillRect(-6, -4, 12, 9);              // outline
        ctx.fillStyle = '#f4f1ea'; ctx.fillRect(-5, -3, 10, 7);              // sheet
        if (i === 0) { ctx.fillStyle = '#9aa0b4'; ctx.fillRect(-3, -1, 6, 1); ctx.fillRect(-3, 1, 5, 1); }  // text lines
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }
}



