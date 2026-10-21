import { Vec3 } from "vec3";
import { Constants } from "./constants";

/**
 * @fileoverview Pure functions for projectile trajectory calculation.
 * Extracted from UtilsManager in src/utils.ts.
 */

const EPS = 1.0e-7;

/**
 * How close (blocks) a simulated pearl flight must come to the wanted target
 * to be usable. A pearl that lands or passes further out teleports the bot
 * onto the side of the platform rather than the top, so the throw is a miss.
 */
const PEARL_LANDING_TOLERANCE = 0.6;

/**
 * How close (blocks, horizontal) a pearl must land to the wanted block for the
 * landing to count as "on that block". Half a block is the block's own radius,
 * so anything further lands on a neighbour (or on the ground next to it).
 */
const PEARL_TOP_LANDING_TOLERANCE = 0.55;

/**
 * How close (blocks, vertical) the landed surface must be to the wanted
 * surface height. Blocks are unit cubes, so a top-face hit lands exactly on
 * the surface; the slack absorbs float noise only.
 */
const PEARL_TOP_SURFACE_EPS = 0.1;

/**
 * Radius (blocks) around a landing point in which a living entity absorbs
 * the pearl instead of letting it land.
 */
const PEARL_ENTITY_BLOCK_RADIUS = 0.25;

/**
 * Standard deviation of the server's launch-direction randomization, per
 * axis of the unit direction.
 *
 * The vanilla throwable adds a Gaussian of this sigma to the normalized
 * look direction before scaling it by the throw power, so a pearl never
 * leaves the hand exactly along the aim. At 30 blocks the landing
 * therefore scatters over roughly 0.2 blocks, which is what makes a
 * one-block-wide platform a lottery.
 */
const LAUNCH_DIRECTION_SIGMA = 0.0075;

/**
 * How long a pearl flight is simulated before it counts as "gone". At the
 * throw speed the pearl covers a little over a block per tick, so this is
 * well past the range it can reach.
 */
const MAX_FLIGHT_TICKS = 100;

/**
 * How far the projectile spawns behind the thrower's eye, along the look
 * direction. The vanilla throwable offsets the spawn point by 0.16 blocks
 * backwards so the projectile does not start inside the thrower.
 */
const LAUNCH_SPAWN_BACK_OFFSET = 0.16;

/**
 * The scatter of a landing caused by the launch-direction randomization.
 *
 * @param distance - The flight distance in blocks
 * @returns The 1-sigma scatter of the landing in blocks
 */
export function launchScatter(distance: number): number {
  // The direction is perturbed per axis, so the landing scatters over a
  // disc of this radius.
  return distance * LAUNCH_DIRECTION_SIGMA * Math.SQRT2;
}

/** Pitch step (degrees) used when refining a top-surface landing. */
const PEARL_TOP_PITCH_STEP = 0.1;

/**
 * How far from the aim the landing may be for the pitch refinement to
 * still be worth trying. The refinement moves the landing by a fraction
 * of a block, so a landing that is further away cannot be fixed by it.
 */
const REFINEMENT_REACH = 1.5;

/** How many refinement steps (each +/- one pitch step) are tried. */
const PEARL_TOP_PITCH_STEPS = 3;

/**
 * Which face of a block a pearl hit.
 * - "top": the pearl came down onto the block's upper surface
 * - "bottom": the pearl hit the block's underside
 * - "side": the pearl hit a vertical face
 * - "none": the pearl never hit a block (flew out of range)
 */
export type PearlHitFace = "top" | "bottom" | "side" | "none";

export interface PearlTrajectoryResult {
  /** The pitch angle (degrees) to use */
  pitch: number;
  /** Which arc this pitch corresponds to */
  arc: "low" | "high";
  /** Total flight time in ticks */
  flightTime: number;
  /** The actual landing point of the projectile */
  landingPoint: Vec3;
  /** Distance from the landing point to the desired target */
  landingDist: number;
}

/**
 * A pearl throw that lands on the upper surface of a block.
 */
export interface PearlTopLanding {
  /** Pitch (degrees) that produces the landing. */
  pitch: number;
  /**
   * Vertical aim offset: the throw aims at (aim.x, eye.y + offset, aim.z).
   * The look is computed from the eye, so the offset is measured from there
   * even though the flight itself starts at the spawn point below it.
   */
  offset: number;
  /** Flight time in ticks. */
  flightTime: number;
  /** Where the pearl actually lands. */
  landingPoint: Vec3;
  /** Horizontal distance from the landing point to the aim point. */
  landingDist: number;
}

/**
 * Check whether a point is inside any shape of a block.
 * @param point - World coordinates
 * @param block - Block object with .shapes array
 * @returns Whether the point is inside any shape
 */
