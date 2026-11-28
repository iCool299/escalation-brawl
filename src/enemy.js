// Enemy: a fighter with a small brain. It lines up with Zee, flanks, chains combos, sidesteps her swings, punishes her recovery,
// throws call-centre headsets, and (navy + sporty, the "heavies") grabs and throws her.
// Art comes from assets/characters/<id>/ ; every enemy shares this one brain.
import { CONFIG } from './config.js?v=202611282241';
import { frameAt, drawAnim, drawShadow, LOOK } from './assets.js?v=202611282241';

const E = CONFIG.enemy;
const rnd = (a, b) => a + Math.random() * (b - a);
const sgn = (v) => (v < 0 ? -1 : 1);

// internal ids only (not shown in the game)
export const ENEMY_IDS = ['navy', 'polo', 'plum', 'cream', 'fighter', 'gangly', 'sporty', 'curvy'];

// The grabbers' animation sheet is drawn WITH Zee in it (so the two are always perfectly in sync). These numbers line the real Zee up
// with it: CLAMP_DX = how far in front of the grabber Zee stands in the clamp frame; RELEASE = where she leaves his hands (px in front
// of his feet, px above the ground) when the throw releases.
// Each enemy walks in its own way. step = length of one step as a share of its height (the walk cycle is advanced by the distance it
// actually covers, so feet never skate), speed = walking-pace multiplier, lean = forward tilt (radians), bounce = extra lift at mid-step (px),
// sway = side-to-side body roll (radians), turn = seconds to commit to a new facing after changing direction.
// Personality: atk = attack animation speed, idle = idle animation speed, aggr = how quickly it attacks again.
const WALK_STYLE = {
  navy:    { step: 0.56, speed: 0.92, lean: 0.00, bounce: 0.6, sway: 0.010, turn: 0.14, atk: 0.88, idle: 0.8, aggr: 0.9 },   // heavy and upright: slow, planted steps
  sporty:  { step: 0.60, speed: 1.12, lean: 0.05, bounce: 1.5, sway: 0.012, turn: 0.08, atk: 1.12, idle: 1.15, aggr: 1.15 },   // athletic: long bouncy strides, leans in
  polo:    { step: 0.40, speed: 1.00, lean: 0.02, bounce: 1.3, sway: 0.030, turn: 0.10, atk: 0.95, idle: 1.1, aggr: 0.95 },   // short and round: quick little steps, waddle
  plum:    { step: 0.50, speed: 1.05, lean: 0.01, bounce: 0.7, sway: 0.008, turn: 0.09, atk: 1.05, idle: 0.9, aggr: 1.0 },   // brisk and composed
  cream:   { step: 0.52, speed: 0.98, lean: 0.02, bounce: 0.9, sway: 0.016, turn: 0.10, atk: 1.0, idle: 1.0, aggr: 0.95 },   // casual stroll
  fighter: { step: 0.55, speed: 1.15, lean: 0.07, bounce: 1.4, sway: 0.010, turn: 0.07, atk: 1.18, idle: 1.25, aggr: 1.25 },   // aggressive: fast, leaning forward
  gangly:  { step: 0.64, speed: 0.90, lean: 0.10, bounce: 0.5, sway: 0.028, turn: 0.15, atk: 0.9, idle: 0.75, aggr: 0.85 },   // slouched and loose: long lazy strides
  curvy:   { step: 0.48, speed: 1.00, lean: 0.00, bounce: 0.8, sway: 0.034, turn: 0.10, atk: 1.0, idle: 0.95, aggr: 1.05 },   // confident swagger
};
const ACCEL = 560;                                                // px/s^2: enemies speed up and slow down instead of snapping

// running: starts when it is further than RUN_FROM px from its spot by her, stops inside RUN_UNTIL; RUN_SPEED = x walking pace, RUN_STEP = x stride length
const RUN_FROM = 230, RUN_UNTIL = 120, RUN_SPEED = 1.9, RUN_STEP = 1.7;
const KD_LIFT = 0.2;                     // knockdown arc height, as a share of the character's height
const CLAMP_DX = { navy: 52, sporty: 48 };
const RELEASE = { navy: { dx: 92, z: 78 }, sporty: { dx: 58, z: 46 } };

