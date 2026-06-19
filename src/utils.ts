import { Vec3 } from "vec3";
import { Constants } from "./constants";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";

const EPS = 1.0e-7;

// ---------------------------------------------------------------------------
// AABB
// ---------------------------------------------------------------------------

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
   * Check whether this AABB intersects another with EPS tolerance.
   */
  intersects(other: AABB): boolean {
    return (
      this.maxX > other.minX + EPS &&
      this.minX < other.maxX - EPS &&
      this.maxY > other.minY + EPS &&
      this.minY < other.maxY - EPS &&
      this.maxZ > other.minZ + EPS &&
      this.minZ < other.maxZ - EPS
    );
  }

  /**
   * Compute the maximum X displacement before colliding with `other`.
   * Returns dx unchanged if no collision.
   * @param other - The other AABB
   * @param dx - Desired X displacement
   * @param margin - Tolerance for overlap checks
   * @returns Adjusted displacement
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
   * @param other - The other AABB
   * @param dy - Desired Y displacement
   * @param margin - Tolerance for overlap checks
   * @returns Adjusted displacement
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
   * @param other - The other AABB
   * @param dz - Desired Z displacement
   * @param margin - Tolerance for overlap checks
   * @returns Adjusted displacement
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
}

// ---------------------------------------------------------------------------
// SimulateTick input/output types
// ---------------------------------------------------------------------------

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

interface SolidCacheEntry {
  solids: Vec3[];
  expiry: number;
}

/** Result of the best pearl trajectory calculation */
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

// ---------------------------------------------------------------------------
// UtilsManager
// ---------------------------------------------------------------------------

export class UtilsManager {
  public bot: Bot;
  public isNewSlipperiness: boolean;
  public isNewCollision: boolean;
  public isNewThreshold: boolean;
  public momentumThreshold: number;
  public applyEffects: boolean;
  public _solidCacheMaxSize: number;
  public _solidCache: Map<string, SolidCacheEntry>;
  public recentPoints: Vec3[];
  public recentPointsMax: number;
  public liquidBlockIds: Set<number>;
  public lastImpulseTick?: number;

  constructor(bot: Bot) {
    this.bot = bot;
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
    this.recentPointsMax = Constants.MOVEMENT.STRAFE_POINTS_MAX_HISTORY;
    this.liquidBlockIds = new Set();
    this._initializeLiquidCache();
  }

