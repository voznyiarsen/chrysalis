import { Logger } from "./logger";
import { Constants } from "./constants";
import { Vec3 } from "vec3";
import { Bot } from "mineflayer";
import { Entity } from "prismarine-entity";
import { goals, Movements } from "mineflayer-pathfinder";
import { buildCombatTree, CombatTreeContext } from "./behavior-tree";
import { StrafeController } from "./strafe";
import { Node as BTNode, SUCCESS } from "behaviortree";
import { AABB } from "./utils";
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
// PVPManager (consolidated from pvp-manager.ts)
// ---------------------------------------------------------------------------

export class PVPManager {
  bot: Bot;
  target: Entity | undefined;
  timeToNextAttack: number = 0;
  wasInRange: boolean = false;
  blockingExplosion: boolean = false;
  private _explosionTimeout: ReturnType<typeof setTimeout> | null = null;
  private _shieldReequipTimeout: ReturnType<typeof setTimeout> | null = null;
  attackRange: number = Constants.COMBAT.ATTACK_RANGE;
  followRange: number = Constants.COMBAT.FOLLOW_RANGE;
  viewDistance: number = Constants.COMBAT.VIEW_DISTANCE;
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
    this.bot.on("entityGone", (e: { position: Vec3 }) => {
      if (e === this.target) this.stop();
    });
  }

  async attack(target: Entity): Promise<void> {
    if (target === this.target) return;
    await this.stop();
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
    this._clearShieldReequipTimeout();
    const pathfinder = this.bot.pathfinder;
    if (pathfinder) {
      pathfinder.stop();
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("timeout")), 5000);
          this.bot.once("path_stop", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } catch {
        this.bot.removeAllListeners("path_stop");
        pathfinder.setGoal(null);
      }
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
    this._clearShieldReequipTimeout();
    const pathfinder = this.bot.pathfinder;
    if (pathfinder) pathfinder.setGoal(null);
    this.bot.emit("stoppedAttacking");
  }

  private _clearShieldReequipTimeout(): void {
    if (this._shieldReequipTimeout !== null) {
      clearTimeout(this._shieldReequipTimeout);
      this._shieldReequipTimeout = null;
    }
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
    if (!this.target || this.blockingExplosion) return;
    this.timeToNextAttack--;
    if (this.timeToNextAttack <= 0) {
      this.attemptAttack();
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
    const inRange = dist <= this.attackRange;
    if (!this.wasInRange && inRange) {
      this.timeToNextAttack = 0;
    }
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
    if (!this.target) return;
    if (!this.wasInRange) {
      this.timeToNextAttack = this.getWeaponCooldown();
      return;
    }
    if (this.hasShield()) {
      this.bot.deactivateItem();
    }
    this.bot.lookAt(
      this.target.position.offset(0, this.target.height ?? 1.8, 0),
      true,
    );
    this.bot.attack(this.target);
    this.bot.emit("attackedTarget");
    this.timeToNextAttack = this.getWeaponCooldown();
    if (this.hasShield()) {
      this._clearShieldReequipTimeout();
      this._shieldReequipTimeout = setTimeout(() => {
        this._shieldReequipTimeout = null;
        if (this.target && this.hasShield()) {
          this.bot.activateItem(true);
        }
      }, 150);
    }
  }

  private getWeaponCooldown(): number {
    const slot =
      this.bot.inventory.slots[this.bot.getEquipmentDestSlot("hand")];
    return getCooldown(slot?.name);
  }

  private hasShield(): boolean {
    if (this.bot.supportFeature?.("doesntHaveOffHandSlot")) return false;
    const slot =
      this.bot.inventory.slots[this.bot.getEquipmentDestSlot("off-hand")];
    if (!slot) return false;
    return slot.name.includes("shield");
  }
}
class CombatDecision {
  condition: () => boolean;
  action: () => Promise<void>;
  name: string;
  /**
   * Priority tier. Higher values are checked first and short-circuit the
   * decision loop if their action swaps the held item. 0 = run after higher
   * tiers and never short-circuit.
   */
  priority: number;

