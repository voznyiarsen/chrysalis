import { Vec3 } from "vec3";
import { Constants } from "./constants";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import {
  getProjectilePitch,
  getProjectileOffset,
  isProjectilePathClear,
  getBestPearlTrajectory,
  type PearlTrajectoryResult,
} from "./projectile";
import {
  isJumpPathClear,
  getJumpVelocity,
  getStrafePoint,
  getStrafeYaw,
  getHorizontalSpeed,
  getGroundJumpSpeed,
  getFlatVelocity,
  getCollisions,
  getSolidBlocks,
  clearSolidCache,
  getGroundBelow,
  getFallDamage,
  isPositionClear,
} from "./movement";

/**
 * @fileoverview Utility functions for Pupa bot.
 * Provides AABB collision detection, physics simulation, projectile prediction,
 * and movement helpers.
 */

const EPS = 1.0e-7;

/**
 * Minimal AABB class for Minecraft physics simulation
 */
export class AABB {
  constructor(
    public minX: number,
    public minY: number,
    public minZ: number,
    public maxX: number,
    public maxY: number,
    public maxZ: number,
  ) {}

  /**
   * Translate the AABB by (dx, dy, dz), returning a new AABB.
   */
  offset(dx: number, dy: number, dz: number): AABB {
    return new AABB(
      this.minX + dx,
      this.minY + dy,
      this.minZ + dz,
      this.maxX + dx,
      this.maxY + dy,
      this.maxZ + dz,
    );
  }

  /**
   * Create a new AABB that encloses this AABB moved by (dx, dy, dz).
   * The result covers both the original and the swept volume.
   */
  extend(dx: number, dy: number, dz: number): AABB {
    let minX = this.minX,
      minY = this.minY,
      minZ = this.minZ;
    let maxX = this.maxX,
      maxY = this.maxY,
      maxZ = this.maxZ;
    if (dx < 0) minX += dx;
    if (dx > 0) maxX += dx;
    if (dy < 0) minY += dy;
    if (dy > 0) maxY += dy;
    if (dz < 0) minZ += dz;
    if (dz > 0) maxZ += dz;
    return new AABB(minX, minY, minZ, maxX, maxY, maxZ);
  }

  /**
   * Expand the AABB outward by a uniform margin on all sides.
   */
  expand(m: number): AABB {
    return new AABB(
      this.minX - m,
      this.minY - m,
      this.minZ - m,
      this.maxX + m,
      this.maxY + m,
      this.maxZ + m,
    );
  }

  /**
   * Check whether a ray (origin, direction) intersects this AABB.
   * Uses the slab method. Direction need not be normalized.
   * Returns true if the ray hits the box at t > 0 (forward intersection).
   */
  /**
   * Ray-AABB intersection (slab method).
   * Returns the parametric distance t_near to the first forward hit,
   * or Infinity if the ray does not intersect the box.
   * A point is blocked only if t_near < distance(origin, point).
   */
  rayHitT(origin: Vec3, dir: Vec3): number {
    let tmin = -Infinity;
    let tmax = Infinity;

    if (Math.abs(dir.x) < EPS) {
      if (origin.x < this.minX || origin.x > this.maxX) return Infinity;
    } else {
      const t1 = (this.minX - origin.x) / dir.x;
      const t2 = (this.maxX - origin.x) / dir.x;
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
    }

    if (Math.abs(dir.y) < EPS) {
      if (origin.y < this.minY || origin.y > this.maxY) return Infinity;
    } else {
      const t1 = (this.minY - origin.y) / dir.y;
      const t2 = (this.maxY - origin.y) / dir.y;
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
    }

    if (Math.abs(dir.z) < EPS) {
      if (origin.z < this.minZ || origin.z > this.maxZ) return Infinity;
    } else {
      const t1 = (this.minZ - origin.z) / dir.z;
      const t2 = (this.maxZ - origin.z) / dir.z;
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
    }

    const tNear = Math.max(tmin, 0);
    if (tmax >= tNear + EPS) return tNear;
    return Infinity;
  }

  /**
   * Check whether a ray (origin, direction) intersects this AABB
   * at any forward distance. Convenience wrapper for rayHitT.
   */
  intersectsRay(origin: Vec3, dir: Vec3): boolean {
    return this.rayHitT(origin, dir) < Infinity;
  }

