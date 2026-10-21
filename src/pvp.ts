import { Logger } from "./logger";
import { Constants } from "./constants";
import { Vec3 } from "vec3";
import { Bot } from "mineflayer";
import { Entity } from "prismarine-entity";
import { goals, Movements } from "mineflayer-pathfinder";
import { buildCombatTree, CombatTreeContext } from "./behavior-tree";
import { StrafeController } from "./strafe";
import { Node as BTNode } from "behaviortree";
import { AABB } from "./utils";
import type { PearlTrajectoryResult, PearlTopLanding } from "./projectile";
import { PearlSolver, type LaunchPointSolution } from "./pearl-solver";
import type { LaunchCandidate } from "./pearl-solver-worker";
import { getCollisions } from "./movement";

/**
 * @fileoverview Combat decision engine, PVP manager, and weapon utilities for Pupa bot.
 *
 * CombatManager: rule-based decision engine for inventory management during combat.
 * PVPManager: attack lifecycle, cooldown, shield blocking, target following.
 * Weapon utilities: getAttackSpeed, getCooldown, getDamageMultiplier.
 */

// ---------------------------------------------------------------------------
// Weapon utilities (consolidated from pvp-manager.ts)
// ---------------------------------------------------------------------------

const WEAPON_NAMES = [
  "sword",
  "trident",
  "axe",
  "pickaxe",
  "shovel",
  "hoe",
] as const;

export function getAttackSpeed(itemName?: string | null): number {
  if (!itemName) return Constants.WEAPON_SPEEDS.OTHER;
  for (const prefix of WEAPON_NAMES) {
    if (itemName.includes(prefix)) {
      const key = itemName.replace(/^minecraft:/, "");
      const speed = (Constants.WEAPON_SPEEDS as Record<string, number>)[key];
      if (speed !== undefined) return speed;
      const speeds: Record<string, number> = {
        sword: 1.6,
        trident: 1.1,
        axe: 1.0,
        pickaxe: 1.2,
        shovel: 1.0,
        hoe: 1.0,
      };
      return speeds[prefix] ?? Constants.WEAPON_SPEEDS.OTHER;
    }
  }
  return Constants.WEAPON_SPEEDS.OTHER;
}

export function getCooldown(itemName?: string | null): number {
  const speed = getAttackSpeed(itemName);
  return Math.floor((1 / speed) * 20);
}

export function getDamageMultiplier(itemName?: string | null): number {
  const speed = getAttackSpeed(itemName);
  const cooldown = getCooldown(itemName);
  const damageMul = 0.2 + Math.pow((speed + 0.5) / cooldown, 2) * 0.8;
  return Math.max(0.2, Math.min(1.0, damageMul));
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/** 1.9 introduced the attack cooldown; earlier versions swing freely. */
const LEGACY_COMBAT_MAJOR = 1;
const LEGACY_COMBAT_MINOR = 9;

/** 1.20.5 introduced the server-enforced entity interaction range (3.0). */
const MODERN_REACH_MAJOR = 1;
const MODERN_REACH_MINOR = 20;
const MODERN_REACH_PATCH = 5;
/** Server-enforced entity interaction range from 1.20.5 on. */
export const MODERN_REACH_RANGE = 3.0;

/**
 * Parse a Minecraft version string ("1.12.2", "1.21") into numeric parts.
 * @returns [major, minor, patch] or null when unparseable
 */
export function parseMcVersion(
  version?: string | null,
): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec((version ?? "").trim());
  if (!match) return null;
  return [
    parseInt(match[1], 10),
    parseInt(match[2], 10),
    parseInt(match[3] ?? "0", 10),
  ];
}

/**
 * Whether a version is at least major.minor.patch. Unknown versions are
 * treated as modern so bots default to current-version behavior.
 */
export function isVersionAtLeast(
  version: string | null | undefined,
  major: number,
  minor: number,
  patch = 0,
): boolean {
  const parsed = parseMcVersion(version);
  if (!parsed) return true;
  if (parsed[0] !== major) return parsed[0] > major;
  if (parsed[1] !== minor) return parsed[1] > minor;
  return parsed[2] >= patch;
}

/** True on versions without the 1.9 attack cooldown (<= 1.8). */
export function isLegacyCombatVersion(version?: string | null): boolean {
  return !isVersionAtLeast(
    version,
    LEGACY_COMBAT_MAJOR,
    LEGACY_COMBAT_MINOR,
  );
}

/**
 * Default melee reach for a game version. From 1.20.5 on the server rejects
 * entity interactions beyond the 3.0 interaction range attribute, so the
 * client-side hitbox reach is lowered to match; older versions keep the
 * classic 3.5 hitbox reach.
 */
export function getDefaultAttackRange(version?: string | null): number {
  return isVersionAtLeast(
    version,
    MODERN_REACH_MAJOR,
    MODERN_REACH_MINOR,
    MODERN_REACH_PATCH,
  )
    ? MODERN_REACH_RANGE
    : Constants.COMBAT.ATTACK_RANGE;
}

/**
 * Modern (1.9+) attack interval in ticks for a weapon: the vanilla attack
 * cooldown, rounded up with a half-tick discount so the swing lands the
 * moment the cooldown bar fills rather than one tick late.
 */
export function getAttackInterval(itemName?: string | null): number {
  const speed = getAttackSpeed(itemName);
  return Math.max(1, Math.ceil(20 / speed - 0.5));
}

// ---------------------------------------------------------------------------
// PVPManager (consolidated from pvp-manager.ts)
// ---------------------------------------------------------------------------

export class PVPManager {
  bot: Bot;
  target: Entity | undefined;
  timeToNextAttack: number = 0;
  wasInRange: boolean = false;
  blockingExplosion: boolean = false;
  private _explosionTimeout: ReturnType<typeof setTimeout> | null = null;
  attackRange: number = Constants.COMBAT.ATTACK_RANGE;
  followRange: number = Constants.COMBAT.FOLLOW_RANGE;
  viewDistance: number = Constants.COMBAT.VIEW_DISTANCE;
  /**
   * Tick at which each entity's hurt immunity expires, keyed by entity id.
   * Fed by the `entityHurt` event and by our own attacks; used to hold
   * swings until a hit would actually register.
   */
  hurtTimers: Map<number, number> = new Map();
  /** Ticks remaining before the offhand shield is raised again after an attack. */
  _shieldRearmTicks: number = 0;
  /**
   * Sequence counter for target switches. `attack()` awaits the
   * pathfinder stop, so two switches can overlap; only the newest one
   * may claim the target.
   */
  private _attackSeq: number = 0;
  /** Ticks spent waiting for a shield-break axe swap to land in the hand. */
  _shieldBreakWaitTicks: number = 0;
  movements: Movements;
  goal: Vec3 | null = null;
  /**
   * Key of the last combat goal handed to the pathfinder. checkRange runs
   * every tick: re-issuing setGoal unconditionally resets pathfinding state
   * (verified live: per-tick setGoal freezes the bot, single setGoal walks
   * fine), so the goal is issued once per key and re-issued only when the
   * pathfinder holds no goal (external stop, arrival, or failed path).
   * NOTE: do NOT gate on isMoving() — it reads false while a path is still
   * being computed, which re-triggers the same storm.
   */
  private _pfGoalKey: string | null = null;

  /**
   * Combat strafing: circles the target laterally while attacking in
   * melee range. While engaged this manager owns movement — the
   * pathfinder goal is released and re-issued again on disengage.
   */
  strafeController: StrafeController = new StrafeController();
  private _strafeEngaged = false;

  constructor(bot: Bot) {
    this.bot = bot;
    this.movements = new Movements(bot);
    this.bot.on("physicsTick", () => this.update());
    this.bot.on("entityGone", (e: { position: Vec3; id: number }) => {
      this.hurtTimers.delete(e.id);
      if (e === this.target) this.stop();
    });
    this.bot.on("entityHurt", (e: Entity) => {
      this.markHurt(e);
    });
  }

  async attack(target: Entity): Promise<void> {
    if (target === this.target) return;
    // The newest call owns the target. attack() awaits stop(), so two
    // switches can overlap: without this guard the older call resumes
    // last and overwrites the newer target (the bot then follows a
    // dead entity).
    const seq = ++this._attackSeq;
    await this.stop();
    if (seq !== this._attackSeq) return;
    this.target = target;
    this.timeToNextAttack = 0;
    if (!this.target) return;
    // Following a live entity now; the static combat goal (if any) no
    // longer describes the pathfinder state.
    this._pfGoalKey = null;
    const pf = this.bot.pathfinder;
    if (pf) {
      pf.setMovements(this.movements);
      pf.setGoal(new goals.GoalFollow(this.target, this.followRange), true);
    }
    this.bot.emit("startedAttacking");
  }

  async stop(): Promise<void> {
    if (this.target == null) return;
    this.target = undefined;
    this.goal = null;
    this._pfGoalKey = null;
    this._disengageStrafe();
    this._clearExplosionTimeout();
    this._cancelShieldRearm();
    this.bot.inventoryManager?.releaseShieldBreaker();
    const pathfinder = this.bot.pathfinder;
    if (pathfinder) {
      // mineflayer-pathfinder's stop() is synchronous: it clears the path
      // and emits 'path_stop' inline. The listener therefore has to be
      // registered BEFORE the call — registering it after meant the event
      // had already fired, so the wait always ran into its 5s timeout and
      // every target switch stalled for five seconds.
      await new Promise<void>((resolve) => {
        const onStop = (): void => {
          clearTimeout(timeout);
          resolve();
        };
        const timeout = setTimeout(() => {
          // Only drop our own listener: removeAllListeners would take
          // every other 'path_stop' listener with it.
          this.bot.removeListener("path_stop", onStop);
          resolve();
        }, 5000);
        this.bot.once("path_stop", onStop);
        pathfinder.stop();
      });
    }
    this.bot.emit("stoppedAttacking");
  }