  /**
   * Compare two semantic version strings.
   * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
   * @private
   */
  private _compareVersion(v1: string, v2: string): number {
    const a = v1.split(".").map(Number);
    const b = v2.split(".").map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) > (b[i] || 0)) return 1;
      if ((a[i] || 0) < (b[i] || 0)) return -1;
    }
    return 0;
  }

  /**
   * Pre-compute the set of liquid block IDs for fast lookup.
   * @private
   */
  private _initializeLiquidCache(): void {
    const names = Constants.BLOCK_DETECTION.LIQUID_BLOCK_NAMES;
    const registry = (this.bot as any).registry;
    for (const name of names) {
      const entry = registry.blocksByName?.[name];
      if (entry?.id !== undefined) this.liquidBlockIds.add(entry.id);
    }
  }

  /**
   * Get the slipperiness factor of the block below the bot.
   * Returns AIRBORNE (1.0) when not on ground.
   * @param pos - Position to check below
   * @returns Slipperiness factor
   */
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

  /**
   * Compute the Effects Multiplier (E₂) per the parkour movement formula.
   *
   *   E₂ = (1 + 0.2 × Speed_Level) × (1 - 0.15 × Slowness_Level) ≥ 0
   *
   * Effect IDs: Speed = 1, Slowness = 2.
   * Amplifier is 0-indexed in the Minecraft protocol, so we add 1 to get the effective level.
   *
   * NOTE: This method is gated behind `this.applyEffects`, which defaults to false.
   * Speed/Slowness effects will NOT affect movement until `this.applyEffects` is set to true.
   * @returns Effects multiplier value
   */
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
   * Simulate a full Minecraft physics tick (ground or air).
   * Applies acceleration, movement, gravity, drag, and the sprint-jump boost.
   * @param state - Current bot state
   * @param inputs - Player inputs
   * @returns New state after the tick
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
    const St = this.getSlipperiness(pos);
    const Mt_base = sprinting ? 1.3 : sneaking ? 0.3 : 1.0;
    const Mt_strafe =
      Math.abs(forward) > 0 && Math.abs(strafe) > 0
        ? Constants.PHYSICS.ACCELERATION.STRAFE_45_MULTIPLIER
        : Constants.PHYSICS.ACCELERATION.STRAFE_MULTIPLIER;
    const Mt = Mt_base * Mt_strafe;
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
        vel.x += -sinYaw * Constants.PHYSICS.SPRINT_JUMP_BOOST;
        vel.z += cosYaw * Constants.PHYSICS.SPRINT_JUMP_BOOST;
      }
    }
    const nextPos = pos.plus(vel);
    vel.y -= Constants.PHYSICS.TICK_GRAVITY;
    vel.y *= Constants.PHYSICS.TICK_DRAG;
    if (vel.y < Constants.PHYSICS.TERMINAL_VELOCITY_Y)
      vel.y = Constants.PHYSICS.TERMINAL_VELOCITY_Y;
    const drag = onGround
      ? St * Constants.PHYSICS.MOMENTUM_CONSERVATION
      : Constants.PHYSICS.MOMENTUM_CONSERVATION;
    vel.x *= drag;
    vel.z *= drag;
    return { pos: nextPos, vel, onGround: entity.onGround };
  }

  /**
   * Apply a velocity impulse to the bot entity.
   * Debounces to once per tick unless `force` is true.
   * @param impulse - Velocity vector to apply
   * @param mode - Whether to add to or replace current velocity
   * @param force - Skip the once-per-tick debounce
   */
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

  /**
   * Compute the pitch angles (low and high arc) to hit a target with a projectile.
   * Uses the standard parabolic projectile formula with drag.
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
  getProjectilePitch(
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
    if (root < 0) return [];
    const rootSq = Math.sqrt(root);
    const lowArc = Math.atan((v2 - rootSq) / (g * x));
    const highArc = Math.atan((v2 + rootSq) / (g * x));
    // lowArc < highArc mathematically, but we want pitches[0] > pitches[1] for low/high arcs
    // So we swap the order to maintain the expected API contract
    const pitches = [(highArc * 180) / Math.PI, (lowArc * 180) / Math.PI];
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
   * @private
   */
  private _computeLandingInfo(
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
   * Check whether a projectile trajectory is clear of blocks and entities.
   * Simulates the full flight path.
   * @param source - Launch position
   * @param target - Target position
   * @param v - Initial projectile speed
   * @param g - Gravity acceleration
   * @param p - Pitch in degrees
   * @param drag - Per-tick velocity multiplier
   * @returns Whether the path is clear
   */
  isProjectilePathClear(
    source: Vec3,
    target: Vec3,
    v: number,
    g: number,
    p: number,
    drag = 1,
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
      const block = this.bot.blockAt(nextPos);
      if (
        block &&
        block.boundingBox !== "empty" &&
        this.isPointInBlock(nextPos, block)
      )
        return false;
      const entities = Object.values(this.bot.entities).filter(
        (e: Entity) =>
          e.id !== this.bot.entity.id &&
          e.position.distanceTo(nextPos) < ((e as any).width || 0.6),
      );
      if (entities.length > 0) return false;
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
   * @returns The best trajectory result, or null if no candidate trajectory
   *          (not even the direct target) is reachable.
   */
  getBestPearlTrajectory(
    source: Vec3,
    target: Vec3,
    velocity: number = Constants.COMBAT.PROJECTILES.ender_pearl.VELOCITY,
    gravity: number = Constants.COMBAT.PROJECTILES.ender_pearl.GRAVITY,
    drag: number = Constants.COMBAT.PROJECTILES.ender_pearl.DRAG,
    toleranceRadius: number = 1.5,
    sampleStep: number = 1.0,
  ): PearlTrajectoryResult | null {
    // ---- 1. Generate candidate landing points within the tolerance sphere ----
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

    // ---- 2. Evaluate each candidate target point ----
    for (const candidateTarget of candidateTargets) {
      const pitches = this.getProjectilePitch(
        source,
        candidateTarget,
        velocity,
        gravity,
        drag,
      );

      for (let i = 0; i < pitches.length; i++) {
        const pitch = pitches[i];
        const arc: "low" | "high" = i === 0 ? "low" : "high";

        const blocked = !this.isProjectilePathClear(
          source,
          candidateTarget,
          velocity,
          gravity,
          pitch,
          drag,
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
        const info = this._computeLandingInfo(
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

    // ---- 3. Rank: unobstructed (false < true) > flightTime ASC > landingDist ASC ----
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      // Clear paths first
      if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
      // Then fastest (shortest flight time)
      if (a.flightTime !== b.flightTime) return a.flightTime - b.flightTime;
      // Then most precise (closest to actual target)
      return a.landingDist - b.landingDist;
    });

    const best = candidates[0];

    // If even the best candidate is blocked, nothing is reachable
    if (best.blocked) return null;

    return {
      pitch: best.pitch,
      arc: best.arc,
      flightTime: best.flightTime,
      landingPoint: best.landingPoint.clone(),
      landingDist: best.landingDist,
    };
  }

  /**
   * Check whether a point is inside any shape of a block.
   * @param point - World coordinates
   * @param block - Block object with .shapes array
   * @returns Whether the point is inside any shape
   */
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

  /**
   * Get the bounding box of an entity, defaulting to player dimensions for players.
   */
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

  /**
   * Compute the pitch offset(s) needed to aim a projectile at a target.
   * Returns raw angle offsets (not final pitch values).
   * @param source - Launch position
   * @param target - Target position
   * @param velocity - Initial projectile speed
   * @returns Offset angles, empty if unreachable
   */
  getProjectileOffset(
    source: Vec3,
    target: Vec3,
    velocity: number = Constants.COMBAT.DEFAULT_PROJECTILE_VELOCITY,
  ): number[] {
    if (!source || !target)
      throw new Error("getProjectileOffset: source and target are required");
    const gravity = Constants.PHYSICS.GRAVITY;
    const distance = Math.sqrt(
      (target.x - source.x) ** 2 + (target.z - source.z) ** 2,
    );
    const dy = target.y - source.y;
    if (distance === 0) return dy >= 0 ? [Infinity] : [-Infinity];
    const v0Sq = velocity * velocity;
    const disc =
      v0Sq * v0Sq - gravity * (gravity * distance * distance + 2 * dy * v0Sq);
    if (disc < 0) return [];
    const discSq = Math.sqrt(disc);
    const denom = gravity * distance;
    const angle1 = Math.atan2(v0Sq + discSq, denom);
    const angle2 = Math.atan2(v0Sq - discSq, denom);
    const highArcOffset =
      distance * Math.tan(angle1) - dy + Constants.COMBAT.PROJECTILE_EYE_OFFSET;
    if (disc === 0) return [highArcOffset];
    const lowArcOffset =
      distance * Math.tan(angle2) - dy + Constants.COMBAT.PROJECTILE_EYE_OFFSET;
    return [highArcOffset, lowArcOffset];
  }

  /**
   * Check whether a point is within a vertical cylinder.
   * @param source - Center of cylinder base
   * @param point - Point to test
   * @param radius - Cylinder radius
   * @param height - Cylinder height
   * @returns Whether the point is inside the cylinder
   */
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

  /**
   * Check whether the bot is inside a hazardous block (web, cactus, liquid).
   * Samples multiple points across the bot's bounding box.
   * @param source - Bot position
   * @param height - Height to sample
   * @param offset - Horizontal offset for corner points
   * @returns The position of the hazard block, or false if clear
   */
  isInUnwanted(
    source: Vec3,
    height: number = Constants.GEOMETRY.UNWANTED_CHECK_HEIGHT,
    offset: number = Constants.GEOMETRY.UNWANTED_CHECK_OFFSET,
  ): boolean {
    const unwantedBlocks = Constants.BLOCK_DETECTION.UNWANTED_BLOCK_NAMES;
    const layerHeight = height / Constants.GEOMETRY.UNWANTED_CHECK_LAYERS;
    const offsets = [offset, offset + Constants.PHYSICS.COLLISION_OFFSET_FINE];
    for (const off of offsets) {
      for (
        let layer = 0;
        layer < Constants.GEOMETRY.UNWANTED_CHECK_LAYERS;
        layer++
      ) {
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

  /**
   * Check whether the bot is inside a liquid block.
   * @param source - Bot position
   * @param height - Height to sample
   * @param width - Entity width
   * @returns Whether the bot is in liquid
   */
  isInLiquid(
    source: Vec3,
    height: number = Constants.GEOMETRY.LIQUID_CHECK_HEIGHT,
    width: number = Constants.GEOMETRY.LIQUID_CHECK_WIDTH,
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

  /**
   * Get all block collision AABBs that intersect a given AABB.
   * @param aabb - The query AABB
   * @param minYThreshold - Minimum Y floor for block scanning
   * @returns Array of collision AABBs
   */
  getCollisions(aabb: AABB, minYThreshold = -Infinity): AABB[] {
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
          const block = this.bot.blockAt(new Vec3(x, y, z));
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

  /**
   * Simulate a sprint-jump trajectory and check whether it reaches the target without colliding.
   * Uses the complete ground-to-air physics formulas with vertical/horizontal collision checks.
   * @param source - Jump origin
   * @param target - Target position
   * @returns Whether the path is clear
   */
  isJumpPathClear(source: Vec3, target: Vec3): boolean {
    const GRAVITY = Constants.PHYSICS.TICK_GRAVITY;
    const DRAG = Constants.PHYSICS.TICK_DRAG;
    const AIRBORNE_MOMENTUM = Constants.PHYSICS.MOMENTUM_CONSERVATION;
    const St = this.getSlipperiness(source);
    const Et = this.applyEffects ? this.getEffectsMultiplier() : 1.0;
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
    const entity = this.bot.entity as any;
    const vH0 = Math.hypot(entity.velocity.x, entity.velocity.z);
    const vH1 =
      vH0 * GROUND_MOMENTUM +
      GROUND_ACCEL +
      Constants.PHYSICS.SPRINT_JUMP_BOOST;
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
      if (Math.abs(currVel.x) < this.momentumThreshold) currVel.x = 0;
      if (Math.abs(currVel.y) < this.momentumThreshold) currVel.y = 0;
      if (Math.abs(currVel.z) < this.momentumThreshold) currVel.z = 0;
      let playerAABB = new AABB(
        currPos.x - 0.3,
        currPos.y,
        currPos.z - 0.3,
        currPos.x + 0.3,
        currPos.y + 1.8,
        currPos.z + 0.3,
      );
      let moveAABB = playerAABB
        .extend(currVel.x, currVel.y, currVel.z)
        .expand(0.1);
      let collisions = this.getCollisions(moveAABB, entity.position.y + 0.3);
      for (const bb of collisions) {
        if (moveAABB.intersects(bb)) {
          return false;
        }
      }
      let dy = currVel.y;
      for (const bb of collisions)
        dy = playerAABB.calculateYOffset(bb, dy, EPS);
      if (currVel.y > 0 && Math.abs(dy - currVel.y) > EPS) currVel.y = 0;
      else if (currVel.y < 0 && dy > currVel.y + EPS) {
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

  /**
   * Find a valid strafe point (solid block surface) near the target.
   * Filters by distance, path clearness, and spacing from recent points.
   * @param source - Bot position
   * @param target - Search center position
   * @param pvpTarget - PVP target position (for attack range filtering)
   * @returns The strafe point, or null if none found
   */
  getStrafePoint(source: Vec3, target: Vec3, pvpTarget?: Vec3): Vec3 | null {
    const solids = this.getSolidBlocks(target);
    const maxDist = Constants.MOVEMENT.STRAFE_POINT_MAX_DISTANCE;
    const minSpacing = Constants.MOVEMENT.STRAFE_POINT_MIN_SPACING;
    const sourceMinDist = Constants.MOVEMENT.STRAFE_POINT_SOURCE_MIN_DISTANCE;
    const attackRange = Constants.COMBAT.ATTACK_RANGE + 0.5;
    const prefMin = Constants.MOVEMENT.STRAFE_PREFERRED_MIN;
    const prefMax = Constants.MOVEMENT.STRAFE_PREFERRED_MAX;
    const dist2D = (a: Vec3, b: Vec3): number =>
      Math.hypot(a.x - b.x, a.z - b.z);
    if (solids.length === 0) return null;

    let bestPoint: Vec3 | null = null;
    let bestScore = -1; // -1=none, 0=acceptable, 1=preferred

    for (const point of solids) {
      if (dist2D(point, target) >= maxDist || dist2D(point, source) >= maxDist)
        continue;
      if (dist2D(point, source) < sourceMinDist) continue;
      if (!this.isJumpPathClear(source, point)) continue;
      if (this.recentPoints.some((rp) => dist2D(point, rp) <= minSpacing))
        continue;

      // Score the point by its distance to the PvP target.
      // Preferred: 1-2 blocks away. Acceptable: within attack range.
      let score = 0;
      if (pvpTarget) {
        const d = dist2D(point, pvpTarget);
        if (d > attackRange) continue;
        if (d >= prefMin && d <= prefMax) score = 1;
      }

      if (score > bestScore) {
        bestScore = score;
        bestPoint = point;
      }
    }

    if (bestPoint) {
      this.recentPoints.push(bestPoint);
      if (this.recentPoints.length > this.recentPointsMax)
        this.recentPoints.shift();
      return bestPoint;
    }
    return null;
  }

  /**
   * Check whether a rectangular column of space between source and target contains any solid blocks.
   * Used as a coarse line-of-sight check.
   * @param source - Start position
   * @param target - End position
   * @returns True if a block is in the way
   */
  drawRectColLine(source: Vec3, target: Vec3): boolean {
    const dir = target.minus(source);
    const len = dir.norm();
    const segments = Math.ceil(len / Constants.MOVEMENT.COLLISION_SEGMENT_SIZE);
    const step = dir.scaled(1 / segments);
    for (let i = 0; i <= segments; i++) {
      const base = source.plus(step.scaled(i));
      for (const dy of Constants.MOVEMENT.COLLISION_CHECK_HEIGHTS) {
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
   * Find all walkable solid block surfaces within a radius of the source.
   * Results are cached for SOLID_BLOCKS_CACHE_DURATION ms.
   * @param source - Center position to search around
   * @returns Array of surface-center positions
   */
  getSolidBlocks(source: Vec3): Vec3[] {
    const now = Date.now();
    const cacheKey = `${Math.floor(source.x)},${Math.floor(source.z)}`;

    const cached = this._solidCache.get(cacheKey);
    if (cached && now < cached.expiry) {
      this._solidCache.delete(cacheKey);
      this._solidCache.set(cacheKey, cached);
      return cached.solids;
    }

    const solids: Vec3[] = [];
    const radius = Constants.MOVEMENT.SOLID_BLOCK_SEARCH_RADIUS;
    const startY = Math.floor(source.y);

    for (let x = -radius; x <= radius; x++) {
      for (let z = -radius; z <= radius; z++) {
        for (
          let y = startY;
          y >= startY + Constants.BLOCK_DETECTION.MIN_WALKABLE_Y_OFFSET;
          y--
        ) {
          const pos = new Vec3(source.x + x, y, source.z + z);
          const block = this.bot.blockAt(pos);
          const above = this.bot.blockAt(pos.offset(0, 1, 0));
          if (
            block &&
            block.boundingBox !== "empty" &&
            (!above || above.boundingBox === "empty")
          ) {
            const shape = block.shapes[0];
            if (shape) {
              const dx = Math.abs(
                shape[Constants.SHAPE.MIN_X] - shape[Constants.SHAPE.MAX_X],
              );
              const dz = Math.abs(
                shape[Constants.SHAPE.MIN_Z] - shape[Constants.SHAPE.MAX_Z],
              );
              if (
                dx > (this.bot.entity as any).width &&
                dz > (this.bot.entity as any).width
              ) {
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

    if (this._solidCache.size >= this._solidCacheMaxSize) {
      const oldestKey = this._solidCache.keys().next().value;
      if (oldestKey !== undefined) this._solidCache.delete(oldestKey);
    }
    this._solidCache.set(cacheKey, {
      solids,
      expiry: now + Constants.BLOCK_DETECTION.SOLID_BLOCKS_CACHE_DURATION,
    });

    return solids;
  }

  /**
   * Clear the solid blocks LRU cache.
   */
  clearSolidCache(): void {
    this._solidCache.clear();
  }

  /**
   * Blends the current velocity toward a target yaw+speed using a strength factor,
   * mirroring LiquidBounce's `Vec3.withStrafe()`.
   * @param velocity - Current velocity vector
   * @param options - Options with yaw, speed, strength
   * @returns New velocity vector (vertical component preserved)
   */
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

  /**
   * Computes the Minecraft yaw for strafing perpendicular to a target.
   * @param playerPos - Bot position
   * @param targetPos - Target position
   * @param direction - Strafe direction (+1 = right, -1 = left)
   * @returns Minecraft yaw (radians) for the strafe direction
   */
  getStrafeYaw(playerPos: Vec3, targetPos: Vec3, direction: number): number {
    const dx = targetPos.x - playerPos.x;
    const dz = targetPos.z - playerPos.z;
    const minecraftYawToTarget = Math.atan2(-dx, dz);
    return minecraftYawToTarget + direction * (Math.PI / 2);
  }

  /**
   * Get the horizontal speed of the bot entity.
   * @returns Horizontal speed
   */
  getHorizontalSpeed(): number {
    const entity = this.bot.entity as any;
    return Math.hypot(entity.velocity.x, entity.velocity.z);
  }

  /**
   * Get the ground-inertia-adjusted jump speed (pre-drag) for the current ground surface.
   * @param source - Position to check slipperiness at
   * @returns Horizontal jump speed
   */
  getGroundJumpSpeed(source: Vec3): number {
    const St = this.getSlipperiness(source);
    const Et = this.applyEffects ? this.getEffectsMultiplier() : 1.0;
    const Mt =
      Constants.PHYSICS.ACCELERATION.SPRINT_MULTIPLIER *
      Constants.PHYSICS.ACCELERATION.STRAFE_MULTIPLIER;
    const GROUND_ACCEL = 0.1 * Mt * Et * Math.pow(0.6 / St, 3);
    const GROUND_MOMENTUM = St * Constants.PHYSICS.MOMENTUM_CONSERVATION;
    const vH0 = this.getHorizontalSpeed();
    return (
      vH0 * GROUND_MOMENTUM + GROUND_ACCEL + Constants.PHYSICS.SPRINT_JUMP_BOOST
    );
  }

  /**
   * Compute a velocity vector for a jump toward a target.
   * @param source - Current position
   * @param target - Target position
   * @param angleDeg - Angular offset
   * @returns Velocity vector
   */
  getJumpVelocity(
    source: Vec3,
    target: Vec3,
    angleDeg = 0,
    isStrafe = false,
  ): Vec3 {
    const dx = target.x - source.x;
    const dz = target.z - source.z;
    const len = Math.hypot(dx, dz);
    const vy = Constants.PHYSICS.JUMP_VELOCITY;
    if (len === 0) return new Vec3(0, vy, 0);

    const St = this.getSlipperiness(source);
    const GROUND_MOMENTUM = St * Constants.PHYSICS.MOMENTUM_CONSERVATION; // 0.546 for default
    const AIR_MOMENTUM = Constants.PHYSICS.MOMENTUM_CONSERVATION; // 0.91

    // Estimate the number of airborne ticks from the vertical trajectory.
    // The jump tick moves the bot upward by JUMP_VELOCITY; subsequent ticks
    // have gravity and drag applied: vy' = (vy - TICK_GRAVITY) * TICK_DRAG.
    let vY = Constants.PHYSICS.JUMP_VELOCITY;
    let airborneTicks = 0;
    let yPos = vY;
    while (yPos > 0) {
      vY = (vY - Constants.PHYSICS.TICK_GRAVITY) * Constants.PHYSICS.TICK_DRAG;
      yPos += vY;
      if (yPos > 0) airborneTicks++;
    }
    if (airborneTicks < 1) airborneTicks = 1;

    // Total horizontal distance covered with initial speed v (no air acceleration):
    //   jump tick:  v
    //   air tick k: v * GROUND_MOMENTUM * AIR_MOMENTUM^k
    //   D(v) = v * (1 + GROUND_MOMENTUM * (1 - AIR_MOMENTUM^T) / (1 - AIR_MOMENTUM))
    const geomSum =
      (1 - Math.pow(AIR_MOMENTUM, airborneTicks)) / (1 - AIR_MOMENTUM);
    const distMultiplier = 1 + GROUND_MOMENTUM * geomSum;

    // Required initial horizontal speed to cover the target distance.
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

  /**
   * Compute a flat (horizontal-only) velocity vector toward a target.
   * Clamps each axis to PER_AXIS_MAX_SPEED.
   * @param source - Current position
   * @param target - Target position
   * @param angleDeg - Angular offset
   * @param speed - Desired horizontal speed
   * @param vy - Vertical component
   * @returns Velocity vector
   */
  getFlatVelocity(
    source: Vec3,
    target: Vec3,
    angleDeg = 0,
    speed: number = Constants.MOVEMENT.FLAT_VELOCITY_XZ,
    vy = 0,
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

  /**
   * Find the Y coordinate of the ground surface below the bot.
   * Searches up to 5 blocks downward.
   * @returns Y coordinate of the surface, or -64 if not found
   */
  getGroundBelow(): number {
    const pos = this.bot.entity.position;
    const startY = Math.floor(pos.y);
    for (let y = startY; y >= startY - 5; y--) {
      const block = this.bot.blockAt(new Vec3(pos.x, y, pos.z));
      if (block && block.boundingBox !== "empty") {
        const shape = block.shapes[0];
        if (shape) return y + shape[Constants.SHAPE.MAX_Y];
        return y + 1;
      }
    }
    return -64;
  }

  /**
   * Calculate fall damage for a given fall distance.
   * First 3 blocks are safe; each additional block deals 1 damage.
   * @param distance - Fall distance in blocks
   * @returns Raw damage amount
   */
  getFallDamage(distance: number): number {
    const safeFallDistance = 3;
    const fallDamageMultiplier = 1;
    if (distance <= 3) return 0;
    return Math.max(
      0,
      Math.floor((distance - safeFallDistance) * fallDamageMultiplier),
    );
  }
}

/**
 * Attach the UtilsManager to a bot instance.
 * @param bot - Mineflayer bot instance
 * @returns The same bot instance with utilsManager attached
 */
export default function attach(bot: Bot): Bot {
  (bot as any).utilsManager = new UtilsManager(bot);
  return bot;
}
