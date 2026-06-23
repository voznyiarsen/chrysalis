/**
 * @fileoverview Movement mechanics for Pupa bot.
 * Jump, strafe, and collision physics — extracted from UtilsManager.
 *
 * Functions accept bot-dependency callbacks so they can be used both
 * by UtilsManager (bound to a live bot) and by E2E tests (with real or
 * mocked bot state).
 */

import { Constants } from "./constants";
import { Vec3 } from "vec3";
import { AABB } from "./utils";

const EPS = 1.0e-7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SolidCacheEntry {
  solids: Vec3[];
  expiry: number;
}

// ---------------------------------------------------------------------------
// isJumpPathClear
// ---------------------------------------------------------------------------

/**
 * Simulate a sprint-jump trajectory and check whether it reaches the target
 * without colliding.
 */
export function isJumpPathClear(
  source: Vec3,
  target: Vec3,
  getSlipperiness: (pos: Vec3) => number,
  getCollisions: (aabb: AABB, minYThreshold: number) => AABB[],
  botEntity: { position: Vec3; velocity: Vec3 },
  momentumThreshold: number,
): boolean {
  const GRAVITY = Constants.PHYSICS.TICK_GRAVITY;
  const DRAG = Constants.PHYSICS.TICK_DRAG;
  const AIRBORNE_MOMENTUM = Constants.PHYSICS.MOMENTUM_CONSERVATION;
  const St = getSlipperiness(source);
  const Et = 1.0; // applyEffects gated off in movement context
  const GROUND_MOMENTUM = St * AIRBORNE_MOMENTUM;
  const Mt =
    Constants.PHYSICS.ACCELERATION.SPRINT_MULTIPLIER *
    Constants.PHYSICS.ACCELERATION.STRAFE_MULTIPLIER;
  const GROUND_ACCEL = 0.1 * Mt * Et * Math.pow(0.6 / St, 3);
  const AIR_ACCEL =
    Constants.PHYSICS.ACCELERATION.AIR *
    Constants.PHYSICS.ACCELERATION.SPRINT_MULTIPLIER;
  const dx_tot = target.x - source.x;
  const dz_tot = target.z - source.z;
  const len = Math.hypot(dx_tot, dz_tot) || 1e-6;
  const dirX = dx_tot / len;
  const dirZ = dz_tot / len;
  const vH0 = Math.hypot(botEntity.velocity.x, botEntity.velocity.z);
  const vH1 =
    vH0 * GROUND_MOMENTUM + GROUND_ACCEL + Constants.PHYSICS.SPRINT_JUMP_BOOST;
  let currPos = source.clone();
  let currVel = new Vec3(
    dirX * vH1,
    Constants.PHYSICS.JUMP_VELOCITY,
    dirZ * vH1,
  );
  const maxTicks = 40;
  const distToTargetXZ = len;
  const OVERLAP_MARGIN = 0.1;
  for (let tick = 0; tick < maxTicks; tick++) {
    if (Math.abs(currVel.x) < momentumThreshold) currVel.x = 0;
    if (Math.abs(currVel.y) < momentumThreshold) currVel.y = 0;
    if (Math.abs(currVel.z) < momentumThreshold) currVel.z = 0;
    let playerAABB = new AABB(
      currPos.x - 0.3,
      currPos.y,
      currPos.z - 0.3,
      currPos.x + 0.3,
      currPos.y + 1.8,
      currPos.z + 0.3,
    );
    const moveAABB = playerAABB
      .extend(currVel.x, currVel.y, currVel.z)
      .expand(0.1);
    const collisions = getCollisions(moveAABB, botEntity.position.y + 0.3);
    for (const bb of collisions) {
      if (moveAABB.intersects(bb)) {
        return false;
      }
    }
    let dy = currVel.y;
    for (const bb of collisions) dy = playerAABB.calculateYOffset(bb, dy, EPS);
    if (currVel.y > 0 && Math.abs(dy - currVel.y) > EPS) currVel.y = 0;
    else if (currVel.y < 0 && dy > currVel.y + EPS) {
      const dist = Math.hypot(currPos.x - source.x, currPos.z - source.z);
      if (dist >= distToTargetXZ - 0.6) return true;
      return false;
    }
    // Check for landing: if the bot's feet have reached the ground
    // surface (source.y) while falling, evaluate horizontal distance
    // even though the strict-inequality collision model doesn't detect
    // surface contact as a collision.
    if (currVel.y < 0 && currPos.y <= source.y + EPS) {
      const dist = Math.hypot(currPos.x - source.x, currPos.z - source.z);
      if (dist >= distToTargetXZ - 0.6) return true;
      return false;
    }
    currPos.y += dy;
    playerAABB = playerAABB.offset(0, dy, 0);
    let dx = currVel.x;
    for (const bb of collisions)
      dx = playerAABB.calculateXOffset(bb, dx, OVERLAP_MARGIN);
    if (Math.abs(dx - currVel.x) > EPS) return false;
    currPos.x += dx;
    playerAABB = playerAABB.offset(dx, 0, 0);
    let dz = currVel.z;
    for (const bb of collisions)
      dz = playerAABB.calculateZOffset(bb, dz, OVERLAP_MARGIN);
    if (Math.abs(dz - currVel.z) > EPS) return false;
    currPos.z += dz;
    if (
      Math.hypot(currPos.x - source.x, currPos.z - source.z) >= distToTargetXZ
    )
      return true;
    currVel.y -= GRAVITY;
    currVel.y *= DRAG;
    if (currVel.y < Constants.PHYSICS.TERMINAL_VELOCITY_Y)
      currVel.y = Constants.PHYSICS.TERMINAL_VELOCITY_Y;
    currVel.x = currVel.x * AIRBORNE_MOMENTUM + dirX * AIR_ACCEL;
    currVel.z = currVel.z * AIRBORNE_MOMENTUM + dirZ * AIR_ACCEL;
    if (currPos.y < target.y - 2 && currVel.y < 0) break;
  }
  return false;
}