  /**
   * @param condition - Function returning boolean
   * @param action - Async function to execute
   * @param name - Decision name
   * @param priority - Priority tier; default 0. Tier >= 1 may short-circuit
   *   lower tiers if its action swaps the held item.
   */
  constructor(
    condition: () => boolean,
    action: () => Promise<void>,
    name: string,
    priority: number = 0,
  ) {
    this.condition = condition;
    this.action = action;
    this.name = name;
    this.priority = priority;
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
  lastDist: number | null;
  _edgeSneaking: boolean;
  mode: number;
  modeFilterCache: ((e: any) => boolean) | null;
  lastMode: number;
  lastPearlTime: number;
  /** Timestamp of the last fall-mitigation pearl equip, to prevent repeated fire-and-forget calls while the first is in flight. */
  _lastFallPearlTime: number;
  /** Peak Y of the current falling sequence, used as the fall origin for fall-damage prediction. Reset when grounded. */
  lastMaxFallY: number;
  /** Launch point for enemy-above pearl mitigation pathfinding goal. Null when not pathfinding. */
  _enemyAboveLaunchPoint: Vec3 | null;
  /** Key for the enemy-above pathfinder goal, to avoid re-issuing every tick. */
  _enemyAboveGoalKey: string | null;
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
  };
  public decisions: CombatDecision[];
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
    this.decisions = [];
    this._isDeciding = false;