  forceStop(): void {
    if (this.target == null) return;
    this.target = undefined;
    this.goal = null;
    this._pfGoalKey = null;
    this._disengageStrafe();
    this._clearExplosionTimeout();
    this._cancelShieldRearm();
    this.bot.inventoryManager?.releaseShieldBreaker();
    const pathfinder = this.bot.pathfinder;
    if (pathfinder) pathfinder.setGoal(null);
    this.bot.emit("stoppedAttacking");
  }

  setGoal(pos: Vec3 | null): void {
    this.goal = pos;
    // Invalidate so checkRange issues the new goal even mid-path.
    this._pfGoalKey = null;
  }

  clearGoal(): void {
    this.goal = null;
    this._pfGoalKey = null;
    const pf = this.bot.pathfinder;
    if (pf) pf.setGoal(null);
  }

  update(): void {
    this.checkExplosion();
    this.checkRange();
    this.doStrafe();
    this._updateShieldRearm();
    // Drop the shield-break axe as soon as the target stops blocking; the
    // weapon tree re-arms the best weapon on its next maintenance pass.
    if (this.target && this.bot.inventoryManager?.isShieldBreakActive?.()) {
      if (!this.targetIsBlocking(this.target)) {
        this.bot.inventoryManager.releaseShieldBreaker();
      }
    }
    if (!this.target || this.blockingExplosion) return;
    this.timeToNextAttack--;
    if (this.timeToNextAttack <= 0) {
      this.attemptAttack();
    }
  }

  /**
   * Raise the offhand shield again once the post-attack re-arm delay has
   * elapsed. Tick-based (not a wall-clock timeout) so the re-raise stays in
   * lockstep with the tick loop.
   */
  private _updateShieldRearm(): void {
    if (this._shieldRearmTicks <= 0) return;
    this._shieldRearmTicks--;
    if (this._shieldRearmTicks === 0) this._raiseShield();
  }

  /** Re-raise the offhand shield when auto-blocking is enabled. */
  private _raiseShield(): void {
    if (!(this.bot.combatManager?.isFeatureEnabled("autoBlock") ?? true)) return;
    if (!this.hasShield()) return;
    if (this.bot.inventoryManager?.isItemUseActive?.()) return;
    this.bot.activateItem(true);
  }

  /** Re-raise a shield that was lowered for an attack before combat ends. */
  private _cancelShieldRearm(): void {
    if (this._shieldRearmTicks <= 0) return;
    this._shieldRearmTicks = 0;
    this._raiseShield();
  }

  // -------------------------------------------------------------------------
  // Target geometry: hitbox reach, line of sight, aim point, hurt immunity
  // -------------------------------------------------------------------------

  /** The bot's eye position (attack ray origin). */
  getEyePosition(): Vec3 {
    const entity = this.bot.entity;
    return entity.position.offset(
      0,
      (entity as { eyeHeight?: number }).eyeHeight ?? Constants.PHYSICS.EYE_HEIGHT,
      0,
    );
  }

  /** Target hitbox as an AABB, with player-sized fallbacks. */
  getTargetBox(target: Entity): AABB {
    const width = (target as { width?: number }).width || Constants.PHYSICS.PLAYER_WIDTH;
    const height = (target as { height?: number }).height || Constants.PHYSICS.PLAYER_HEIGHT;
    const half = width / 2;
    return new AABB(
      target.position.x - half,
      target.position.y,
      target.position.z - half,
      target.position.x + half,
      target.position.y + height,
      target.position.z + half,
    );
  }

  /**
   * Distance from the bot's eye to the closest point on the target hitbox.
   * This is the reach metric: a hitbox can be attacked when any part of it
   * falls inside the reach sphere, like the vanilla interaction check.
   */
  getTargetDistance(target: Entity): number {
    return this.getTargetBox(target).distanceToPoint(this.getEyePosition());
  }

  /**
   * Block raycast from the bot's eye to a point. Returns false when any
   * non-empty block volume sits between the two (water and other empty
   * bounding boxes do not count).
   */
  private _hasLineOfSightTo(point: Vec3): boolean {
    const from = this.getEyePosition();
    const delta = point.minus(from);
    const distance = delta.norm();
    if (distance < 1e-6) return true;
    const samples = Math.ceil(distance / 0.25);
    for (let i = 1; i < samples; i++) {
      const sample = from.plus(delta.scaled(i / samples));
      const block = this.bot.blockAt(sample);
      if (block && block.boundingBox !== "empty") return false;
    }
    return true;
  }

  /**
   * Aim point on the target plus whether it is visible. Prefers the middle
   * of the hitbox; when a wall blocks that, the head/eye point is used so
   * attacks over low cover still aim at a sensible spot.
   */
  getAimInfo(target: Entity): { point: Vec3; visible: boolean } {
    const height = (target as { height?: number }).height || Constants.PHYSICS.PLAYER_HEIGHT;
    const center = target.position.offset(0, height / 2, 0);
    if (this._hasLineOfSightTo(center)) return { point: center, visible: true };
    const eyeHeight =
      (target as { eyeHeight?: number }).eyeHeight ?? Constants.PHYSICS.EYE_HEIGHT;
    const eyes = target.position.offset(0, Math.min(eyeHeight, height), 0);
    if (this._hasLineOfSightTo(eyes)) return { point: eyes, visible: true };
    return { point: center, visible: false };
  }

  /**
   * Whether the target is inside melee reach. Reach is measured eye to
   * hitbox; when a wall blocks the line of sight the shorter walls range is
   * enforced instead of the full attack range.
   *
   * The walls range only applies to cover that stands between bot and
   * target at the same level. A target on a platform above the bot is out
   * of reach no matter how close it is: the platform blocks the swing.
   */
  inAttackReach(target: Entity): boolean {
    const distance = this.getTargetDistance(target);
    const heightDiff = Math.abs(
      target.position.y - this.bot.entity.position.y,
    );
    if (heightDiff > Constants.COMBAT.ENEMY_ABOVE_PEARL.MELEE_HEIGHT_LIMIT) {
      return false;
    }
    // Inside the walls range the target is reachable regardless of cover.
    if (distance <= Math.min(this.attackRange, Constants.COMBAT.WALLS_RANGE)) {
      return true;
    }
    if (distance > this.attackRange) return false;
    // Between walls range and full reach: only a visible hitbox counts.
    return this.getAimInfo(target).visible;
  }

  /** Record that an entity was just hit; it is immune for HURT_IMMUNITY_TICKS. */
  markHurt(entity: Entity): void {
    if (!entity) return;
    this.hurtTimers.set(
      entity.id,
      (this.bot.time?.age ?? 0) + Constants.COMBAT.HURT_IMMUNITY_TICKS,
    );
  }

  /** Ticks of hurt immunity left on an entity (0 when hittable). */
  getHurtTicks(entity: Entity): number {
    const until = this.hurtTimers.get(entity.id);
    if (until === undefined) return 0;
    const age = this.bot.time?.age ?? 0;
    if (until <= age) {
      this.hurtTimers.delete(entity.id);
      return 0;
    }
    return until - age;
  }

  // -------------------------------------------------------------------------
  // Shield handling
  // -------------------------------------------------------------------------

  /** Whether the target holds a shield in its off-hand slot. */
  targetHasShield(target: Entity): boolean {
    if (this.bot.supportFeature?.("doesntHaveOffHandSlot")) return false;
    const offhand = (target as { equipment?: Array<{ name?: string } | null> })
      .equipment?.[1];
    return !!offhand?.name?.includes("shield");
  }

  /**
   * Whether the target is actively blocking with a shield. Reads the living
   * entity hand-state metadata byte (bit 0 = hand active); minecraft-data
   * names the field from 1.19 on, older versions use the per-version index.
   */
  targetIsBlocking(target: Entity): boolean {
    if (!this.targetHasShield(target)) return false;
    const state = this._getHandState(target);
    if (state === null) return false;
    const active = (state & 0x01) !== 0;
    const offhandActive = (state & 0x02) !== 0;
    return active && offhandActive;
  }

  /**
   * Read the hand-state metadata byte of a living entity. Index history:
   * 6 through 1.13, 7 for 1.14-1.16 (pose added to Entity), 8 from 1.17
   * (ticks-frozen added). Registry metadata keys win when available.
   */
  private _getHandState(entity: Entity): number | null {
    const name = (entity as { name?: string }).name;
    const keys = name
      ? (this.bot.registry as { entitiesByName?: Record<string, { metadataKeys?: string[] }> })
          ?.entitiesByName?.[name]?.metadataKeys
      : undefined;
    let index = keys?.indexOf("living_entity_flags") ?? -1;
    if (index < 0) {
      if (isVersionAtLeast(this.bot.version, 1, 17)) index = 8;
      else if (isVersionAtLeast(this.bot.version, 1, 14)) index = 7;
      else index = 6;
    }
    const value = (entity.metadata as Record<number, unknown>)?.[index];
    return typeof value === "number" ? value : null;
  }

  /**
   * Shield-break responder: while the target blocks with a shield, swap to
   * the best axe (axes disable shields on hit) and hold the swing until the
   * axe is actually in hand.
   * @returns True when the attack must be skipped this tick
   */
  private _handleShieldBreak(target: Entity): boolean {
    const inv = this.bot.inventoryManager;
    if (!(this.bot.combatManager?.isFeatureEnabled("shieldBreak") ?? true)) {
      this._resetShieldBreak();
      return false;
    }

    if (!this.targetIsBlocking(target)) {
      this._resetShieldBreak();
      return false;
    }

    const hasAxe = this.bot.inventory
      .items()
      .some((item: { name: string }) => item.name.endsWith("_axe"));
    if (!hasAxe) {
      // No axe: swipes are absorbed, but side hits still land.
      this._resetShieldBreak();
      return false;
    }

    if (!inv?.isShieldBreakActive()) {
      void inv?.equipShieldBreaker();
      this._shieldBreakWaitTicks = 0;
    }
    if (!this.bot.heldItem?.name?.endsWith("_axe")) {
      // Give the async equip a bounded number of ticks before giving up.
      this._shieldBreakWaitTicks++;
      if (this._shieldBreakWaitTicks > 20) {
        this._resetShieldBreak();
        return false;
      }
      return true; // wait for the swap
    }
    this._shieldBreakWaitTicks = 0;
    return false;
  }