function isPointInBlock(
  point: Vec3,
  block: { position: Vec3; shapes: number[][] },
): boolean {
  const localX = point.x - block.position.x;
  const localY = point.y - block.position.y;
  const localZ = point.z - block.position.z;
  for (const shape of block.shapes) {
    if (
      localX >= shape[0] &&
      localX <= shape[3] &&
      localY >= shape[1] &&
      localY <= shape[4] &&
      localZ >= shape[2] &&
      localZ <= shape[5]
    )
      return true;
  }
  return false;
}

/**
 * Result of simulating a pearl flight: where it landed and how.
 */
export interface PearlLandingInfo {
  /** Flight time in ticks. */
  flightTime: number;
  /** Where the pearl entered the block it hit. */
  landingPoint: Vec3;
  /** Which face of the block was hit. */
  face: PearlHitFace;
  /** Y of the hit surface (the block's top edge for a "top" hit). */
  surfaceY: number;
  /** True when the pearl was falling at the moment it hit. */
  descending: boolean;
}

/**
 * Simulate a projectile flight and report where it lands, without treating a
 * landing as success. A landing is the first solid block entered; with no
 * block in the way, the flight is scored by how close it passes the target
 * (that is where the pearl drops onto whatever surface it passes over).
 * @param source - Launch position
 * @param target - Aim point (only used for the yaw direction)
 * @param v - Initial speed
 * @param g - Gravity per tick
 * @param p - Pitch in degrees
 * @param drag - Per-tick velocity multiplier
 * @param blockAt - Block lookup
 * @returns { flightTime, landingPoint, face, ... } or null if the flight is
 *   blocked outright (the launch point is inside a block, so the pearl never
 *   leaves).
 */
function simulateLanding(
  source: Vec3,
  target: Vec3,
  v: number,
  g: number,
  p: number,
  drag: number,
  blockAt: (pos: Vec3) => any,
): PearlLandingInfo | null {
  // Starting inside a solid block: the pearl collides on the first tick and
  // teleports back where it came from. Treat it as blocked.
  const startBlock = blockAt(source);
  if (blocksPearl(startBlock)) return null;

  const yaw = Math.atan2(target.x - source.x, target.z - source.z);
  const pitch = (p * Math.PI) / 180;
  // The vanilla throwable spawns the projectile behind the thrower, along
  // the look direction, so the flight does not start inside the player.
  // The look direction is what the yaw and the pitch describe.
  const look = new Vec3(
    Math.cos(pitch) * Math.sin(yaw),
    Math.sin(pitch),
    Math.cos(pitch) * Math.cos(yaw),
  );
  const spawn = source.minus(look.scaled(LAUNCH_SPAWN_BACK_OFFSET));

  let currPos = spawn.clone();
  let currVel = look.scaled(v);
  let closest = Infinity;
  let closestPos = spawn.clone();
  // The pearl covers at most a little over a block per tick, so a flight
  // that has not landed after this many ticks is out of range: simulating
  // it further only costs time.
  const maxTicks = MAX_FLIGHT_TICKS;
  for (let i = 0; i < maxTicks; i++) {
    const entry = pearlEntryPoint(currPos, currVel, blockAt);
    if (entry) {
      const box = blockAABB(entry.block);
      const point = entry.point;
      let face: PearlHitFace = "side";
      if (Math.abs(point.y - box.max.y) < 1e-6) face = "top";
      else if (Math.abs(point.y - box.min.y) < 1e-6) face = "bottom";
      return {
        flightTime: i + 1,
        landingPoint: point,
        face,
        surfaceY: box.max.y,
        descending: currVel.y < 0,
      };
    }
    currPos = currPos.plus(currVel);
    const dist = currPos.distanceTo(target);
    if (dist < closest) {
      closest = dist;
      closestPos = currPos.clone();
    }
    currVel.y = currVel.y * drag - g;
    currVel.x *= drag;
    currVel.z *= drag;
    if (currPos.y < -64) break;
  }
  // No block hit: the pearl falls past the target, so the closest approach
  // is the best estimate of where it would land.
  return {
    flightTime: maxTicks,
    landingPoint: closestPos,
    face: "none",
    surfaceY: closestPos.y,
    descending: currVel.y < 0,
  };
}

/**
 * Get projectile pitch angles for reaching a target.
 * @param source - Launch position
 * @param target - Target position
 * @param v - Initial projectile speed
 * @param g - Gravity acceleration
 * @param drag - Per-tick velocity multiplier
 * @returns Pitches in degrees (low arc first, then high arc), empty if unreachable
 *
 * The returned array has pitches sorted: [lowArc, highArc] where lowArc > highArc numerically
 * (low arc = steeper angle downward = larger pitch value).
 */