export class Enemy {
  constructor(id, character, x, y) {
    this.id = id; this.character = character; this.anims = character.anims;
    this.heavy = !!character.manifest.grab;                          // navy + sporty: tougher, harder hitting, can grab
    this.canGrab = this.heavy;
    this.x = x; this.y = y; this.z = 0; this.vx = 0; this.face = 1; this.view = 'side';
    this.hp = this.maxHp = this.heavy ? E.heavyHp : E.hp;
    this.dmgMul = this.heavy ? E.heavyDmgMul : 1;
    this.style = WALK_STYLE[id] || WALK_STYLE.cream;
    this.aggr = rnd(0.9, 1.25) * (this.heavy ? 1.1 : 1) * (this.style.aggr || 1);   // how fast it recovers between attacks
    this.speed = E.walkSpeed * rnd(0.95, 1.2) * (this.heavy ? 1.05 : 1) * this.style.speed;
    this.stepLen = this.style.step * (character.manifest.gameHeight || 140);      // px covered by one step (one pass through the walk loop)
    this.vw = 0; this.vh = 0; this.turnT = 0; this.stride = 0; this.leanK = 0;                      // smoothed velocity, turn timer, walk phase 0..1 per step
    this.atkRate = (this.heavy ? 1.12 : 1.1) * (this.style.atk || 1);                           // their swings are quicker than the raw animation
    this.evadeChance = this.heavy ? 0.12 : 0.4;
    this.prefersRange = !this.canGrab && Math.random() < 0.45;       // some enemies keep their distance and throw headsets
    this.side = 1;                                         // which side of Zee it likes to fight from
    this.flash = 0; this.barT = 0; this.spawnT = 0.5; this.cool = rnd(0.5, 0.9);
    this.mx = 0; this.my = 0; this.decideT = 0; this.still = 0; this.sideT = 0; this.hitCool = 0; this.combo = 0; this.evadeId = -1; this.evadeT = 0;
    this.tellT = 0; this.squash = 0; this.landed = true; this.stepAcc = 0;
    this.hitId = -1; this.holdingZee = false; this.struggle = 0; this.deadT = 0; this.remove = false;
    this.state = 'spawn'; this.attackName = 'punch';
    this._play('idle');
  }

  // idle, walk and run have front / back versions when the enemy has them (base = 'idle' / 'walk' / 'run', animName = the real one); every other move is side-on
  _play(name) {
    if (name !== 'idle' && name !== 'walk' && name !== 'run') this.view = 'side';
    const real = this.view !== 'side' && this.anims[name + '_' + this.view] ? name + '_' + this.view : name;
    this.anim = this.anims[real]; this.animName = real; this.base = name; this.t = 0;
  }
  // walking: turn to front / back on a clearly vertical walk, back to the side on a clearly sideways one (hysteresis: no flicker on diagonals)
  _turnView() {
    if (!this.anims.walk_front) return;
    const ax = Math.abs(this.vw), ay = Math.abs(this.vh) / CONFIG.zee.depthSpeedFactor, was = this.view;
    if (this.view === 'side') { if (ay > 20 && ay > ax * 1.4) this.view = this.vh > 0 ? 'front' : 'back'; }
    else if (ax > 20 && ax > ay) this.view = 'side';
    else if (ay > 20) this.view = this.vh > 0 ? 'front' : 'back';
    if (this.view !== was) { this._play(this.base); this.t = this.stride * this.anim.duration; }
  }
  get frame() { return frameAt(this.anim, this.t); }
  get done() { return this.t >= this.anim.duration; }
  snapshot() { this.px = this.x; this.py = this.y; }
  canBeHit() { return !['spawn', 'dead', 'down'].includes(this.state) && !this.holdingZee; }
  get attacking() { return ['attack', 'grab', 'hold', 'throw'].includes(this.state); }