  /** Drop the shield-break axe state and let the weapon tree re-arm. */
  private _resetShieldBreak(): void {
    this._shieldBreakWaitTicks = 0;
    if (this.bot.inventoryManager?.isShieldBreakActive?.()) {
      this.bot.inventoryManager.releaseShieldBreaker();
    }
  }

  /** True while the bot is actively strafing around its target. */
  get strafeActive(): boolean {
    return this._strafeEngaged;
  }

  /**
   * Strafe around the current target while it is in melee range.
   *
   * Engages once the target is within STRAFE_RADIUS and the bot is on
   * the ground; the pathfinder goal is released so this manager owns
   * movement. Every tick the StrafeController computes the continuous
   * orbit velocity (LiquidBounce-style tangential + radial encirclement
   * redirect), validated by a per-tick physics prediction so the bot never
   * commits to a path that falls into the void. A grounded tick adds a
   * jump impulse (vy = 0.42), so the bot bunny-hops in a continuous orbit
   * around the target. Blocked candidates make the orbit shrink or flip
   * direction instead. Disengaging (target escapes attack range) hands
   * movement back to the pathfinder with a follow goal.
   */
  private doStrafe(): void {
    if (!this.bot.combatManager.isFeatureEnabled("strafe")) {
      this._disengageStrafe();
      return;
    }

    const target = this.target;
    if (!target || !target.isValid) {
      this._disengageStrafe();
      return;
    }
    if (this.blockingExplosion) return;
    if (this.goal) {
      // A static combat goal owns movement; stay out of the way.
      this._disengageStrafe();
      return;
    }
    if (this.bot.combatManager?._enemyAboveLaunchPoint) {
      // The enemy-above pearl approach owns movement: the bot has to walk to
      // a launch point instead of orbiting a target it cannot reach yet.
      this._disengageStrafe();
      return;
    }

    const entity = this.bot.entity;
    const source = entity.position;
    const targetPos = target.position;
    const dist = targetPos.distanceTo(source);

    if (!this._strafeEngaged) {
      if (dist > Constants.MOVEMENT.STRAFE_RADIUS || !entity.onGround) return;
      this._strafeEngaged = true;
      this.strafeController.reset();
      // Take over movement from the pathfinder; released on disengage.
      const pf = this.bot.pathfinder;
      if (pf) pf.setGoal(null);
    } else if (dist > this.attackRange) {
      this._disengageStrafe();
      this._resumeFollow();
      return;
    }

    const collided = (entity as any).isCollidedHorizontally === true;
    const blockAt = (pos: Vec3) => this.bot.blockAt(pos);

    // Continuous orbit plan, validated against the real block world.
    const plan = this.strafeController.computeTick({
      source,
      target: targetPos,
      velocity: entity.velocity,
      onGround: entity.onGround,
      collidedHorizontally: collided,
      world: {
        blockAt,
        getCollisions: (aabb: AABB, minY: number) =>
          getCollisions(aabb, minY, blockAt),
      },
    });

    if (plan) {
      this.bot.utilsManager.applyImpulse(plan.velocity, "set", true);
    }

    // Keep facing the target while sidestepping.
    this.bot.lookAt(targetPos.offset(0, target.height ?? 1.8, 0), true);
  }

  /** Drop strafe state; the pathfinder is not touched. */
  private _disengageStrafe(): void {
    if (!this._strafeEngaged) return;
    this._strafeEngaged = false;
    this.strafeController.reset();
  }

  /**
   * Re-issue the follow goal after strafing hands movement back to the
   * pathfinder. Issued once — only while the pathfinder holds no goal —
   * to avoid the per-tick setGoal storm documented on checkRange.
   */
  private _resumeFollow(): void {
    const target = this.target;
    const pf = this.bot.pathfinder;
    if (!target || !pf || pf.goal) return;
    pf.setMovements(this.movements);
    pf.setGoal(new goals.GoalFollow(target, this.followRange), true);
  }

  private checkRange(): void {
    if (!this.target) return;
    if (this.timeToNextAttack < 0) return;
    const dist = this.target.position.distanceTo(this.bot.entity.position);
    if (dist > this.viewDistance) {
      this.stop();
      return;
    }
    // Hitbox-based reach: no range-entry cooldown reset — attacks wait for
    // the weapon's attack cooldown like the vanilla client does.
    const inRange = this.inAttackReach(this.target);
    this.wasInRange = inRange;
    if (this.goal) {
      const distToGoal = this.bot.entity.position.distanceTo(this.goal);
      const pf = this.bot.pathfinder;
      if (distToGoal > this.attackRange + 1) {
        if (pf) {
          const key = `${Math.round(this.goal.x)}:${Math.round(this.goal.z)}`;
          // setGoal/setMovements both reset path state AND clear control
          // states, so re-issuing them every tick freezes the bot mid-path.
          // Issue once per goal; re-issue only when the pathfinder holds no
          // goal (external stop, arrival, failed path) or movements changed.
          if (
            this._pfGoalKey !== key ||
            !pf.goal ||
            pf.movements !== this.movements
          ) {
            pf.setMovements(this.movements);
            pf.setGoal(
              new goals.GoalNearXZ(this.goal.x, this.goal.z, 1),
              true,
            );
            this._pfGoalKey = key;
          }
        }
      } else if (inRange) {
        if (pf) pf.setGoal(null);
        this._pfGoalKey = null;
      }
    }
  }

  private checkExplosion(): void {
    if (!this.target || !this.hasShield()) return;
    if (
      this.target.name === "creeper" &&
      (this.target.metadata as Record<number, unknown>)[16] === 1
    ) {
      this.blockingExplosion = true;
      const pf = this.bot.pathfinder;
      if (pf) pf.stop();
      this.bot.lookAt(this.target.position.offset(0, 1, 0), true);
      this.bot.activateItem(true);
      this._clearExplosionTimeout();
      this._explosionTimeout = setTimeout(() => {
        this.blockingExplosion = false;
        this._explosionTimeout = null;
      }, 2000);
    }
  }

  private _clearExplosionTimeout(): void {
    if (this._explosionTimeout !== null) {
      clearTimeout(this._explosionTimeout);
      this._explosionTimeout = null;
    }
  }

  private attemptAttack(): void {
    const target = this.target;
    if (!target) return;
    // checkRange() ran earlier this tick and refreshed wasInRange.
    if (!this.wasInRange) {
      this.timeToNextAttack = 1;
      return;
    }
    // Item-use gate: a swing while our own main hand is mid-use would
    // interrupt the use (e.g. a pearl throw). Offhand eats keep swinging —
    // using the off hand does not conflict with a main-hand attack.
    if (this.bot.inventoryManager?.isMainHandUseActive?.()) {
      this.timeToNextAttack = 1;
      return;
    }
    // Hurt-time gate: the target's damage immunity absorbs the hit; hold
    // the swing until the window closes instead of wasting it.
    if (this.getHurtTicks(target) > 0) {
      this.timeToNextAttack = 1;
      return;
    }
    // Shield break: an actively blocking shield absorbs sword hits; swap
    // to an axe (axes disable shields) and wait for it to reach the hand.
    if (this._handleShieldBreak(target)) {
      this.timeToNextAttack = 1;
      return;
    }

    const inv = this.bot.inventoryManager;
    const autoBlock = this.bot.combatManager?.isFeatureEnabled("autoBlock") ?? true;
    const offhandShield = this.hasShield();
    // Lower the shield just before the swing: the server does not apply the
    // attack while the use-item state is active on some versions. Offhand
    // consumables (gapple eats) are left untouched.
    if (offhandShield && autoBlock && !inv?.isItemUseActive?.()) {
      this.bot.deactivateItem();
    }
    const aim = this.getAimInfo(target).point;
    this.bot.lookAt(aim, true);
    // mineflayer flushes lastSentYaw/lastSentPitch in updatePosition(), which
    // runs synchronously right after the physicsTick listeners return. A
    // queueMicrotask callback runs after that same tick, so the server sees
    // the rotation packet before the attack packet.
    const bot = this.bot;
    queueMicrotask(() => {
      if (this.target !== target || !target.isValid) return;
      // Re-check the item-use state here, not only at dispatch time: the
      // combat tree runs right after this manager in the same tick, so a
      // pearl throw can start between the dispatch and this callback. The
      // swing would then go out with the pearl in hand — a hit without the
      // weapon's damage, and the attack packet can cancel the throw.
      if (this.bot.inventoryManager?.isMainHandUseActive?.()) {
        // Retry as soon as the throw is done instead of burning the whole
        // weapon cooldown on a swing that never happened.
        this.timeToNextAttack = 1;
        return;
      }
      try {
        bot.attack(target);
        bot.emit("attackedTarget");
        // Locally mirror the hurt immunity the server will apply; the
        // authoritative `entityHurt` event follows within a tick or two.
        // Only a swing that actually went out counts — marking a target
        // that was never hit would hold the next attack back for the whole
        // immunity window.
        this.markHurt(target);
      } catch (error: unknown) {
        const err = error as Error;
        this.bot.__logger?.debug(`Attack failed: ${err.message}`, "Combat");
      }
    });
    this.timeToNextAttack = this.getWeaponCooldown();
    if (offhandShield && autoBlock) {
      this._shieldRearmTicks = Constants.COMBAT.SHIELD_REBLOCK_TICKS;
    }
  }