// ---------------------------------------------------------------------------
// getJumpVelocity
// ---------------------------------------------------------------------------

/**
 * Compute a velocity vector for a jump toward a target.
 */
export function getJumpVelocity(
  source: Vec3,
  target: Vec3,
  angleDeg: number,
  isStrafe: boolean,
  getSlipperiness: (pos: Vec3) => number,
  getHorizontalSpeed: () => number,
): Vec3 {
  const dx = target.x - source.x;
  const dz = target.z - source.z;
  const len = Math.hypot(dx, dz);
  const vy = Constants.PHYSICS.JUMP_VELOCITY;
  if (len === 0) return new Vec3(0, vy, 0);

  const St = getSlipperiness(source);
  const GROUND_MOMENTUM = St * Constants.PHYSICS.MOMENTUM_CONSERVATION;
  const AIR_MOMENTUM = Constants.PHYSICS.MOMENTUM_CONSERVATION;

  let vY = Constants.PHYSICS.JUMP_VELOCITY;
  let airborneTicks = 0;
  let yPos = vY;
  while (yPos > 0) {
    vY = (vY - Constants.PHYSICS.TICK_GRAVITY) * Constants.PHYSICS.TICK_DRAG;
    yPos += vY;
    if (yPos > 0) airborneTicks++;
  }
  if (airborneTicks < 1) airborneTicks = 1;

  const geomSum =
    (1 - Math.pow(AIR_MOMENTUM, airborneTicks)) / (1 - AIR_MOMENTUM);
  const distMultiplier = 1 + GROUND_MOMENTUM * geomSum;

  const calibrationFactor = isStrafe
    ? Constants.PHYSICS.STRAFE_VELOCITY_CALIBRATION
    : Constants.PHYSICS.JUMP_VELOCITY_CALIBRATION;
  const vH1 = (len / distMultiplier) * calibrationFactor;

  const rad = (angleDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const vx = ((dx / len) * cosA - (dz / len) * sinA) * vH1;
  const vz = ((dx / len) * sinA + (dz / len) * cosA) * vH1;
  return new Vec3(vx, vy, vz);
}

// ---------------------------------------------------------------------------
// getStrafeYaw
// ---------------------------------------------------------------------------

/**
 * Computes the Minecraft yaw for strafing perpendicular to a target.
 */
export function getStrafeYaw(
  playerPos: Vec3,
  targetPos: Vec3,
  direction: number,
): number {
  const dx = targetPos.x - playerPos.x;
  const dz = targetPos.z - playerPos.z;
  const minecraftYawToTarget = Math.atan2(-dx, dz);
  return minecraftYawToTarget + direction * (Math.PI / 2);
}

// ---------------------------------------------------------------------------
// getHorizontalSpeed
// ---------------------------------------------------------------------------

/**
 * Get the horizontal speed of an entity.
 */
export function getHorizontalSpeed(entity: { velocity: Vec3 }): number {
  return Math.hypot(entity.velocity.x, entity.velocity.z);
}

// ---------------------------------------------------------------------------
// getGroundJumpSpeed
// ---------------------------------------------------------------------------

/**
 * Get the ground-inertia-adjusted jump speed (pre-drag).
 */
export function getGroundJumpSpeed(
  source: Vec3,
  getSlipperiness: (pos: Vec3) => number,
  getHorizontalSpeedFn: () => number,
): number {
  const St = getSlipperiness(source);
  const Et = 1.0;
  const Mt =
    Constants.PHYSICS.ACCELERATION.SPRINT_MULTIPLIER *
    Constants.PHYSICS.ACCELERATION.STRAFE_MULTIPLIER;
  const GROUND_ACCEL = 0.1 * Mt * Et * Math.pow(0.6 / St, 3);
  const GROUND_MOMENTUM = St * Constants.PHYSICS.MOMENTUM_CONSERVATION;
  const vH0 = getHorizontalSpeedFn();
  return (
    vH0 * GROUND_MOMENTUM + GROUND_ACCEL + Constants.PHYSICS.SPRINT_JUMP_BOOST
  );
}

// ---------------------------------------------------------------------------
// getFlatVelocity
// ---------------------------------------------------------------------------

/**
 * Compute a flat (horizontal-only) velocity vector toward a target.
 */
export function getFlatVelocity(
  source: Vec3,
  target: Vec3,
  angleDeg: number,
  speed: number,
  vy: number,
): Vec3 {
  const angleRad =
    Math.atan2(target.z - source.z, target.x - source.x) +
    (angleDeg * Math.PI) / 180;
  const limit = Constants.MOVEMENT.PER_AXIS_MAX_SPEED;
  return new Vec3(
    Math.max(-limit, Math.min(limit, Math.cos(angleRad) * speed)),
    vy,
    Math.max(-limit, Math.min(limit, Math.sin(angleRad) * speed)),
  );
}

// ---------------------------------------------------------------------------
// getCollisions
// ---------------------------------------------------------------------------

/**
 * Get all block collision AABBs that intersect a given AABB.
 */
export function getCollisions(
  aabb: AABB,
  minYThreshold: number,
  blockAt: (pos: Vec3) => any,
): AABB[] {
  const collisions: AABB[] = [];
  const minX = Math.floor(aabb.minX);
  const maxX = Math.floor(aabb.maxX);
  const minYActual = Math.floor(Math.max(aabb.minY, minYThreshold));
  const maxY = Math.floor(aabb.maxY);
  const minZ = Math.floor(aabb.minZ);
  const maxZ = Math.floor(aabb.maxZ);
  for (let x = minX; x <= maxX; x++) {
    for (let y = minYActual; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        const block = blockAt(new Vec3(x, y, z));
        if (block && block.shapes && block.shapes.length > 0) {
          if (
            aabb.maxX <= x ||
            aabb.minX >= x + 1 ||
            aabb.maxY <= y ||
            aabb.minY >= y + 1 ||
            aabb.maxZ <= z ||
            aabb.minZ >= z + 1
          )
            continue;
          for (const shape of block.shapes) {
            collisions.push(
              new AABB(
                x + shape[0],
                y + shape[1],
                z + shape[2],
                x + shape[3],
                y + shape[4],
                z + shape[5],
              ),
            );
          }
        }
      }
    }
  }
  return collisions;
}