  breakFree() { this.holdingZee = false; this.state = 'hurt'; this._play('hurt'); this.vx = -this.face * 40; this.cool = 1.2; }

  // returns false if ignored, 'kill' if it killed, true otherwise
  takeHit(dmg, dir, knock) {
    if (!this.canBeHit()) return false;
    this.hp -= dmg; this.flash = 0.22; this.barT = 2.6; this.squash = 1; this.landed = false;
    if (this.hp <= 0) { this.hp = 0; this.state = 'dead'; this._play('defeat'); this.vx = dir * 100; this.deadT = 0; return 'kill'; }
    if (knock) { this.state = 'down'; this._play('knockdown'); this.vx = dir * 120; this.hitCool = 0; return true; }
    // committed swings (past the wind-up) can't be flinched by a light hit, and nobody can be stun-locked forever
    const committed = (this.state === 'attack' && this.frame >= Math.min(...this.anim.active)) || this.state === 'ranged' && this.frame >= (this.anim.release[0] || 0);
    if (committed || this.hitCool > 0) return true;
    this.state = 'hurt'; this._play('hurt'); this.vx = dir * 55; this.hitCool = E.hitCool; this.combo = 0;
    return true;
  }

  update(dt, g) {
    const rate = this.state === 'attack' ? this.atkRate : this.base === 'idle' ? (this.style.idle || 1) : 1;
    if (this.state !== 'whiff' && !(this.base === 'walk' || this.base === 'run')) this.t += dt * rate;   // the walk loop is advanced by distance walked (see _stride)
    this.flash = Math.max(0, this.flash - dt);
    this.tellT = Math.max(0, this.tellT - dt); this.squash = Math.max(0, this.squash - dt * 6);
    // body hits the floor (knockdown / KO): dust cloud once
    if ((this.state === 'down' || this.state === 'dead') && !this.landed && (this.animName === 'knockdown' || this.animName === 'defeat') && this.frame >= this.anim.frames - 3) { this.landed = true; g.floorDust(this.x, this.y, this.heavy ? 1.4 : 1.1); }
    const tl = (this.state === 'walk' || this.state === 'evade') ? Math.min(1, Math.hypot(this.vw, this.vh) / Math.max(1, this.speed)) : 0;
    this.leanK += (tl - this.leanK) * Math.min(1, dt * 9);        // eases the style in and out as it starts and stops walking
    this.barT = Math.max(0, this.barT - dt);
    this.hitCool = Math.max(0, this.hitCool - dt);
    switch (this.state) {
      case 'spawn': this.spawnT -= dt; if (this.spawnT <= 0) { this.state = 'idle'; this._play('idle'); } break;
      case 'idle': case 'walk': this._free(dt, g); break;
      case 'evade': this._evade(dt, g); break;
      case 'attack': this._attack(dt, g); break;
      case 'ranged': this._ranged(dt, g); break;
      case 'grab': this._grab(dt, g); break;
      case 'whiff': this.whiffT -= dt; if (this.whiffT <= 0) this._back(0.7); break;
      case 'hold': this._hold(dt, g); break;
      case 'throw': this._throw(dt, g); break;
      case 'hurt': this.x += this.vx * dt; this.vx *= Math.pow(0.02, dt); if (this.done) this._back(0.2); break;
      case 'down': this._down(dt); break;
      case 'dead':
        this.x += this.vx * dt; this.vx *= Math.pow(0.04, dt);
        if (this.done) { this.deadT += dt; if (this.deadT > E.corpseTime) this.remove = true; }
        break;
    }
    const b = g.bounds;
    if (this.entering) { if (this.x > b.minX && this.x < b.maxX) this.entering = false; }    // walking in from off-screen
    else this.x = Math.max(b.minX - 20, Math.min(b.maxX + 20, this.x));
    this.y = Math.max(b.minY, Math.min(b.maxY, this.y));
  }

