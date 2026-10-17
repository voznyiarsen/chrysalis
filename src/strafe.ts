/**
 * @fileoverview Strafe controller — continuous orbit hops with full landing validation.
 *
 * The bot hops on every landing tick while applying a continuous orbit velocity
 * (tangent + radius pullback) every tick. The step ahead is validated with a
 * hazard-aware arc sweep (void drops, lava/water, cobwebs, cacti, fire, walls).
 */

import { Vec3 } from "vec3";
import { AABB, isPathClear } from "./collision-oracle";
import { isJumpPathClear, getGroundBelow } from "./movement";
import { Constants } from "./constants";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STRAFE_JUMP_DISTANCE = Constants.MOVEMENT.STRAFE_JUMP_DISTANCE;
const STRAFE_MIN_SPACING = Constants.MOVEMENT.STRAFE_MIN_SPACING;
const STRAFE_MIN_DISTANCE = Constants.MOVEMENT.STRAFE_MIN_DISTANCE;
const STRAFE_GRID_RESOLUTION = Constants.MOVEMENT.STRAFE_GRID_RESOLUTION;
const STRAFE_RADIUS = Constants.MOVEMENT.STRAFE_RADIUS;
const STRAFE_HAZARD_LOOKAHEAD = Constants.MOVEMENT.STRAFE_HAZARD_LOOKAHEAD;
const STRAFE_HAZARD_MAX_DROP = Constants.MOVEMENT.STRAFE_HAZARD_MAX_DROP;
const MAX_AXIS_SPEED = Constants.MOVEMENT.MAX_AXIS_SPEED;
const PLAYER_HALF_WIDTH = Constants.PHYSICS.PLAYER_OFFSET;
const PLAYER_HEIGHT = Constants.PHYSICS.PLAYER_HEIGHT;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StrafeCandidate {
  point: Vec3;
  score: number;
  distToTarget: number;
  clearance: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the yaw angle for a strafe direction.
 * direction: quarter-turns relative to the target — 0 = forward,
 * +1 = strafe left, -1 = strafe right, 2 = backward.
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

/**
 * Apply a strafe impulse to a velocity vector.
 */
export function withStrafe(
  velocity: Vec3,
  yaw: number,
  speed?: number,
  strength: number = 1.0,
): Vec3 {
  const currentSpeed = Math.hypot(velocity.x, velocity.z);
  const usedSpeed = speed !== undefined ? speed : currentSpeed;
  const oneMinusStrength = 1.0 - strength;
  const prevX = velocity.x * oneMinusStrength;
  const prevZ = velocity.z * oneMinusStrength;
  const used = usedSpeed * strength;
  return new Vec3(
    prevX - Math.sin(yaw) * used,
    velocity.y,
    prevZ + Math.cos(yaw) * used,
  );
}

// ---------------------------------------------------------------------------
// Obstacle tracking
// ---------------------------------------------------------------------------

export class ObstacleCache {
  private _obstacles: AABB[] = [];
  private _holes: [number, number][] = [];
  private _lastPos: Vec3 | null = null;
  private _lastUpdateTick = -1;

  get obstacles(): AABB[] {
    return this._obstacles;
  }

  get holes(): [number, number][] {
    return this._holes;
  }

  /**
   * Rebuild obstacle and hole maps from the block world.
   * Only re-query if the bot moved > 0.5 blocks since last update.
   */
  update(botPos: Vec3, blockAt: (pos: Vec3) => any): void {
    if (
      this._lastPos &&
      botPos.distanceTo(this._lastPos) < 0.5 &&
      this._lastUpdateTick >= 0
    ) {
      return;
    }
    this._lastPos = botPos.clone();
    this._lastUpdateTick++;

    const radius = Constants.MOVEMENT.SOLID_BLOCK_RADIUS;
    const obstacles: AABB[] = [];
    const minX = Math.floor(botPos.x - radius);
    const maxX = Math.floor(botPos.x + radius);
    const minZ = Math.floor(botPos.z - radius);
    const maxZ = Math.floor(botPos.z + radius);
    const minY = Math.floor(botPos.y);
    const maxY = Math.floor(botPos.y + PLAYER_HEIGHT);

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          const block = blockAt(new Vec3(x, y, z));
          if (block && block.boundingBox !== "empty" && block.shapes) {
            for (const shape of block.shapes) {
              obstacles.push(
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
    this._obstacles = obstacles;

    // Detect holes (cells with no walkable surface)
    const holes: [number, number][] = [];
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        let hasSurface = false;
        for (let y = maxY; y >= minY + 1; y--) {
          const block = blockAt(new Vec3(x, y, z));
          const above = blockAt(new Vec3(x, y + 1, z));
          if (
            block &&
            block.boundingBox !== "empty" &&
            (!above || above.boundingBox === "empty")
          ) {
            hasSurface = true;
            break;
          }
        }
        if (!hasSurface) {
          holes.push([x, z]);
        }
      }
    }
    this._holes = holes;
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreDistance(dist: number): number {
  if (dist < 1.0) return 0;
  if (dist < 2.0) return dist;
  if (dist <= 2.5) return 6.0 - 2.0 * dist;
  return -1;
}

function isInsideObstacleXZ(x: number, z: number, obstacles: AABB[], eps: number): boolean {
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

function isHole(x: number, z: number, holes: [number, number][]): boolean {
  const bx = Math.floor(x);
  const bz = Math.floor(z);
  for (const [hx, hz] of holes) {
    if (bx === hx && bz === hz) return true;
  }
  return false;
}

function isPathBlocked(source: Vec3, point: Vec3, obstacles: AABB[]): boolean {
  const dx = point.x - source.x;
  const dy = point.y - source.y;
  const dz = point.z - source.z;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-6) return false;
  const dirX = dx / length;
  const dirY = dy / length;
  const dirZ = dz / length;

  for (const obs of obstacles) {
    const mask = new AABB(
      obs.minX - PLAYER_HALF_WIDTH,
      obs.minY - PLAYER_HALF_WIDTH,
      obs.minZ - PLAYER_HALF_WIDTH,
      obs.maxX + PLAYER_HALF_WIDTH,
      obs.maxY + PLAYER_HALF_WIDTH,
      obs.maxZ + PLAYER_HALF_WIDTH,
    );
    const [, tFar] = mask.rayHitTFar(source, new Vec3(dirX, dirY, dirZ));
    if (tFar < 1.0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Hazard-aware arc lookahead
// ---------------------------------------------------------------------------
//
// The short ground probe validates a 0.8-block step and the swept
// volume to it, but the bot actually commits to a full hop that travels
// several blocks. To stop strafing into death traps (cliff edges, lava,
// water, cobwebs, cacti, fire, suffocating ceilings) we scan a short arc
// along the strafe heading and reject the step if any cell along it cannot
// safely support the bot's landing.

// Reuse the project's "unwanted" block list (lava, water, web, cactus)
// and add fire, which damages the bot but isn't in that list.
const HAZARD_BLOCK_NAMES: ReadonlySet<string> = new Set([
  ...Constants.BLOCK_DETECTION.UNWANTED_BLOCK_NAMES,
  "fire",
  "cobweb", // minecraft-data names it "web"; keep both for safety
]);

/** A block whose collision shape is a full 1x1x1 cube (impassable wall). */
function isFullCube(block: any): boolean {
  if (!block || !block.shapes || block.shapes.length === 0) return false;
  return block.shapes.some(
    (s: number[]) =>
      s[0] === 0 && s[1] === 0 && s[2] === 0 &&
      s[3] === 1 && s[4] === 1 && s[5] === 1,
  );
}

/** True if the block is a named movement hazard / damage source. */
function isHazardBlock(block: any): boolean {
  if (!block) return false;
  return HAZARD_BLOCK_NAMES.has(block.name);
}

/**
 * Scan a straight arc (length = STRAFE_HAZARD_LOOKAHEAD) along the
 * (dirX, dirZ) heading from `source` and return false if any cell holds
 * ground the bot cannot safely stand on:
 *   - no solid support beneath the feet within STRAFE_HAZARD_MAX_DROP
 *     -> the bot would fall and take damage
 *   - a hazard block (lava/water/cobweb/cactus/fire) at foot or head level
 *   - a full-cube obstacle at foot level (a wall the bot can't pass)
 *
 * getGroundBelow finds the first solid surface beneath each column; if the
 * drop from the bot's feet to that surface exceeds the safe threshold the
 * step is rejected before the hop is committed.
 */
function isHazardFreeArc(
  source: Vec3,
  dirX: number,
  dirZ: number,
  blockAt: (pos: Vec3) => any,
): boolean {
  const len = Math.hypot(dirX, dirZ);
  if (len < 1e-6) return true;
  const ux = dirX / len;
  const uz = dirZ / len;
  const footY = Math.floor(source.y);
  const headY = footY + 1;
  const belowY = footY - 1; // block directly under the feet (landing support)

  for (let t = 0; t <= STRAFE_HAZARD_LOOKAHEAD; t += STRAFE_GRID_RESOLUTION) {
    const x = source.x + ux * t;
    const z = source.z + uz * t;
    const bx = Math.floor(x);
    const bz = Math.floor(z);

    // Full-height solid block at foot level = an impassable wall.
    const feet = blockAt(new Vec3(bx, footY, bz));
    if (isFullCube(feet)) return false;
    if (isHazardBlock(feet)) return false;

    // Hazard floating at / above head height (lava on a ledge, fire, webs).
    const head = blockAt(new Vec3(bx, headY, bz));
    if (isHazardBlock(head)) return false;

    // The block directly beneath the feet is the landing support.
    const support = blockAt(new Vec3(bx, belowY, bz));
    if (isHazardBlock(support)) return false;

    // Solid ground must hold the landing. getGroundBelow finds the surface
    // of the first solid block beneath the column; if the drop from the
    // bot's feet exceeds the safe threshold the bot would fall.
    const groundY = getGroundBelow(new Vec3(x, source.y, z), blockAt);
    if (source.y - groundY > STRAFE_HAZARD_MAX_DROP) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Walkable surface
// ---------------------------------------------------------------------------

/**
 * Find a walkable surface Y at the given (x, z) by scanning downward.
 */
export function findWalkableSurface(
  x: number,
  z: number,
  targetY: number,
  blockAt: (pos: Vec3) => any,
): Vec3 | null {
  const step = STRAFE_GRID_RESOLUTION;
  const maxY = targetY + STRAFE_JUMP_DISTANCE;
  const minY = targetY - 2;
  const halfWidth = PLAYER_HALF_WIDTH;
  const height = PLAYER_HEIGHT;

  for (let y = maxY; y >= minY; y -= step) {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);
    const block = blockAt(new Vec3(bx, by, bz));
    if (!block || block.boundingBox === "empty") continue;

    const shape = block.shapes[0];
    // Shape layout is [minX, minY, minZ, maxX, maxY, maxZ]: the standing
    // surface is the shape's top face (maxY). Falling back to a full cube
    // keeps shapesless blocks (by + 1) consistent.
    const surfaceY = shape ? by + shape[4] : by + 1;

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
          const aboveBlock = blockAt(new Vec3(cx, cy, cz));
          if (aboveBlock && aboveBlock.boundingBox !== "empty") {
            if (aboveBlock.shapes && aboveBlock.shapes.length > 0) {
              for (const s of aboveBlock.shapes) {
                if (
                  x + halfWidth > cx + s[0] &&
                  x - halfWidth < cx + s[3] &&
                  surfaceY + height > cy + s[1] &&
                  surfaceY < cy + s[4] &&
                  z + halfWidth > cz + s[2] &&
                  z - halfWidth < cz + s[5]
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

// ---------------------------------------------------------------------------
// Main: getStrafePoint (point-to-point hop evaluator, kept for future use)
// ---------------------------------------------------------------------------

/**
 * Find the best strafe point around a target.
 *
 * Samples candidate points in a circle around the target at
 * STRAFE_JUMP_DISTANCE, checks walkability, obstacle collision,
 * and returns the best-scoring candidate.
 *
 * @param source - Bot position (feet-level)
 * @param target - PvP target position
 * @param obstacles - Current obstacle cache
 * @param holes - Current hole map
 * @param blockAt - Block lookup callback
 * @param recentPoints - Recent strafe points (for spacing)
 * @param direction - Current strafe direction (+1 / -1)
 * @returns Best strafe point, or null if none found
 */
export function getStrafePoint(
  source: Vec3,
  target: Vec3,
  obstacles: AABB[],
  holes: [number, number][],
  blockAt: (pos: Vec3) => any,
  recentPoints: Vec3[],
  direction: number = 1,
): Vec3 | null {
  const candidates: StrafeCandidate[] = [];
  const yaw = getStrafeYaw(source, target, direction);
  const candidate = source.offset(
    -Math.sin(yaw) * STRAFE_JUMP_DISTANCE,
    0,
    Math.cos(yaw) * STRAFE_JUMP_DISTANCE,
  );

  const walkable = findWalkableSurface(
    candidate.x,
    candidate.z,
    candidate.y,
    blockAt,
  );
  if (!walkable) return null;

  if (isInsideObstacle(walkable, obstacles)) return null;
  if (isHole(walkable.x, walkable.z, holes)) return null;
  if (isPathBlocked(source, walkable, obstacles)) return null;

  const distToTarget = Math.hypot(
    walkable.x - target.x,
    walkable.z - target.z,
  );
  const distToSource = Math.hypot(
    walkable.x - source.x,
    walkable.z - source.z,
  );

  if (distToSource < STRAFE_MIN_DISTANCE) return null;

  // Check spacing against recent points
  let tooClose = false;
  for (const rp of recentPoints) {
    if (Math.hypot(walkable.x - rp.x, walkable.z - rp.z) < STRAFE_MIN_SPACING) {
      tooClose = true;
      break;
    }
  }
  if (tooClose) return null;

  const score = scoreDistance(distToTarget);
  candidates.push({
    point: walkable,
    score,
    distToTarget,
    clearance: 0,
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].point;
}

// ---------------------------------------------------------------------------
// StrafeController — high-level strafe decision (continuous orbit)
// ---------------------------------------------------------------------------

export class StrafeController {
  private _direction: number = 1;
  private _strafePoint: Vec3 | null = null;
  private _obstacleCache: ObstacleCache;
  private _recentPoints: Vec3[] = [];
  private _maxRecent: number;

  constructor(maxRecent: number = Constants.MOVEMENT.STRAFE_HISTORY_SIZE) {
    this._obstacleCache = new ObstacleCache();
    this._maxRecent = maxRecent;
  }

  get direction(): number {
    return this._direction;
  }

  get strafePoint(): Vec3 | null {
    return this._strafePoint;
  }

  /**
   * Compute and apply a strafe jump toward the target.
   * Returns the strafe point if a jump was applied, null otherwise.
   * (Kept for potential future use; not wired to PVPManager.)
   */
  computeStrafe(
    source: Vec3,
    target: Vec3,
    blockAt: (pos: Vec3) => any,
    isOnGround: boolean,
    isCollidedHorizontally: boolean,
  ): Vec3 | null {
    // Flip direction on collision
    if (isCollidedHorizontally) {
      this._direction = -this._direction;
      this._strafePoint = null;
    }

    this._obstacleCache.update(source, blockAt);

    const distToTarget = Math.hypot(
      source.x - target.x,
      source.z - target.z,
    );

    if (distToTarget > STRAFE_RADIUS) {
      this._strafePoint = null;
      return null;
    }

    if (isOnGround) {
      // Validate existing strafe point
      if (this._strafePoint) {
        const distToPoint = Math.hypot(
          source.x - this._strafePoint.x,
          source.z - this._strafePoint.z,
        );
        if (distToPoint > STRAFE_RADIUS + 1) {
          this._strafePoint = null;
        } else {
          const blocked = !isPathClear(source, this._strafePoint, blockAt);
          if (blocked || distToPoint < 0.2) {
            this._strafePoint = null;
          }
        }
      }

      // Find new strafe point
      if (!this._strafePoint) {
        const directions = [this._direction, -this._direction, 0, 2];
        for (const dir of directions) {
          this._strafePoint = getStrafePoint(
            source,
            target,
            this._obstacleCache.obstacles,
            this._obstacleCache.holes,
            blockAt,
            this._recentPoints,
            dir,
          );
          if (this._strafePoint) {
            this._direction = dir;
            break;
          }
        }
      }

      if (this._strafePoint) {
        // Record recent point
        this._recentPoints.push(this._strafePoint.clone());
        if (this._recentPoints.length > this._maxRecent) {
          this._recentPoints.shift();
        }
      }
    }

    return this._strafePoint;
  }

  /**
   * Continuous lateral steering for circling a nearby target (combat).
   *
   * The step direction is re-aimed from the bot's current position every tick.
   * A pure tangent step of length s widens the orbit to sqrt(r^2 + s^2), so the
   * tangent blend gets an exact pullback that lands the step back on the
   * STRAFE_RADIUS circle — including after a hop has pushed the bot in
   * or out. While grounded each step ahead is validated with the
   * walkable-surface scan and a swept AABB test; a blocked side flips
   * the orbit direction. Airborne ticks (onGround=false) skip that probe
   * — the jump arc is already committed — and only hold the circle. The
   * lateral velocity is blended with the current velocity (withStrafe)
   * so direction changes carry momentum instead of snapping.
   *
   * @param source - Bot position (feet-level)
   * @param target - PvP target position
   * @param velocity - Current bot velocity
   * @param blockAt - Block lookup callback
   * @param isCollidedHorizontally - Whether the bot pushed into a wall
   * @param onGround - Whether the bot is grounded (probes the step ahead)
   * @returns Blended velocity with the strafe applied, or null to hold
   */
  steerAroundTarget(
    source: Vec3,
    target: Vec3,
    velocity: Vec3,
    blockAt: (pos: Vec3) => any,
    isCollidedHorizontally: boolean,
    onGround: boolean = true,
  ): Vec3 | null {
    if (isCollidedHorizontally) {
      this._direction = -this._direction;
    }

    const radiusDx = source.x - target.x;
    const radiusDz = source.z - target.z;
    const radius = Math.hypot(radiusDx, radiusDz);
    // Beyond melee reach the caller hands movement back to the
    // pathfinder; steering here would just fight the follow goal. In
    // between, steer back toward the orbit.
    if (radius > Constants.COMBAT.ATTACK_RANGE) return null;
    // Too close to orbit meaningfully; hold and attack from point blank.
    if (radius < STRAFE_MIN_DISTANCE) return null;

    const speed = Constants.MOVEMENT.STRAFE_SPEED;
    const strength = Constants.MOVEMENT.STRAFE_STRENGTH;

    // Try the preferred side first, then the opposite one.
    for (let attempt = 0; attempt < 2; attempt++) {
      const yaw = getStrafeYaw(source, target, this._direction);
      const blended = withStrafe(velocity, yaw, speed, strength);

      // Pull the step back onto the orbit circle: a step whose tangential
      // part is s_t and radial part is b_r must be corrected inward by
      // p = r + b_r - sqrt(R^2 - s_t^2) to land at radius R again.
      const ux = radiusDx / radius;
      const uz = radiusDz / radius;
      const step = Math.hypot(blended.x, blended.z);
      const radial = blended.x * ux + blended.z * uz;
      const tangential = Math.sqrt(Math.max(step * step - radial * radial, 0));
      const pullback = Math.max(
        -step,
        Math.min(
          step,
          radius +
            radial -
            Math.sqrt(
              Math.max(
                STRAFE_RADIUS * STRAFE_RADIUS - tangential * tangential,
                0,
              ),
            ),
        ),
      );
      const dirX = blended.x - ux * pullback;
      const dirZ = blended.z - uz * pullback;

      const clear = !onGround || this._isStepClear(source, dirX, dirZ, blockAt);
      if (clear) {
        return new Vec3(dirX, blended.y, dirZ);
      }

      this._direction = -this._direction;
    }

    return null;
  }

  /**
   * Validate the step ahead along a movement direction: a walkable
   * surface at the current level, reachable without clipping terrain.
   * Endpoints are lifted a hair above the floor so the feet-level sweep
   * does not graze the ground block under floating-point noise.
   *
   * Also runs a hazard-aware arc lookahead (STRAFE_HAZARD_LOOKAHEAD blocks)
   * to reject steps that carry the bot over cliffs into lava/water/cobwebs
   * or off lethal drops.
   */
  private _isStepClear(
    source: Vec3,
    dirX: number,
    dirZ: number,
    blockAt: (pos: Vec3) => any,
  ): boolean {
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-6) return false;

    const probe = source.offset(
      (dirX / len) * Constants.MOVEMENT.STRAFE_PROBE_DISTANCE,
      0,
      (dirZ / len) * Constants.MOVEMENT.STRAFE_PROBE_DISTANCE,
    );

    const walkable = findWalkableSurface(probe.x, probe.z, source.y, blockAt);
    if (!walkable) return false;
    if (Math.abs(walkable.y - source.y) > 0.5) return false;
    if (!isPathClear(source.offset(0, 0.01, 0), walkable.offset(0, 0.01, 0), blockAt)) {
      return false;
    }

    // Hazard-aware arc lookahead: reject steps that carry the bot over a
    // cliff into lava/water, through a cobweb, or off a lethal drop. This
    // covers the full hop distance rather than the 0.8-block probe above.
    if (!isHazardFreeArc(source, dirX, dirZ, blockAt)) return false;

    return true;
  }

  reset(): void {
    this._direction = 1;
    this._strafePoint = null;
    this._recentPoints = [];
  }
}