export function getProjectilePitch(
  source: Vec3,
  target: Vec3,
  v: number,
  g: number,
  drag = 1,
): number[] {
  const dx = target.x - source.x;
  const dz = target.z - source.z;
  const x = Math.sqrt(dx * dx + dz * dz);
  const y = target.y - source.y;
  const v2 = v * v;
  const v4 = v2 * v2;
  const root = v4 - g * (g * x * x + 2 * y * v2);
  if (root < 0) {
    return [];
  }
  const rootSq = Math.sqrt(root);
  const lowArc = Math.atan((v2 - rootSq) / (g * x));
  const highArc = Math.atan((v2 + rootSq) / (g * x));
  // lowArc < highArc mathematically
  // pitches[0] = low arc (shallower angle, lower pitch value)
  // pitches[1] = high arc (steeper angle, higher pitch value)
  const pitches = [(lowArc * 180) / Math.PI, (highArc * 180) / Math.PI];
  const getDistanceAtY = (p: number): number => {
    let currX = 0;
    let currY = 0;
    let velX = v * Math.cos((p * Math.PI) / 180);
    let velY = v * Math.sin((p * Math.PI) / 180);
    for (let i = 0; i < 200; i++) {
      const prevX = currX;
      const prevY = currY;
      currX += velX;
      currY += velY;
      velX *= drag;
      velY = velY * drag - g;
      if (currY <= y && velY < 0) {
        // Interpolate the crossing inside the tick: without it the distance
        // jumps by a full tick of travel at every pitch step, which hides the
        // drag's effect and makes the solved pitch jump around.
        const span = prevY - currY;
        const frac =
          span > 1e-9 ? Math.min(1, Math.max(0, (prevY - y) / span)) : 0;
        return prevX + (currX - prevX) * frac;
      }
    }
    // The projectile never comes back down to the target's height: the
    // distance is undefined, not "very far".
    return Infinity;
  };

  /**
   * Pitch whose descending crossing of the target height happens at the
   * target's horizontal distance.
   *
   * The crossing distance is not monotonic in the pitch — a steeper throw
   * drifts less — so the solution is bracketed by scanning the pitch space
   * and then bisected. Two crossings exist for a target at the bot's level:
   * the flat shot (low arc) and the steep lob (high arc). For a target
   * above the bot only the steep lob exists: a flat throw never comes back
   * down onto the target's height.
   */
  const solveCrossings = (): { low: number | null; high: number | null } => {
    const STEP = 0.5;
    const solutions: number[] = [];
    let prevP: number | null = null;
    let prevD = 0;
    for (let p = 0; p <= 89.5 && solutions.length < 2; p += STEP) {
      const d = getDistanceAtY(p);
      if (!isFinite(d)) {
        prevP = null;
        continue;
      }
      if (prevP !== null && (prevD - x) * (d - x) <= 0) {
        // Bisect the bracket down to a tenth of a degree.
        let lo = prevP;
        let hi = p;
        let dLo = prevD - x;
        for (let k = 0; k < 40; k++) {
          const mid = (lo + hi) / 2;
          const dMid = getDistanceAtY(mid) - x;
          if (!isFinite(dMid)) break;
          if (dLo < 0 === dMid < 0) {
            lo = mid;
            dLo = dMid;
          } else {
            hi = mid;
          }
        }
        solutions.push((lo + hi) / 2);
      }
      prevP = p;
      prevD = d;
    }
    return {
      low: solutions[0] ?? null,
      high: solutions[1] ?? null,
    };
  };

  const solved = solveCrossings();
  return [solved.low ?? pitches[0], solved.high ?? pitches[1]];
}

/**
 * Calculate vertical offset for aiming at a target using projectile physics.
 * This offset-based approach is more intuitive than angle-based aiming.
 *
 * @param source - Projectile spawn point (the thrower's hand: eye height
 *   minus 0.1). The returned offset is the rise of the aim point above it.
 * @param target - Target position (where you want the projectile to land)
 * @param v - Initial projectile speed (blocks per tick)
 * @param g - Gravity acceleration (blocks per tick squared)
 * @param drag - Per-tick velocity multiplier
 * @param arcType - 'low' or 'high' arc trajectory
 * @returns Vertical offset in blocks to aim at (add to target Y position)
 *
 * The offset represents how much to aim above/below the target.
 * Positive offset = aim above target (for high arcs)
 * Negative offset = aim below target (for low arcs)
 */