  // Advance the walk loop by the distance covered (negative = walking backwards): one step = one pass through the 12-frame loop.
  _stride(d) {
    const dur = this.anim.duration, len = this.base === 'run' ? this.stepLen * RUN_STEP : this.stepLen;   // running strides are longer
    this.stride = (((this.stride + d / len) % 1) + 1) % 1;
    this.t = this.stride * dur;
  }
  // Ease the velocity toward a target (no sudden starts, stops or reversals).
  _steer(tvx, tvy, dt) {
    const a = ACCEL * dt, ex = tvx - this.vw, ey = tvy - this.vh, m = Math.hypot(ex, ey);
    if (m <= a) { this.vw = tvx; this.vh = tvy; } else { this.vw += ex / m * a; this.vh += ey / m * a; }
  }
  // Which way to look: the way it is walking, never walking backwards at her. Standing still (or only closing in depth) it looks at her.
  // A change of facing waits a moment (and for the body to slow down), so a turn-around reads as a real turn.
  _facing(z, dt, moving) {
    let want = this.face;
    if (moving && Math.abs(this.vw) > 10) want = sgn(this.vw);                 // always face the way it is walking
    else if (Math.abs(z.x - this.x) > 5) want = z.x > this.x ? 1 : -1;          // standing: face her
    if (want === this.face) { this.turnT = 0; return; }
    this.turnT += dt;
    if (this.turnT >= 0.05) { this.face = want; this.turnT = 0; }               // a quick turn, never walking backwards
  }

  _back(cd) { this.state = 'idle'; this._play('idle'); this.vw = 0; this.vh = 0; this.cool = Math.max(this.cool, cd / this.aggr); }
  _faceZee(z) { if (Math.abs(z.x - this.x) > 5) this.face = z.x > this.x ? 1 : -1; }