  private getWeaponCooldown(): number {
    if (isLegacyCombatVersion(this.bot.version)) {
      return Constants.COMBAT.LEGACY_HIT_INTERVAL;
    }
    const slot =
      this.bot.inventory.slots[this.bot.getEquipmentDestSlot("hand")];
    return getAttackInterval(slot?.name);
  }

  private hasShield(): boolean {
    if (this.bot.supportFeature?.("doesntHaveOffHandSlot")) return false;
    const slot =
      this.bot.inventory.slots[this.bot.getEquipmentDestSlot("off-hand")];
    if (!slot) return false;
    return slot.name.includes("shield");
  }
}
/**
 * Manages combat state, targeting, movement, and automated inventory decisions
 */
class CombatManager {
  public readonly bot: Bot;
  public readonly logger: Logger;
  public readonly alliesSet: Set<string>;
  debounce: boolean;
  lastDamage: number;
  lastHealth: number;
  /**
   * Effective-health samples (health + absorption), one per tick, newest
   * last. They bracket a hit so that the damage can be told apart from
   * a golden apple's absorption wearing off.
   */
  private _healthSamples: { tick: number; total: number }[] = [];
  lastDist: number | null;
  _edgeSneaking: boolean;
  mode: number;
  modeFilterCache: ((e: any) => boolean) | null;
  lastMode: number;
  /** View distance the cached target filter was built with. */
  _filterViewDistance: number = -1;
  lastPearlTime: number;
  /** Timestamp of the last fall-mitigation pearl equip, to prevent repeated fire-and-forget calls while the first is in flight. */
  _lastFallPearlTime: number;
  /** Peak Y of the current falling sequence, used as the fall origin for fall-damage prediction. Reset when grounded. */
  lastMaxFallY: number;
  /** Launch point for enemy-above pearl mitigation pathfinding goal. Null when not pathfinding. */
  _enemyAboveLaunchPoint: Vec3 | null;
  /** Key for the enemy-above pathfinder goal, to avoid re-issuing every tick. */
  _enemyAboveGoalKey: string | null;
  /**
   * Cached launch-point search for an enemy-above pearl approach. The
   * search simulates trajectories for dozens of candidates — far too
   * expensive to repeat on every tick while pathfinding to the launch
   * point. Reused only while the same target stays within a block of its
   * cached position; the TTL bounds staleness otherwise.
   */
  private _launchPointCache: {
    at: number;
    targetId: number | undefined;
    targetPos: Vec3;
    launchPos: Vec3;
    landing: PearlTopLanding;
  } | null = null;
  /**
   * The worker thread that runs the launch point search. Null when the
   * worker could not be started — the search then runs synchronously.
   */
  private _pearlSolver: PearlSolver | null = null;
  /** The aim point of the launch point request that is running. */
  private _launchPointAim: Vec3 | null = null;
  /** Feature toggle states for individual combat features. All default to true. */
  private _featureToggles: Record<string, boolean> = {
    armor: true,
    weapon: true,
    gapple: true,
    totem: true,
    pearl: true,
    strafe: true,
    enemyAbovePearl: true,
    buff: true,
    food: true,
    shieldBreak: true,
    autoBlock: true,
  };
  _isDeciding: boolean;
  private _tree: BTNode | null = null;

  /**
   * @param bot - Mineflayer bot instance
   */
  constructor(bot: Bot) {
    this.bot = bot;
    this.logger = bot.__logger;
    this.alliesSet = new Set();
    this.debounce = false;
    this.lastDamage = 0;
    this.lastHealth = 20;
    this.lastDist = null;
    this._edgeSneaking = false;
    this.mode = 2;
    this.modeFilterCache = null;
    this.lastMode = -1;
    this.lastPearlTime = 0;
    this._lastFallPearlTime = 0;
    this.lastMaxFallY = -Infinity;
    this._enemyAboveLaunchPoint = null;
    this._enemyAboveGoalKey = null;
    this._launchPointCache = null;
    this._isDeciding = false;

    this.setupDecisions();
    // Sample the effective health every tick: the damage of a hit is
    // measured across it, and the absorption wears off on its own.
    this.bot.on("physicsTick", () => this.sampleHealth());

    // The launch point search is far too slow for the main thread: it
    // runs in a worker and the answer is picked up a tick or two later.
    this._pearlSolver = new PearlSolver(bot);
    this._pearlSolver.onSolution = (solution) =>
      this._applyLaunchPointSolution(solution);
    this.bot.on("end", () => {
      this._pearlSolver?.dispose();
      this._pearlSolver = null;
    });
  }

  /**
   * Toggle a combat feature on/off.
   * @param name - Feature name (armor, weapon, gapple, totem, pearl, strafe,
   *   enemyAbovePearl, buff, food, shieldBreak, autoBlock)
   */
  toggleFeature(name: string): void {
    const valid = Object.keys(this._featureToggles);
    if (!(name in this._featureToggles)) {
      this.logger.combat(
        `Unknown feature '${name}'. Valid: ${valid.join(", ")}`,
      );
      return;
    }
    this._featureToggles[name] = !this._featureToggles[name];
    this.logger.combat(
      `Feature '${name}' ${this._featureToggles[name] ? "enabled" : "disabled"}`,
    );
  }

  /**
   * Check if a combat feature is enabled.
   */
  isFeatureEnabled(name: string): boolean {
    return this._featureToggles[name] ?? true;
  }

  /**
   * Get status of all combat features as a formatted string.
   */
  getFeatureStatus(): string {
    const entries = Object.entries(this._featureToggles)
      .map(([name, enabled]) => `  ${name}: ${enabled ? "on" : "off"}`)
      .join("\n");
    return `Combat features:\n${entries}`;
  }

  /**
   * Initialize the combat behavior tree.
   *
   * The tree is stateless: every run reads a fresh context snapshot from
   * `_buildTreeContext()`.
   */
  setupDecisions(): void {
    this._tree = buildCombatTree();
  }

  /**
   * Determine the best offset for throwing an ender pearl using offset-based aiming.
   * @param source - Launch position
   * @param target - Target position
   * @param arcType - 'low' or 'high' arc trajectory
   * @returns Offset and arc info, or null if unreachable
   */
  /**
   * Aim offset for a throw at a target.
   *
   * @param source - Projectile spawn point (the thrower's hand: eye height
   *   minus 0.1), i.e. where the flight starts.
   * @param target - Point the throw should hit
   * @param arcType - "low" for the flat shot, "high" for the steep lob
   * @returns The aim offset (the rise of the aim point above the thrower's
   *   eye) and the arc that solved it, or null when neither arc reaches.
   */
  getBestPearlOffset(
    source: Vec3,
    target: Vec3,
    arcType: "low" | "high" = "low",
  ): { offset: number; arc: "low" | "high" } | null {
    const { VELOCITY, GRAVITY, DRAG, MAX_RANGE } = Constants.COMBAT.ENDER_PEARL;

    // Reject targets beyond maximum ender pearl range (50 blocks).
    const d = Math.hypot(target.x - source.x, target.z - source.z);
    if (d > MAX_RANGE) return null;

    try {
      const offset = this.bot.utilsManager.getProjectileOffset(
        source,
        target,
        VELOCITY,
        GRAVITY,
        DRAG,
        arcType,
      );

      // For now, we'll assume it's clear if we can calculate an offset
      // In a full implementation, we'd simulate the trajectory with the offset

      return { offset, arc: arcType };
    } catch (error) {
      this.logger.debug(
        `Pearl: cannot calculate offset for ${arcType} arc. Reason: ${error.message}`,
        "Combat",
      );

      // Try the other arc type if the first one fails
      if (arcType === "low") {
        try {
          const offset = this.bot.utilsManager.getProjectileOffset(
            source,
            target,
            VELOCITY,
            GRAVITY,
            DRAG,
            "high",
          );
          return { offset, arc: "high" };
        } catch (error) {
          this.logger.debug(
            `Pearl: cannot calculate offset for high arc either. Reason: ${error.message}`,
            "Combat",
          );
          return null;
        }
      }

      return null;
    }
  }

  /**
   * Execute automated combat decisions.
   */
  async executeDecisions(): Promise<void> {
    if (this.debounce) return;
    this.debounce = true;

    try {
      if (this._tree) {
        const blackboard = { ctx: this._buildTreeContext() };
        this._tree.run(blackboard);
      }
    } finally {
      this.debounce = false;
    }
  }

  private _buildTreeContext(): CombatTreeContext {
    return {
      bot: this.bot,
      inv: () => this.bot.inventoryManager,
      getHealthStatus: () => this.getHealthStatus(),
      getFallProtectionStatus: () => this.getFallProtectionStatus(),
      // The options must be forwarded: the tree re-plans a throw with
      // `ignoreCooldown`, because the cooldown starts when the throw is
      // dispatched. Dropping it makes every re-plan read "no mitigation"
      // and the throw is cancelled before it leaves the hand.
      getPearlMitigation: (options) => this.getPearlMitigation(options),
      lastDamage: this.lastDamage,
      lastPearlTime: this.lastPearlTime,
      setLastPearlTime: (ts: number) => {
        this.lastPearlTime = ts;
      },
      logger: this.logger,
    };
  }

  /**
   * Set or cycle combat mode. Callers are responsible for logging.
   * @param mode - Mode number (0-3), or undefined to cycle
   */
  setMode(mode?: number): void {
    this.mode = mode !== undefined ? mode : (this.mode + 1) % 4;
    this.modeFilterCache = null;
  }