export function getProjectileOffset(
  source: Vec3,
  target: Vec3,
  v: number,
  g: number,
  drag = 1,
  arcType: "low" | "high" = "low",
): number {
  const dx = target.x - source.x;
  const dz = target.z - source.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const dy = target.y - source.y;

  // When drag=1 the old parabolic formula applies; keep it for backwards compat
  if (drag === 1) {
    const v2 = v * v;
    const v4 = v2 * v2;
    const root = v4 - g * (g * d * d + 2 * dy * v2);
    if (root < 0) {
      throw new Error("Target is unreachable with given projectile parameters");
    }
    const rootSq = Math.sqrt(root);
    const lowArcAngle = Math.atan((v2 - rootSq) / (g * d));
    const highArcAngle = Math.atan((v2 + rootSq) / (g * d));
    const angle = arcType === "low" ? lowArcAngle : highArcAngle;
    return d * Math.tan(angle);
  }

  // Equations of motion (per tick n):
  //   x_n = v_x0 * (1 - c^n) / (1 - c)
  //   y_n = v_y0 * (1 - c^n) / (1 - c) - g/(1-c) * (n - (1 - c^n)/(1 - c))
  // where c = drag coefficient, g = gravity per tick.
  //
  // We binary-search on the aim offset H (vertical aim above target).
  //   tan(θ) = H / d  →  v_x0 = v·cos(θ), v_y0 = v·sin(θ)
  // From x_n = d we solve for n:
  //   c^n = 1 - d(1-c)/v_x0
  //   n = ln(1 - d(1-c)/v_x0) / ln(c)
  // Then we evaluate y_n at that n and adjust H until y_n ≈ 0.
  //
  // The function is non-monotonic: low arcs have small H and high arcs have
  // large H. For high arcs, find the second root by scanning from the low arc
  // root until the trajectory crosses back down.

  const c = drag;
  const oneMinusC = 1 - c;
  const lnC = Math.log(c);

  if (c <= 0 || c >= 1) {
    throw new Error("Target is unreachable with given projectile parameters");
  }

  // Helper: given H, compute the vertical position y at the tick where x = d
  const verticalAtH = (H: number): number => {
    const angle = Math.atan2(H, d);
    const vx0 = v * Math.cos(angle);
    const vy0 = v * Math.sin(angle);

    // Time of flight from horizontal distance
    const cToN = 1 - (d * oneMinusC) / vx0;
    if (cToN <= 0 || cToN >= 1) return Infinity; // unreachable
    const n = Math.log(cToN) / lnC;

    // Geometric series: S = (1 - c^n) / (1 - c)
    const cPowN = Math.pow(c, n);
    const S = (1 - cPowN) / oneMinusC;

    // y_n = vy0 * S - g/(1-c) * (n - S)
    // Subtract dy so the root finder finds H where the projectile
    // reaches the target's actual Y level (not just y=0).
    return vy0 * S - (g / oneMinusC) * (n - S) - dy;
  };

  const findRoot = (startLo: number, startHi: number): number => {
    let lo = startLo;
    let hi = startHi;
    let yLo = verticalAtH(lo);
    let yHi = verticalAtH(hi);

    if (!isFinite(yLo) || !isFinite(yHi)) {
      throw new Error("Target is unreachable with given projectile parameters");
    }

    for (let i = 0; i < 40 && yLo * yHi > 0; i++) {
      hi *= 2;
      yHi = verticalAtH(hi);
      if (!isFinite(yHi)) {
        throw new Error(
          "Target is unreachable with given projectile parameters",
        );
      }
    }

    if (yLo * yHi > 0) {
      throw new Error("Target is unreachable with given projectile parameters");
    }

    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      const yMid = verticalAtH(mid);
      if (Math.abs(yMid) < 1e-6) return mid;
      if (yMid * yLo < 0) {
        hi = mid;
        yHi = yMid;
      } else {
        lo = mid;
        yLo = yMid;
      }
    }

    return (lo + hi) / 2;
  };

  if (arcType === "low") {
    return findRoot(0, 1);
  }

  // For the high arc, we need the second root of verticalAtH — where the
  // trajectory peaks and comes back down through y=0.  Scanning from just
  // above the low root finds the wrong sign change (the initial upward
  // crossing).  Instead, find the peak first, then scan downward from there.
  const lowRoot = findRoot(0, 1);

  // Find the peak: walk upward until verticalAtH starts decreasing.
  let peakH = lowRoot;
  let peakY = verticalAtH(peakH);
  for (let h = Math.ceil(lowRoot) + 1; h < 10_000; h += 1) {
    const y = verticalAtH(h);
    if (!isFinite(y)) break;
    if (y > peakY) {
      peakH = h;
      peakY = y;
    } else {
      break;
    }
  }

  if (peakY <= 0) {
    throw new Error("Target is unreachable with given projectile parameters");
  }

  // Scan from the peak to find where verticalAtH crosses zero on the way down.
  let previousH = peakH;
  let previousY = peakY;
  for (let highH = peakH + 1; highH < 10_000; highH += 1) {
    const highY = verticalAtH(highH);
    if (!isFinite(highY)) break;
    if (previousY * highY < 0) {
      return findRoot(previousH, highH);
    }
    previousH = highH;
    previousY = highY;
  }

  throw new Error("Target is unreachable with given projectile parameters");
}

