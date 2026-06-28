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
  getHorizontalSpeed,
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



export class UtilsManager {
  bot: Bot;
  isNewSlipperiness: boolean;
  isNewCollision: boolean;
  isNewThreshold: boolean;
  momentumThreshold: number;
  applyEffects: boolean;
  _solidCacheMaxSize: number;
  _solidCache: Map<string, { solids: Vec3[]; expiry: number }>;
  liquidBlockIds: Set<number>;
  lastImpulseTick?: number;
  logger: any;

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
    this.liquidBlockIds = new Set();
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

  /**
   * Simulate a single physics tick using the Legacy Console Edition
   * movement model.  Mirrors the LCE `Mob::travel()` function
   * (Mob.cpp:953-1030) which is the authoritative reference for ground/air
   * movement, friction, and gravity.
   *
   * LCE tick order:
   *   1. Compute friction (air=0.91, ground=block.friction*0.91)
   *   2. Compute speed (air=flyingSpeed, ground=walkingSpeed*friction2)
   *   3. moveRelative(): normalize input to `speed`, rotate by yaw, add to vel
   *   4. move(): apply velocity with collision
   *   5. Post-movement: gravity (-0.08), vertical drag (*0.98), horizontal friction
   */
  simulateTick(
    state: SimulateTickState,
    inputs: SimulateInputs,
  ): SimulateTickState {
    let { pos, vel, onGround } = state;
    const { forward, strafe, jumping, sprinting, sneaking } = inputs;
    if (Math.abs(vel.x) < this.momentumThreshold) vel.x = 0;
    if (Math.abs(vel.y) < this.momentumThreshold) vel.y = 0;
    if (Math.abs(vel.z) < this.momentumThreshold) vel.z = 0;

    // ── Step 1: Friction (Mob.cpp:998-1001) ──────────────────────────
    // LCE uses 0.91 for air, block.friction*0.91 for ground.
    // Pupa maps slipperiness St to block.friction: default St=0.6 → friction=0.546.
    const St = this.getSlipperiness(pos);
    let friction: number;
    if (onGround) {
      friction = St * Constants.PHYSICS.MOMENTUM; // 0.6*0.91=0.546 default
    } else {
      friction = Constants.PHYSICS.MOMENTUM; // 0.91
    }

    // ── Step 2: Speed (Mob.cpp:1003-1012) ──────────────────────────
    // LCE friction2 = (0.6^3 * 0.91^3) / friction^3, normalized so that
    // ground speed equals walkingSpeed when friction=0.546.
    // In air, speed = flyingSpeed (0.02) regardless of sprint.
    const friction2 =
      Math.pow(0.6, 3) * Math.pow(Constants.PHYSICS.MOMENTUM, 3) /
      Math.pow(friction, 3);
    let speed: number;
    if (onGround) {
      const walkingSpeed = sprinting
        ? Constants.MOVEMENT.SPRINT_SPEED
        : sneaking
          ? Constants.MOVEMENT.WALK_SPEED * 0.3
          : Constants.MOVEMENT.WALK_SPEED;
      speed = walkingSpeed * friction2;
    } else {
      // Air: flyingSpeed (Player.cpp:1017-1018). Sprint adds 0.3*flyingSpeed.
      speed = sprinting
        ? Constants.MOVEMENT.SPRINT_AIR_SPEED
        : Constants.MOVEMENT.AIR_SPEED;
    }

    // ── Step 3: moveRelative (Entity.cpp:1094-1107) ──────────────────
    // Normalize input to `speed`, rotate by yaw, add to velocity.
    // Deadzone: ignore inputs with magnitude < 0.01 (squared).
    const entity = this.bot.entity as any;
    const yaw = entity.yaw;
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    const inputMagSq = forward * forward + strafe * strafe;
    if (inputMagSq >= 0.01 * 0.01) {
      const inputMag = Math.sqrt(inputMagSq);
      const scale = speed / Math.max(inputMag, 1.0);
      const s = strafe * scale;
      const fw = forward * scale;
      vel.x += s * cosYaw - fw * sinYaw;
      vel.z += fw * cosYaw + s * sinYaw;
    }

    // ── Jump (Mob.cpp:1329-1343) ────────────────────────────────────
    if (onGround && jumping) {
      vel.y = Constants.PHYSICS.JUMP_VELOCITY;
      if (sprinting) {
        vel.x += -sinYaw * Constants.PHYSICS.JUMP_BOOST;
        vel.z += cosYaw * Constants.PHYSICS.JUMP_BOOST;
      }
    }

    // ── Step 4: move() — apply velocity (collision handled by server) ──
    const nextPos = pos.plus(vel);

    // ── Step 5: Post-movement (Mob.cpp:1024-1027) ────────────────────
    vel.y -= Constants.PHYSICS.GRAVITY;
    vel.y *= Constants.PHYSICS.DRAG;
    if (vel.y < Constants.PHYSICS.TERMINAL_VELOCITY)
      vel.y = Constants.PHYSICS.TERMINAL_VELOCITY;
    vel.x *= friction;
    vel.z *= friction;

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
    _getSlipperiness?: (pos: Vec3) => number,
    _getHorizontalSpeed?: () => number,
    airAccel = 0,
  ): Vec3 {
    return getJumpVelocity(
      source,
      target,
      angleDeg,
      _getSlipperiness ?? ((pos: Vec3) => this.getSlipperiness(pos)),
      _getHorizontalSpeed ?? (() => this.getHorizontalSpeed()),
      airAccel,
    );
  }

