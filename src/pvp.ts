import { Logger } from "./logger";
import { Constants } from "./constants";
import { Vec3 } from "vec3";
import { Bot } from "mineflayer";
import { Entity } from "prismarine-entity";
import { goals, Movements } from "mineflayer-pathfinder";

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
  attackRange: number = Constants.COMBAT.ATTACK_RANGE;
  followRange: number = Constants.COMBAT.FOLLOW_RANGE;
  viewDistance: number = Constants.COMBAT.VIEW_DISTANCE;
  movements: Movements;
  goal: Vec3 | null = null;

  constructor(bot: Bot) {
    this.bot = bot;
    this.movements = new Movements(bot);
    this.bot.on("physicsTick" as any, () => this.update());
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
    const pf = this.bot.pathfinder;
    if (pf) {
      pf.setMovements(this.movements);
      pf.setGoal(new goals.GoalFollow(this.target, this.followRange), true);
    }
    this.bot.emit("startedAttacking" as any);
  }

  async stop(): Promise<void> {
    if (this.target == null) return;
    this.target = undefined;
    this.goal = null;
    this._clearExplosionTimeout();
    const pathfinder = this.bot.pathfinder;
    if (pathfinder) {
      pathfinder.stop();
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("timeout")), 5000);
          this.bot.once("path_stop" as any, () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } catch {
        this.bot.removeAllListeners("path_stop" as any);
        pathfinder.setGoal(null);
      }
    }
    this.bot.emit("stoppedAttacking" as any);
  }

  forceStop(): void {
    if (this.target == null) return;
    this.target = undefined;
    this.goal = null;
    this._clearExplosionTimeout();
    const pathfinder = this.bot.pathfinder;
    if (pathfinder) pathfinder.setGoal(null);
    this.bot.emit("stoppedAttacking" as any);
  }

  setGoal(pos: Vec3 | null): void {
    this.goal = pos;
  }

  clearGoal(): void {
    this.goal = null;
    const pf = this.bot.pathfinder;
    if (pf) pf.setGoal(null);
  }

  update(): void {
    this.checkExplosion();
    this.checkRange();
    if (!this.target || this.blockingExplosion) return;
    this.timeToNextAttack--;
    if (this.timeToNextAttack <= 0) {
      this.attemptAttack();
    }
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
          pf.setMovements(this.movements);
          pf.setGoal(new goals.GoalNearXZ(this.goal.x, this.goal.z, 1));
        }
      } else if (inRange) {
        if (pf) pf.setGoal(null);
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
    this.bot.emit("attackedTarget" as any);
    this.timeToNextAttack = this.getWeaponCooldown();
    if (this.hasShield()) {
      setTimeout(() => {
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
   * @param condition - Function returning boolean
   * @param action - Async function to execute
   * @param name - Decision name
   */
  constructor(
    condition: () => boolean,
    action: () => Promise<void>,
    name: string,
  ) {
    this.condition = condition;
    this.action = action;
    this.name = name;
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
  public decisions: CombatDecision[];
  _isDeciding: boolean;

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
    this.decisions = [];
    this._isDeciding = false;

    this.setupDecisions();
  }

  /**
   * Initialize the combat decision tree.
   */
  setupDecisions(): void {
    const { CRITICAL_HP_MULT, LOW_FOOD } = Constants.COMBAT;
    const inv = () => (this.bot as any).inventoryManager;

    this.decisions = [
      new CombatDecision(
        () => {
          const status = this.getFallProtectionStatus();
          return status.isDangerous;
        },
        async () => {
          const status = this.getFallProtectionStatus();
          const { canEatGapple, canEatEGapple, needsTotem } = status;

          if (needsTotem) {
            if (!inv().hasItem("totem_of_undying")) return;
            this.logger.combat(
              "Fall: Survival impossible with Gapples, equipping Totem",
            );
            await inv().equipTotem();
          } else if (canEatEGapple && inv().hasItem("golden_apple", 1)) {
            this.logger.combat("Fall: Mitigating with Enchanted Golden Apple");
            await inv().equipGapple();
          } else if (canEatGapple && inv().hasItem("golden_apple", 0)) {
            this.logger.combat("Fall: Mitigating with Golden Apple");
            await inv().equipGapple();
          } else {
            if (
              !inv().hasItem("golden_apple") &&
              !inv().hasItem("totem_of_undying")
            )
              return;
            this.logger.combat(
              "Fall: No suitable Gapple available, equipping Totem",
            );
            await inv().equipTotem();
          }
        },
        "fall",
      ),

      new CombatDecision(
        () => true,
        () => inv().equipArmor(),
        "armor",
      ),
      new CombatDecision(
        () => true,
        () => inv().equipWeapon(),
        "weapon",
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
        () => inv().equipTotem(),
        "totem",
      ),

      new CombatDecision(
        () => {
          const target = (this.bot as any).pvp.target;
          if (!target) return false;

          const { COOLDOWN } = Constants.COMBAT.ENDER_PEARL;
          if (Date.now() - this.lastPearlTime < COOLDOWN) return false;

          const dist = this.bot.entity!.position.distanceTo(target.position);
          const hasPearls = inv().hasItem("ender_pearl");
          if (
            !hasPearls ||
            dist <= (this.bot as any).pvp.attackRange ||
            dist > 50
          )
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
          const target = (this.bot as any).pvp.target;
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
      ),

      new CombatDecision(
        () => {
          const { totalHealth, healthPoints } = this.getHealthStatus();
          const hasGapple = inv().hasItem("golden_apple");
          const hasTotems = inv().hasItem("totem_of_undying");
          const regeneration = (this.bot as any).entity.effects["10"];
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
      ),

      new CombatDecision(
        () => {
          const { totalHealth } = this.getHealthStatus();
          const hasPotion = inv().hasItem("potion");
          const strength = (this.bot as any).entity.effects["5"];
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
      ),

      new CombatDecision(
        () => {
          const { totalHealth, healthPoints } = this.getHealthStatus();
          const hasGapple = inv().hasItem("golden_apple");
          const hasTotems = inv().hasItem("totem_of_undying");
          const hasFood = inv().hasFood();
          const regeneration = (this.bot as any).entity.effects["10"];

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
      ),

      new CombatDecision(
        () => true,
        () => this.decideIfToss(),
        "toss",
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
    const result = (this.bot as any).utilsManager.getBestPearlTrajectory(
      source,
      target,
    );

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
      const offset = (this.bot as any).utilsManager.getProjectileOffset(
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
          const offset = (this.bot as any).utilsManager.getProjectileOffset(
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
      const svc: { switchedItem: boolean } = { switchedItem: false };
      const track = (fn: () => Promise<void>) => async () => {
        const heldBefore = (this.bot as any).heldItem?.type;
        await fn();
        const heldAfter = (this.bot as any).heldItem?.type;
        if (heldBefore !== heldAfter) svc.switchedItem = true;
      };

      // Priority decisions that may cause an item swap — if any of these
      // trigger and swap the held item, we skip the lower-priority decisions.
      const priorityNames = new Set([
        "fall",
        "totem",
        "heal",
        "armor",
        "weapon",
      ]);

      for (const decision of this.decisions) {
        if (decision.condition()) {
          this.logger.debug(`Decision: ${decision.name} triggered`, "Combat");
          if (priorityNames.has(decision.name)) {
            await track(decision.action)();
            if (svc.switchedItem) {
              this.logger.debug(
                `Decision: item swapped by ${decision.name}, skipping lower priority`,
                "Combat",
              );
              break;
            }
          } else {
            await decision.action();
          }
        }
      }
    } finally {
      this.debounce = false;
    }
  }

  /**
   * Set or cycle combat mode.
   * @param mode - Mode number (0-3), or undefined to cycle
   */
  setMode(mode?: number): void {
    this.mode = mode !== undefined ? mode : (this.mode + 1) % 4;
    this.modeFilterCache = null;
    this.logger.combat(`Combat mode set to ${this.mode}`);
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
          (this.bot as any).players[e.username]?.gamemode === 0 &&
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
    const health =
      this.bot.health! + ((this.bot as any).entity.metadata[11] || 0);
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
    const ap = (this.bot as any).entity.metadata[11] || 0;
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
    hasTimeToEat?: boolean;
    canEatGapple?: boolean;
    canEatEGapple?: boolean;
    needsTotem?: boolean;
  } {
    const {
      DANGER_HP,
      GAPPLE_ABSORB,
      EGAPPLE_ABSORB,
      EGAPPLE_RESIST,
      EAT_TICKS,
      EAT_BUFFER,
    } = Constants.COMBAT.SURVIVAL;
    const { totalHealth } = this.getHealthStatus();
    const velY = (this.bot as any).entity.velocity.y;

    if (velY >= 0 || (this.bot as any).entity.onGround) {
      return { isDangerous: false };
    }

    const groundY = (this.bot as any).utilsManager.getGroundBelow();
    const fallDistance = this.bot.entity!.position.y - groundY;
    const predictedDamage = (this.bot as any).utilsManager.getFallDamage(
      fallDistance,
    );

    // Tolerance: 32 ticks (1.6s) to eat + 10 ticks buffer = 42 ticks
    const EAT_TICKS_WITH_TOLERANCE = EAT_TICKS + EAT_BUFFER;
    // Rough time to impact: distance / average velocity (simplified)
    // Using current velocity as a lower bound for time (conservative)
    const ticksToImpact = Math.abs(fallDistance / (velY || -0.01));
    const hasTimeToEat = ticksToImpact > EAT_TICKS_WITH_TOLERANCE;

    const isDangerous = predictedDamage >= totalHealth - DANGER_HP;
    if (!isDangerous) {
      return { isDangerous: false };
    }

    // Survival with Regular Gapple: +8 Absorption HP
    const canEatGapple =
      hasTimeToEat && predictedDamage < totalHealth + GAPPLE_ABSORB;
    // Survival with Enchanted Gapple: +32 Absorption HP and 20% Resistance
    const damageWithResistance = predictedDamage * EGAPPLE_RESIST;
    const canEatEGapple =
      hasTimeToEat && damageWithResistance < totalHealth + EGAPPLE_ABSORB;

    const needsTotem = !canEatGapple && !canEatEGapple;

    this.logger.debug(
      `Fall: DANGEROUS. Predicted damage: ${predictedDamage.toFixed(1)} HP, total health: ${totalHealth.toFixed(1)} HP, ticks to impact: ${ticksToImpact.toFixed(0)}. Can eat gapple: ${canEatGapple}, can eat enchanted gapple: ${canEatEGapple}, needs totem: ${needsTotem}`,
      "Combat",
    );

    return {
      isDangerous,
      predictedDamage,
      ticksToImpact,
      hasTimeToEat,
      canEatGapple,
      canEatEGapple,
      needsTotem,
    };
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
      await this.executeDecisions();
    } catch (error: unknown) {
      const err = error as Error;
      const targetName = (this.bot as any).pvp?.target?.username ?? "none";
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
      const items = (this.bot as any).inventoryManager.findItem(name);
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
    const unwanted = (this.bot as any).utilsManager.isInUnwanted(
      this.bot.entity!.position,
    );
    if (unwanted) {
      const impulse = (this.bot as any).utilsManager.getFlatVelocity(
        this.bot.entity!.position,
        unwanted,
        180,
        0.01,
        (this.bot as any).entity.velocity.y,
      );
      (this.bot as any).utilsManager.applyImpulse(impulse, "set");
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
    const currentTarget = (this.bot as any).pvp.target;
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
      (this.bot as any).pvp.attack(target);
    } else {
      if (currentTarget) {
        this.logger.debug(`Target: lost. No valid entity in range`, "Combat");
      }
      (this.bot as any).pvp.forceStop();
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
    await (this.bot as any).inventoryManager.equipPearl(
      targetPos,
      result.offset,
    );
    this.lastPearlTime = Date.now();
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

export { CombatDecision, CombatManager };