  // ---------- on the move ----------
  _free(dt, g) {
    const z = g.zee, dx = z.x - this.x, dy = z.y - this.y, adx = Math.abs(dx), ady = Math.abs(dy);
    this.cool -= dt * this.aggr * (g.escMul || 1);        // the higher the escalation, the sooner they attack again
    const calm = z.state === 'defeat';
    // she just whiffed or is stuck in a recovery: punish it
    if (z.state === 'attack' && z.anim.active.length && z.frame > Math.max(...z.anim.active) && adx < E.attackRange + 40) this.cool = Math.min(this.cool, 0.06);
    // she starts a swing next to me: maybe sidestep it, then counter
    if (!calm && z.state === 'attack' && z.attackId !== this.evadeId && adx < 78 && ady < 22 && z.anim.active.length && z.frame < Math.min(...z.anim.active)) {
      this.evadeId = z.attackId;
      if (Math.random() < this.evadeChance) {
        this._faceZee(z); this.state = 'evade'; this.evadeT = 0.28; this._play('walk');
        this.mx = 0; this.my = (ady > 6 ? -sgn(dy) : (Math.random() < 0.5 ? 1 : -1)) * 1.4; return;     // sidestep in depth (never back away)
      }
    }
    // ---- pick a spot (always closing in on her, never backing off) ----
    // One enemy takes her front; the next one works round to her BACK (the side she is not facing) to hit her from behind.
    // A lone enemy also tries to slip behind her now and then. To get round it detours through depth instead of walking through her.
    this.decideT -= dt; this.sideT -= dt;
    const mySide = sgn(this.x - z.x), behind = -(z.face || 1);
    if (this.decideT <= 0) {
      this.decideT = 0.15;
      if (this.sideT <= 0) {
        const front = g.enemies.some((o) => o !== this && !['dead', 'down', 'spawn'].includes(o.state) && sgn(o.x - z.x) === -behind && Math.abs(o.x - z.x) < 110);
        // surround her: take whichever side has fewer of us on it (so a crowd spreads out round her instead of queueing)
        const mates = g.enemies.filter((o) => o !== this && !['dead', 'down', 'spawn'].includes(o.state) && o.side);
        const nB = mates.filter((o) => o.side === behind).length, nF = mates.length - nB;
        if (nB < nF) this.side = behind;
        else if (nF < nB) this.side = -behind;
        else if (front) this.side = behind;                                                             // someone is already in her face: go round the back
        else if (Math.random() < (this.heavy ? 0.25 : 0.4)) this.side = behind;                         // flank on my own
        else this.side = mySide;
        // sharing a side: stand in a different depth lane so we don't hide behind each other
        const same = mates.filter((o) => o.side === this.side && o.id < this.id).length;
        this.slotY = same === 0 ? 0 : (same % 2 ? -1 : 1) * 22;
        this.sideT = rnd(1.6, 2.8);
      }
      const wait = g.attackerCount() >= g.maxAttackers && !this.attacking && this.side !== behind;   // the attack slots are full: hover just outside her reach (backstabbers never wait)
      let mx = 0, my = 0;
      if (calm) {                                                     // she is beaten: step back off her body and stand around her
        this.mx = adx < 70 ? -sgn(dx || 1) * 0.6 : 0; this.my = 0; this.running = false;
      }
      else {
        const tx = z.x + this.side * (wait ? E.attackRange + 34 : E.attackRange * 0.8);
        let ty = z.y + (this.slotY || 0) * (Math.abs(this.x - tx) < 40 ? 0.35 : 1);   // close in on her line once in reach
        if (mySide !== this.side && adx < 95) ty = z.y + (this.lane || (this.lane = (Math.random() < 0.5 ? -1 : 1))) * 34;   // going round her: swing out in depth first
        else this.lane = 0;
        const ex = tx - this.x, ey = ty - this.y;
        if (!this.anims.run) this.running = false;
        else if (Math.abs(ex) > RUN_FROM) this.running = true;                                           // far off: run at her
        else if (Math.abs(ex) < RUN_UNTIL) this.running = false;                                        // close: drop back to a walk
        if (Math.abs(ex) > 7) mx = sgn(ex) * (this.running ? RUN_SPEED : Math.abs(ex) > 170 ? 1.3 : 1);   // charge in from afar
        if (Math.abs(ey) > 5) my = sgn(ey) * (mySide !== this.side ? 1.2 : 0.85);
        this.mx = mx; this.my = my;
      }
    }
    // ---- move (eased) ----
    let tvx = this.mx * this.speed, tvy = this.my * this.speed * CONFIG.zee.depthSpeedFactor * 1.15;
    if (!calm) {                                                     // don't stack on top of other enemies: nudge apart
      for (const o of g.enemies) {
        if (o === this || o.state === 'dead' || o.state === 'down') continue;
        const ox = this.x - o.x, oy = this.y - o.y;
        if (Math.abs(ox) < 30 && Math.abs(oy) < 12) { const k = 1 - Math.abs(ox) / 30; tvx += (ox === 0 ? (this.id < o.id ? 1 : -1) : sgn(ox)) * 70 * k; tvy += (oy === 0 ? 1 : sgn(oy)) * 40 * k; }
      }
    }
    if (!calm && adx > 140 && tvx !== 0 && sgn(tvx) !== sgn(dx)) tvx = 0;   // far from her: never drift further away
    if (this.turnT > 0 || (Math.abs(this.vw) > 10 && Math.abs(tvx) > 10 && sgn(tvx) !== sgn(this.vw))) {   // turning round: stop, turn, then go
      tvx = 0; tvy *= 0.6; if (Math.abs(this.vw) < 25) this.vw = 0;
    }
    this._steer(tvx, tvy, dt);
    const spd = Math.hypot(this.vw, this.vh), moving = spd > 8;
    if (moving) {
      const px = this.x, py = this.y;
      this.x += this.vw * dt; this.y += this.vh * dt;
      this.still = 0;
      const gait = this.running && this.anims.run ? 'run' : 'walk';
      if (this.state !== 'walk' || this.base !== gait) { this.state = 'walk'; this._play(gait); this.t = this.stride * this.anim.duration; }
      this._turnView();
      const d = Math.hypot(this.x - px, this.y - py);
      this._stride(d * (this.view !== 'side' || Math.abs(this.vw) < 14 || sgn(this.vw) === this.face ? 1 : -1));      // backwards only while turning round
      this.stepAcc += d; if (this.stepAcc > this.stepLen * 0.5) { this.stepAcc = 0; g.footDust(this.x - this.face * 6, this.y, 0.6); }
    } else {
      this.still += dt;
      if (this.state === 'walk' && this.still > 0.15) { this.state = 'idle'; this._play('idle'); }
      // navy shows off: every few seconds of standing he flexes and admires his bicep once, then back to his normal idle
      if (this.anims.flex && this.state === 'idle' && this.view === 'side') {
        if (this.animName === 'flex') { if (this.done) this._play('idle'); }
        else if (this.still > (this.flexAt || (this.flexAt = rnd(2.5, 5)))) { this._play('flex'); this.flexAt = this.still + rnd(4, 7); }
      }
    }
    if (!calm) this._facing(z, dt, moving);
    if (calm || this.cool > 0 || z.state === 'held') return;
    // ---- choose an attack ----
    const inRange = adx < E.attackRange + 8 && ady < E.engageY + 4;
    const atHerBack = sgn(this.x - z.x) === -(z.face || 1);                    // she is looking the other way: hit her from behind, no waiting
    if (inRange && atHerBack) this.cool = Math.min(this.cool, 0.05);
    if (inRange && (g.attackerCount() < g.maxAttackers || atHerBack)) {
      this._faceZee(z); this.turnT = 0;
      if (this.canGrab && Math.random() < E.grabChance && z.canBeGrabbed()) { this.state = 'grab'; this._play('grab'); this.tellT = 0.35; this.tellCol = '#ff5a4a'; g.sfx.grab(); return; }
      this.combo = this.combo > 0 ? this.combo : (Math.random() < 0.6 ? Math.floor(rnd(1, 3.4)) : 0);   // 0-2 follow-up hits
      this._startMelee(g);
    } else if (!this.canGrab && adx > 130 && adx < 460 && ady < 9 && Math.random() < (this.prefersRange ? 0.05 : 0.015)) {   // a headset on the way in
      this.state = 'ranged'; this.fired = false; this._play('throw_headset'); this._faceZee(z); this.tellT = 0.3; this.tellCol = '#ffe08a';
    }
  }

