/**
 * @fileoverview Strafe controller — continuous per-tick orbit steering with
 * full physics prediction.
 *
 * Modelled after LiquidBounce's ModuleTargetStrafe (`computeDirectionVec`
 * + per-tick movement redirect) and Lambda's TargetStrafe/setSpeed model:
 *
 * - Every tick (grounded or airborne) the horizontal velocity is *set* to the
 *   desired orbit direction at a fixed speed — the continuous counterpart of
 *   LiquidBounce's `withStrafe(yaw, speed)` redirect and Lambda's
 *   `setSpeed(moveSpeed)`. The orbit vector is LiquidBounce's
 *   `computeDirectionVec`: a tangential component around the target plus a
 *   radial encirclement correction that pulls the bot back to the orbit
 *   radius (clamped so a too-close target pushes outward at most one step).
 *   There are no discrete orbit points, so the bot traces a continuous,
 *   roughly circular path instead of oscillating between a few sampled ones.
 * - Grounded ticks add a jump: vertical velocity 0.42 (Lambda Speed's
 *   `player.motionY = 0.42` / vanilla jump), while the horizontal component
 *   keeps the orbit tangent — bunny-hopping in a continuous circle.
 * - The orbit side flips on horizontal collision (`direction = -direction`),
 *   like both reference clients.
 * - Every candidate plan is validated with *continuous physics prediction*:
 *   a closed-loop, per-tick simulation of the exact control pattern the bot
 *   will apply (velocity injection + prismarine gravity/drag/collision
 *   order), rejecting any plan whose simulated path blocks on a wall,
 *   touches a hazard, or descends into a void. This runs every tick, not
 *   only when a jump is planned, so the bot aborts or steers away from a
 *   fall before committing to it.
 *
 * Candidate preference: current orbit side at the full radius → progressively
 * smaller radii (wall/void hugging) → opposite side → inward rescue → escape
 * hop (validated jump across an uncrossable gap) → brake. Landing drops up
 * to STRAFE_SAFE_DROP are "safe"; larger drops up to STRAFE_HAZARD_MAX_DROP
 * are only accepted when nothing better exists.
 */

import { Vec3 } from "vec3";
import { getGroundBelow, isPositionClear } from "./movement";
import { AABB } from "./utils";
import { Constants } from "./constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** World access used for validation. Mirrors PVPManager's bot wiring. */
export interface StrafeWorld {
  blockAt(pos: Vec3): any;
  getCollisions(aabb: AABB, minY: number): AABB[];
}

/** Per-tick input for the strafe controller. */
export interface StrafeTickInput {
  /** Bot feet position at this tick */
  source: Vec3;
  /** Target feet position — the orbit center */
  target: Vec3;
  /** Bot's current velocity (y is preserved on non-jump ticks) */
  velocity: Vec3;
  onGround: boolean;
  collidedHorizontally: boolean;
  world: StrafeWorld;
}

/** Quality of the chosen plan. */
export type StrafeTier = "safe" | "warn" | "rescue" | "escape" | "brake";

/** The per-tick movement decision returned by StrafeController. */
export interface StrafePlan {
  /**
   * Velocity to apply this tick. X/Z is the orbit movement (the next tick
   * moves the bot by exactly this vector); Y is the jump impulse on jump
   * ticks or the current vertical velocity otherwise.
   */
  velocity: Vec3;
  /** True when this tick launches a jump (vertical velocity 0.42). */
  jump: boolean;
  /** Orbit side used for this plan (+1 or -1). */
  direction: number;
  /** Orbit radius the plan was validated against. */
  range: number;
  /** Plan quality that made it win the candidate search. */
  tier: StrafeTier;
  /** Position the bot reaches after one tick of this velocity (probe). */
  point: Vec3;
}