  /**
   * Ray-AABB intersection returning both t_near and t_far.
   * Returns [Infinity, Infinity] if no intersection.
   */
  rayHitTFar(origin: Vec3, dir: Vec3): [number, number] {
    let tmin = -Infinity;
    let tmax = Infinity;
    if (Math.abs(dir.x) < EPS) {
      if (origin.x < this.minX || origin.x > this.maxX)
        return [Infinity, Infinity];
    } else {
      const t1 = (this.minX - origin.x) / dir.x;
      const t2 = (this.maxX - origin.x) / dir.x;
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
    }
    if (Math.abs(dir.y) < EPS) {
      if (origin.y < this.minY || origin.y > this.maxY)
        return [Infinity, Infinity];
    } else {
      const t1 = (this.minY - origin.y) / dir.y;
      const t2 = (this.maxY - origin.y) / dir.y;
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
    }
    if (Math.abs(dir.z) < EPS) {
      if (origin.z < this.minZ || origin.z > this.maxZ)
        return [Infinity, Infinity];
    } else {
      const t1 = (this.minZ - origin.z) / dir.z;
      const t2 = (this.maxZ - origin.z) / dir.z;
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
    }
    const tNear = Math.max(tmin, 0);
    if (tmax >= tNear + EPS) return [tNear, tmax];
    return [Infinity, Infinity];
  }

  /**
   * Check whether this AABB intersects another.
   * Uses strict inequality: touching a face is not a collision.
   */
  intersects(other: AABB): boolean {
    return (
      this.maxX > other.minX &&
      this.minX < other.maxX &&
      this.maxY > other.minY &&
      this.minY < other.maxY &&
      this.maxZ > other.minZ &&
      this.minZ < other.maxZ
    );
  }

  /**
   * Compute the maximum X displacement before colliding with `other`.
   * Returns dx unchanged if no collision.
   */
  calculateXOffset(other: AABB, dx: number, margin = 0): number {
    if (other.maxY <= this.minY - margin || other.minY >= this.maxY + margin)
      return dx;
    if (other.maxZ <= this.minZ - margin || other.minZ >= this.maxZ + margin)
      return dx;
    if (dx > 0 && other.minX >= this.maxX) {
      const d = other.minX - this.maxX;
      if (d < dx) dx = d;
    } else if (dx < 0 && other.maxX <= this.minX) {
      const d = other.maxX - this.minX;
      if (d > dx) dx = d;
    }
    return dx;
  }

  /**
   * Compute the maximum Y displacement before colliding with `other`.
   * Returns dy unchanged if no collision.
   */
  calculateYOffset(other: AABB, dy: number, margin = 0): number {
    if (other.maxX <= this.minX - margin || other.minX >= this.maxX + margin)
      return dy;
    if (other.maxZ <= this.minZ - margin || other.minZ >= this.maxZ + margin)
      return dy;
    if (dy > 0 && other.minY >= this.maxY) {
      const d = other.minY - this.maxY;
      if (d < dy) dy = d;
    } else if (dy < 0 && other.maxY <= this.minY) {
      const d = other.maxY - this.minY;
      if (d > dy) dy = d;
    }
    return dy;
  }

  /**
   * Compute the maximum Z displacement before colliding with `other`.
   * Returns dz unchanged if no collision.
   */
  calculateZOffset(other: AABB, dz: number, margin = 0): number {
    if (other.maxX <= this.minX - margin || other.minX >= this.maxX + margin)
      return dz;
    if (other.maxY <= this.minY - margin || other.minY >= this.maxY + margin)
      return dz;
    if (dz > 0 && other.minZ >= this.maxZ) {
      const d = other.minZ - this.maxZ;
      if (d < dz) dz = d;
    } else if (dz < 0 && other.maxZ <= this.minZ) {
      const d = other.maxZ - this.minZ;
      if (d > dz) dz = d;
    }
    return dz;
  }