/**
 * Raycast between two positions to detect block collisions.
 * Returns the first block hit along the path, or null if clear.
 * @param from - Start position
 * @param to - End position
 * @param blockAt - Function to look up a block at a given position
 * @returns The first block hit, or null if path is clear
 */
function raycastBlocks(
  from: Vec3,
  to: Vec3,
  blockAt: (pos: Vec3) => any,
): any | null {
  const dir = to.minus(from);
  const len = dir.norm();
  if (len < 1e-6) return null;

  const step = dir.scaled(1 / len);
  const steps = Math.ceil(len);

  for (let i = 1; i <= steps; i++) {
    const pos = from.plus(step.scaled(i));
    const block = blockAt(pos);
    if (block && block.boundingBox !== "empty") {
      return block;
    }
  }
  return null;
}

/**
 * Check if a position is in water.
 * @param pos - Position to check
 * @param blockAt - Function to look up a block at a given position
 * @returns true if the position is in water
 */
function isInWater(pos: Vec3, blockAt: (pos: Vec3) => any): boolean {
  const block = blockAt(pos);
  return block && block.name === "water";
}

/**
 * Whether a block stops a pearl. Liquids are not solid: a pearl flies
 * through water instead of landing in it.
 * @param block - Block to check
 */
function blocksPearl(block: any): boolean {
  if (!block || block.boundingBox === "empty") return false;
  const name = block.name as string | undefined;
  if (name === "water" || name === "flowing_water") return false;
  return true;
}

/**
 * Axis-aligned bounding box of a block's first shape (or the full cube).
 * @param block - Block with .position and optional .shapes
 * @returns AABB in world coordinates
 */
function blockAABB(block: { position: Vec3; shapes?: number[][] }): {
  min: Vec3;
  max: Vec3;
} {
  if (block.shapes && block.shapes.length > 0) {
    const s = block.shapes[0];
    return {
      min: new Vec3(block.position.x + s[0], block.position.y + s[1], block.position.z + s[2]),
      max: new Vec3(block.position.x + s[3], block.position.y + s[4], block.position.z + s[5]),
    };
  }
  return {
    min: block.position.clone(),
    max: block.position.offset(1, 1, 1),
  };
}

/**
 * Ray-AABB slab intersection returning the entry distance, or null.
 * @param origin - Ray origin
 * @param dir - Normalized ray direction
 * @param box - Box to intersect
 * @param maxDist - Maximum distance to consider
 * @returns Distance to the entry point, or null when there is no hit
 */
function rayBoxEntry(
  origin: Vec3,
  dir: Vec3,
  box: { min: Vec3; max: Vec3 },
  maxDist: number,
): number | null {
  let tNear = 0;
  let tFar = maxDist;
  for (const axis of ["x", "y", "z"] as const) {
    const o = origin[axis];
    const d = dir[axis];
    if (Math.abs(d) < 1e-9) {
      // Ray parallel to this slab: outside the slab means no hit at all.
      if (o < box.min[axis] || o > box.max[axis]) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (box.min[axis] - o) * inv;
    let t2 = (box.max[axis] - o) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tNear = Math.max(tNear, t1);
    tFar = Math.min(tFar, t2);
    if (tNear > tFar) return null;
  }
  // tNear === 0 means the ray starts inside the box (a collision already in
  // progress), which callers treat as "path blocked" — not a landing.
  return tNear > 1e-9 ? tNear : null;
}

/**
 * Landed ender pearl: the point where the pearl first enters a solid block.
 * @param source - Launch position
 * @param vel - Velocity for the tick
 * @param blockAt - Block lookup
 * @returns Entry point and the block that was hit, or null when the tick
 *   travels clear
 */
function pearlEntryPoint(
  source: Vec3,
  vel: Vec3,
  blockAt: (pos: Vec3) => any,
): { point: Vec3; block: any } | null {
  const step = vel.norm();
  if (step < 1e-9) return null;
  const dir = vel.scaled(1 / step);

  // Blocks the pearl can enter this tick: those overlapping the swept box.
  const minX = Math.floor(Math.min(source.x, source.x + vel.x));
  const maxX = Math.max(
    minX,
    Math.floor(Math.max(source.x, source.x + vel.x) - EPS),
  );
  const minY = Math.floor(Math.min(source.y, source.y + vel.y));
  const maxY = Math.max(
    minY,
    Math.floor(Math.max(source.y, source.y + vel.y) - EPS),
  );
  const minZ = Math.floor(Math.min(source.z, source.z + vel.z));
  const maxZ = Math.max(
    minZ,
    Math.floor(Math.max(source.z, source.z + vel.z) - EPS),
  );

  let bestT: number | null = null;
  let bestPoint: Vec3 | null = null;
  let bestBlock: any = null;
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        const block = blockAt(new Vec3(x, y, z));
        if (!blocksPearl(block)) continue;
        const t = rayBoxEntry(source, dir, blockAABB(block), step);
        if (t !== null && (bestT === null || t < bestT)) {
          bestT = t;
          bestPoint = source.plus(dir.scaled(t));
          bestBlock = block;
        }
      }
    }
  }
  if (!bestPoint || !bestBlock) return null;
  return { point: bestPoint, block: bestBlock };
}