  _startMelee(g) {
    this.attackName = this.combo % 2 === 0 ? 'punch' : 'kick';
    if (Math.random() < 0.2) this.attackName = this.attackName === 'punch' ? 'kick' : 'punch';
    this.state = 'attack'; this.hitDone = false; this._play(this.attackName);
    this.tellT = 0.28; this.tellCol = this.heavy ? '#ffb07a' : '#fff4c8';                    // wind-up tell: a glint by the head
  }

  _evade(dt, g) {
    this.evadeT -= dt;
    const px = this.x, py = this.y;
    this.x += this.mx * this.speed * 1.9 * dt; this.y += this.my * this.speed * 1.0 * dt;
    this.vw = this.mx * this.speed * 1.9; this.vh = this.my * this.speed;
    const back = Math.sign((this.x - px) * this.face) || 1;
    this._stride(Math.hypot(this.x - px, this.y - py) * back);
    if (this.evadeT <= 0) { this.state = 'idle'; this._play('idle'); this.cool = 0.05; this.combo = 1; }   // and straight back in
  }

  _attack(dt, g) {
    const f = this.frame, a = this.anim, z = g.zee, first = Math.min(...a.active), last = Math.max(...a.active);
    if (f < first) this._faceZee(z);                                  // can still re-aim during the wind-up (she jumped over / went round), never after
    if (f >= 1 && f <= last && Math.abs(z.x - this.x) > 30) this.x += this.face * 48 * dt;    // step into the swing (never through her)
    if (!this.hitDone && a.active.includes(f)) {
      const dx = (z.x - this.x) * this.face;
      if (dx > -8 && dx < E.attackRange + 20 && Math.abs(z.y - this.y) < 17 && z.z < 40) {
        const dmg = Math.round((this.attackName === 'punch' ? E.punchDmg : E.kickDmg) * this.dmgMul);
        if (g.hurtZee(dmg, this.face, this)) this.hitDone = true;
      }
    }
    if (this.done) {
      const dx = Math.abs(z.x - this.x), dy = Math.abs(z.y - this.y);
      if (this.combo > 0 && dx < E.attackRange + 24 && dy < E.engageY + 6 && z.state !== 'defeat' && z.state !== 'down') {
        this.combo--; this._faceZee(z); this._startMelee(g); this.cool = 0;             // chain the next hit
      } else { this.combo = 0; this._back(rnd(...E.cooldown)); }
    }
  }