/** Parameters for the continuous physics prediction. */
export interface StrafeSimParams {
  source: Vec3;
  target: Vec3;
  velocity: Vec3;
  onGround: boolean;
  /** Launch a jump on the first simulated tick (grounded only). */
  jump: boolean;
  direction: number;
  range: number;
  speed: number;
  /** Ground level the bot is standing on / took off from (null = unknown). */
  referenceGroundY: number | null;
  world: StrafeWorld;
  /** Orbit direction control (default) or pure inward steering (rescue). */
  mode?: "orbit" | "inward";
  /**
   * Force relaxed mid-air ground checks (void columns tolerated while the
   * arc is airborne; success requires a real landing within MAX_DROP).
   * Defaults to `mode === "inward" && !onGround` — the escape hop sets this
   * explicitly because its launch is grounded.
   */
  relax?: boolean;
  maxTicks?: number;
}
/**
 * Failure reasons for the rescue/escape-mode prediction:
 * the arc crosses void columns (or the simulated control is already
 * committed), so per-tick ground checks are relaxed; the plan is only valid
 * if it lands on real ground (drop within MAX_DROP) before the horizon ends.
 */
const INWARD_NO_LANDING = "no-landing";

/** Result of the continuous physics prediction. */
export interface StrafeSimResult {
  /** No collision, hazard, void, or too-deep drop along the whole path. */
  safe: boolean;
  /** Landing drop relative to the reference ground (blocks). */
  drop: number;
  /** Whether the simulation reached a landing. */
  landed: boolean;
  /** Failure reason when `!safe`: blocked | hazard | void | deep-drop. */
  reason?: string;
  ticks: number;
}