  /**
   * Get the entity filter function for the current combat mode. The filter
   * follows the live `pvp.viewDistance`, so runtime config changes apply
   * without a restart; the cache is invalidated when mode or distance move.
   * @returns Filter function that takes an entity and returns boolean
   */
  getTargetFilter(): (e: any) => boolean {
    const viewDistance =
      this.bot.pvp?.viewDistance ?? Constants.COMBAT.VIEW_DISTANCE;
    if (
      this.modeFilterCache &&
      this.lastMode === this.mode &&
      this._filterViewDistance === viewDistance
    ) {
      return this.modeFilterCache;
    }

    const viewDistSq = viewDistance * viewDistance;
    const distSq = (e: any) => {
      const dx = e.position.x - this.bot.entity!.position.x;
      const dz = e.position.z - this.bot.entity!.position.z;
      const dy = e.position.y - this.bot.entity!.position.y;
      return dx * dx + dy * dy + dz * dz;
    };
    let filter: (e: any) => boolean;

    switch (this.mode) {
      case 0: // Mobs
        filter = (e) =>
          e.type === "mob" &&
          e.kind === "Hostile mobs" &&
          distSq(e) <= viewDistSq;
        break;
      case 1: // Players (Survival)
        filter = (e) =>
          e.type === "player" &&
          this.bot.players[e.username]?.gamemode === 0 &&
          !this.alliesSet.has(e.username) &&
          distSq(e) <= viewDistSq;
        break;
      case 2: // Players (All)
        filter = (e) =>
          e.type === "player" &&
          !this.alliesSet.has(e.username) &&
          distSq(e) < viewDistSq;
        break;
      case 3: // All entities
        filter = (e) =>
          (e.type === "player" || e.type === "mob") &&
          !this.alliesSet.has(e.username) &&
          distSq(e) < viewDistSq;
        break;
      default:
        filter = () => false;
    }

    this.modeFilterCache = filter;
    this.lastMode = this.mode;
    this._filterViewDistance = viewDistance;
    return filter;
  }

  /**
   * Add a player to the allies set (excluded from targeting).
   * @param username - Player username
   */
  addAlly(username: string): void {
    this.alliesSet.add(username);
    this.modeFilterCache = null;
  }

  /**
   * Remove a player from the allies set.
   * @param username - Player username
   */
  removeAlly(username: string): void {
    this.alliesSet.delete(username);
    this.modeFilterCache = null;
  }

  /**
   * The health plus the absorption that buffers damage. This is the
   * "effective health": it drops when the bot is hit, and it also drops
   * when a golden apple's absorption wears off.
   */
  private _effectiveHealth(): number {
    const absorb = (this.bot.entity.metadata[11] as unknown as number) || 0;
    return (this.bot.health ?? 0) + absorb;
  }

  /**
   * Sample the effective health for this tick.
   *
   * The samples are kept per tick so that a drop can be attributed to
   * the hit that caused it: the absorption wears off on its own (a
   * golden apple's absorption expires after two minutes) and that drop
   * is not damage.
   */
  sampleHealth(): void {
    const tick = this.bot.time?.age ?? 0;
    this._healthSamples.push({ tick, total: this._effectiveHealth() });
    // A few ticks of history are enough to bracket a hit.
    if (this._healthSamples.length > 8) this._healthSamples.shift();
  }

  /**
   * Record the damage of the hit that was just reported.
   *
   * The damage is the drop of the effective health across the hit. The
   * hit is reported one tick after it happened (the health update and
   * the hurt event are separate packets), so the drop is measured
   * against the sample from before the hit: measuring against the last
   * reported hit instead would also count an absorption expiry that
   * happened in between as damage, and the bot would panic over a hit
   * it never took.
   */
  getLastDamage(): void {
    const total = this._effectiveHealth();
    const tick = this.bot.time?.age ?? 0;
    // The newest sample from before the hit: the drop can land in
    // either of the two ticks around the report.
    let before = this.lastHealth;
    for (let i = this._healthSamples.length - 1; i >= 0; i--) {
      if (this._healthSamples[i].tick <= tick - 2) {
        before = this._healthSamples[i].total;
        break;
      }
    }
    const delta = before - total;
    if (delta > 0) this.lastDamage = delta;
    this.lastHealth = total;
  }

  /**
   * Get the current health status including absorption.
   * @returns Health status object
   */
  getHealthStatus(): {
    totalHealth: number;
    healthPoints: number;
    absorbPoints: number;
  } {
    const hp = this.bot.health!;
    const ap = (this.bot.entity.metadata[11] as unknown as number) || 0;
    return { totalHealth: hp + ap, healthPoints: hp, absorbPoints: ap };
  }

  /**
   * Predict fall damage and determine mitigation strategy.
   * @returns Fall protection status
   */
  getFallProtectionStatus(): {
    isDangerous: boolean;
    predictedDamage?: number;
    ticksToImpact?: number;
    needsTotem?: boolean;
  } {
    const { DANGER_HP } = Constants.COMBAT.SURVIVAL;
    const { totalHealth } = this.getHealthStatus();
    const entity = this.bot.entity;
    const velY = entity.velocity.y;

    if (velY >= 0 || entity.onGround) {
      return { isDangerous: false };
    }

    // Ground: shallow scan for nearby support first, then a deep scan for
    // the real landing ground. Fall-damage prediction needs ground far
    // below a high fall; the default 5-block scan only finds local support.
    let groundY = this.bot.utilsManager.getGroundBelow();
    if (groundY <= -64) {
      groundY = this.bot.utilsManager.getGroundBelow(
        Constants.MOVEMENT.FALL_GROUND_SCAN_DEPTH,
      );
    }
    // Fall origin is the peak Y of this falling sequence (tracked in
    // doDecide). Falling from a teleport or jump starts there; damage is
    // sized from the fall origin, not the current (lower) position.
    const fallOriginY =
      this.lastMaxFallY !== -Infinity ? this.lastMaxFallY : entity.position.y;
    const fallDistance = fallOriginY - groundY;
    const predictedDamage = this.bot.utilsManager.getFallDamage(fallDistance);

    // Time remaining until impact, simulated with vanilla fall physics
    // (gravity + drag, terminal clamp) from current height/velocity.
    const ticksToImpact = this.bot.utilsManager.getFallTicks(
      entity.position.y,
      velY,
      groundY,
    );

    const isDangerous = predictedDamage >= totalHealth - DANGER_HP;
    if (!isDangerous) {
      return { isDangerous: false, predictedDamage, ticksToImpact };
    }

    // Totem of Undying is the only fall mitigation: a dangerous fall is
    // always survivable with a totem, and eating mid-fall can't complete
    // in time (gapple fall-eat is unreachable with vanilla fall physics —
    // dangerous falls land before the consume bar finishes).
    const needsTotem = true;

    this.logger.debug(
      `Fall: DANGEROUS. Predicted damage: ${predictedDamage.toFixed(1)} HP, total health: ${totalHealth.toFixed(1)} HP, fall distance: ${fallDistance.toFixed(1)} blocks, ticks to impact: ${ticksToImpact.toFixed(0)}. Needs totem: ${needsTotem}`,
      "Combat",
    );

    return {
      isDangerous,
      predictedDamage,
      ticksToImpact,
      needsTotem,
    };
  }

