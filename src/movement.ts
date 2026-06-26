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
// isPositionClear — validates the full player AABB at a candidate position
// ---------------------------------------------------------------------------

/**
 * Check whether the bot's full AABB (0.6×1.8×0.6) fits at the given position
 * without intersecting any solid block. Uses strict-inequality overlap
 * (touching a face is not a collision).
 * @param pos - The position (feet-level) to check
 * @param blockAtFn - Callback to query a block at a given position
 * @returns true if the position is clear of solid blocks
 */
export function isPositionClear(
  pos: Vec3,
  blockAtFn: (pos: Vec3) => any,
): boolean {
  const halfWidth = Constants.PHYSICS.PLAYER_OFFSET; // 0.3
  const height = Constants.PHYSICS.PLAYER_HEIGHT; // 1.8
  const minX = Math.floor(pos.x - halfWidth);
  const maxX = Math.floor(pos.x + halfWidth);
  const minY = Math.floor(pos.y);
  const maxY = Math.floor(pos.y + height);
  const minZ = Math.floor(pos.z - halfWidth);
  const maxZ = Math.floor(pos.z + halfWidth);

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        const block = blockAtFn(new Vec3(x, y, z));
        if (block && block.boundingBox !== "empty") {
          if (block.shapes && block.shapes.length > 0) {
            for (const shape of block.shapes) {
              const bMinX = x + shape[Constants.SHAPE.MIN_X];
              const bMinY = y + shape[Constants.SHAPE.MIN_Y];
              const bMinZ = z + shape[Constants.SHAPE.MIN_Z];
              const bMaxX = x + shape[Constants.SHAPE.MAX_X];
              const bMaxY = y + shape[Constants.SHAPE.MAX_Y];
              const bMaxZ = z + shape[Constants.SHAPE.MAX_Z];

              // Strict inequality: AABB must overlap with volume > 0
              if (
                pos.x + halfWidth > bMinX &&
                pos.x - halfWidth < bMaxX &&
                pos.y + height > bMinY &&
                pos.y < bMaxY &&
                pos.z + halfWidth > bMinZ &&
                pos.z - halfWidth < bMaxZ
              ) {
                return false;
              }
            }
          } else {
            // No shapes but boundingBox is non-empty → treat as full block
            return false;
          }
        }
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// isLandingClear — validates landing AABB using getCollisions callback
// ---------------------------------------------------------------------------

/**
 * Check whether the bot's full AABB at a landing position is clear of solid
 * blocks. Uses the getCollisions callback to query block geometry.
 * @param pos - The landing position (feet-level)
 * @param getCollisionsFn - Callback that returns collision AABBs for a given AABB
 * @returns true if the landing position is clear
 */
function isLandingClear(
  pos: Vec3,
  getCollisionsFn: (aabb: AABB, minY: number) => AABB[],
): boolean {
  const halfWidth = Constants.PHYSICS.PLAYER_OFFSET; // 0.3
  const height = Constants.PHYSICS.PLAYER_HEIGHT; // 1.8
  const landingAABB = new AABB(
    pos.x - halfWidth,
    pos.y,
    pos.z - halfWidth,
    pos.x + halfWidth,
    pos.y + height,
    pos.z + halfWidth,
  );
  const blocks = getCollisionsFn(landingAABB, pos.y);
  for (const bb of blocks) {
    if (landingAABB.intersects(bb)) return false;
  }
  return true;
}

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
  const GRAVITY = Constants.PHYSICS.GRAVITY;
  const DRAG = Constants.PHYSICS.DRAG;
  const AIRBORNE_MOMENTUM = Constants.PHYSICS.MOMENTUM;
  const AIR_ACCEL =
    Constants.PHYSICS.ACCELERATION.AIR *
    Constants.PHYSICS.ACCELERATION.SPRINT_MULTIPLIER;
  const dx_tot = target.x - source.x;
  const dz_tot = target.z - source.z;
  const len = Math.hypot(dx_tot, dz_tot) || 1e-6;
  const dirX = dx_tot / len;
  const dirZ = dz_tot / len;

  // Use getJumpVelocity for the initial velocity so the simulation matches
  // the actual impulse applied by doStrafe.
  const jumpVel = getJumpVelocity(
    source,
    target,
    0,
    false,
    getSlipperiness,
    () => Math.hypot(botEntity.velocity.x, botEntity.velocity.z),
  );
  const vH1 = jumpVel.x / dirX;
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
      currPos.x - Constants.PHYSICS.PLAYER_OFFSET,
      currPos.y,
      currPos.z - Constants.PHYSICS.PLAYER_OFFSET,
      currPos.x + Constants.PHYSICS.PLAYER_OFFSET,
      currPos.y + Constants.PHYSICS.PLAYER_HEIGHT,
      currPos.z + Constants.PHYSICS.PLAYER_OFFSET,
    );
    const moveAABB = playerAABB
      .extend(currVel.x, currVel.y, currVel.z)
      .expand(0.1);
    const collisions = getCollisions(moveAABB, -Infinity);
    let earliestTOI = 1;
    for (const bb of collisions) {
      const toi = playerAABB.sweptTOI(currVel, bb);
      if (toi === null) continue;
      // Skip landing: box was above the block and is landing on top
      if (source.y >= bb.maxY - EPS && currVel.y <= 0) continue;
      if (toi < earliestTOI) earliestTOI = toi;
    }
    if (earliestTOI < 1) {
      return false;
    }
    let dy = currVel.y;
    for (const bb of collisions) dy = playerAABB.calculateYOffset(bb, dy, EPS);
    if (currVel.y > 0 && Math.abs(dy - currVel.y) > EPS) currVel.y = 0;
    else if (currVel.y < 0 && dy > currVel.y + EPS) {
      const dist = Math.hypot(currPos.x - source.x, currPos.z - source.z);
      if (dist >= distToTargetXZ - 0.6) {
        // Validate landing AABB is clear at the current position
        if (!isLandingClear(currPos, getCollisions)) return false;
        return true;
      }
      return false;
    }
    // Check for landing: if the bot's feet have reached the ground
    // surface (source.y) while falling, evaluate horizontal distance
    // even though the strict-inequality collision model doesn't detect
    // surface contact as a collision.
    if (currVel.y < 0 && currPos.y <= source.y + EPS) {
      const dist = Math.hypot(currPos.x - source.x, currPos.z - source.z);
      if (dist >= distToTargetXZ - 0.6) {
        // Validate landing AABB is clear at the current position
        if (!isLandingClear(currPos, getCollisions)) return false;
        return true;
      }
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
    ) {
      // Validate landing AABB is clear at the final position
      if (!isLandingClear(currPos, getCollisions)) return false;
      return true;
    }
    currVel.y -= GRAVITY;
    currVel.y *= DRAG;
    if (currVel.y < Constants.PHYSICS.TERMINAL_VELOCITY)
      currVel.y = Constants.PHYSICS.TERMINAL_VELOCITY;
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
  const GROUND_MOMENTUM = St * Constants.PHYSICS.MOMENTUM;
  const AIR_MOMENTUM = Constants.PHYSICS.MOMENTUM;

  let vY = Constants.PHYSICS.JUMP_VELOCITY;
  let airborneTicks = 0;
  let yPos = vY;
  while (yPos > 0) {
    vY = (vY - Constants.PHYSICS.GRAVITY) * Constants.PHYSICS.DRAG;
    yPos += vY;
    if (yPos > 0) airborneTicks++;
  }
  if (airborneTicks < 1) airborneTicks = 1;

  const geomSum =
    (1 - Math.pow(AIR_MOMENTUM, airborneTicks)) / (1 - AIR_MOMENTUM);
  const distMultiplier = 1 + GROUND_MOMENTUM * geomSum;

  const calibrationFactor = isStrafe
    ? Constants.PHYSICS.STRAFE_CALIBRATION
    : Constants.PHYSICS.JUMP_CALIBRATION;
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
  const GROUND_MOMENTUM = St * Constants.PHYSICS.MOMENTUM;
  const vH0 = getHorizontalSpeedFn();
  return vH0 * GROUND_MOMENTUM + GROUND_ACCEL + Constants.PHYSICS.JUMP_BOOST;
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
  const limit = Constants.MOVEMENT.MAX_AXIS_SPEED;
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
        y >= startY + Constants.BLOCK_DETECTION.WALKABLE_Y_OFFSET;
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
    expiry: now + Constants.BLOCK_DETECTION.SOLID_CACHE_TTL,
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
 * Score a candidate based on its distance to the target.
 * Piecewise-linear gradient:
 *   [0, 1)   → 0
 *   [1, 2)   → dist              (ramp 1→2)
 *   [2, 2.5] → 6 - 2*dist        (ramp 2→1)
 *   (2.5, ∞) → -1
 */