/**
 * Check whether a projectile trajectory is clear of blocks and entities.
 * Simulates the full flight path with swept collision detection.
 * @param source - Launch position
 * @param target - Target position
 * @param v - Initial projectile speed
 * @param g - Gravity acceleration
 * @param p - Pitch in degrees
 * @param drag - Per-tick velocity multiplier
 * @param blockAt - Function to look up a block at a given position
 * @param entities - Array of entities to check for collisions (should exclude the thrower)
 * @returns Whether the path is clear
 */
export function isProjectilePathClear(
  source: Vec3,
  target: Vec3,
  v: number,
  g: number,
  p: number,
  drag = 1,
  blockAt: (pos: Vec3) => any,
  entities: any[],
): boolean {
  const yaw = Math.atan2(target.x - source.x, target.z - source.z);
  let currPos = source.clone();
  let currVel = new Vec3(
    v * Math.cos((p * Math.PI) / 180) * Math.sin(yaw),
    v * Math.sin((p * Math.PI) / 180),
    v * Math.cos((p * Math.PI) / 180) * Math.cos(yaw),
  );
  const maxTicks = 200;
  for (let i = 0; i < maxTicks; i++) {
    const nextPos = currPos.plus(currVel);

    // Use swept raycast for block collision (more accurate than discrete check)
    const hitBlock = raycastBlocks(currPos, nextPos, blockAt);
    if (hitBlock && isPointInBlock(nextPos, hitBlock)) {
      // Ender pearls teleport on collision with solid blocks. If the path
      // enters a block from outside (currPos not inside), the collision at
      // the surface between them is the teleport trigger — treat as a valid
      // path end. Only reject if already inside the block (passing through).
      if (!isPointInBlock(currPos, hitBlock)) {
        // Entering block from outside = valid ender pearl collision
        return true;
      }
      // Already inside block interior = path is blocked
      return false;
    }

    // Check entity collisions with correct pearl hitbox (0.25x0.25)
    const hitEntities = entities.filter(
      (e: any) => e.position.distanceTo(nextPos) < 0.25, // Pearl hitbox size
    );
    if (hitEntities.length > 0) return false;

    currPos = nextPos;

    // Apply water physics if in water (drag changes to 0.80)
    const inWater = isInWater(currPos, blockAt);
    const effectiveDrag = inWater ? 0.8 : drag;

    currVel.y = currVel.y * effectiveDrag - g;
    currVel.x *= effectiveDrag;
    currVel.z *= effectiveDrag;

    if (currPos.distanceTo(target) < 1.0) return true;
    if (currPos.y < -64) break;
  }
  return false;
}

/**
 * Best pearl trajectory calculation.
 *
 * Samples candidate landing points laterally (perpendicular to the origin-to-target
 * axis), capped at one quarter of the origin-to-target distance. No forward or
 * backward sampling along the throw axis. Prefers smaller lateral offsets first.
 *
 * Scoring: exact target > relaxed target; minimum flight time; miss distance within
 * tolerance; tie-break by smaller miss and larger clearance.
 *
 * @param source - Projectile spawn point (the thrower's hand: eye height
 *   minus 0.1), i.e. where the flight starts.
 * @param target - Desired target position
 * @param velocity - Initial projectile speed (default: ender pearl 1.5)
 * @param gravity  - Gravity acceleration per tick (default: 0.03)
 * @param drag     - Per-tick velocity multiplier (default: 0.99)
 * @param toleranceRadius - Max lateral sampling radius (default: 1.5, capped at dist/4)
 * @param sampleStep       - Lateral grid step size for candidate generation (default: 0.5)
 * @param blockAt - Function to look up a block at a given position
 * @param entities - Array of entities to check for collisions (should exclude the thrower)
 * @returns The best trajectory result, or null if no candidate trajectory
 *          (not even the direct target) is reachable.
 */