// ---------------------------------------------------------------------------
// getSolidBlocks
// ---------------------------------------------------------------------------

/**
 * Find all walkable solid block surfaces within a radius of the source.
 * Results are cached for SOLID_BLOCKS_CACHE_DURATION ms.
 */
export function getSolidBlocks(
  source: Vec3,
  radius: number,
  blockAt: (pos: Vec3) => any,
  entityWidth: number,
  cache: Map<string, SolidCacheEntry>,
  cacheMaxSize: number,
): Vec3[] {
  const now = Date.now();
  const cacheKey = `${Math.floor(source.x)},${Math.floor(source.z)}`;

  const cached = cache.get(cacheKey);
  if (cached && now < cached.expiry) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return cached.solids;
  }

  const solids: Vec3[] = [];
  const startY = Math.floor(source.y);

  for (let x = -radius; x <= radius; x++) {
    for (let z = -radius; z <= radius; z++) {
      for (
        let y = startY;
        y >= startY + Constants.BLOCK_DETECTION.MIN_WALKABLE_Y_OFFSET;
        y--
      ) {
        const pos = new Vec3(source.x + x, y, source.z + z);
        const block = blockAt(pos);
        const above = blockAt(pos.offset(0, 1, 0));
        if (
          block &&
          block.boundingBox !== "empty" &&
          (!above || above.boundingBox === "empty")
        ) {
          const shape = block.shapes[0];
          if (shape) {
            const sdx = Math.abs(
              shape[Constants.SHAPE.MIN_X] - shape[Constants.SHAPE.MAX_X],
            );
            const sdz = Math.abs(
              shape[Constants.SHAPE.MIN_Z] - shape[Constants.SHAPE.MAX_Z],
            );
            if (sdx > entityWidth && sdz > entityWidth) {
              const yOff = Math.abs(
                shape[Constants.SHAPE.MIN_Y] - shape[Constants.SHAPE.MAX_Y],
              );
              solids.push(pos.offset(0.5, yOff, 0.5));
              break;
            }
          }
        }
      }
    }
  }

  if (cache.size >= cacheMaxSize) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(cacheKey, {
    solids,
    expiry: now + Constants.BLOCK_DETECTION.SOLID_BLOCKS_CACHE_DURATION,
  });

  return solids;
}

