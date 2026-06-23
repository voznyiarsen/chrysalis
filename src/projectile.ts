import { Vec3 } from "vec3";
import { Constants } from "./constants";

/**
 * @fileoverview Pure functions for projectile trajectory calculation.
 * Extracted from UtilsManager in src/utils.ts.
 */

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
 * Simulate a projectile trajectory from source with given pitch and return
 * the total flight time (ticks) and landing position (first tick where
 * the projectile is within 1.0 block of the target).
 *
 * This does NOT check for obstacles; it purely computes the parabolic path.
 * @param source - Launch position
 * @param target - Target position (end-of-flight marker)
 * @param v - Initial speed
 * @param g - Gravity per tick
 * @param p - Pitch in degrees
 * @param drag - Per-tick velocity multiplier
 * @returns { flightTime, landingPoint } or null if flight never reaches target vicinity
 */
function computeLandingInfo(
  source: Vec3,
  target: Vec3,
  v: number,
  g: number,
  p: number,
  drag: number,
): { flightTime: number; landingPoint: Vec3 } | null {
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
    currPos = nextPos;
    currVel.y = currVel.y * drag - g;
    currVel.x *= drag;
    currVel.z *= drag;
    if (currPos.distanceTo(target) < 1.0)
      return { flightTime: i + 1, landingPoint: currPos.clone() };
    if (currPos.y < -64) break;
  }
  return null;
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
      currX += velX;
      currY += velY;
      velX *= drag;
      velY = velY * drag - g;
      if (currY <= y && velY < 0) return currX;
    }
    return currX;
  };
  const refine = (p: number): number => {
    let refinedP = p;
    for (let i = 0; i < 5; i++) {
      const d1 = getDistanceAtY(refinedP);
      const err = x - d1;
      if (Math.abs(err) < 0.1) break;
      const delta = 0.1;
      const d2 = getDistanceAtY(refinedP + delta);
      const deriv = (d2 - d1) / delta;
      refinedP += err / (deriv || 1);
    }
    return refinedP;
  };
  return pitches.map(refine);
}

/**
 * Calculate vertical offset for aiming at a target using projectile physics.
 * This offset-based approach is more intuitive than angle-based aiming.
 *
 * @param source - Eye position (projectile origin)
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
 * Check whether a projectile trajectory is clear of blocks and entities.
 * Simulates the full flight path.
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
    const block = blockAt(nextPos);
    if (
      block &&
      block.boundingBox !== "empty" &&
      isPointInBlock(nextPos, block)
    )
      return false;
    const hitEntities = entities.filter(
      (e: any) => e.position.distanceTo(nextPos) < (e.width || 0.6),
    );
    if (hitEntities.length > 0) return false;
    currPos = nextPos;
    currVel.y = currVel.y * drag - g;
    currVel.x *= drag;
    currVel.z *= drag;
    if (currPos.distanceTo(target) < 1.0) return true;
    if (currPos.y < -64) break;
  }
  return false;
}

/**
 * Best pearl trajectory calculation.
 *
 * Samples candidate landing points within a 1.5-block tolerance sphere centered
 * on the target point, computes pitches for each candidate, checks whether each
 * trajectory is unobstructed, then ranks by:
 *  1) Unobstructed (clear paths before blocked ones)
 *  2) Flight time  (ascending  – faster is better)
 *  3) Landing distance to original target (ascending – more precise is better)
 *
 * @param source - Launch position (eye position of the thrower)
 * @param target - Desired target position
 * @param velocity - Initial projectile speed (default: ender pearl 1.5)
 * @param gravity  - Gravity acceleration per tick (default: 0.03)
 * @param drag     - Per-tick velocity multiplier (default: 0.99)
 * @param toleranceRadius - Sampling radius around the target (default: 1.5)
 * @param sampleStep       - Grid step size for candidate generation (default: 1.0)
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
  sampleStep: number = 1.0,
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

  // Determine the number of integer-valued offset steps that fit inside the radius
  const maxOffset = Math.floor(toleranceRadius / sampleStep);
  const offsets: number[] = [];
  for (let d = -maxOffset; d <= maxOffset; d++) {
    const o = d * sampleStep;
    // Always include the exact target (o = 0) and keep the list small
    offsets.push(o);
  }
  // Ensure 0 is always present (maxOffset >= 1 for radius >= step, which is typical)
  if (!offsets.includes(0)) offsets.push(0);

  const candidateTargets: Vec3[] = [];
  for (const dx of offsets) {
    for (const dy of offsets) {
      for (const dz of offsets) {
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > toleranceRadius * toleranceRadius + 1e-9) continue;
        candidateTargets.push(
          new Vec3(target.x + dx, target.y + dy, target.z + dz),
        );
      }
    }
  }

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

      const blocked = !isProjectilePathClear(
        source,
        candidateTarget,
        velocity,
        gravity,
        pitch,
        drag,
        blockAt,
        entities,
      );

      if (blocked) {
        // Still record the blocked entry so it ranks below all clear paths
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

      // Compute flight time and actual landing position
      const info = computeLandingInfo(
        source,
        candidateTarget,
        velocity,
        gravity,
        pitch,
        drag,
      );

      if (!info) {
        // Shouldn't happen for a pitch that came from getProjectilePitch, but be safe
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

  // ---- 3. Rank: unobstructed (false < true) > low arc preferred > flightTime ASC > landingDist ASC ----
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    // Clear paths first
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    // Prefer low arc over high arc when both are available
    if (a.arc !== b.arc) return a.arc === "low" ? -1 : 1;
    // Then fastest (shortest flight time)
    if (a.flightTime !== b.flightTime) return a.flightTime - b.flightTime;
    // Then most precise (closest to actual target)
    return a.landingDist - b.landingDist;
  });

  const best = candidates[0];

  if (best.blocked) return null;

  return {
    pitch: best.pitch,
    arc: best.arc,
    flightTime: best.flightTime,
    landingPoint: best.landingPoint.clone(),
    landingDist: best.landingDist,
  };
}
