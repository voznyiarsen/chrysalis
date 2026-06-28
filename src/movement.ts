/**
 * @fileoverview Movement mechanics for Pupa bot.
 * Jump and collision physics — extracted from UtilsManager.
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
 * Simulate a jump trajectory and check whether it reaches the target without
 * colliding.  Uses the LCE airborne model:
 *   - Gravity: -0.08 per tick (Mob.cpp:1024)
 *   - Vertical drag: *0.98 per tick (Mob.cpp:1025)
 *   - Horizontal drag: *0.91 per tick (Mob.cpp:998)
 *   - No air acceleration without input (LCE air control comes from
 *     moveRelative() which requires active forward/strafe input each tick).
 *
 * The bot applies air steering via applyImpulse each tick, so this function
 * can model both ballistic (no steering) and guided (with steering) paths
 * depending on the `airAccel` parameter.
 */
export function isJumpPathClear(
  source: Vec3,
  target: Vec3,
  getSlipperiness: (pos: Vec3) => number,
  getCollisions: (aabb: AABB, minYThreshold: number) => AABB[],
  botEntity: { position: Vec3; velocity: Vec3 },
  momentumThreshold: number,
  airAccel = 0,
): boolean {
  const GRAVITY = Constants.PHYSICS.GRAVITY;
  const DRAG = Constants.PHYSICS.DRAG;
  const AIR_FRICTION = Constants.PHYSICS.MOMENTUM; // 0.91
  const dx_tot = target.x - source.x;
  const dz_tot = target.z - source.z;
  const len = Math.hypot(dx_tot, dz_tot) || 1e-6;
  const dirX = dx_tot / len;
  const dirZ = dz_tot / len;

  // Use getJumpVelocity for the initial velocity so the simulation matches
  // the actual impulse applied by jump logic.
  const jumpVel = getJumpVelocity(
    source,
    target,
    0,
    getSlipperiness,
    () => Math.hypot(botEntity.velocity.x, botEntity.velocity.z),
  );
  // Decompose jumpVel into magnitude along the target direction.
  // jumpVel.x = dirX * vH1, jumpVel.z = dirZ * vH1 → vH1 = jumpVel.x / dirX
  // Handle dirX=0 by using dirZ component instead.
  const vH1 =
    Math.abs(dirX) > 1e-6
      ? jumpVel.x / dirX
      : jumpVel.z / dirZ;
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
      if (!isLandingClear(currPos, getCollisions)) return false;
      return true;
    }
    // LCE airborne physics (Mob.cpp:1024-1027): gravity, drag, friction.
    // Optional air acceleration models the bot's air-steering impulse.
    currVel.y -= GRAVITY;
    currVel.y *= DRAG;
    if (currVel.y < Constants.PHYSICS.TERMINAL_VELOCITY)
      currVel.y = Constants.PHYSICS.TERMINAL_VELOCITY;
    currVel.x = currVel.x * AIR_FRICTION + dirX * airAccel;
    currVel.z = currVel.z * AIR_FRICTION + dirZ * airAccel;
    if (currPos.y < target.y - 2 && currVel.y < 0) break;
  }
  return false;
}

// ---------------------------------------------------------------------------
// getJumpVelocity
// ---------------------------------------------------------------------------

/**
 * Compute a velocity vector for a jump toward a target.
 *
 * Uses the LCE ballistic model: the initial horizontal velocity needed to
 * reach the target under LCE airborne physics (gravity=0.08, drag=0.98,
 * friction=0.91) WITHOUT further air input.  The bot can optionally apply
 * air steering (seeairAccel` parameter) to extend.
 *
 * LCE reference: Mob::jumpFromGround() (Mob.cpp:1329-1343) sets yd=0.42;
 * gravity and drag decay y velocity each tick until landing.
 *
 * @param source - Jump origin (feet position)
 * @param target - Target landing position
 * @param angleDeg - Horizontal angle offset from the direct source→target line
 * @param getSlipperiness - Callback to get block slipperiness at a position
 * @param getHorizontalSpeed - Callback to get current horizontal speed
 * @param airAccel - Air acceleration per tick (0 = ballistic, >0 = guided)
 */
export function getJumpVelocity(
  source: Vec3,
  target: Vec3,
  angleDeg: number,
  getSlipperiness: (pos: Vec3) => number,
  getHorizontalSpeed: () => number,
  airAccel = 0,
): Vec3 {
  const dx = target.x - source.x;
  const dz = target.z - source.z;
  const len = Math.hypot(dx, dz);
  const vy = Constants.PHYSICS.JUMP_VELOCITY;
  if (len === 0) return new Vec3(0, vy, 0);

  // ── Airborne tick count (Mob.cpp:1329-1343) ────────────────────────
  // Simulate Y decay: vY = (vY - 0.08) * 0.98 each tick until landing.
  let vY = Constants.PHYSICS.JUMP_VELOCITY;
  let airborneTicks = 0;
  let yPos = vY;
  while (yPos > 0) {
    vY = (vY - Constants.PHYSICS.GRAVITY) * Constants.PHYSICS.DRAG;
    yPos += vY;
    if (yPos > 0) airborneTicks++;
  }
  if (airborneTicks < 1) airborneTicks = 1;

  // ── Horizontal distance covered during airborne ticks ────────────────
  // Under LCE physics with friction=0.91 and optional air acceleration:
  //   Each tick: v = v * 0.91 + airAccel; dist += v
  //   Total distance = vH1 * sum(0.91^k, k=0..N-1) + airAccel * sum(0.91^(N-k-1), k=0..N-1)
  //   = vH1 * geomSum(0.91, N) + airAccel * geomSum(0.91, N)
  // Solving for vH1 to cover distance `len`:
  //   vH1 = (len - airAccel * geomSum) / geomSum
  const St = getSlipperiness(source);
  const AIR_FRICTION = Constants.PHYSICS.MOMENTUM; // 0.91
  const geomSum =
    (1 - Math.pow(AIR_FRICTION, airborneTicks)) / (1 - AIR_FRICTION);

  // Ground momentum at takeoff preserves some pre-existing horizontal speed.
  // LCE: friction at takeoff = block.friction * 0.91 (Mob.cpp:1000-1001).
  const GROUND_FRICTION = St * AIR_FRICTION;
  const groundGeomSum =
    (1 - Math.pow(GROUND_FRICTION, airborneTicks)) / (1 - GROUND_FRICTION);

  // Solve for initial horizontal speed vH1:
  // len = vH1 * airGeomSum + vH0 * groundGeomSum + airAccel * airGeomSum
  // where vH0 = getHorizontalSpeed() (pre-existing horizontal speed)
  const vH0 = getHorizontalSpeed();
  const calibrationFactor = Constants.PHYSICS.JUMP_CALIBRATION;
  const vH1 =
    ((len - airAccel * geomSum - vH0 * groundGeomSum) / geomSum) *
    calibrationFactor;

  // ── Apply angle rotation ────────────────────────────────────────────
  const rad = (angleDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const vx = ((dx / len) * cosA - (dz / len) * sinA) * vH1;
  const vz = ((dx / len) * sinA + (dz / len) * cosA) * vH1;
  return new Vec3(vx, vy, vz);
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