  _ranged(dt, g) {
    if (!this.fired && this.frame >= this.anim.release[0]) { this.fired = true; g.fireHeadset(this); }
    if (this.done) this._back(rnd(1.0, 1.9));
  }

  // ---------- heavies: grab and throw ----------
  // coil -> lunge -> CLAMP (the catch) -> hoist -> overhead. Zee is drawn inside this animation from the clamp frame on.
  _grab(dt, g) {
    const f = this.frame, z = g.zee, clamp = this.anim.active[0];
    if (!this.holdingZee) {
      if (f < clamp) { this._faceZee(z); this.x += this.face * 100 * dt; return; }               // lunge in
      const dx = (z.x - this.x) * this.face;
      if (dx > -14 && dx < E.grabRange + 14 && Math.abs(z.y - this.y) < 16 && z.canBeGrabbed()) {
        this.holdingZee = true; this.struggle = 0; z.getGrabbed(this);
        this.x = z.x - this.face * (CLAMP_DX[this.id] || 50); this.y = z.y;                      // line up with the clamp pose (a few px at most)
        g.sfx.grab(); g.shake = Math.max(g.shake, 2.5); g.hitstop = Math.max(g.hitstop, 0.05);
      } else {                                                                                   // missed: she dodged or jumped away
        this.state = 'whiff'; this.whiffT = 0.35; this.t = this.anim.starts[clamp] - 0.001;
      }
      return;
    }
    if (this.done) { this.state = 'hold'; this.holdT = 0; this._play('hold'); }
  }

  // overhead hold (looping): she struggles; mash buttons to break free (see Zee._held), otherwise he throws
  _hold(dt, g) {
    this.holdT += dt;
    if (!this.holdingZee) { this._back(1.0); return; }
    if (this.holdT >= E.holdTime) { this.state = 'throw'; this.thrown = false; this._play('throw'); }
  }

  // wind-up (Zee behind his head) -> heave -> RELEASE: Zee leaves his hands and flies
  _throw(dt, g) {
    if (!this.thrown && this.holdingZee && this.frame >= this.anim.release[0]) {
      const R = RELEASE[this.id] || { dx: 60, z: 60 };
      this.thrown = true; this.holdingZee = false;
      g.zee.throwAway(this.face, this.x + this.face * R.dx, R.z); g.onThrow();
    }
    if (this.done) this._back(rnd(1.0, 1.5));
  }

  _down(dt) {
    this.x += this.vx * dt; this.vx *= Math.pow(0.05, dt);
    if (this.animName === 'knockdown' && this.t >= this.anim.duration + 0.5) this._play('get_up');
    else if (this.animName === 'get_up' && this.done) { this._back(0.25); this.combo = 1; }
  }