// ---------------------------------------------------------------------------
// clearSolidCache
// ---------------------------------------------------------------------------

export function clearSolidCache(cache: Map<string, SolidCacheEntry>): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// getStrafePoint
// ---------------------------------------------------------------------------

/**
 * Find a valid strafe point (solid block surface) near the target.
 */
export function getStrafePoint(
  source: Vec3,
  candidate: Vec3,
  target: Vec3,
  getSolidBlocksFn: (pos: Vec3) => Vec3[],
  isJumpPathClearFn: (a: Vec3, b: Vec3) => boolean,
  recentPoints: Vec3[],
  recentPointsMax: number,
  pvpTarget?: Vec3,
  obstacles?: AABB[],
): Vec3 | null {
  // Search for solid blocks around both the source (bot) and the target
  // so that valid strafe points are found even on flat ground where the
  // target offset would otherwise yield no overlapping candidates.
  const solidsSource = getSolidBlocksFn(source);
  const solidsTarget = getSolidBlocksFn(target);
  const solids = [...solidsSource, ...solidsTarget];
  const maxDistBot = Constants.MOVEMENT.STRAFE_POINT_MAX_DISTANCE_BOT;
  const maxDistTarget = Constants.MOVEMENT.STRAFE_POINT_MAX_DISTANCE_TARGET;
  const minSpacing = Constants.MOVEMENT.STRAFE_POINT_MIN_SPACING;
  const sourceMinDist = Constants.MOVEMENT.STRAFE_POINT_SOURCE_MIN_DISTANCE;
  const dist2D = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);
  if (solids.length === 0) return null;

  for (const point of solids) {
    if (
      dist2D(point, target) >= maxDistTarget ||
      dist2D(point, source) >= maxDistBot
    )
      continue;
    if (dist2D(point, source) < sourceMinDist) continue;
    if (!isJumpPathClearFn(source, point)) continue;
    if (recentPoints.some((rp) => dist2D(point, rp) <= minSpacing)) continue;
    if (obstacles && obstacles.length > 0) {
      const PROXIMITY_EPS = 0.3;
      const dirBot = new Vec3(
        point.x - source.x,
        point.y - source.y,
        point.z - source.z,
      );
      const dirTarget = new Vec3(
        point.x - target.x,
        point.y - target.y,
        point.z - target.z,
      );
      const distBotToPoint = dist2D(source, point);
      const distTargetToPoint = dist2D(target, point);
      let blocked = false;
      for (const obs of obstacles) {
        // Proximity mask: expanded AABB that blocks rays from both observers.
        const mask = new AABB(
          obs.minX - PROXIMITY_EPS,
          obs.minY - PROXIMITY_EPS,
          obs.minZ - PROXIMITY_EPS,
          obs.maxX + PROXIMITY_EPS,
          obs.maxY + PROXIMITY_EPS,
          obs.maxZ + PROXIMITY_EPS,
        );
        // Bot raycast: block if ray passes through mask (point behind far edge, t_far < 1).
        const [, tBotFar] = mask.rayHitTFar(source, dirBot);
        if (tBotFar < 1) {
          blocked = true;
          break;
        }
        // Target raycast: block if ray passes through mask (point behind far edge, t_far < 1).
        const [, tTgtFar] = mask.rayHitTFar(target, dirTarget);
        if (tTgtFar < 1) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
    }

    // Reject points too close to the target (< 0.3 blocks).
    if (dist2D(point, target) < 0.3) continue;

    // First valid point wins (no scoring).
    recentPoints.push(point);
    if (recentPoints.length > recentPointsMax) recentPoints.shift();
    return point;
  }

  return null;
}

// ---------------------------------------------------------------------------
// getGroundBelow
// ---------------------------------------------------------------------------

/**
 * Find the Y coordinate of the ground surface below a position.
 */
export function getGroundBelow(pos: Vec3, blockAt: (pos: Vec3) => any): number {
  const startY = Math.floor(pos.y);
  for (let y = startY; y >= startY - 5; y--) {
    const block = blockAt(new Vec3(pos.x, y, pos.z));
    if (block && block.boundingBox !== "empty") {
      const shape = block.shapes[0];
      if (shape) return y + shape[Constants.SHAPE.MAX_Y];
      return y + 1;
    }
  }
  return -64;
}

// ---------------------------------------------------------------------------
// getFallDamage
// ---------------------------------------------------------------------------

/**
 * Calculate fall damage for a given fall distance.
 */
export function getFallDamage(distance: number): number {
  const safeFallDistance = 3;
  const fallDamageMultiplier = 1;
  if (distance <= 3) return 0;
  return Math.max(
    0,
    Math.floor((distance - safeFallDistance) * fallDamageMultiplier),
  );
}