  /**
   * Determine whether an ender pearl can mitigate the current situation:
   * either a dangerous fall (teleport to solid ground before impact) or an
   * enemy on elevated position (pathfind to a launch point, then throw to
   * teleport up).
   *
   * Falls take priority over an enemy target. For a fall, only a throw from
   * the current position is considered: pathfinding to a launch point cannot
   * beat the impact. For a target, the current position is tried first and a
   * nearby launch point is searched when that trajectory is blocked.
   *
   * Ender pearl teleport deals PEARL_DAMAGE (5 HP). If the bot's health is
   * below that and it has no armor, the pearl itself would be lethal.
   *
   * @param options - `ignoreCooldown` skips the pearl cooldown check, for
   *   re-planning a throw that was already decided (the cooldown starts
   *   when the throw is dispatched, before the projectile leaves the
   *   hand). `source` overrides the launch position the trajectory is
   *   solved from — a throw that is re-planned just before the release
   *   uses the spot the bot will be at by then, not the one it is at.
   * @returns Whether pearl mitigation is viable, plus optional launch point,
   *   target position, flight time, and aim offset.
   */
  getPearlMitigation(options?: {
    ignoreCooldown?: boolean;
    source?: Vec3;
  }): {
    canMitigate: boolean;
    launchPos?: Vec3;
    targetPos?: Vec3;
    flightTime?: number;
    offset?: number;
    /** True when the throw mitigates a fall rather than closing on a target. */
    isFallMitigation?: boolean;
    /** True when the target sits above the bot (enemy-above pearl case). */
    isEnemyAbove?: boolean;
    /** Ticks until the bot hits the ground (fall mitigation only). */
    ticksToImpact?: number;
  } {
    const entity = this.bot.entity;
    // Trajectories are solved from the pearl's spawn point; the launch
    // angle comes from the look vector, which is relative to the eye.
    const launchPos = options?.source ?? this._launchPosition();
    const inv = this.bot.inventoryManager;
    // The launch point only belongs to an active enemy-above mitigation:
    // clear it on every other path so the strafe controller takes over
    // again once the pearl is away.
    this._enemyAboveLaunchPoint = null;
    if (!inv.hasItem("ender_pearl")) return { canMitigate: false };

    if (
      !options?.ignoreCooldown &&
      Date.now() - this.lastPearlTime < Constants.COMBAT.ENDER_PEARL.COOLDOWN
    ) {
      return { canMitigate: false };
    }

    const pvp = this.bot.pvp as { target?: Entity } | undefined;
    const { VELOCITY, GRAVITY, DRAG, MAX_RANGE } = Constants.COMBAT.ENDER_PEARL;

    // Determine target position: fall mitigation (ground/ceiling) takes
    // priority over an enemy target — a fall kills now, a target can wait.
    let targetPos: Vec3 | null = null;
    let ticksToImpact: number | undefined;
    let isFallMitigation = false;
    let isEnemyAbove = false;

    const fallStatus = this.getFallProtectionStatus();
    // A pre-solved strict top-surface landing: the block-above fall case
    // throws for a surface the pearl has to land on, not for a block it
    // may hit from below.
    let fallTopLanding: PearlTopLanding | null = null;
    if (fallStatus.isDangerous) {
      let groundY = this.bot.utilsManager.getGroundBelow();
      if (groundY <= -64) {
        groundY = this.bot.utilsManager.getGroundBelow(
          Constants.MOVEMENT.FALL_GROUND_SCAN_DEPTH,
        );
      }
      if (groundY > -64) {
        targetPos = new Vec3(entity.position.x, groundY, entity.position.z);
      } else {
        // No ground below — throw for the TOP surface of the block above:
        // the pearl comes down onto it and teleports the bot up onto that
        // block. Aiming at the block's underside would only hit the
        // ceiling, which teleports the bot to the same block it is already
        // under.
        let ceilingTop = this.bot.utilsManager.getGroundTopAbove();
        if (ceilingTop <= -64) {
          ceilingTop = this.bot.utilsManager.getGroundTopAbove(
            Constants.MOVEMENT.FALL_GROUND_SCAN_DEPTH,
          );
        }
        if (ceilingTop > -64) {
          const surface = new Vec3(
            entity.position.x,
            ceilingTop,
            entity.position.z,
          );
          // The throw only counts when the pearl actually lands on that
          // surface; without a reachable landing there is no throw.
          const landing = this._solvePearlTopLanding(launchPos, surface);
          if (landing) {
            fallTopLanding = landing;
            targetPos = surface;
          }
        }
      }
      if (targetPos) {
        isFallMitigation = true;
        ticksToImpact = fallStatus.ticksToImpact;
      }
    }

    if (!targetPos) {
      // Enemy case: target must be out of melee range but within max range.
      const target = pvp?.target;
      if (target) {
        const dist = entity.position.distanceTo(target.position);
        // A target directly overhead is out of reach even when it is only a
        // couple of blocks away in 3D: the platform between bot and target
        // blocks every melee hit. Judging reach by the 3D distance alone
        // would treat it as "in range" and skip the pearl entirely.
        const inMeleeRange = this._isMeleeReachable(target);
        if (!inMeleeRange && dist <= MAX_RANGE) {
          // The platform surface the target stands on, not the target's
          // chest: a pearl aimed at the body drops down the platform's side
          // face and teleports the bot against the wall instead of onto the
          // top. Falls back to the target's own position when it is not
          // standing on solid ground.
          const surface = this._pearlAimPoint(target.position);
          targetPos = surface;
          isEnemyAbove =
            target.position.y - entity.position.y >=
            Constants.COMBAT.ENEMY_ABOVE_PEARL.MIN_HEIGHT;
        }
      }
    }

    if (!targetPos) return { canMitigate: false };

    // targetPos already points at the platform surface (or the fall ground
    // point, whose Y the caller resolved).
    const aimPoint = targetPos;

    // An elevated target is approached by walking to a launch point first:
    // the direct throw from below always lands on the platform's underside
    // or its side face, so it is never a usable throw.
    if (isEnemyAbove) {
      const result = this._enemyAboveMitigation(aimPoint, launchPos);
      if (!result) return { canMitigate: false };
      return {
        canMitigate: true,
        launchPos: result.launchPos,
        targetPos: aimPoint,
        flightTime: result.flightTime,
        offset: result.offset,
        isFallMitigation: false,
        isEnemyAbove: true,
      };
    }

    // The block-above fall case: the pearl has to land on that surface, so
    // the throw is the pre-solved top-surface landing, not the generic
    // trajectory search.
    if (fallTopLanding) {
      // The pearl has to arrive before the bot hits the ground.
      if (
        isFallMitigation &&
        ticksToImpact !== undefined &&
        fallTopLanding.flightTime >= ticksToImpact
      ) {
        return { canMitigate: false };
      }
      return {
        canMitigate: true,
        targetPos: aimPoint,
        flightTime: fallTopLanding.flightTime,
        offset: fallTopLanding.offset,
        isFallMitigation: true,
        isEnemyAbove: false,
        ticksToImpact,
      };
    }

    // A target at or below the bot's level can be reached from where the
    // bot stands.
    const currentTrajectory: PearlTrajectoryResult | null =
      this.bot.utilsManager.getBestPearlTrajectory(
      launchPos,
      aimPoint,
      VELOCITY,
      GRAVITY,
      DRAG,
      1.5, // toleranceRadius
      0.5, // sampleStep
    );

    if (currentTrajectory) {
      // For fall mitigation, pearl must arrive before the bot hits the ground.
      if (isFallMitigation && ticksToImpact !== undefined) {
        if (currentTrajectory.flightTime >= ticksToImpact) {
          return { canMitigate: false };
        }
      }

      const hDist = Math.hypot(
        aimPoint.x - launchPos.x,
        aimPoint.z - launchPos.z,
      );
      let offset: number;
      if (hDist < 1e-6) {
        offset = aimPoint.y > launchPos.y ? 5 : -5;
      } else {
        offset = hDist * Math.tan((currentTrajectory.pitch * Math.PI) / 180);
      }
      return {
        canMitigate: true,
        targetPos: aimPoint,
        flightTime: currentTrajectory.flightTime,
        offset,
        isFallMitigation,
        isEnemyAbove,
        ticksToImpact,
      };
    }

    this.logger.debug(
      `PearlDebug: currentTrajectory=null (direct trajectory search failed)`,
      "Combat",
    );

    // Falls are time-critical: if the direct throw from the current
    // position cannot land before impact, pathfinding to a launch point
    // cannot help — the bot reaches the ground first.
    if (isFallMitigation) return { canMitigate: false };

    return { canMitigate: false };
  }

  /**
   * Mitigation for an enemy that stands on a platform above the bot.
   *
   * The pearl has to land on the platform's top surface, which is only
   * possible from a spot where the throw descends onto that surface. The
   * bot therefore walks to a launch point first (the caller pathfinds to
   * `launchPos`) and throws from there.
   *
   * @param aimPoint - Top surface of the block the target stands on
   * @param launchPos - The pearl's spawn position the throw is solved from
   * @returns The throw to perform, or null when no launch point works
   * @private
   */
  private _enemyAboveMitigation(aimPoint: Vec3, launchPos: Vec3): {
    launchPos?: Vec3;
    flightTime: number;
    offset: number;
  } | null {
    const entity = this.bot.entity!;

    // A throw from where the bot stands right now: valid when the bot
    // already stands clear of the platform.
    const direct = this._solvePearlTopLanding(launchPos, aimPoint);
    if (direct) {
      this._enemyAboveLaunchPoint = null;
      return {
        flightTime: direct.flightTime,
        offset: direct.offset,
      };
    }

    // Otherwise walk to a launch point first.
    const found = this._getPearlLaunchPoint(aimPoint);
    if (!found) return null;

    const { launchPos: spot, landing } = found;
    this._enemyAboveLaunchPoint = spot;

    // Standing on the launch point: recompute from the bot's actual
    // position, so the throw matches where the pearl really leaves from.
    if (this.isAtLaunchPoint(spot)) {
      const actual = this._solvePearlTopLanding(launchPos, aimPoint);
      if (actual) {
        return {
          flightTime: actual.flightTime,
          offset: actual.offset,
        };
      }
      // The spot the bot ended up on does not work: drop the cached
      // launch point so the next search picks a different one.
      this._launchPointCache = null;
    }

    // The offset is relative to the launch point's eye level — that is where
    // the pearl actually leaves from. Using the bot's current position here
    // tilts the throw by however far the bot still has to walk.
    return {
      launchPos: spot,
      flightTime: landing.flightTime,
      offset: landing.offset,
    };
  }

  /**
   * Solve the throw that lands a pearl on the top surface of the platform
   * the aim point belongs to.
   * @private
   */
  private _solvePearlTopLanding(
    source: Vec3,
    aimPoint: Vec3,
  ): PearlTopLanding | null {
    return this.bot.utilsManager.getPearlTopLanding(source, aimPoint);
  }

  /**
   * Launch point for the enemy-above pearl, cached while the target stays
   * put.
   *
   * The search simulates a trajectory per candidate, which is far too
   * expensive to run on the main thread — it runs in a worker thread
   * ({@link PearlSolver}). While the search runs the caller gets no
   * launch point and waits: a launch point is only useful once it is
   * known to work, and the bot is walking to it anyway.
   * @private
   */
  private _getPearlLaunchPoint(aimPoint: Vec3): {
    launchPos: Vec3;
    landing: PearlTopLanding;
  } | null {
    const target = this.bot.pvp?.target;
    const cache = this._launchPointCache;
    const { LAUNCH_CACHE_MS } = Constants.COMBAT.ENEMY_ABOVE_PEARL;
    if (
      cache &&
      Date.now() - cache.at < LAUNCH_CACHE_MS &&
      cache.targetId === target?.id &&
      cache.targetPos.distanceTo(aimPoint) < 1
    ) {
      return { launchPos: cache.launchPos, landing: cache.landing };
    }

    // No usable launch point yet: hand the search to the worker and try
    // again on a later tick. Without a worker the search runs inline.
    if (this._pearlSolver?.available) {
      this._requestPearlLaunchPoint(aimPoint);
      this._launchPointCache = null;
      return null;
    }

    const found = this._findPearlLaunchPoint(aimPoint);
    if (!found) {
      this._launchPointCache = null;
      return null;
    }
    this._launchPointCache = {
      at: Date.now(),
      targetId: target?.id,
      targetPos: aimPoint.clone(),
      launchPos: found.launchPos,
      landing: found.landing,
    };
    return found;
  }