  /**
   * Compute time of impact between this moving AABB and a static AABB.
   *
   * Uses the slab method: on each axis, compute the entry/exit times
   * of this box's center relative to the expanded static box.
   *
   * @param velocity - Motion vector for this tick
   * @param block    - Static AABB to test against
   * @returns Time of impact in [0, 1], or null if no collision this tick.
   *          Returns 0 if already overlapping at start.
   */
  sweptTOI(velocity: Vec3, block: AABB): number | null {
    const thisCx = (this.minX + this.maxX) / 2;
    const thisCy = (this.minY + this.maxY) / 2;
    const thisCz = (this.minZ + this.maxZ) / 2;
    const thisHx = (this.maxX - this.minX) / 2;
    const thisHy = (this.maxY - this.minY) / 2;
    const thisHz = (this.maxZ - this.minZ) / 2;

    const blkCx = (block.minX + block.maxX) / 2;
    const blkCy = (block.minY + block.maxY) / 2;
    const blkCz = (block.minZ + block.maxZ) / 2;
    const blkHx = (block.maxX - block.minX) / 2;
    const blkHy = (block.maxY - block.minY) / 2;
    const blkHz = (block.maxZ - block.minZ) / 2;

    const dx = thisCx - blkCx;
    const dy = thisCy - blkCy;
    const dz = thisCz - blkCz;
    const hx = thisHx + blkHx;
    const hy = thisHy + blkHy;
    const hz = thisHz + blkHz;

    let tEntry = 0;
    let tExit = 1;

    // X axis
    if (Math.abs(velocity.x) < 1e-9) {
      if (Math.abs(dx) >= hx) return null;
    } else {
      let t1 = (-hx - dx) / velocity.x;
      let t2 = (hx - dx) / velocity.x;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tEntry = Math.max(tEntry, t1);
      tExit = Math.min(tExit, t2);
      if (tEntry > tExit) return null;
    }

    // Y axis
    if (Math.abs(velocity.y) < 1e-9) {
      if (Math.abs(dy) >= hy) return null;
    } else {
      let t1 = (-hy - dy) / velocity.y;
      let t2 = (hy - dy) / velocity.y;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tEntry = Math.max(tEntry, t1);
      tExit = Math.min(tExit, t2);
      if (tEntry > tExit) return null;
    }

    // Z axis
    if (Math.abs(velocity.z) < 1e-9) {
      if (Math.abs(dz) >= hz) return null;
    } else {
      let t1 = (-hz - dz) / velocity.z;
      let t2 = (hz - dz) / velocity.z;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tEntry = Math.max(tEntry, t1);
      tExit = Math.min(tExit, t2);
      if (tEntry > tExit) return null;
    }

    if (tEntry < 0) return 0;
    if (tEntry > 1) return null;
    return tEntry;
  }
}

interface SimulateTickState {
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
}

interface SimulateInputs {
  forward: number;
  strafe: number;
  jumping: boolean;
  sprinting: boolean;
  sneaking: boolean;
}

interface WithStrafeOptions {
  yaw: number;
  speed?: number;
  strength?: number;
}

export class UtilsManager {
  bot: Bot;
  isNewSlipperiness: boolean;
  isNewCollision: boolean;
  isNewThreshold: boolean;
  momentumThreshold: number;
  applyEffects: boolean;
  _solidCacheMaxSize: number;
  _solidCache: Map<string, { solids: Vec3[]; expiry: number }>;
  recentPoints: Vec3[];
  recentPointsMax: number;
  liquidBlockIds: Set<number>;
  lastImpulseTick?: number;
  logger: any;
  _obstacles: AABB[];
  _holes: [number, number][];

  constructor(bot: Bot) {
    this.bot = bot;
    this.logger = bot.__logger || console;

    if (typeof this.bot.chat === "function") {
      this.bot._originalChat = this.bot.chat.bind(this.bot);
    }
    this.isNewSlipperiness = this._compareVersion(bot.version, "1.15") >= 0;
    this.isNewCollision = this._compareVersion(bot.version, "1.14") >= 0;
    this.isNewThreshold = this._compareVersion(bot.version, "1.9") >= 0;
    this.momentumThreshold = this.isNewThreshold
      ? Constants.PHYSICS.MOMENTUM_THRESHOLD_1_9
      : Constants.PHYSICS.MOMENTUM_THRESHOLD_1_8;
    this.applyEffects = false;
    this._solidCacheMaxSize = 16;
    this._solidCache = new Map();
    this.recentPoints = [];
    this.recentPointsMax = Constants.MOVEMENT.STRAFE_HISTORY_SIZE;
    this.liquidBlockIds = new Set();
    this._obstacles = [];
    this._initializeLiquidCache();
  }