export function getBestPearlTrajectory(
  source: Vec3,
  target: Vec3,
  velocity: number = Constants.COMBAT.PROJECTILES.ender_pearl.VELOCITY,
  gravity: number = Constants.COMBAT.PROJECTILES.ender_pearl.GRAVITY,
  drag: number = Constants.COMBAT.PROJECTILES.ender_pearl.DRAG,
  toleranceRadius: number = 1.5,
  sampleStep: number = 0.5,
  blockAt: (pos: Vec3) => any,
  entities: any[],
): PearlTrajectoryResult | null {
  const candidates: Array<{
    point: Vec3;
    pitch: number;
    arc: "low" | "high";
    blocked: boolean;
    flightTime: number;
    landingPoint: Vec3;
    landingDist: number;
  }> = [];

  // Lateral sampling: perpendicular to origin-to-target axis in XZ plane.
  const dx = target.x - source.x;
  const dz = target.z - source.z;
  const dist = Math.hypot(dx, dz);
  // Cap tolerance at one quarter of origin-to-target distance.
  const maxLateral = Math.min(toleranceRadius, dist / 4);
  // Lateral unit vector (perpendicular to forward in XZ).
  const latX = dist > 1e-6 ? -dz / dist : 1;
  const latZ = dist > 1e-6 ? dx / dist : 0;

  // Build lateral offsets: 0 first, then expanding outward (±step, ±2*step, ...).
  const offsets: number[] = [0];
  const maxSteps = Math.ceil(maxLateral / sampleStep);
  for (let i = 1; i <= maxSteps; i++) {
    const o = i * sampleStep;
    if (o > maxLateral + 1e-9) break;
    offsets.push(o, -o);
  }

  const candidateTargets: Vec3[] = offsets.map(
    (o) => new Vec3(target.x + latX * o, target.y, target.z + latZ * o),
  );

  for (const candidateTarget of candidateTargets) {
    const pitches = getProjectilePitch(
      source,
      candidateTarget,
      velocity,
      gravity,
      drag,
    );

    for (let i = 0; i < pitches.length; i++) {
      const pitch = pitches[i];
      const arc: "low" | "high" = i === 0 ? "low" : "high";

      // Where the pearl actually lands: first solid block it enters, or the
      // end of the simulated path. A landing is only usable when it is close
      // to the wanted target — striking a wall face short of it is a miss.
      const info = simulateLanding(
        source,
        candidateTarget,
        velocity,
        gravity,
        pitch,
        drag,
        blockAt,
      );

      if (!info) {
        candidates.push({
          point: candidateTarget,
          pitch,
          arc,
          blocked: true,
          flightTime: Infinity,
          landingPoint: candidateTarget.clone(),
          landingDist: Infinity,
        });
        continue;
      }

      // A pearl that hits a wall (side or underside) leaves the bot against
      // or below that block instead of on the surface it aimed for: the
      // throw never reaches the wanted spot.
      if (info.face === "bottom" || info.face === "side") {
        candidates.push({
          point: candidateTarget,
          pitch,
          arc,
          blocked: true,
          flightTime: Infinity,
          landingPoint: info.landingPoint,
          landingDist: Infinity,
        });
        continue;
      }

      // Entity collisions use the correct pearl hitbox (0.25x0.25).
      const hitEntities = entities.filter(
        (e: any) => e.position.distanceTo(info.landingPoint) < 0.25,
      );
      if (hitEntities.length > 0) {
        candidates.push({
          point: candidateTarget,
          pitch,
          arc,
          blocked: true,
          flightTime: Infinity,
          landingPoint: info.landingPoint,
          landingDist: Infinity,
        });
        continue;
      }

      candidates.push({
        point: candidateTarget,
        pitch,
        arc,
        blocked: false,
        flightTime: info.flightTime,
        landingPoint: info.landingPoint,
        landingDist: info.landingPoint.distanceTo(target),
      });
    }
  }

  // ---- 3. Rank: usable landing > nearest to target > min flight time ----
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    // Paths that reach a block/landing outrank those that fly out of range
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    // Nearest landing first: a throw that ends on the wanted spot beats a
    // quicker throw that ends somewhere else (e.g. against the platform's
    // side instead of on top of it).
    if (a.landingDist !== b.landingDist) return a.landingDist - b.landingDist;
    // Tie-break by minimum flight time
    return a.flightTime - b.flightTime;
  });

  const best = candidates[0];

  if (best.blocked) return null;
  // A pearl that lands more than a block away does not teleport the bot to
  // the target — it hits the side of the platform instead. No usable throw.
  if (best.landingDist > PEARL_LANDING_TOLERANCE) return null;

  return {
    pitch: best.pitch,
    arc: best.arc,
    flightTime: best.flightTime,
    landingPoint: best.landingPoint.clone(),
    landingDist: best.landingDist,
  };
}