  /**
   * Whether the bot is in position to throw from a launch point.
   *
   * The throw is solved for the launch point's eye level, so the bot has
   * to be on the same ground level there: throwing from a different
   * height tilts the arc and the pearl lands beside the platform instead
   * of on it. The horizontal distance is the one the launch point search
   * used, and the bot may still be sliding onto the spot.
   *
   * @param launchPos - The launch point the throw would be made from
   * @returns Whether the bot may throw from there
   */
  isAtLaunchPoint(launchPos: Vec3): boolean {
    const entity = this.bot.entity;
    if (!entity) return false;
    const horizontal = Math.hypot(
      entity.position.x - launchPos.x,
      entity.position.z - launchPos.z,
    );
    if (
      horizontal >
      Constants.COMBAT.ENEMY_ABOVE_PEARL.LAUNCH_ARRIVAL_RADIUS
    ) {
      return false;
    }
    const vertical = Math.abs(entity.position.y - launchPos.y);
    return (
      vertical <= Constants.COMBAT.ENEMY_ABOVE_PEARL.LAUNCH_HEIGHT_TOLERANCE
    );
  }

  /**
   * Store the launch point the worker found.
   * @private
   */
  private _applyLaunchPointSolution(
    solution: LaunchPointSolution | null,
  ): void {
    if (!solution) return;
    const target = this.bot.pvp?.target;
    this._launchPointCache = {
      at: Date.now(),
      targetId: target?.id,
      targetPos: this._launchPointAim?.clone() ?? solution.launchPos,
      launchPos: solution.launchPos,
      landing: solution.landing,
    };
  }

  /**
   * Hand the launch point search to the worker thread.
   * @private
   */
  private _requestPearlLaunchPoint(aimPoint: Vec3): void {
    const solver = this._pearlSolver;
    if (!solver) return;
    const candidates = this._launchPointCandidates(aimPoint);
    if (candidates.length === 0) return;
    this._launchPointAim = aimPoint.clone();
    solver.request(aimPoint, candidates);
  }

  /**
   * The launch points worth testing: the ground around the bot, closest
   * first.
   * @private
   */
  private _launchPointCandidates(aimPoint: Vec3): LaunchCandidate[] {
    const entity = this.bot.entity!;
    const { LAUNCH_SEARCH_RADIUS } = Constants.COMBAT.ENEMY_ABOVE_PEARL;
    const groundY = this.bot.utilsManager.getGroundBelow();
    if (groundY <= -64) return [];

    const candidates: (LaunchCandidate & { dist: number })[] = [];
    for (let dx = -LAUNCH_SEARCH_RADIUS; dx <= LAUNCH_SEARCH_RADIUS; dx++) {
      for (let dz = -LAUNCH_SEARCH_RADIUS; dz <= LAUNCH_SEARCH_RADIUS; dz++) {
        if (dx === 0 && dz === 0) continue;
        const x = Math.floor(entity.position.x + dx) + 0.5;
        const z = Math.floor(entity.position.z + dz) + 0.5;
        const pos = new Vec3(x, groundY, z);
        const feet = this.bot.blockAt(pos);
        const head = this.bot.blockAt(new Vec3(x, groundY + 1, z));
        const below = this.bot.blockAt(new Vec3(x, groundY - 1, z));
        if (!below || below.boundingBox === "empty") continue;
        if (feet && feet.boundingBox !== "empty") continue;
        if (head && head.boundingBox !== "empty") continue;
        const dist = Math.hypot(
          pos.x - entity.position.x,
          pos.z - entity.position.z,
        );
        if (
          dist <=
          Constants.COMBAT.ENEMY_ABOVE_PEARL.LAUNCH_ARRIVAL_RADIUS
        ) {
          continue;
        }
        candidates.push({ x: pos.x, y: pos.y, z: pos.z, dist });
      }
    }
    candidates.sort((a, b) => a.dist - b.dist);
    // The worker tests the candidates closest first and stops at the
    // first one that works, so a long tail of far-away spots only costs
    // time when nothing works at all.
    return candidates.slice(
      0,
      Constants.COMBAT.ENEMY_ABOVE_PEARL.LAUNCH_SEARCH_MAX_CANDIDATES,
    );
  }

  /**
   * Whether the bot can hit the target with a melee swing from where it
   * stands. A target that is well above (or below) the bot is out of reach:
   * the platform between them blocks the swing even when the 3D distance is
   * inside the attack range.
   * @private
   */
  private _isMeleeReachable(target: Entity): boolean {
    const entity = this.bot.entity!;
    const heightDiff = Math.abs(target.position.y - entity.position.y);
    if (heightDiff > Constants.COMBAT.ENEMY_ABOVE_PEARL.MELEE_HEIGHT_LIMIT) {
      return false;
    }
    const pvp = this.bot.pvp as
      | { inAttackReach?: (t: Entity) => boolean; attackRange?: number }
      | undefined;
    if (typeof pvp?.inAttackReach === "function") {
      return pvp.inAttackReach(target);
    }
    // Fallback when the PVP manager is not available: the 3D distance.
    const attackRange = pvp?.attackRange ?? Constants.COMBAT.ATTACK_RANGE;
    return entity.position.distanceTo(target.position) <= attackRange;
  }

  /**
   * Launch position of a thrown pearl: the point the projectile spawns at.
   * Vanilla spawns it at the eye height minus 0.1, so the pearl leaves the
   * hand at 1.52 above the feet. Trajectories are solved from here; the
   * launch angle itself comes from the look vector, which is relative to
   * the eye.
   * @private
   */
  private _launchPosition(): Vec3 {
    const entity = this.bot.entity!;
    return entity.position.offset(0, Constants.PHYSICS.PEARL_SPAWN_OFFSET, 0);
  }

  /**
   * Find a valid launch point near the bot from which an ender pearl lands
   * on the top surface of the platform the target stands on. Launch points
   * are ground-level positions around the bot with solid ground below, air
   * above, and a trajectory that descends onto the platform's top. Only the
   * closest candidates are tested, to bound the cost of the trajectory
   * simulations.
   *
   * The launch point is the position the pearl is thrown FROM, so the aim
   * offset has to be measured against the launch point's own eye level —
   * computing it against the bot's current position would tilt the throw.
   * @private
   */
  private _findPearlLaunchPoint(aimPoint: Vec3): {
    launchPos: Vec3;
    landing: PearlTopLanding;
  } | null {
    const entity = this.bot.entity!;
    const { LAUNCH_SEARCH_RADIUS, LAUNCH_SEARCH_MAX_CANDIDATES } =
      Constants.COMBAT.ENEMY_ABOVE_PEARL;

    const groundY = this.bot.utilsManager.getGroundBelow();
    if (groundY <= -64) return null;

    const candidates: { pos: Vec3; dist: number }[] = [];

    // Scan in a radius around the bot.
    for (let dx = -LAUNCH_SEARCH_RADIUS; dx <= LAUNCH_SEARCH_RADIUS; dx++) {
      for (let dz = -LAUNCH_SEARCH_RADIUS; dz <= LAUNCH_SEARCH_RADIUS; dz++) {
        if (dx === 0 && dz === 0) continue; // skip bot's own position

        // Snap to block centers so the standability check is exact.
        const launchPos = new Vec3(
          Math.floor(entity.position.x + dx) + 0.5,
          groundY,
          Math.floor(entity.position.z + dz) + 0.5,
        );

        // Position must be clear (air at feet and head level), ground below must be solid.
        const blockAtFeet = this.bot.blockAt(launchPos);
        const blockAbove = this.bot.blockAt(
          new Vec3(launchPos.x, launchPos.y + 1, launchPos.z),
        );
        const blockBelow = this.bot.blockAt(
          new Vec3(launchPos.x, launchPos.y - 1, launchPos.z),
        );

        if (!blockBelow || blockBelow.boundingBox === "empty") continue; // no ground below
        if (blockAtFeet && blockAtFeet.boundingBox !== "empty") continue; // feet blocked
        if (blockAbove && blockAbove.boundingBox !== "empty") continue; // head blocked

        const dist = Math.hypot(
          launchPos.x - entity.position.x,
          launchPos.z - entity.position.z,
        );
        // A launch point the bot is already standing on is not a launch
        // point: the direct throw from there was already tried.
        if (dist <= Constants.COMBAT.ENEMY_ABOVE_PEARL.LAUNCH_ARRIVAL_RADIUS) {
          continue;
        }

        candidates.push({ pos: launchPos, dist });
      }
    }

    if (candidates.length === 0) return null;

    // Sort by distance to bot (prefer closer launch points).
    candidates.sort((a, b) => a.dist - b.dist);

    // Return the first candidate whose trajectory lands on the platform top.
    const limit = Math.min(candidates.length, LAUNCH_SEARCH_MAX_CANDIDATES);
    for (let i = 0; i < limit; i++) {
      const launchPos = candidates[i].pos;
      // Solve from the launch point's SPAWN position (eye minus 0.1), the
      // same origin the direct throw uses. Solving from the eye instead
      // shifts the flight by 0.1 blocks: the candidate validates, but the
      // throw from that very spot does not — the throw is then cancelled
      // and the launch point is searched again on every tick.
      const launchSpawnPos = launchPos.offset(
        0,
        Constants.PHYSICS.PEARL_SPAWN_OFFSET,
        0,
      );
      const landing = this._solvePearlTopLanding(launchSpawnPos, aimPoint);
      if (landing) return { launchPos, landing };
    }

    return null;
  }

  /**
   * Aim point for an ender pearl meant to land the bot on the platform the
   * target is standing on. The target's own position is the wrong reference:
   * a pearl aimed there drops down the platform's side face and teleports
   * the bot against the wall instead of onto the top. Aiming at the top
   * surface of the block under the target puts the landing on the platform.
   *
   * Falls through to the target's own position when there is no solid block
   * under it (a target in mid-air, or a fall-mitigation ground point where
   * the caller already knows the landing Y).
   * @param targetPos - The target's feet position
   * @private
   */
  private _pearlAimPoint(targetPos: Vec3): Vec3 {
    // The target's feet are in air when it stands on a platform, so probe
    // from the feet level downward for the first solid block.
    for (let dy = 0; dy <= 2; dy++) {
      const block = this.bot.blockAt(
        new Vec3(targetPos.x, targetPos.y + 0.01 - dy, targetPos.z),
        true,
      );
      if (block && block.boundingBox !== "empty" && block.shapes?.length) {
        const topY =
          block.position.y + block.shapes[0][Constants.SHAPE.MAX_Y];
        return new Vec3(targetPos.x, topY, targetPos.z);
      }
    }
    return targetPos;
  }