  private _compareVersion(v1: string, v2: string): number {
    const a = v1.split(".").map(Number);
    const b = v2.split(".").map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) > (b[i] || 0)) return 1;
      if ((a[i] || 0) < (b[i] || 0)) return -1;
    }
    return 0;
  }

  private _initializeLiquidCache(): void {
    const names = Constants.BLOCK_DETECTION.LIQUID_BLOCK_NAMES;
    const registry = this.bot.registry;
    for (const name of names) {
      const entry = registry.blocksByName?.[name];
      if (entry?.id !== undefined) this.liquidBlockIds.add(entry.id);
    }
  }

  getSlipperiness(pos: Vec3): number {
    const entity = this.bot.entity as any;
    if (!entity.onGround) return Constants.PHYSICS.SLIPPERINESS.AIRBORNE;
    const offset = this.isNewSlipperiness ? 0.5 : 1.0;
    const blockPos = pos.offset(0, -offset, 0);
    const block = this.bot.blockAt(blockPos);
    if (!block) return Constants.PHYSICS.SLIPPERINESS.DEFAULT;
    switch (block.name) {
      case "slime_block":
        return Constants.PHYSICS.SLIPPERINESS.SLIME;
      case "ice":
      case "packed_ice":
        return Constants.PHYSICS.SLIPPERINESS.ICE;
      case "blue_ice":
        return Constants.PHYSICS.SLIPPERINESS.BLUE_ICE;
      default:
        return Constants.PHYSICS.SLIPPERINESS.DEFAULT;
    }
  }

  getEffectsMultiplier(): number {
    const effects = (this.bot.entity as any).effects as Record<
      string,
      { amplifier: number } | undefined
    >;
    const speedAmp = effects["1"];
    const slowAmp = effects["2"];
    const speedLevel = speedAmp ? speedAmp.amplifier + 1 : 0;
    const slowLevel = slowAmp ? slowAmp.amplifier + 1 : 0;
    const multiplier = (1 + 0.2 * speedLevel) * (1 - 0.15 * slowLevel);
    return Math.max(0, multiplier);
  }

  simulateTick(
    state: SimulateTickState,
    inputs: SimulateInputs,
  ): SimulateTickState {
    let { pos, vel, onGround } = state;
    const { forward, strafe, jumping, sprinting, sneaking } = inputs;
    if (Math.abs(vel.x) < this.momentumThreshold) vel.x = 0;
    if (Math.abs(vel.y) < this.momentumThreshold) vel.y = 0;
    if (Math.abs(vel.z) < this.momentumThreshold) vel.z = 0;
    const St = this.getSlipperiness(pos);
    const Mt_base = sprinting ? 1.3 : sneaking ? 0.3 : 1.0;
    const Mt = Mt_base * Constants.PHYSICS.ACCELERATION.STRAFE_MULTIPLIER;
    const Et = this.applyEffects ? this.getEffectsMultiplier() : 1.0;
    let moveFactor = onGround
      ? 0.1 * Mt * Et * Math.pow(0.6 / St, 3)
      : Constants.PHYSICS.ACCELERATION.AIR * Mt_base;
    const entity = this.bot.entity as any;
    const yaw = entity.yaw;
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    let inputMag = Math.hypot(forward, strafe);
    if (inputMag >= 1e-4) {
      if (inputMag < 1.0) inputMag = 1.0;
      const f = moveFactor / inputMag;
      const s = strafe * f;
      const fw = forward * f;
      vel.x += s * cosYaw - fw * sinYaw;
      vel.z += fw * cosYaw + s * sinYaw;
    }
    if (onGround && jumping) {
      vel.y = Constants.PHYSICS.JUMP_VELOCITY;
      if (sprinting) {
        vel.x += -sinYaw * Constants.PHYSICS.JUMP_BOOST;
        vel.z += cosYaw * Constants.PHYSICS.JUMP_BOOST;
      }
    }
    const nextPos = pos.plus(vel);
    vel.y -= Constants.PHYSICS.GRAVITY;
    vel.y *= Constants.PHYSICS.DRAG;
    if (vel.y < Constants.PHYSICS.TERMINAL_VELOCITY)
      vel.y = Constants.PHYSICS.TERMINAL_VELOCITY;
    const drag = onGround
      ? St * Constants.PHYSICS.MOMENTUM
      : Constants.PHYSICS.MOMENTUM;
    vel.x *= drag;
    vel.z *= drag;
    return { pos: nextPos, vel, onGround: entity.onGround };
  }

  applyImpulse(
    impulse: Vec3,
    mode: "add" | "set" = "add",
    force = false,
  ): void {
    const currentTick = (this.bot.time as any).age;
    if (!force && this.lastImpulseTick === currentTick) return;
    const entity = this.bot.entity as any;
    if (mode === "add") {
      entity.velocity.add(impulse);
    } else {
      entity.velocity.set(impulse.x, impulse.y, impulse.z);
    }
    this.lastImpulseTick = currentTick;
  }

  // ---------------------------------------------------------------------------
  // Projectile physics — delegated to projectile.ts
  // ---------------------------------------------------------------------------

  getProjectilePitch(
    source: Vec3,
    target: Vec3,
    v: number,
    g: number,
    drag = 1,
  ): number[] {
    return getProjectilePitch(source, target, v, g, drag);
  }

  getProjectileOffset(
    source: Vec3,
    target: Vec3,
    v: number,
    g: number,
    drag = 1,
    arcType: "low" | "high" = "low",
  ): number {
    return getProjectileOffset(source, target, v, g, drag, arcType);
  }

  isProjectilePathClear(
    source: Vec3,
    target: Vec3,
    v: number,
    g: number,
    p: number,
    drag = 1,
  ): boolean {
    return isProjectilePathClear(
      source,
      target,
      v,
      g,
      p,
      drag,
      (pos: Vec3) => this.bot.blockAt(pos),
      Object.values(this.bot.entities),
    );
  }

  getBestPearlTrajectory(
    source: Vec3,
    target: Vec3,
    velocity: number = Constants.COMBAT.PROJECTILES.ender_pearl.VELOCITY,
    gravity: number = Constants.COMBAT.PROJECTILES.ender_pearl.GRAVITY,
    drag: number = Constants.COMBAT.PROJECTILES.ender_pearl.DRAG,
    toleranceRadius: number = 1.5,
    sampleStep: number = 1.0,
  ): PearlTrajectoryResult | null {
    return getBestPearlTrajectory(
      source,
      target,
      velocity,
      gravity,
      drag,
      toleranceRadius,
      sampleStep,
      (pos: Vec3) => this.bot.blockAt(pos),
      Object.values(this.bot.entities),
    );
  }

  // ---------------------------------------------------------------------------
  // Movement physics — delegated to movement.ts
  // ---------------------------------------------------------------------------

  isJumpPathClear(source: Vec3, target: Vec3): boolean {
    return isJumpPathClear(
      source,
      target,
      (pos: Vec3) => this.getSlipperiness(pos),
      (aabb: AABB, minY: number) => this.getCollisions(aabb, minY),
      this.bot.entity as any,
      this.momentumThreshold,
    );
  }

  getJumpVelocity(
    source: Vec3,
    target: Vec3,
    angleDeg = 0,
    isStrafe = false,
  ): Vec3 {
    return getJumpVelocity(
      source,
      target,
      angleDeg,
      isStrafe,
      (pos: Vec3) => this.getSlipperiness(pos),
      () => this.getHorizontalSpeed(),
    );
  }

  getStrafePoint(
    source: Vec3,
    candidate: Vec3,
    pvpTarget?: Vec3,
    debugLog?: (msg: string) => void,
  ): Vec3 | null {
    return getStrafePoint(
      source,
      candidate,
      pvpTarget || (this.bot.entity as any).position,
      (pos: Vec3) => this.bot.blockAt(pos),
      (a: Vec3, b: Vec3) => this.isJumpPathClear(a, b),
      this.recentPoints,
      this.recentPointsMax,
      undefined,
      this._obstacles,
      this._holes,
      debugLog,
    );
  }

  getStrafeYaw(playerPos: Vec3, targetPos: Vec3, direction: number): number {
    return getStrafeYaw(playerPos, targetPos, direction);
  }

  getHorizontalSpeed(): number {
    return getHorizontalSpeed(this.bot.entity as any);
  }

  getGroundJumpSpeed(source: Vec3): number {
    return getGroundJumpSpeed(
      source,
      (pos: Vec3) => this.getSlipperiness(pos),
      () => this.getHorizontalSpeed(),
    );
  }

  getFlatVelocity(
    source: Vec3,
    target: Vec3,
    angleDeg = 0,
    speed: number = Constants.MOVEMENT.FLAT_SPEED,
    vy = 0,
  ): Vec3 {
    return getFlatVelocity(source, target, angleDeg, speed, vy);
  }

  getCollisions(aabb: AABB, minYThreshold = -Infinity): AABB[] {
    return getCollisions(aabb, minYThreshold, (pos: Vec3) =>
      this.bot.blockAt(pos),
    );
  }

  getSolidBlocks(source: Vec3): Vec3[] {
    return getSolidBlocks(
      source,
      Constants.MOVEMENT.SOLID_BLOCK_RADIUS,
      (pos: Vec3) => this.bot.blockAt(pos),
      (this.bot.entity as any).width,
      this._solidCache,
      this._solidCacheMaxSize,
    );
  }

  clearSolidCache(): void {
    clearSolidCache(this._solidCache);
  }

  /**
   * Build obstacle AABBs from blocks surrounding the bot.
   * Called each tick by CombatManager.doStrafe so that strafe points
   * behind walls / inside blocks are rejected via raycast.
   */
  updateObstacles(): void {
    const entity = this.bot.entity as any;
    const pos = entity.position;
    const radius = Constants.MOVEMENT.SOLID_BLOCK_RADIUS;
    const obstacles: AABB[] = [];
    const minX = Math.floor(pos.x - radius);
    const maxX = Math.floor(pos.x + radius);
    const minZ = Math.floor(pos.z - radius);
    const maxZ = Math.floor(pos.z + radius);
    const minY = Math.floor(pos.y);
    const maxY = Math.floor(pos.y + Constants.PHYSICS.PLAYER_HEIGHT);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          const block = this.bot.blockAt(new Vec3(x, y, z));
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

    // Detect holes: XZ grid cells within the search radius that have no
    // walkable surface (no solid block with empty space above it).
    const holes: [number, number][] = [];
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        let hasSurface = false;
        for (
          let y = maxY;
          y >= minY + Constants.BLOCK_DETECTION.WALKABLE_Y_OFFSET;
          y--
        ) {
          const block = this.bot.blockAt(new Vec3(x, y, z));
          const above = this.bot.blockAt(new Vec3(x, y + 1, z));
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

  getGroundBelow(): number {
    return getGroundBelow(this.bot.entity.position, (pos: Vec3) =>
      this.bot.blockAt(pos),
    );
  }

  getFallDamage(distance: number): number {
    return getFallDamage(distance);
  }

  /**
   * Check whether the bot's full AABB (0.6×1.8×0.6) fits at the given
   * position without intersecting any solid block. Uses strict-inequality
   * overlap (touching a face is not a collision).
   * @param pos - The position (feet-level) to check
   * @returns true if the position is clear of solid blocks
   */
  isPositionClear(pos: Vec3): boolean {
    return isPositionClear(pos, (p: Vec3) => this.bot.blockAt(p));
  }

  // ---------------------------------------------------------------------------
  // Production testable action: jumpViaOffset
  // ---------------------------------------------------------------------------

  async jumpViaOffset(offset?: Vec3): Promise<number> {
    const targetPos = offset
      ? this.bot.entity.position.plus(offset)
      : this.bot.entity.position.offset(0, 0, 0);
    const jumpSource = this.bot.entity.position.clone();
    const impulse = this.getJumpVelocity(jumpSource, targetPos);
    if (!impulse) return -1;
    const original = this.applyImpulse.bind(this);
    const startTick = (this.bot.time as any).age;
    this.applyImpulse = (imp: Vec3, mode = "add", force = false) => {
      const r = original(imp, mode, force);
      if ((this.bot.time as any).age - startTick >= 40) {
        this.applyImpulse = original;
      }
      return r;
    };
    this.applyImpulse(impulse, "set", true);
    await this.bot.waitForTicks!(1);
    await this._waitUntilSettled();
    const finalPos = this.bot.entity.position;
    return Math.hypot(targetPos.x - finalPos.x, targetPos.z - finalPos.z);
  }

  private async _waitUntilSettled(): Promise<void> {
    while (
      !this.bot.entity.onGround ||
      this.bot.entity.velocity.x !== 0 ||
      this.bot.entity.velocity.z !== 0
    ) {
      await this.bot.waitForTicks!(1);
    }
  }

  // ---------------------------------------------------------------------------
  // Block / entity utilities (retained)
  // ---------------------------------------------------------------------------

  isPointInBlock(
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

  getEntityHitbox(entity: Entity): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  } {
    const entityAny = entity as any;
    let width = entityAny.width;
    let height = entityAny.height;
    if (entity.type === "player") {
      width = Constants.PHYSICS.PLAYER_WIDTH;
      height = Constants.PHYSICS.PLAYER_HEIGHT;
    }
    const halfWidth = width / 2;
    return {
      minX: entity.position.x - halfWidth,
      maxX: entity.position.x + halfWidth,
      minY: entity.position.y,
      maxY: entity.position.y + height,
      minZ: entity.position.z - halfWidth,
      maxZ: entity.position.z + halfWidth,
    };
  }

  isInCylinder(
    source: Vec3,
    point: Vec3,
    radius: number,
    height: number,
  ): boolean {
    const dy = point.y - source.y;
    if (dy < 0 || dy > height) return false;
    const dx = point.x - source.x;
    const dz = point.z - source.z;
    return dx * dx + dz * dz <= radius * radius;
  }

  isInUnwanted(
    source: Vec3,
    height: number = Constants.GEOMETRY.UNWANTED_HEIGHT,
    offset: number = Constants.GEOMETRY.UNWANTED_OFFSET,
  ): boolean {
    const unwantedBlocks = Constants.BLOCK_DETECTION.UNWANTED_BLOCK_NAMES;
    const layerHeight = height / Constants.GEOMETRY.UNWANTED_LAYERS;
    const offsets = [offset, offset + Constants.PHYSICS.COLLISION_OFFSET];
    for (const off of offsets) {
      for (let layer = 0; layer < Constants.GEOMETRY.UNWANTED_LAYERS; layer++) {
        const y = source.y + layer * layerHeight;
        const points = [
          new Vec3(source.x + off, y, source.z + off),
          new Vec3(source.x + off, y, source.z - off),
          new Vec3(source.x - off, y, source.z + off),
          new Vec3(source.x - off, y, source.z - off),
        ];
        for (const p of points) {
          const block = this.bot.blockAt(p);
          if (
            block &&
            (unwantedBlocks as readonly string[]).includes(block.name)
          )
            return true;
        }
      }
    }
    return false;
  }

  isInLiquid(
    source: Vec3,
    height: number = Constants.GEOMETRY.LIQUID_HEIGHT,
    width: number = Constants.GEOMETRY.LIQUID_WIDTH,
  ): boolean {
    const w2 = width / 2;
    const levels = [0, height / 2, height];
    for (const y of levels) {
      const checkPoints = [
        new Vec3(source.x + w2, source.y + y, source.z + w2),
        new Vec3(source.x + w2, source.y + y, source.z - w2),
        new Vec3(source.x - w2, source.y + y, source.z + w2),
        new Vec3(source.x - w2, source.y + y, source.z - w2),
      ];
      for (const p of checkPoints) {
        const block = this.bot.blockAt(p);
        if (block && this.liquidBlockIds.has((block as any).id)) return true;
      }
    }
    return false;
  }

  drawRectColLine(source: Vec3, target: Vec3): boolean {
    const dir = target.minus(source);
    const len = dir.norm();
    const segments = Math.ceil(len / Constants.MOVEMENT.COLLISION_SEGMENT);
    const step = dir.scaled(1 / segments);
    for (let i = 0; i <= segments; i++) {
      const base = source.plus(step.scaled(i));
      for (const dy of Constants.MOVEMENT.COLLISION_HEIGHTS) {
        for (const offset of Constants.MOVEMENT.COLLISION_OFFSETS) {
          const p = new Vec3(base.x + offset.x, base.y + dy, base.z + offset.z);
          const block = this.bot.blockAt(p);
          if (block && this.isPointInBlock(p, block)) return true;
        }
      }
    }
    return false;
  }

  withStrafe(
    velocity: Vec3,
    { yaw, speed, strength = 1.0 }: WithStrafeOptions,
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
}

/**
 * Attach the UtilsManager to a bot instance.
 */
export function attachUtils(bot: Bot): Bot {
  bot.utilsManager = new UtilsManager(bot);
  return bot;
}