    this.setupDecisions();
  }

  /**
   * Toggle a combat feature on/off.
   * @param name - Feature name (armor, weapon, gapple, totem, pearl, strafe, enemyAbovePearl, buff, food)
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
   */
  setupDecisions(): void {
    const ctx: CombatTreeContext = {
      bot: this.bot,
      inv: () => this.bot.inventoryManager,
      getHealthStatus: () => this.getHealthStatus(),
      getFallProtectionStatus: () => this.getFallProtectionStatus(),
      getFallPearlMitigation: () => this.getFallPearlMitigation(),
      getEnemyAbovePearlMitigation: () => this.getEnemyAbovePearlMitigation(),
      getBestPearlOffset: (source, target, arc) => this.getBestPearlOffset(source, target, arc),
      lastDamage: this.lastDamage,
      lastPearlTime: this.lastPearlTime,
      setLastPearlTime: (ts: number) => {
        this.lastPearlTime = ts;
      },
      logger: this.logger,
    };
    this._tree = buildCombatTree(ctx);
    this.decisions = [];
  }

  /** @deprecated kept for backward compat */
  private _legacySetupDecisions(): void {
    const { CRITICAL_HP_MULT, LOW_FOOD } = Constants.COMBAT;
    const inv = () => this.bot.inventoryManager;

    this.decisions = [
      new CombatDecision(
        () => {
          const status = this.getFallProtectionStatus();
          return status.isDangerous;
        },
        async () => {
          const status = this.getFallProtectionStatus();
          // Totem of Undying is the only fall mitigation.
          if (!status.needsTotem) return;
          if (!inv().hasItem("totem_of_undying")) return;
          this.logger.combat(
            "Fall: dangerous, equipping Totem of Undying",
          );
          await inv().equipTotem();
        },
        "fall",
        10,
      ),

      new CombatDecision(
        () => true,
        () => inv().equipArmor(),
        "armor",
        5,
      ),
      new CombatDecision(
        () => true,
        () => inv().equipWeapon(),
        "weapon",
        5,
      ),

      new CombatDecision(
        () => {
          const { totalHealth } = this.getHealthStatus();
          const hasTotems = inv().hasItem("totem_of_undying");
          const hasGapple = inv().hasItem("golden_apple");
          return (
            hasTotems &&
            (totalHealth <= (this.lastDamage || 1) * CRITICAL_HP_MULT ||
              !hasGapple)
          );
        },
        async () => {
          await inv().equipTotem();
        },
        "totem",
        10,
      ),

      new CombatDecision(
        () => {
          const target = this.bot.pvp.target;
          if (!target) return false;

          const { COOLDOWN } = Constants.COMBAT.ENDER_PEARL;
          if (Date.now() - this.lastPearlTime < COOLDOWN) return false;

          const dist = this.bot.entity!.position.distanceTo(target.position);
          const hasPearls = inv().hasItem("ender_pearl");
          if (!hasPearls || dist <= this.bot.pvp.attackRange || dist > 50)
            return false;

          const eyePos = this.bot.entity!.position.offset(
            0,
            Constants.PHYSICS.EYE_HEIGHT,
            0,
          );
          const targetPos = target.position.offset(0, target.height / 2, 0);

          return this.getBestPearlOffset(eyePos, targetPos, "low") !== null;
        },
        async () => {
          const target = this.bot.pvp.target;
          const eyePos = this.bot.entity!.position.offset(
            0,
            Constants.PHYSICS.EYE_HEIGHT,
            0,
          );
          const targetPos = target.position.offset(0, target.height / 2, 0);

          const result = this.getBestPearlOffset(eyePos, targetPos, "low");
          if (!result) {
            this.logger.debug(
              `Pearl: cannot throw at ${target.username}. Target unreachable`,
              "Combat",
            );
            return;
          }

          this.logger.combat(
            `Throwing ${result.arc}-arc pearl at ${target.username}. Vertical offset: ${result.offset.toFixed(2)}b`,
          );
          await inv().equipPearl(targetPos, result.offset);

          this.lastPearlTime = Date.now();
        },
        "pearl",
        0,
      ),

      new CombatDecision(
        () => {
          const { totalHealth, healthPoints } = this.getHealthStatus();
          const hasGapple = inv().hasItem("golden_apple");
          const hasTotems = inv().hasItem("totem_of_undying");
          const regeneration = this.bot.entity.effects["10"];
          return (
            hasGapple &&
            healthPoints < 20 &&
            !regeneration &&
            (totalHealth > (this.lastDamage || 1) * CRITICAL_HP_MULT ||
              !hasTotems)
          );
        },
        () => inv().equipGapple(),
        "heal",
        10,
      ),

      new CombatDecision(
        () => {
          const { totalHealth } = this.getHealthStatus();
          const hasPotion = inv().hasItem("potion");
          const strength = this.bot.entity.effects["5"];
          const hasTotems = inv().hasItem("totem_of_undying");
          const hasGapple = inv().hasItem("golden_apple");
          return (
            hasPotion &&
            !strength &&
            (totalHealth > 10 || (!hasTotems && !hasGapple))
          );
        },
        () => inv().equipBuff(),
        "buff",
        0,
      ),

      new CombatDecision(
        () => {
          const { totalHealth, healthPoints } = this.getHealthStatus();
          const hasGapple = inv().hasItem("golden_apple");
          const hasTotems = inv().hasItem("totem_of_undying");
          const hasFood = inv().hasFood();
          const regeneration = this.bot.entity.effects["10"];

          const safe =
            totalHealth > (this.lastDamage || 1) * CRITICAL_HP_MULT ||
            !hasTotems;
          const needsFood = this.bot.food! < LOW_FOOD;
          const needsHealingFood =
            healthPoints < 20 && !regeneration && !hasGapple;

          return hasFood && (needsFood || needsHealingFood) && safe;
        },
        () => inv().equipFood(),
        "food",
        0,
      ),

      new CombatDecision(
        () => {
          const { totalHealth } = this.getHealthStatus();
          return (
            totalHealth > (this.lastDamage || 1) * CRITICAL_HP_MULT ||
            !inv().hasItem("totem_of_undying")
          );
        },
        () => inv().equipUtility(),
        "utility",
        0,
      ),

      new CombatDecision(
        () => true,
        () => this.decideIfToss(),
        "toss",
        0,
      ),
    ];
  }

  /**
   * Determine the best pitch for throwing an ender pearl.
   * Delegates to {@link UtilsManager.getBestPearlTrajectory} which samples
   * landing points within a 1.5-block tolerance radius, checks obstacles,
   * and ranks by unobstructed > flight time > landing precision.
   *
   * @param source - Launch position
   * @param target - Target position
   * @returns Pitch and arc info, or null if unreachable
   */
  getBestPearlPitch(
    source: Vec3,
    target: Vec3,
  ): { pitch: number; arc: "low" | "high" } | null {
    const result = this.bot.utilsManager.getBestPearlTrajectory(source, target);

    if (result) {
      if (result.arc === "high") {
        this.logger.debug(
          "Pearl: low arc blocked, evaluating high arc via tolerance sampling",
          "Combat",
        );
      }
      return { pitch: result.pitch, arc: result.arc };
    }
    return null;
  }

  /**
   * Determine the best offset for throwing an ender pearl using offset-based aiming.
   * This is the offset-based alternative to getBestPearlPitch.
   *
   * @param source - Launch position
   * @param target - Target position
   * @param arcType - 'low' or 'high' arc trajectory
   * @returns Offset and arc info, or null if unreachable
   */
  getBestPearlOffset(
    source: Vec3,
    target: Vec3,
    arcType: "low" | "high" = "low",
  ): { offset: number; arc: "low" | "high" } | null {
    const { VELOCITY, GRAVITY, DRAG } = Constants.COMBAT.ENDER_PEARL;

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
      getFallPearlMitigation: () => this.getFallPearlMitigation(),
      getEnemyAbovePearlMitigation: () => this.getEnemyAbovePearlMitigation(),
      getBestPearlOffset: (source, target, arc) => this.getBestPearlOffset(source, target, arc),
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
   * Get the entity filter function for the current combat mode.
   * @returns Filter function that takes an entity and returns boolean
   */
  getTargetFilter(): (e: any) => boolean {
    if (this.modeFilterCache && this.lastMode === this.mode)
      return this.modeFilterCache;

    const viewDistSq =
      Constants.COMBAT.VIEW_DISTANCE * Constants.COMBAT.VIEW_DISTANCE;
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
   * Record the last damage taken based on health change.
   */
  getLastDamage(): void {
    const absorb = (this.bot.entity.metadata[11] as unknown as number) || 0;
    const health = this.bot.health! + absorb;
    const delta = this.lastHealth - health;
    if (delta > 0) this.lastDamage = delta;
    this.lastHealth = health;
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
   * Determine whether an ender pearl can mitigate the current dangerous fall
   * by teleporting the bot to solid ground before impact.
   *
   * Ender pearl teleport deals PEARL_DAMAGE (5 HP). If the bot's health is
   * below that and it has no armor, the pearl itself would be lethal — the
   * caller should eat a golden apple first in that case.
   *
   * @returns Whether pearl mitigation is viable, plus target position and flight time.
   */
  getFallPearlMitigation(): {
    canMitigate: boolean;
    targetPos?: Vec3;
    flightTime?: number;
    offset?: number;
  } {
    const status = this.getFallProtectionStatus();
    if (!status.isDangerous) return { canMitigate: false };

    // Cooldown: don't re-dispatch while a previous fall-pearl equip is in flight.
    if (Date.now() - this._lastFallPearlTime < 1500) {
      return { canMitigate: false };
    }

    const inv = this.bot.inventoryManager;
    if (!inv.hasItem("ender_pearl")) return { canMitigate: false };

    const entity = this.bot.entity;
    const eyePos = entity.position.offset(0, entity.height!, 0);

    // Try downward ground first (normal fall case).
    let groundY = this.bot.utilsManager.getGroundBelow();
    if (groundY <= -64) {
      groundY = this.bot.utilsManager.getGroundBelow(
        Constants.MOVEMENT.FALL_GROUND_SCAN_DEPTH,
      );
    }

    let targetPos: Vec3 | null = null;

    if (groundY > -64) {
      // Solid ground below: aim at the block's top surface (block.y + 1).
      // The ender pearl collides with the block face and teleports the bot
      // to safety before impact.
      targetPos = new Vec3(entity.position.x, groundY, entity.position.z);
    } else {
      // No ground below (void): scan upward for overhead blocks. Ender pearls
      // teleport on collision with ANY solid block, so a ceiling block above
      // is a valid mitigation target. Aim at the ceiling's bottom surface.
      let ceilingY = this.bot.utilsManager.getGroundAbove();
      if (ceilingY <= -64) {
        ceilingY = this.bot.utilsManager.getGroundAbove(
          Constants.MOVEMENT.FALL_GROUND_SCAN_DEPTH,
        );
      }
      if (ceilingY <= -64) return { canMitigate: false }; // No ground above either

      targetPos = new Vec3(entity.position.x, ceilingY, entity.position.z);
    }

    // Calculate ballistic trajectory to the target (downward or upward).
    const trajectory = this.bot.utilsManager.getBestPearlTrajectory(
      eyePos,
      targetPos,
      Constants.COMBAT.PROJECTILES.ender_pearl.VELOCITY,
      Constants.COMBAT.PROJECTILES.ender_pearl.GRAVITY,
      Constants.COMBAT.PROJECTILES.ender_pearl.DRAG,
      1.5, // toleranceRadius
      0.5, // sampleStep
    );

    if (!trajectory) return { canMitigate: false };

    // Pearl must arrive before the bot hits the ground/void.
    if (trajectory.flightTime >= (status.ticksToImpact ?? 0)) {
      return { canMitigate: false };
    }

    // Convert pitch to vertical aim offset for equipPearl:
    // offset = horizontal_distance * tan(pitch)
    const horizontalDist = Math.hypot(
      targetPos.x - eyePos.x,
      targetPos.z - eyePos.z,
    );
    let offset: number;
    if (horizontalDist < 1e-6) {
      // Target is directly above/below: aim straight up/down.
      offset = targetPos.y > eyePos.y ? 5 : -5;
    } else {
      offset = horizontalDist * Math.tan(trajectory.pitch * Math.PI / 180);
    }

    return { canMitigate: true, targetPos, flightTime: trajectory.flightTime, offset };
  }

  /**
   * Determine whether an ender pearl can be used to reach an enemy
   * standing on an elevated position (e.g. on a block above the bot).
   * Finds valid launch points near the bot, then the behavior tree
   * pathfinds to one and throws a pearl at the enemy to teleport up.
   *
   * Ender pearl teleport deals PEARL_DAMAGE (5 HP). If the bot's health is
   * below that and it has no armor, the pearl itself would be lethal.
   *
   * @returns Whether pearl mitigation is viable, plus launch point, target position, flight time and offset.
   */
  getEnemyAbovePearlMitigation(): {
    canMitigate: boolean;
    launchPos?: Vec3;
    targetPos?: Vec3;
    flightTime?: number;
    offset?: number;
  } {
    const target = (this.bot as any).pvp?.target;
    if (!target) return { canMitigate: false };

    const entity = this.bot.entity;
    const { MIN_HEIGHT } = Constants.COMBAT.ENEMY_ABOVE_PEARL;

    // Target must be above the bot
    if (target.position.y <= entity.position.y + MIN_HEIGHT) {
      return { canMitigate: false };
    }

    // Must be out of melee range
    const dist = entity.position.distanceTo(target.position);
    const pvp = this.bot as any;
    const attackRange = pvp.attackRange ?? Constants.COMBAT.ATTACK_RANGE;
    if (dist <= attackRange) return { canMitigate: false };

    // Must have pearls
    const inv = this.bot.inventoryManager;
    if (!inv.hasItem("ender_pearl")) return { canMitigate: false };

    // Cooldown
    if (Date.now() - this.lastPearlTime < Constants.COMBAT.ENDER_PEARL.COOLDOWN) {
      return { canMitigate: false };
    }

    const eyePos = entity.position.offset(0, entity.height!, 0);
    const targetPos = target.position.offset(0, target.height / 2, 0);

    // Find a valid launch point
    const launchPos = this._findEnemyAboveLaunchPoint(target);
    if (!launchPos) return { canMitigate: false };

    // Cache it for pathfinding
    this._enemyAboveLaunchPoint = launchPos;

    const trajectory = this.bot.utilsManager.getBestPearlTrajectory(
      launchPos.offset(0, entity.height!, 0),
      targetPos,
      Constants.COMBAT.PROJECTILES.ender_pearl.VELOCITY,
      Constants.COMBAT.PROJECTILES.ender_pearl.GRAVITY,
      Constants.COMBAT.PROJECTILES.ender_pearl.DRAG,
      1.5,
      0.5,
    );

    if (!trajectory) {
      this._enemyAboveLaunchPoint = null;
      return { canMitigate: false };
    }

    const hDist = Math.hypot(
      targetPos.x - launchPos.x,
      targetPos.z - launchPos.z,
    );
    let offset: number;
    if (hDist < 1e-6) {
      offset = targetPos.y > eyePos.y ? 5 : -5;
    } else {
      offset = hDist * Math.tan(trajectory.pitch * Math.PI / 180);
    }

    return {
      canMitigate: true,
      launchPos,
      targetPos,
      flightTime: trajectory.flightTime,
      offset,
    };
  }

  /**
   * Find a valid launch point near the bot from which an ender pearl can
   * reach the target. Launch points are ground-level positions adjacent to
   * the bot with solid ground below, air above, and a clear trajectory to
   * the target.
   * @private
   */
  private _findEnemyAboveLaunchPoint(target: any): Vec3 | null {
    const entity = this.bot.entity;
    const { LAUNCH_SEARCH_RADIUS } = Constants.COMBAT.ENEMY_ABOVE_PEARL;

    const groundY = this.bot.utilsManager.getGroundBelow();
    if (groundY <= -64) return null;

    const candidates: Vec3[] = [];

    // Scan in a radius around the bot
    for (let dx = -LAUNCH_SEARCH_RADIUS; dx <= LAUNCH_SEARCH_RADIUS; dx++) {
      for (let dz = -LAUNCH_SEARCH_RADIUS; dz <= LAUNCH_SEARCH_RADIUS; dz++) {
        if (dx === 0 && dz === 0) continue; // skip bot's own position

        const launchPos = new Vec3(
          entity.position.x + dx,
          groundY,
          entity.position.z + dz,
        );

        // Position must be clear (air at feet and head level), ground below must be solid
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

        candidates.push(launchPos);
      }
    }

    if (candidates.length === 0) return null;

    // Sort by distance to bot (prefer closer launch points)
    candidates.sort((a, b) =>
      a.distanceTo(entity.position) - b.distanceTo(entity.position),
    );

    // Return first candidate with valid trajectory to target
    const targetPos = target.position.offset(0, target.height / 2, 0);

    for (const launchPos of candidates) {
      const launchEyePos = launchPos.offset(0, entity.height!, 0);
      const trajectory = this.bot.utilsManager.getBestPearlTrajectory(
        launchEyePos,
        targetPos,
        Constants.COMBAT.PROJECTILES.ender_pearl.VELOCITY,
        Constants.COMBAT.PROJECTILES.ender_pearl.GRAVITY,
        Constants.COMBAT.PROJECTILES.ender_pearl.DRAG,
        1.5,
        0.5,
      );
      if (trajectory) return launchPos;
    }

    return null;
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
   * Decide whether to toss junk items from inventory.
   */
  async decideIfToss(): Promise<void> {
    const junk = ["compass", "knowledge_book", "glass_bottle"];
    for (const name of junk) {
      const items = this.bot.inventoryManager.findItem(name);
      if (items.length > 0) {
        const item = items[0];
        this.logger.inventory(
          `Tossing junk item: ${item.name} (count: ${item.count})`,
        );
        await this.bot.toss!(item.type, item.metadata, item.count);
        await this.bot.waitForTicks!(Constants.TIMING.EQUIP_TICKS);
        break;
      }
    }
  }

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
   * Gradually nudges the bot's position towards a target point (XZ only).
   * Moves by 0.01 units per tick until within 0.01 units of the target.
   * @param target - The target position to nudge towards
   */
  async nudgeToCenter(target: Vec3): Promise<void> {
    const dist2D = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

    while (dist2D(this.bot.entity!.position, target) > 0.01) {
      const pos = this.bot.entity!.position;
      const dx = target.x - pos.x;
      const dz = target.z - pos.z;

      const totalDist = Math.abs(dx) + Math.abs(dz);
      const moveX = totalDist > 0.01 ? dx * (0.01 / totalDist) : dx;
      const moveZ = totalDist > 0.01 ? dz * (0.01 / totalDist) : dz;

      this.bot.entity!.position.add(new Vec3(moveX, 0, moveZ));

      await this.bot.waitForTicks!(1);
    }

    this.bot.entity!.position.set(
      target.x,
      this.bot.entity!.position.y,
      target.z,
    );
  }

  /**
   * Update the PVP target to the nearest entity matching the current mode filter.
   */
  updateTarget(): void {
    const currentTarget = this.bot.pvp.target;
    const filter = this.getTargetFilter();

    // Stickiness: if the current target is still alive and matches the filter,
    // avoid calling nearestEntity (which scans all entities).
    if (currentTarget && currentTarget.isValid && filter(currentTarget)) {
      return;
    }

    const target = this.bot.nearestEntity!(filter);
    if (target) {
      const dist = this.bot.entity!.position.distanceTo(target.position);
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
    const eyePos = this.bot.entity.position.offset(
      0,
      this.bot.entity.height!,
      0,
    );
    const resolvedArc: "low" | "high" = arcType === "auto" ? "low" : arcType;
    const result = this.getBestPearlOffset(eyePos, targetPos, resolvedArc);
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

export { CombatDecision, CombatManager };