  /**
   * Whether the bot is wearing any armor (any armor slot occupied).
   * Used to judge whether ender pearl teleport damage (5 HP) is lethal.
   * @private
   */
  private _hasAnyArmor(): boolean {
    for (const slot of ["head", "torso", "legs", "feet"]) {
      const slotNum = this.bot.getEquipmentDestSlot(slot);
      const item = this.bot.inventory.slots[slotNum];
      if (item) return true;
    }
    return false;
  }

  /** Public wrapper: whether any armor piece is worn. */
  hasAnyArmor(): boolean {
    return this._hasAnyArmor();
  }

  /**
   * Whether a lethal pearl teleport should be preceded by eating a golden
   * apple. A pearl deals PEARL_DAMAGE (5 HP); at less health with no armor
   * the teleport itself kills, so the apple's absorption/regeneration must
   * land first.
   *
   * Eating first is only worthwhile while the pearl's flight time does not
   * exceed the eat time: a short flight means eat-then-throw completes in
   * time, while a long flight is better served by throwing first and eating
   * during the flight (handled by the heal branch once the pearl is away).
   *
   * @param flightTime - Pearl flight time in ticks
   * @param healthPoints - Current health (without absorption)
   * @param hasArmor - Whether any armor is worn
   * @param hasGapple - Whether a golden apple is available
   */
  shouldEatBeforePearl(
    flightTime: number | undefined,
    healthPoints: number,
    hasArmor: boolean,
    hasGapple: boolean,
  ): boolean {
    if (!hasGapple || hasArmor) return false;
    if (healthPoints >= Constants.COMBAT.SURVIVAL.PEARL_DAMAGE) return false;
    return (flightTime ?? 0) <= Constants.COMBAT.SURVIVAL.EAT_TICKS;
  }

  /**
   * Main tick handler for combat logic.
   */
  doDecide = async (): Promise<void> => {
    if (this._isDeciding) return;
    this._isDeciding = true;

    try {
      this.updateTarget();
      this.doAvoid();
      this.doEdgeProtection();
      // Track the peak Y of the current falling sequence so fall-damage
      // prediction uses the fall origin, not the current (lower) position.
      // Reset the baseline whenever the bot is grounded.
      const entity = this.bot.entity;
      if (entity) {
        if (entity.onGround) {
          this.lastMaxFallY = -Infinity;
        } else {
          this.lastMaxFallY = Math.max(this.lastMaxFallY, entity.position.y);
        }
      }
      await this.executeDecisions();
    } catch (error: unknown) {
      const err = error as Error;
      const targetName = this.bot.pvp?.target?.username ?? "none";
      err.message = `Error in combat loop (mode=${this.mode}, target=${targetName}, health=${this.bot.health?.toFixed(1) ?? "unknown"}): ${err.message}`;
      this.logger.error(err, "Combat");
    } finally {
      this._isDeciding = false;
    }
  };

  /**
   * Avoid unwanted blocks (web, cactus, liquid) by applying a velocity impulse.
   */
  doAvoid(): void {
    const unwanted = this.bot.utilsManager.isInUnwanted(
      this.bot.entity!.position,
    );
    if (unwanted) {
      const impulse = this.bot.utilsManager.getFlatVelocity(
        this.bot.entity!.position,
        unwanted as unknown as Vec3,
        180,
        0.01,
        this.bot.entity.velocity.y,
      );
      this.bot.utilsManager.applyImpulse(impulse, "set");
    }
  }

  /**
   * Edge protection — prevents falling off block edges by sneaking and
   * nudging back toward the block center when the bot drifts too far.
   *
   * Activates only when on ground and the bot's position on either the X
   * or Z axis is ≥0.5 blocks from the center of the block below.
   */
  doEdgeProtection(): void {
    const bot = this.bot;
    if (!bot.entity.onGround) return;

    const pos = bot.entity!.position;
    const blockX = Math.floor(pos.x) + 0.5;
    const blockZ = Math.floor(pos.z) + 0.5;

    const dx = Math.abs(pos.x - blockX);
    const dz = Math.abs(pos.z - blockZ);

    if (dx < 0.5 && dz < 0.5) {
      // Centered — release sneak if we set it
      if (this._edgeSneaking) {
        bot.setControlState("sneak", false);
        this._edgeSneaking = false;
      }
      return;
    }

    // Edge detected — sneak and nudge toward center
    if (!this._edgeSneaking) {
      this.logger.debug(
        `Edge: near block boundary at dx=${dx.toFixed(2)}b, dz=${dz.toFixed(2)}b, engaging sneak`,
        "Combat",
      );
    }
    bot.setControlState("sneak", true);
    this._edgeSneaking = true;

    const nudgeX = dx >= 0.5 ? Math.sign(blockX - pos.x) * 0.02 : 0;
    const nudgeZ = dz >= 0.5 ? Math.sign(blockZ - pos.z) * 0.02 : 0;

    if (nudgeX !== 0 || nudgeZ !== 0) {
      bot.entity.velocity.add(new Vec3(nudgeX, 0, nudgeZ));
    }
  }

  /**
   * Update the PVP target to the best entity matching the current mode
   * filter. Candidates are ranked by type (players beat hostile mobs beat
   * everything else), then by hurt immunity (a target already in its damage
   * immunity window would absorb the first swing), then by hitbox distance.
   */
  updateTarget(): void {
    const currentTarget = this.bot.pvp.target;
    const filter = this.getTargetFilter();

    // Stickiness: if the current target is still alive and matches the filter,
    // keep it instead of re-scanning all entities every tick.
    if (currentTarget && currentTarget.isValid && filter(currentTarget)) {
      return;
    }

    const target = this.selectTarget(filter);
    if (target) {
      const dist = this.bot.pvp.getTargetDistance(target);
      this.logger.debug(
        `Target: acquired ${target.username ?? target.name ?? "entity"}. Distance: ${dist.toFixed(1)}b`,
        "Combat",
      );
      this.bot.pvp.attack(target);
    } else {
      if (currentTarget) {
        this.logger.debug(`Target: lost. No valid entity in range`, "Combat");
      }
      this.bot.pvp.forceStop();
    }
  }

  /**
   * Pick the best target among the entities passing the mode filter.
   * @param filter - Mode filter from getTargetFilter
   * @returns The chosen entity, or null when nothing qualifies
   */
  selectTarget(filter: (e: any) => boolean): Entity | null {
    let best: Entity | null = null;
    let bestScore: [number, number, number] | null = null;

    for (const id of Object.keys(this.bot.entities)) {
      const entity = this.bot.entities[id as unknown as number];
      if (!entity || !entity.isValid || entity === this.bot.entity) continue;
      if (!filter(entity)) continue;

      const score: [number, number, number] = [
        this._targetTypeWeight(entity),
        this.bot.pvp.getHurtTicks(entity),
        this.bot.pvp.getTargetDistance(entity),
      ];
      if (
        bestScore === null ||
        score[0] < bestScore[0] ||
        (score[0] === bestScore[0] &&
          (score[1] < bestScore[1] ||
            (score[1] === bestScore[1] && score[2] < bestScore[2])))
      ) {
        best = entity;
        bestScore = score;
      }
    }

    return best;
  }

  /**
   * Target type priority: players first, then hostile mobs, then the rest.
   * @private
   */
  private _targetTypeWeight(entity: any): number {
    if (entity.type === "player") return 0;
    if (entity.type === "mob" && entity.kind === "Hostile mobs") return 1;
    return 2;
  }

  // ---------------------------------------------------------------------------
  // Production testable actions (promoted from debug.ts)
  // ---------------------------------------------------------------------------

  /**
   * Throw an ender pearl at a target position using the specified arc type.
   * Calculates eye position, determines best offset, equips and throws.
   */
  async throwPearlAt(
    targetPos: Vec3,
    arcType: "low" | "high" | "auto" = "low",
  ): Promise<void> {
    const launchPos = this.bot.entity.position.offset(
      0,
      Constants.PHYSICS.PEARL_SPAWN_OFFSET,
      0,
    );
    const resolvedArc: "low" | "high" = arcType === "auto" ? "low" : arcType;
    const result = this.getBestPearlOffset(launchPos, targetPos, resolvedArc);
    if (!result) {
      this.logger.debug("Pearl: cannot reach target with any arc", "Combat");
      return;
    }
    await this.bot.inventoryManager.equipPearl(targetPos, result.offset);
    this.lastPearlTime = Date.now();
  }

  async _waitUntilSettled(): Promise<void> {
    let iterations = 0;
    while (
      !this.bot.entity.onGround ||
      this.bot.entity.velocity.x !== 0 ||
      this.bot.entity.velocity.z !== 0
    ) {
      if (++iterations > 200) {
        this.logger.warning(
          `_waitUntilSettled: timed out after 200 ticks (onGround=${this.bot.entity.onGround})`,
          "Combat",
        );
        break;
      }
      await this.bot.waitForTicks!(1);
    }
  }
}

/**
 * Attach the CombatManager to a bot instance.
 * @param bot - Mineflayer bot instance
 * @returns The same bot instance with combatManager attached
 */
export function attachCombat(bot: Bot): Bot {
  bot.combatManager = new CombatManager(bot);
  return bot;
}

export function plugin(bot: Bot): void {
  bot.pvp = new PVPManager(bot);
}

export { CombatManager };