  // ---------- drawing ----------
  draw(ctx, alpha = 1) {
    if (this.px === undefined) this.snapshot();
    let x = this.px + (this.x - this.px) * alpha, y = this.py + (this.y - this.py) * alpha;
    // she fights the grab: the held pose shakes all the time, with a hard jolt on every button she mashes
    if (this.holdingZee) {
      const now = performance.now(), j = Math.max(0, 1 - (now - (this.joltAt || 0)) / 160);
      x += Math.sin(now / 38) * 0.9 + Math.sin(now / 17) * 2.6 * j; y += -Math.abs(Math.sin(now / 23)) * 1.6 * j;
    }
    let fade = 1;
    if (this.state === 'spawn') fade = 1 - this.spawnT / 0.5;
    if (this.state === 'dead' && this.deadT > E.corpseTime - 0.6) fade = Math.max(0, (E.corpseTime - this.deadT) / 0.6);
    const ch = this.character, lying = this.state === 'down' || this.state === 'dead' || this.animName === 'get_up';
    const face = this.view === 'side' ? this.face : 1, lean = this.view === 'side' ? this.style.lean : 0;   // front / back sprites are never mirrored and do not lean
    drawShadow(ctx, ch, this.anim, this.frame, x, y, 0, face, lying, fade);          // the one shared character shadow
    if (this.animName === 'knockdown' && this.anim.frames > 2) {      // knocked off his feet: the flying frames arc up off the floor, landing on the slam frame
      const u = Math.min(1, this.t / this.anim.starts[2]);
      y -= KD_LIFT * (ch.manifest.gameHeight || 140) * Math.sin(u * Math.PI);
    }
    if (this.leanK > 0.01 && !lying) {                          // each enemy's walking style: forward lean, body roll and mid-step lift
      const S = this.style, k = this.leanK, roll = S.sway * Math.sin(this.stride * 2 * Math.PI) * k;
      const lift = S.bounce * Math.abs(Math.sin(this.stride * Math.PI)) * k;
      ctx.save(); ctx.translate(x, y); ctx.rotate(lean * k * face + roll); ctx.translate(-x, -y);
      drawAnim(ctx, ch, this.anim, this.frame, x, y - lift, face, fade, this.flash * 6);
      ctx.restore();
    } else drawAnim(ctx, ch, this.anim, this.frame, x, y, face, fade, this.flash * 6);
    if (this.tellT > 0 && this.state !== 'dead') {              // wind-up tell: a quick glint + "!" by the head before a swing / grab / throw
      const k = this.tellT / 0.3, hx = x + this.face * 10, hy = y - ch.manifest.gameHeight * 0.92, r = 3 + 6 * Math.sin(Math.min(1, 1 - k) * Math.PI);
      ctx.save(); ctx.globalAlpha = Math.min(1, k * 2.5); ctx.strokeStyle = this.tellCol || '#fff4c8'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(hx - r, hy); ctx.lineTo(hx + r, hy); ctx.moveTo(hx, hy - r); ctx.lineTo(hx, hy + r); ctx.stroke();
      ctx.font = 'bold 10px ui-monospace, Consolas, monospace'; ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = '#10101a';
      ctx.strokeText('!', hx + this.face * 9, hy - 2); ctx.fillStyle = this.tellCol || '#fff4c8'; ctx.fillText('!', hx + this.face * 9, hy - 2);
      ctx.restore();
    }
    // health bar with the HP number beside it, for a moment after being hit
    if (this.barT > 0 && this.state !== 'dead') {
      const bw = this.heavy ? 44 : 34, bx = Math.round(x - bw / 2 - 6), by = Math.round(y - (lying ? 34 : ch.manifest.gameHeight + 12));   // lying down: bar sits just above the body
      ctx.globalAlpha = Math.min(1, this.barT * 2);
      ctx.fillStyle = '#10101a'; ctx.fillRect(bx - 1, by - 1, bw + 2, 6);
      ctx.fillStyle = '#3a2430'; ctx.fillRect(bx, by, bw, 4);
      ctx.fillStyle = '#e2574c'; ctx.fillRect(bx, by, Math.round(bw * this.hp / this.maxHp), 4);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 7px ui-monospace, Consolas, monospace'; ctx.textAlign = 'left';
      ctx.lineWidth = 2; ctx.strokeStyle = '#10101a'; const t = String(Math.ceil(this.hp));
      ctx.strokeText(t, bx + bw + 3, by + 4); ctx.fillText(t, bx + bw + 3, by + 4); ctx.globalAlpha = 1;
    }
  }
}