/**
 * Find the throw that lands an ender pearl ON the upper surface of the block
 * the aim point belongs to.
 *
 * This is the throw an elevated enemy needs: the pearl has to come down onto
 * the top of the platform the enemy stands on. A throw that hits the platform
 * from the side or from below teleports the bot against the wall instead of
 * onto the platform, so the landing is validated on three points:
 *
 *   1. the pearl hits a TOP face (not a side or the underside),
 *   2. that surface is at the aim height (the platform the enemy stands on),
 *   3. the pearl is falling when it lands, and it lands on the aim block.
 *
 * The pitch comes from the drag-aware offset solver: the "high" root is the
 * throw whose descending crossing of the aim height happens at the aim's
 * horizontal distance, i.e. the lob that comes down onto the surface instead
 * of passing through it. The analytic solution is then verified against the
 * simulated flight and nudged by small pitch steps when the tick sampling
 * puts the landing slightly off.
 *
 * @param source - Projectile spawn point (the thrower's hand: eye height
 *   minus 0.1), i.e. where the flight starts.
 * @param aim - Point on the surface the pearl must land on
 * @param velocity - Initial projectile speed (default: ender pearl 1.5)
 * @param gravity - Gravity acceleration per tick (default: 0.03)
 * @param drag - Per-tick velocity multiplier (default: 0.99)
 * @param blockAt - Function to look up a block at a given position
 * @param entities - Entities that would absorb the pearl (may be empty)
 * @param tolerance - Max horizontal distance from the aim (default: 0.55)
 * @returns The landing solution, or null when no throw lands on the surface
 */
export function findPearlTopLanding(
  source: Vec3,
  aim: Vec3,
  velocity: number = Constants.COMBAT.PROJECTILES.ender_pearl.VELOCITY,
  gravity: number = Constants.COMBAT.PROJECTILES.ender_pearl.GRAVITY,
  drag: number = Constants.COMBAT.PROJECTILES.ender_pearl.DRAG,
  blockAt: (pos: Vec3) => any,
  entities: any[] = [],
  tolerance: number = PEARL_TOP_LANDING_TOLERANCE,
): PearlTopLanding | null {
  const dx = aim.x - source.x;
  const dz = aim.z - source.z;
  const d = Math.hypot(dx, dz);
  // A pearl thrown straight up comes back down onto the thrower, so an aim
  // point directly overhead cannot be reached from where the bot stands.
  if (d < 1e-3) return null;

  let offset: number;
  try {
    offset = getProjectileOffset(source, aim, velocity, gravity, drag, "high");
  } catch {
    return null;
  }
  if (!isFinite(offset)) return null;

  const basePitch = (Math.atan2(offset, d) * 180) / Math.PI;
  const candidates: number[] = [basePitch];
  for (let i = 1; i <= PEARL_TOP_PITCH_STEPS; i++) {
    candidates.push(
      basePitch + i * PEARL_TOP_PITCH_STEP,
      basePitch - i * PEARL_TOP_PITCH_STEP,
    );
  }

  // The server randomizes the launch direction, so the landing scatters
  // over roughly this radius around the simulated one. A solution whose
  // margin is smaller than the scatter can be thrown off the target by
  // the randomization alone.
  const scatter = launchScatter(d);

  // A landing on top of a living entity is a landing the pearl cannot use:
  // the entity absorbs it and the thrower is not teleported. Such a landing
  // is kept as a fallback — the server randomizes the pearl's launch
  // direction, so the real flight can still land clear of the entity.
  let fallback: PearlTopLanding | null = null;
  let best: PearlTopLanding | null = null;

  for (const pitch of candidates) {
    const landing = simulateLanding(
      source,
      aim,
      velocity,
      gravity,
      pitch,
      drag,
      blockAt,
    );
    if (!landing) continue;

    // The pitch refinements only move the landing by a fraction of a
    // block: refining a pitch that is nowhere near the target just burns
    // simulations. Stop once the base pitch is clearly out of reach.
    if (
      best === null &&
      pitch !== basePitch &&
      landing.landingPoint.distanceTo(aim) > REFINEMENT_REACH
    ) {
      break;
    }

    // The pearl has to come down onto the surface, not clip its side or hit
    // its underside.
    if (landing.face !== "top") continue;
    if (!landing.descending) continue;
    if (Math.abs(landing.landingPoint.y - aim.y) > PEARL_TOP_SURFACE_EPS) {
      continue;
    }
    const landingDist = Math.hypot(
      landing.landingPoint.x - aim.x,
      landing.landingPoint.z - aim.z,
    );
    if (landingDist > tolerance) continue;

    const solution: PearlTopLanding = {
      pitch,
      offset: d * Math.tan((pitch * Math.PI) / 180),
      flightTime: landing.flightTime,
      landingPoint: landing.landingPoint.clone(),
      landingDist,
    };

    // A living entity standing on the landing spot would eat the pearl.
    if (
      entities.some(
        (e: any) =>
          e.position &&
          e.position.distanceTo(landing.landingPoint) < PEARL_ENTITY_BLOCK_RADIUS,
      )
    ) {
      fallback = fallback ?? solution;
      continue;
    }

    // Keep the solution with the largest margin, but stop as soon as the
    // randomization cannot move the landing off the target: refining
    // further only costs simulations.
    if (!best || solution.landingDist < best.landingDist) {
      best = solution;
    }
    if (best.landingDist + 2 * scatter <= tolerance) return best;
  }

  return best ?? fallback;
}