  getHorizontalSpeed(): number {
    return getHorizontalSpeed(this.bot.entity as any);
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

  /**
   * Send a server command and assert it succeeds.
   * Waits for the server's success message (matched by translate key)
   * within the given timeout, then resolves with the matched text.
   *
   * @param command - Command name without leading slash (e.g. "give", "tp")
   * @param args - Command arguments (e.g. "@p dirt 1", "100 64 100")
   * @param timeoutTicks - Timeout in ticks (default 20 = 1 second)
   * @returns The matched success message text
   * @throws Error if no success message arrives within the timeout
   */
  async assertCommandSuccess(
    command: string,
    args: string = "",
    timeoutTicks = 20,
  ): Promise<string> {
    const bot = this.bot;
    const fullCommand = `/${command} ${args}`.trim();
    const timeoutMs = timeoutTicks * 50;

    // Translation keys for command success messages.
    // The message event provides raw JSON with a `translate` field that
    // identifies the message type on all protocol versions.
    // Reference: https://minecraft.wiki/w/Commands and en_US.lang
    // Full list extracted from minecraft-data 1.12.2 + 1.21.5-pre3 (261 keys).
    const translateKeys = new Set([
      "commands.advancement.grant.criterion.success",
      "commands.advancement.grant.criterion.to.many.success",
      "commands.advancement.grant.criterion.to.one.success",
      "commands.advancement.grant.everything.success",
      "commands.advancement.grant.from.success",
      "commands.advancement.grant.many.to.many.success",
      "commands.advancement.grant.many.to.one.success",
      "commands.advancement.grant.one.to.many.success",
      "commands.advancement.grant.one.to.one.success",
      "commands.advancement.grant.only.success",
      "commands.advancement.grant.through.success",
      "commands.advancement.grant.until.success",
      "commands.advancement.revoke.criterion.success",
      "commands.advancement.revoke.criterion.to.many.success",
      "commands.advancement.revoke.criterion.to.one.success",
      "commands.advancement.revoke.everything.success",
      "commands.advancement.revoke.from.success",
      "commands.advancement.revoke.many.to.many.success",
      "commands.advancement.revoke.many.to.one.success",
      "commands.advancement.revoke.one.to.many.success",
      "commands.advancement.revoke.one.to.one.success",
      "commands.advancement.revoke.only.success",
      "commands.advancement.revoke.through.success",
      "commands.advancement.revoke.until.success",
      "commands.advancement.test.advancement.success",
      "commands.advancement.test.criterion.success",
      "commands.attribute.base_value.get.success",
      "commands.attribute.base_value.set.success",
      "commands.attribute.modifier.add.success",
      "commands.attribute.modifier.remove.success",
      "commands.attribute.modifier.value.get.success",
      "commands.attribute.value.get.success",
      "commands.ban.success",
      "commands.banip.success",
      "commands.banip.success.players",
      "commands.blockdata.success",
      "commands.bossbar.create.success",
      "commands.bossbar.remove.success",
      "commands.bossbar.set.color.success",
      "commands.bossbar.set.max.success",
      "commands.bossbar.set.name.success",
      "commands.bossbar.set.players.success.none",
      "commands.bossbar.set.players.success.some",
      "commands.bossbar.set.style.success",
      "commands.bossbar.set.value.success",
      "commands.bossbar.set.visible.success.hidden",
      "commands.bossbar.set.visible.success.visible",
      "commands.clear.success",
      "commands.clear.success.multiple",
      "commands.clear.success.single",
      "commands.clone.success",
      "commands.compare.success",
      "commands.damage.success",
      "commands.datapack.list.available.success",
      "commands.datapack.list.enabled.success",
      "commands.debug.function.success.multiple",
      "commands.debug.function.success.single",
      "commands.defaultgamemode.success",
      "commands.deop.success",
      "commands.difficulty.success",
      "commands.downfall.success",
      "commands.drop.success.multiple",
      "commands.drop.success.multiple_with_table",
      "commands.drop.success.single",
      "commands.drop.success.single_with_table",
      "commands.effect.clear.everything.success.multiple",
      "commands.effect.clear.everything.success.single",
      "commands.effect.clear.specific.success.multiple",
      "commands.effect.clear.specific.success.single",
      "commands.effect.give.success.multiple",
      "commands.effect.give.success.single",
      "commands.effect.success",
      "commands.effect.success.removed",
      "commands.effect.success.removed.all",
      "commands.enchant.success",
      "commands.enchant.success.multiple",
      "commands.enchant.success.single",
      "commands.entitydata.success",
      "commands.experience.add.levels.success.multiple",
      "commands.experience.add.levels.success.single",
      "commands.experience.add.points.success.multiple",
      "commands.experience.add.points.success.single",
      "commands.experience.set.levels.success.multiple",
      "commands.experience.set.levels.success.single",
      "commands.experience.set.points.success.multiple",
      "commands.experience.set.points.success.single",
      "commands.fill.success",
      "commands.fillbiome.success",
      "commands.fillbiome.success.count",
      "commands.forceload.query.success",
      "commands.function.success",
      "commands.function.success.multiple",
      "commands.function.success.multiple.result",
      "commands.function.success.single",
      "commands.function.success.single.result",
      "commands.gamemode.success.other",
      "commands.gamemode.success.self",
      "commands.gamerule.success",
      "commands.give.success",
      "commands.give.success.multiple",
      "commands.give.success.single",
      "commands.item.block.set.success",
      "commands.item.entity.set.success.multiple",
      "commands.item.entity.set.success.single",
      "commands.kick.success",
      "commands.kick.success.reason",
      "commands.kill.success.multiple",
      "commands.kill.success.single",
      "commands.kill.successful",
      "commands.locate.biome.success",
      "commands.locate.poi.success",
      "commands.locate.structure.success",
      "commands.locate.success",
      "commands.op.success",
      "commands.pardon.success",
      "commands.pardonip.success",
      "commands.particle.success",
      "commands.place.feature.success",
      "commands.place.jigsaw.success",
      "commands.place.structure.success",
      "commands.place.template.success",
      "commands.playsound.success",
      "commands.playsound.success.multiple",
      "commands.playsound.success.single",
      "commands.publish.success",
      "commands.random.reset.all.success",
      "commands.random.reset.success",
      "commands.random.sample.success",
      "commands.recipe.give.success.all",
      "commands.recipe.give.success.multiple",
      "commands.recipe.give.success.one",
      "commands.recipe.give.success.single",
      "commands.recipe.take.success.all",
      "commands.recipe.take.success.multiple",
      "commands.recipe.take.success.one",
      "commands.recipe.take.success.single",
      "commands.reload.success",
      "commands.replaceitem.success",
      "commands.ride.dismount.success",
      "commands.ride.mount.success",
      "commands.save.success",
      "commands.schedule.cleared.success",
      "commands.scoreboard.objectives.add.success",
      "commands.scoreboard.objectives.list.success",
      "commands.scoreboard.objectives.remove.success",
      "commands.scoreboard.objectives.setdisplay.successCleared",
      "commands.scoreboard.objectives.setdisplay.successSet",
      "commands.scoreboard.players.add.success.multiple",
      "commands.scoreboard.players.add.success.single",
      "commands.scoreboard.players.display.name.clear.success.multiple",
      "commands.scoreboard.players.display.name.clear.success.single",
      "commands.scoreboard.players.display.name.set.success.multiple",
      "commands.scoreboard.players.display.name.set.success.single",
      "commands.scoreboard.players.display.numberFormat.clear.success.multiple",
      "commands.scoreboard.players.display.numberFormat.clear.success.single",
      "commands.scoreboard.players.display.numberFormat.set.success.multiple",
      "commands.scoreboard.players.display.numberFormat.set.success.single",
      "commands.scoreboard.players.enable.success",
      "commands.scoreboard.players.enable.success.multiple",
      "commands.scoreboard.players.enable.success.single",
      "commands.scoreboard.players.get.success",
      "commands.scoreboard.players.list.entity.success",
      "commands.scoreboard.players.list.success",
      "commands.scoreboard.players.operation.success",
      "commands.scoreboard.players.operation.success.multiple",
      "commands.scoreboard.players.operation.success.single",
      "commands.scoreboard.players.remove.success.multiple",
      "commands.scoreboard.players.remove.success.single",
      "commands.scoreboard.players.reset.success",
      "commands.scoreboard.players.resetscore.success",
      "commands.scoreboard.players.set.success",
      "commands.scoreboard.players.set.success.multiple",
      "commands.scoreboard.players.set.success.single",
      "commands.scoreboard.players.tag.success.add",
      "commands.scoreboard.players.tag.success.remove",
      "commands.scoreboard.players.test.success",
      "commands.scoreboard.teams.add.success",
      "commands.scoreboard.teams.empty.success",
      "commands.scoreboard.teams.join.success",
      "commands.scoreboard.teams.leave.success",
      "commands.scoreboard.teams.option.success",
      "commands.scoreboard.teams.remove.success",
      "commands.seed.success",
      "commands.setblock.success",
      "commands.setidletimeout.success",
      "commands.setworldspawn.success",
      "commands.spawnpoint.success",
      "commands.spawnpoint.success.multiple",
      "commands.spawnpoint.success.single",
      "commands.spectate.success.started",
      "commands.spectate.success.stopped",
      "commands.spreadplayers.success.entities",
      "commands.spreadplayers.success.players",
      "commands.spreadplayers.success.teams",
      "commands.stats.success",
      "commands.stopsound.success.all",
      "commands.stopsound.success.individualSound",
      "commands.stopsound.success.soundSource",
      "commands.stopsound.success.source.any",
      "commands.stopsound.success.source.sound",
      "commands.stopsound.success.sourceless.any",
      "commands.stopsound.success.sourceless.sound",
      "commands.summon.success",
      "commands.tag.add.success.multiple",
      "commands.tag.add.success.single",
      "commands.tag.list.multiple.success",
      "commands.tag.list.single.success",
      "commands.tag.remove.success.multiple",
      "commands.tag.remove.success.single",
      "commands.team.add.success",
      "commands.team.empty.success",
      "commands.team.join.success.multiple",
      "commands.team.join.success.single",
      "commands.team.leave.success.multiple",
      "commands.team.leave.success.single",
      "commands.team.list.members.success",
      "commands.team.list.teams.success",
      "commands.team.option.collisionRule.success",
      "commands.team.option.color.success",
      "commands.team.option.deathMessageVisibility.success",
      "commands.team.option.name.success",
      "commands.team.option.nametagVisibility.success",
      "commands.team.option.prefix.success",
      "commands.team.option.suffix.success",
      "commands.team.remove.success",
      "commands.teleport.success.coordinates",
      "commands.teleport.success.entity.multiple",
      "commands.teleport.success.entity.single",
      "commands.teleport.success.location.multiple",
      "commands.teleport.success.location.single",
      "commands.testfor.success",
      "commands.testforblock.success",
      "commands.tick.rate.success",
      "commands.tick.sprint.stop.success",
      "commands.tick.step.stop.success",
      "commands.tick.step.success",
      "commands.title.success",
      "commands.tp.success",
      "commands.tp.success.coordinates",
      "commands.transfer.success.multiple",
      "commands.transfer.success.single",
      "commands.trigger.add.success",
      "commands.trigger.set.success",
      "commands.trigger.simple.success",
      "commands.trigger.success",
      "commands.unban.success",
      "commands.unbanip.success",
      "commands.whitelist.add.success",
      "commands.whitelist.remove.success",
      "commands.worldborder.center.success",
      "commands.worldborder.damage.amount.success",
      "commands.worldborder.damage.buffer.success",
      "commands.worldborder.get.success",
      "commands.worldborder.set.success",
      "commands.worldborder.setSlowly.grow.success",
      "commands.worldborder.setSlowly.shrink.success",
      "commands.worldborder.warning.distance.success",
      "commands.worldborder.warning.time.success",
      "commands.xp.success",
      "commands.xp.success.levels",
      "commands.xp.success.negative.levels"
    
    ]);

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        bot.removeListener("message", onMessage);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for success message after sending: ${fullCommand}`,
          ),
        );
      }, timeoutMs);

      const onMessage = (jsonMsg: any) => {
        const translate =
          (jsonMsg as any)?.json?.translate ?? (jsonMsg as any)?.translate;
        if (translate && translateKeys.has(translate)) {
          clearTimeout(timer);
          bot.removeListener("message", onMessage);
          resolve(jsonMsg?.toString?.() ?? String(jsonMsg));
        }
      };

      bot.on("message", onMessage);
      bot.chat!(fullCommand);
    });
  }

}

/**
 * Attach the UtilsManager to a bot instance.
 */
export function attachUtils(bot: Bot): Bot {
  bot.utilsManager = new UtilsManager(bot);
  return bot;
}
