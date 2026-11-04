// The auto rider: a scripted assist for jumps on the engine's simple rider model (a body on a slide along the frame's
// vertical axis, held by a bounded internal force; the engine's RIDER slots). It decides once per batch of steps from the
// last observation and the trail ahead, never from the clock, and its output goes into the ride's input log like any other
// input, so a replay of the log is exact.
//
// One primitive, "absorb and level", placed against each jump's lip (found in the terrain points: the first crest whose
// ground falls away beyond it):
//
//   ready   front wheel within READY of the lip: the rider holds a neutral stance (target 0) instead of riding loose on the
//           slide's spring, so the takeoff's compression does not spring back into the bike as it leaves;
//   absorb  front wheel ABSORB_AT past the lip: the rider lets the bike come up into the body (target ABSORB, below
//           neutral). On this model pushing down at the lip pitches the nose down (the rear is still on the ramp, behind
//           the frame's centre), and absorbing it pitches it up: the only takeoff lever a vertical slide has;
//   air     both wheels off the ground: neutral stance, and the pitch corrected towards PITCH_TARGET with the rear hub: a
//           little drive lifts the nose (power-bounded, as legs on pedals are), the rear brake drops it (it takes spin out of
//           the wheel). Angular momentum in the air only moves between the wheel and the frame: nothing turns the bike;
//   landed  a wheel down beyond the lip (LAND_CLEAR): the rider is released (passive) for the rest of the trail.
//
// Every number is a bound or a placement, not a fit to a setup. What it cannot do: a fore-aft weight shift (the slide is
// vertical), pumping, or anything the bounded actuator cannot follow; those wait for the bounded-limb rider.
import { OBS } from "./engine.js";

export const RIDER_MVP = Object.freeze({
  READY: 2.5,          // m before the lip (front hub x) where the rider takes a stance
  ABSORB_AT: 0.1,      // m past the lip (front hub x) where the rider absorbs
  ABSORB: -0.06,       // m: the absorb target on the slide (neutral 0)
  FORCE: 1000,         // N: the actuator's force limit while the rider acts (the engine also bounds its power)
  PITCH_TARGET: 0.2,   // rad, nose down: the attitude it levels towards in the air
  KP: 150,             // N m per rad of pitch error
  KD: 75,              // N m per rad/s of pitch rate (a lead of half a second on the pitch)
  DRIVE_POWER: 1000,   // W: the in-air drive's bound (torque times the rear hub's spin)
  MAX_DRIVE: 120,      // N m: the engine's drive bound
  MAX_BRAKE: 60,       // N m: the in-air rear brake's bound
  CREST_DROP: 0.2,     // m: a crest is a lip when the ground half a metre beyond it is at least this much lower
  LAND_CLEAR: 0.5,     // m past the lip: a wheel's contact beyond it is the landing (one on the lip itself is not)
});

const P = RIDER_MVP;
const PHASES = ["idle", "ready", "absorb", "air", "landed"];

/**
 * The lips of the jumps in a run of terrain points: in each [start, end) range, the first vertex where the ground stops
 * rising and falls by at least CREST_DROP within half a metre.
 * @param {Float64Array|number[]} points (x, z) pairs, x increasing.
 * @param {{start:number, end:number}[]} ranges Where to look (the course's jump features).
 * @returns {number[]} Lip x per range that has one.
 */
export function findLips(points, ranges) {
  const lips = [];
  const n = points.length / 2;
  for (const { start, end } of ranges) {
    for (let i = 1; i + 1 < n; i++) {
      const x = points[2 * i], z = points[2 * i + 1];
      if (x < start) continue;
      if (x >= end) break;
      const rising = z > points[2 * i - 1];
      const falling = points[2 * i + 3] < z;
      if (!rising || !falling) continue;
      let j = i + 1;
      while (j + 1 < n && points[2 * j] < x + 0.5) j++;
      if (z - points[2 * j + 1] >= P.CREST_DROP) { lips.push(x); break; }
    }
  }
  return lips;
}

/** The auto rider over a list of lips. Deterministic: its output depends only on the observations it is given, in order. */
export class RiderMvp {
  /** @param {number[]} lips Lip x of each jump, increasing. */
  constructor(lips) {
    this.lips = lips.slice();
    this.next = 0;          // the lip it is working on
    this.phase = 0;         // index into PHASES
  }

  get phaseName() {
    return PHASES[this.phase];
  }

  /**
   * The rider's input for the next batch from the observation the last batch ended on.
   * @param {Float64Array} obs An observation (OBS).
   * @returns {{riderTarget:number, riderForce:number, drive:number, rearBrake:number}}
   */
  decide(obs) {
    const out = { riderTarget: 0, riderForce: 0, drive: 0, rearBrake: 0 };
    if (this.next >= this.lips.length) return out;
    const lip = this.lips[this.next];
    const front = obs[OBS.frontX];
    const airborne = obs[OBS.frontContacts] === 0 && obs[OBS.rearContacts] === 0;
    if (this.phase === 0 && front >= lip - P.READY) this.phase = 1;
    if (this.phase === 1 && front >= lip + P.ABSORB_AT) this.phase = 2;
    if (this.phase === 2 && airborne) this.phase = 3;
    const frontDown = obs[OBS.frontContacts] > 0 && obs[OBS.frontX] > lip + P.LAND_CLEAR;
    const rearDown = obs[OBS.rearContacts] > 0 && obs[OBS.rearX] > lip + P.LAND_CLEAR;
    if (this.phase === 3 && (frontDown || rearDown)) this.phase = 4;
    if (this.phase === 4) {
      // Released; the next lip (if any) starts over.
      this.next++;
      this.phase = 0;
      return out;
    }
    if (this.phase === 0) return out;
    out.riderForce = P.FORCE;
    out.riderTarget = this.phase === 2 ? P.ABSORB : 0;
    if (this.phase === 3) {
      const e = P.KP * (obs[OBS.pitch] - P.PITCH_TARGET) + P.KD * obs[OBS.pitchRate];
      if (e > 0) out.drive = Math.min(e, P.MAX_DRIVE, P.DRIVE_POWER / Math.max(obs[OBS.rearSpin], 1));
      else out.rearBrake = Math.min(-e, P.MAX_BRAKE);
    }
    return out;
  }
}

/**
 * The input a batch applies: the rider's keys (drive and brakes) with the auto rider's output added (drive summed and
 * clamped to the engine's bound, brakes the larger of the two).
 */
export function combine(keys, rider) {
  return {
    drive: Math.max(-P.MAX_DRIVE, Math.min(P.MAX_DRIVE, keys.drive + rider.drive)),
    frontBrake: keys.frontBrake,
    rearBrake: Math.max(keys.rearBrake, rider.rearBrake),
    riderTarget: rider.riderTarget,
    riderForce: rider.riderForce,
  };
}