function scoreDistance(dist: number): number {
  if (dist < 1.0) return 0;
  if (dist < 2.0) return dist;
  if (dist <= 2.5) return 6.0 - 2.0 * dist;
  return -1;
}

/**
 * Check if an XZ position falls within any obstacle's XZ footprint expanded by eps.
 * Uses half-open interval so the obstacle footprint matches its grid cell exactly.
 */
function isInsideObstacleXZ(
  x: number,
  z: number,
  obstacles: AABB[],
  eps: number,
): boolean {
  for (const obs of obstacles) {
    if (
      x >= obs.minX - eps &&
      x <= obs.maxX + eps &&
      z >= obs.minZ - eps &&
      z <= obs.maxZ + eps
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a surface point is inside any obstacle's 3D AABB.
 */
function isInsideObstacle(point: Vec3, obstacles: AABB[]): boolean {
  for (const obs of obstacles) {
    if (
      point.x >= obs.minX &&
      point.x <= obs.maxX &&
      point.y >= obs.minY &&
      point.y <= obs.maxY &&
      point.z >= obs.minZ &&
      point.z <= obs.maxZ
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Check if an XZ position is a hole (no solid ground at that grid cell).
 * Uses half-open interval [hx, hx+1) x [hz, hz+1) so each hole covers exactly one 1x1 cell.
 */
function isHole(x: number, z: number, holes: [number, number][]): boolean {
  const bx = Math.floor(x);
  const bz = Math.floor(z);
  for (const [hx, hz] of holes) {
    if (bx === hx && bz === hz) return true;
  }
  return false;
}

/**
 * Check if the straight-line path from source to point is blocked by any obstacle.
 */
function isPathBlocked(source: Vec3, point: Vec3, obstacles: AABB[]): boolean {
  const dx = point.x - source.x;
  const dy = point.y - source.y;
  const dz = point.z - source.z;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-6) return false;
  const dirX = dx / length;
  const dirY = dy / length;
  const dirZ = dz / length;

  const PROXIMITY_EPS = Constants.PHYSICS.PLAYER_OFFSET;
  for (const obs of obstacles) {
    const mask = new AABB(
      obs.minX - PROXIMITY_EPS,
      obs.minY - PROXIMITY_EPS,
      obs.minZ - PROXIMITY_EPS,
      obs.maxX + PROXIMITY_EPS,
      obs.maxY + PROXIMITY_EPS,
      obs.maxZ + PROXIMITY_EPS,
    );
    const [, tFar] = mask.rayHitTFar(source, new Vec3(dirX, dirY, dirZ));
    if (tFar < 1.0) return true;
  }
  return false;
}

/**
 * Find a walkable surface point at the given (x, z) by scanning downward
 * from targetY + jumpDistance to targetY - 2.
 */
export function findWalkableSurface(
  x: number,
  z: number,
  targetY: number,
  blockAtFn: (pos: Vec3) => any,
): Vec3 | null {
  const step = Constants.MOVEMENT.STRAFE_GRID_RESOLUTION;
  const maxY = targetY + Constants.MOVEMENT.STRAFE_JUMP_DISTANCE;
  const minY = targetY - 2;
  const halfWidth = Constants.PHYSICS.PLAYER_OFFSET; // 0.3
  const height = Constants.PHYSICS.PLAYER_HEIGHT; // 1.8
  for (let y = maxY; y >= minY; y -= step) {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);
    const block = blockAtFn(new Vec3(bx, by, bz));
    if (!block || block.boundingBox === "empty") continue;

    // Compute actual top surface Y from shape
    const shape = block.shapes[0];
    const surfaceY = shape ? by + shape[Constants.SHAPE.MAX_Y] : by + 1;

    // Check that the full player AABB above the surface is clear
    // Player occupies [x-0.3, x+0.3] x [surfaceY, surfaceY+1.8] x [z-0.3, z+0.3]
    const clearMinX = Math.floor(x - halfWidth);
    const clearMaxX = Math.floor(x + halfWidth);
    const clearMinY = Math.floor(surfaceY);
    const clearMaxY = Math.floor(surfaceY + height);
    const clearMinZ = Math.floor(z - halfWidth);
    const clearMaxZ = Math.floor(z + halfWidth);

    let isClear = true;
    for (let cx = clearMinX; cx <= clearMaxX && isClear; cx++) {
      for (let cy = clearMinY; cy <= clearMaxY && isClear; cy++) {
        for (let cz = clearMinZ; cz <= clearMaxZ && isClear; cz++) {
          const aboveBlock = blockAtFn(new Vec3(cx, cy, cz));
          if (aboveBlock && aboveBlock.boundingBox !== "empty") {
            // Check actual shape overlap with the player AABB volume
            if (aboveBlock.shapes && aboveBlock.shapes.length > 0) {
              for (const s of aboveBlock.shapes) {
                if (
                  x + halfWidth > cx + s[Constants.SHAPE.MIN_X] &&
                  x - halfWidth < cx + s[Constants.SHAPE.MAX_X] &&
                  surfaceY + height > cy + s[Constants.SHAPE.MIN_Y] &&
                  surfaceY < cy + s[Constants.SHAPE.MAX_Y] &&
                  z + halfWidth > cz + s[Constants.SHAPE.MIN_Z] &&
                  z - halfWidth < cz + s[Constants.SHAPE.MAX_Z]
                ) {
                  isClear = false;
                  break;
                }
              }
            } else {
              isClear = false;
            }
          }
        }
      }
    }

    if (isClear) {
      return new Vec3(x, surfaceY, z);
    }
  }
  return null;
}

/**
 * Find the best strafe point by sampling a dense grid and scoring candidates.
 */
export function getStrafePoint(
  source: Vec3,
  _candidate: Vec3,
  target: Vec3,
  blockAtFn: (pos: Vec3) => any,
  isJumpPathClearFn: (a: Vec3, b: Vec3) => boolean,
  recentPoints: Vec3[],
  recentPointsMax: number,
  _pvpTarget?: Vec3,
  obstacles?: AABB[],
  holes?: [number, number][],
  debugLog?: (msg: string) => void,
): Vec3 | null {
  const resolution = Constants.MOVEMENT.STRAFE_GRID_RESOLUTION;
  const maxDistTarget = Constants.MOVEMENT.STRAFE_RADIUS;
  const maxDistBot = Constants.MOVEMENT.STRAFE_JUMP_DISTANCE;
  const minDistBot = Constants.MOVEMENT.STRAFE_MIN_DISTANCE;
  const minSpacing = Constants.MOVEMENT.STRAFE_MIN_SPACING;
  const dist2D = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

  const minX = target.x - maxDistTarget;
  const maxX = target.x + maxDistTarget;
  const minZ = target.z - maxDistTarget;
  const maxZ = target.z + maxDistTarget;

  /**
   * Collect all valid candidates that pass hard filters, AABB clearance,
   * and jump-path clearance.  Returns an array of { point, score } sorted
   * by descending score.
   */
  const collectCandidates = (): { point: Vec3; score: number }[] => {
    const candidates: { point: Vec3; score: number }[] = [];
    for (let x = minX; x <= maxX; x += resolution) {
      for (let z = minZ; z <= maxZ; z += resolution) {
        const surface = findWalkableSurface(x, z, target.y, blockAtFn);
        if (!surface) continue;

        const dTarget = dist2D(surface, target);
        const dBot = dist2D(surface, source);

        if (dTarget >= maxDistTarget) continue;
        if (dBot >= maxDistBot) continue;
        if (dBot < minDistBot) continue;
        if (dTarget < 0.3) continue;

        if (holes && isHole(surface.x, surface.z, holes)) continue;
        if (!isPositionClear(surface, blockAtFn)) continue;
        if (!isJumpPathClearFn(source, surface)) continue;

        const score = scoreDistance(dTarget);
        candidates.push({ point: surface, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  };

  // ── Pass 1: try with full spacing constraint ──
  const allCandidates = collectCandidates();
  const spacingBlocked = allCandidates.filter(({ point }) =>
    recentPoints.some((rp) => dist2D(point, rp) <= minSpacing),
  );
  debugLog?.(
    `getStrafePoint: candidates=${allCandidates.length} spacingBlocked=${spacingBlocked.length}/${allCandidates.length} recentPts=${recentPoints.length} topScore=${allCandidates[0]?.score.toFixed(1) ?? "n/a"}`,
  );
  for (const { point, score } of allCandidates) {
    if (recentPoints.some((rp) => dist2D(point, rp) <= minSpacing)) continue;
    recentPoints.push(point);
    if (recentPoints.length > recentPointsMax) recentPoints.shift();
    return point;
  }

  // ── Pass 2: spacing blocked every candidate — clear history and retry ──
  // When surrounded by obstacles, all candidates may be close to recent
  // points. Clearing history allows the bot to revisit any point.
  debugLog?.(
    `getStrafePoint: Pass 1 exhausted, clearing history and retrying`,
  );
  recentPoints.length = 0;
  for (const { point, score } of allCandidates) {
    recentPoints.push(point);
    if (recentPoints.length > recentPointsMax) recentPoints.shift();
    return point;
  }
  debugLog?.(
    `getStrafePoint: no candidates at all (grid=${resolution}, range=${maxDistTarget})`,
  );
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