/** Internal candidate evaluated by the controller. */
interface Candidate {
  direction: number;
  range: number;
  velocity: Vec3;
  point: Vec3;
  tier: "safe" | "warn";
  jump: boolean;
  result: StrafeSimResult;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPEED = Constants.MOVEMENT.STRAFE_SPEED;
const BASE_RANGE = Constants.MOVEMENT.STRAFE_RADIUS;
const SAFE_DROP = Constants.MOVEMENT.STRAFE_SAFE_DROP;
const MAX_DROP = Constants.MOVEMENT.STRAFE_HAZARD_MAX_DROP;
const SIM_TICKS = Constants.MOVEMENT.STRAFE_SIM_TICKS;
/** Orbit radius cascade tried before flipping the orbit side. */
const RANGE_STEPS = [1.0, 0.7, 0.45];
/** getGroundBelow's sentinel: everything at/below this Y is not ground. */
const VOID_LEVEL = -63.5;
const EPS = 1e-6;

/** Blocks that must never be stood in or on during a strafe. */
const HAZARD_BLOCK_NAMES = new Set<string>([
  ...Constants.BLOCK_DETECTION.UNWANTED_BLOCK_NAMES,
  "fire",
  "cobweb",
]);

const GRAVITY = Constants.PHYSICS.GRAVITY;
const DRAG = Constants.PHYSICS.DRAG;
const TERMINAL_VELOCITY = Constants.PHYSICS.TERMINAL_VELOCITY;
const JUMP_VELOCITY = Constants.PHYSICS.JUMP_VELOCITY;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function playerAABB(pos: Vec3): AABB {
  const half = Constants.PHYSICS.PLAYER_OFFSET;
  return new AABB(
    pos.x - half,
    pos.y,
    pos.z - half,
    pos.x + half,
    pos.y + Constants.PHYSICS.PLAYER_HEIGHT,
    pos.z + half,
  );
}

/**
 * Hazard scan of the support/feet/head blocks around a feet position.
 * Checks the column across three block levels: support (dy=-1), feet (dy=0)
 * and head (dy=1).
 */
function hasHazardAt(pos: Vec3, blockAt: (pos: Vec3) => any): boolean {
  const baseY = Math.floor(pos.y);
  for (let dy = -1; dy <= 1; dy++) {
    const block = blockAt(new Vec3(pos.x, baseY + dy, pos.z));
    if (block && HAZARD_BLOCK_NAMES.has(block.name)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// computeDirectionVec — LiquidBounce's encirclement formula
// ---------------------------------------------------------------------------

/**
 * Compute the per-tick horizontal velocity for orbiting the target.
 *
 * LiquidBounce formula: a tangential component (magnitude `speed`, rotating
 * around the target on `direction`'s side) plus a radial encirclement
 * correction `max(-speed, distance - range)` pointing at the target. The sum
 * is normalized back to `speed` so the orbit speed is constant regardless of
 * the correction strength — LiquidBounce redirects movement toward the
 * resulting direction at the current speed, so the yaw is what matters.
 *
 * Convention: `bearing = atan2(dz, dx)` uses the standard math orientation,
 * so circle points are `target + (cos a, sin a) * r` — consistent with the
 * tangential/radial trig below (no yaw-mirroring mismatch).
 *
 * @param source - Bot feet position
 * @param target - Target (orbit center)
 * @param speed - Orbit speed (blocks/tick)
 * @param range - Desired orbit radius (blocks)
 * @param direction - Orbit side: +1 or -1
 */
export function computeDirectionVec(
  source: Vec3,
  target: Vec3,
  speed: number,
  range: number,
  direction: number,
): Vec3 {
  const dx = target.x - source.x;
  const dz = target.z - source.z;
  const distance = Math.hypot(dx, dz);
  const bearing = Math.atan2(dz, dx);

  // Tangential unit vector: perpendicular to the bot→target line.
  const tangentialX = -Math.sin(bearing) * direction;
  const tangentialZ = Math.cos(bearing) * direction;
  // Radial encirclement toward the orbit radius, clamped so a too-close
  // target pushes outward by at most one speed step (LiquidBounce).
  const encirclement = Math.max(-speed, distance - range);
  const radialX = Math.cos(bearing) * encirclement;
  const radialZ = Math.sin(bearing) * encirclement;

  let vx = tangentialX * speed + radialX;
  let vz = tangentialZ * speed + radialZ;
  const len = Math.hypot(vx, vz);
  if (len > EPS) {
    vx = (vx / len) * speed;
    vz = (vz / len) * speed;
  } else {
    // Degenerate: fall back to the pure tangent.
    vx = tangentialX * speed;
    vz = tangentialZ * speed;
    const tangentLen = Math.hypot(vx, vz) || 1;
    vx = (vx / tangentLen) * speed;
    vz = (vz / tangentLen) * speed;
  }

  return new Vec3(vx, 0, vz);
}

/** Unit direction from a position toward the target, scaled to `speed`. */
function inwardVector(
  source: Vec3,
  target: Vec3,
  speed: number,
): Vec3 {
  const dx = target.x - source.x;
  const dz = target.z - source.z;
  const len = Math.hypot(dx, dz) || 1;
  return new Vec3((dx / len) * speed, 0, (dz / len) * speed);
}

// ---------------------------------------------------------------------------
// simulateStrafePath — continuous physics prediction
// ---------------------------------------------------------------------------

/**
 * Predict the bot's path over the coming ticks with the candidate control
 * applied continuously on every simulated tick (closed loop):
 *
 * - horizontal velocity is *set* each tick to the candidate's orbit vector
 *   (or inward steering in rescue mode);
 * - a grounded start with `jump` launches with vy = 0.42, like Lambda's
 *   Speed module;
 * - vertical motion is real physics (gravity −0.08, drag 0.98, terminal
 *   velocity −3.92);
 * - movement resolution mirrors prismarine-physics `moveEntity` (Y first,
 *   then X, then Z; onGround set on downward Y collisions; velocities zeroed
 *   on collision).
 *
 * The prediction is what makes void safety continuous: any candidate whose
 * simulated path blocks on geometry, touches hazards, or whose ground drops
 * into a void / beyond MAX_DROP is rejected before the real bot moves.
 */
export function simulateStrafePath(params: StrafeSimParams): StrafeSimResult {
  const maxTicks = params.maxTicks ?? SIM_TICKS;
  const mode = params.mode ?? "orbit";
  const blockAt = params.world.blockAt;
  // Relaxed mode flies through void columns (the bot is already committed
  // to gravity — airborne rescue, or a grounded escape hop whose launch the
  // bot commits to); success means landing on real ground before the
  // horizon ends. A non-relaxed run keeps stricter ground checks.
  const relaxGroundChecks =
    params.relax ?? (mode === "inward" && !params.onGround);
  // Effective ground reference for the landing-drop measurement.
  const dropReferenceY = params.referenceGroundY ?? params.source.y;

  const pos = params.source.clone();
  let vx = params.velocity.x;
  let vy = params.velocity.y;
  let vz = params.velocity.z;
  let onGround = params.onGround;
  let jumpPending = params.jump && onGround;
  let everAirborne = !onGround;
  let landed = false;
  let drop = 0;

  for (let tick = 0; tick < maxTicks; tick++) {
    // 1. Control — set horizontal velocity this tick (the "move" of this
    //    tick comes from the velocity set during the previous tick).
    if (mode === "inward") {
      const inward = inwardVector(pos, params.target, params.speed);
      vx = inward.x;
      vz = inward.z;
    } else {
      const dirVel = computeDirectionVec(
        pos,
        params.target,
        params.speed,
        params.range,
        params.direction,
      );
      vx = dirVel.x;
      vz = dirVel.z;
    }
    if (onGround && jumpPending) vy = JUMP_VELOCITY;
    jumpPending = false;
    // Grounded rest velocity (tests may pass exactly 0; the real bot stands
    // with the post-friction -0.0784 value this mirrors).
    if (onGround && !jumpPending && vy === 0) vy = (0 - GRAVITY) * DRAG;

    // 2. Collision-resolved move — prismarine moveEntity: Y, X, Z. Offsets
    //    use prismarine's exact semantics (touching is not colliding; the
    //    mover clamps against blocks it is entirely above/below of).
    let bb = playerAABB(pos);
    const collisions = params.world.getCollisions(
      bb.extend(vx, vy, vz),
      -Infinity,
    );

    let dy = vy;
    for (const c of collisions) dy = bb.calculateYOffset(c, dy);
    const yBlocked = Math.abs(dy - vy) > EPS;
    bb = bb.offset(0, dy, 0);
    pos.y += dy;

    let dx = vx;
    for (const c of collisions) dx = bb.calculateXOffset(c, dx);
    let dz = vz;
    for (const c of collisions) dz = bb.calculateZOffset(c, dz);
    const horizontalBlocked =
      Math.abs(dx - vx) > EPS || Math.abs(dz - vz) > EPS;

    pos.x += dx;
    pos.z += dz;

    // 3. Update flags — prismarine: onGround requires a downward Y collision;
    //    colliding velocities are zeroed.
    if (yBlocked && vy < 0) {
      if (!landed) {
        const g = getGroundBelow(pos, blockAt);
        drop = dropReferenceY - g;
        if (everAirborne) {
          landed = true;
          if (drop > MAX_DROP) {
            return {
              safe: false,
              drop,
              landed: true,
              reason: "deep-drop",
              ticks: tick + 1,
            };
          }
        }
      }
      onGround = true;
      vy = 0;
    } else {
      onGround = false;
      if (vy > 0 && yBlocked) vy = 0; // head bump
      everAirborne = true;
    }

    // 4. Per-tick safety: hazards always; ground presence/drop depth only in
    //    orbit mode (rescue mode already tolerates void columns it crosses).
    if (hasHazardAt(pos, blockAt)) {
      return { safe: false, drop, landed, reason: "hazard", ticks: tick + 1 };
    }
    if (!relaxGroundChecks) {
      const groundY = getGroundBelow(pos, blockAt);
      if (groundY <= VOID_LEVEL) {
        return { safe: false, drop, landed, reason: "void", ticks: tick + 1 };
      }
      if (params.referenceGroundY !== null && params.referenceGroundY - groundY > MAX_DROP) {
        return {
          safe: false,
          drop,
          landed,
          reason: "deep-drop",
          ticks: tick + 1,
        };
      }
    } else if (pos.y < dropReferenceY - 4) {
      // Rescue fell well below its starting level without landing.
      return {
        safe: false,
        drop,
        landed,
        reason: "deep-drop",
        ticks: tick + 1,
      };
    }
    if (horizontalBlocked && !landed) {
      return { safe: false, drop, landed, reason: "blocked", ticks: tick + 1 };
    }
    if (landed) {
      // Landing stabilizes the sim; the next tick computes a fresh plan.
      return { safe: true, drop, landed: true, ticks: tick + 1 };
    }

    // 5. Physics for the next tick. Horizontal gets overwritten by the
    //    control anyway; vertical momentum carries over exactly like the
    //    real bot (prismarine zeroes vy on collision, then gravity + drag).
    vy = (vy - GRAVITY) * DRAG;
    if (vy < TERMINAL_VELOCITY) vy = TERMINAL_VELOCITY;
  }

  if (mode === "inward" && everAirborne && !landed) {
    // The rescue never touched ground — no guaranteed recovery.
    return {
      safe: false,
      drop,
      landed: false,
      reason: INWARD_NO_LANDING,
      ticks: maxTicks,
    };
  }

  // Still airborne after the horizon: the per-tick checks above cover the
  // dangerous part into the visible future.
  return { safe: true, drop, landed, ticks: maxTicks };
}

// ---------------------------------------------------------------------------
// StrafeController
// ---------------------------------------------------------------------------

/**
 * Continuous per-tick strafe driver. Candidate preference:
 *
 * 1. Hop orbit (`jump: true` on grounded ticks): the current orbit side (the
 *    flipped side right after a collision) at radius steps 1.0/0.7/0.45 ×
 *    STRAFE_RADIUS, each validated with probe clearance + continuous
 *    physics prediction. A "safe" plan wins immediately; a "warn" plan
 *    (descends ≤ MAX_DROP) is remembered as a fallback.
 * 2. Walk orbit (grounded ticks only, when every hop was rejected): the
 *    same candidates without a jump.
 * 3. Rescue: steer straight toward the target (validated the same way) —
 *    airborne falls head for the known-safe ground under the target.
 * 4. Escape hop (grounded ticks only, when every orbit/walk/rescue plan was
 *    rejected): jump straight toward the target's ground and coast over the
 *    blocking gap (an isolated perch's void ring, a deep moat). The
 *    prediction runs relaxed — mid-air void columns tolerated — and demands
 *    a real landing with drop ≤ MAX_DROP, so an unreachable far shore never
 *    validates.
 * 5. Brake: no validated plan — stop horizontal motion and stand; never
 *    jump into an unresolved path.
 */
export class StrafeController {
  private _direction = 1;
  private _groundY: number | null = null;

  /** Current orbit side (+1 / -1). Flips on collision. */
  get direction(): number {
    return this._direction;
  }

  reset(): void {
    this._direction = 1;
    this._groundY = null;
  }

  /**
   * Compute this tick's strafe plan. Returns null when the target is out of
   * attack range (the caller disengages) or coincident with the bot.
   */
  computeTick(input: StrafeTickInput): StrafePlan | null {
    const { source, target, velocity, onGround, collidedHorizontally, world } =
      input;

    const dxT = target.x - source.x;
    const dzT = target.z - source.z;
    const dist = Math.hypot(dxT, dzT);
    if (dist > Constants.COMBAT.ATTACK_RANGE || dist < EPS) {
      this.reset();
      return null;
    }

    if (collidedHorizontally) this._direction = -this._direction;

    const groundHere = getGroundBelow(source, world.blockAt);
    if (onGround) {
      this._groundY = groundHere > VOID_LEVEL ? groundHere : null;
    }
    const referenceGroundY = this._groundY;

    const hop = this._search(input, referenceGroundY, true);
    const walk =
      onGround && !hop.safe
        ? this._search(input, referenceGroundY, false)
        : null;

    const chosen =
      hop.safe ??
      walk?.safe ??
      walk?.warn ??
      hop.warn ??
      null;

    if (chosen) {
      this._direction = chosen.direction;
      const jump = chosen.jump;
      return {
        velocity: new Vec3(
          chosen.velocity.x,
          jump ? JUMP_VELOCITY : velocity.y,
          chosen.velocity.z,
        ),
        jump,
        direction: chosen.direction,
        range: chosen.range,
        tier: chosen.tier,
        point: chosen.point,
      };
    }

    // Rescue: validated inward steering toward the target's ground.
    const rescue = this._searchInward(input, referenceGroundY, dist, false);
    if (rescue) {
      return {
        velocity: new Vec3(
          rescue.velocity.x,
          velocity.y,
          rescue.velocity.z,
        ),
        jump: false,
        direction: this._direction,
        range: BASE_RANGE,
        tier: "rescue",
        point: rescue.point,
      };
    }

    // Escape hop: a grounded bot with no validated orbit/walk/rescue may be
    // standing on an isolated block surrounded by void (or a deep moat).
    // Jump toward the target's ground and let the arc coast over the gap —
    // only when the prediction lands the arc on solid ground.
    const escape = this._searchInward(input, referenceGroundY, dist, true);
    if (escape) {
      return {
        velocity: new Vec3(
          escape.velocity.x,
          JUMP_VELOCITY,
          escape.velocity.z,
        ),
        jump: true,
        direction: this._direction,
        range: BASE_RANGE,
        tier: "escape",
        point: escape.point,
      };
    }

    // Brake: stand. Never commit to an unresolved path.
    return {
      velocity: new Vec3(0, velocity.y, 0),
      jump: false,
      direction: this._direction,
      range: BASE_RANGE,
      tier: "brake",
      point: source.clone(),
    };
  }

  /**
   * Candidate search over both orbit sides and radius steps.
   * Returns the first fully "safe" and the first "warn" plan.
   */
  private _search(
    input: StrafeTickInput,
    referenceGroundY: number | null,
    allowJump: boolean,
  ): { safe: Candidate | null; warn: Candidate | null } {
    let safe: Candidate | null = null;
    let warn: Candidate | null = null;

    for (const direction of [this._direction, -this._direction]) {
      for (const step of RANGE_STEPS) {
        const range = BASE_RANGE * step;
        const velocity = computeDirectionVec(
          input.source,
          input.target,
          SPEED,
          range,
          direction,
        );
        const point = new Vec3(
          input.source.x + velocity.x,
          input.source.y,
          input.source.z + velocity.z,
        );

        if (!isPositionClear(point, input.world.blockAt)) continue;
        if (hasHazardAt(point, input.world.blockAt)) continue;

        const jump = allowJump && input.onGround;
        const result = simulateStrafePath({
          source: input.source,
          target: input.target,
          velocity: input.velocity,
          onGround: input.onGround,
          jump,
          direction,
          range,
          speed: SPEED,
          referenceGroundY,
          world: input.world,
        });

        if (!result.safe) continue;
        const tier: "safe" | "warn" =
          result.drop > SAFE_DROP ? "warn" : "safe";
        const candidate: Candidate = {
          direction,
          range,
          velocity,
          point,
          tier,
          jump,
          result,
        };
        if (tier === "safe") return { safe: candidate, warn };
        if (!warn) warn = candidate;
      }
    }

    return { safe, warn };
  }

  /**
   * Inward candidate: steer straight toward the target. The regular rescue
   * (`escape: false`) is accepted only when the continuous prediction of the
   * inward walk is fully safe. The escape hop (`escape: true`, grounded
   * only) launches a jump with relaxed mid-air ground checks, so the arc may
   * cross void columns; the prediction still requires a real landing with
   * drop ≤ MAX_DROP before the horizon ends, or the candidate is rejected.
   */
  private _searchInward(
    input: StrafeTickInput,
    referenceGroundY: number | null,
    dist: number,
    escape: boolean,
  ): Candidate | null {
    const velocity = inwardVector(input.source, input.target, SPEED);
    const point = new Vec3(
      input.source.x + velocity.x,
      input.source.y,
      input.source.z + velocity.z,
    );
    if (!isPositionClear(point, input.world.blockAt)) return null;
    if (hasHazardAt(point, input.world.blockAt)) return null;
    if (dist < SPEED) {
      // Already at the target; standing is the safe action.
      return null;
    }
    if (escape && !input.onGround) return null;

    const result = simulateStrafePath({
      source: input.source,
      target: input.target,
      velocity: input.velocity,
      onGround: input.onGround,
      jump: escape,
      direction: this._direction,
      range: BASE_RANGE,
      speed: SPEED,
      referenceGroundY,
      world: input.world,
      mode: "inward",
      relax: escape || undefined,
    });
    if (!result.safe) return null;

    return {
      direction: this._direction,
      range: BASE_RANGE,
      velocity,
      point,
      tier: "warn",
      jump: escape,
      result,
    };
  }
}
