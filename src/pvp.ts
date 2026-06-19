import { Logger } from "./logger";
import { Constants } from "./constants";
import { Vec3 } from "vec3";
import { Bot } from "mineflayer";

/**
 * Represents a rule-based decision for inventory management during combat
 */
class CombatDecision {
  public condition: () => boolean;
  public action: () => Promise<void>;
  public name: string;

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
 * Manages combat state, targeting, movement (strafing), and automated inventory decisions
 */
class CombatManager {
  public bot: Bot;
  public logger: Logger;
  public alliesSet: Set<string>;
  public debounce: boolean;
  public lastDamage: number;
  public lastHealth: number;
  public strafeDirection: number;
  public strafePoint: Vec3 | null;
  public lastDist: number | null;
  public _edgeSneaking: boolean;
  public mode: number;
  public modeFilterCache: ((e: any) => boolean) | null;
  public lastMode: number;
  public lastPearlTime: number;
  public decisions: CombatDecision[];
  public _isDeciding: boolean;

  /**
   * @param bot - Mineflayer bot instance
   */
  constructor(bot: Bot) {
    this.bot = bot;
    this.logger = (bot as any).__logger;
    this.alliesSet = new Set();
    this.debounce = false;
    this.lastDamage = 0;
    this.lastHealth = 20;
    this.strafeDirection = 1; // +1 = strafe right, -1 = strafe left
    this.strafePoint = null;
    this.lastDist = null;
    this._edgeSneaking = false;
    this.mode = 2; // Default: Player PVP
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
    const { CRITICAL_HEALTH_MULTIPLIER, LOW_FOOD_THRESHOLD } = Constants.COMBAT;
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
            // Exit early if no totem is in inventory
            if (!inv().hasItem("totem_of_undying")) return;
            this.logger.combat(
              "Fall: Survival impossible with Gapples, equipping Totem",
              "Combat",
            );
            await inv().equipTotem();
          } else if (
            canEatEGapple &&
            inv().hasItemWithMetadata("golden_apple", 1)
          ) {
            this.logger.combat(
              "Fall: Mitigating with Enchanted Golden Apple",
              "Combat",
            );
            await inv().equipGapple();
          } else if (
            canEatGapple &&
            inv().hasItemWithMetadata("golden_apple", 0)
          ) {
            this.logger.combat("Fall: Mitigating with Golden Apple", "Combat");
            await inv().equipGapple();
          } else {
            // Exit early if neither gapple nor totem is available
            if (
              !inv().hasItem("golden_apple") &&
              !inv().hasItem("totem_of_undying")
            )
              return;
            this.logger.combat(
              "Fall: No suitable Gapple available, equipping Totem",
              "Combat",
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
            (totalHealth <=
              (this.lastDamage || 1) * CRITICAL_HEALTH_MULTIPLIER ||
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
            Constants.PHYSICS.EYE_HEIGHT_OFFSET,
            0,
          );
          const targetPos = target.position.offset(0, target.height / 2, 0);
          return this.getBestPearlPitch(eyePos, targetPos) !== null;
        },
        async () => {
          const target = (this.bot as any).pvp.target;
          const eyePos = this.bot.entity!.position.offset(
            0,
            Constants.PHYSICS.EYE_HEIGHT_OFFSET,
            0,
          );
          const targetPos = target.position.offset(0, target.height / 2, 0);
          const { pitch, arc } = this.getBestPearlPitch(eyePos, targetPos)!;
          const yaw = Math.atan2(
            eyePos.x - targetPos.x,
            eyePos.z - targetPos.z,
          );
          this.logger.combat(
            `Throwing ${arc} arc pearl at ${target.username}`,
            "Combat",
          );
          await inv().equipPearl(yaw, pitch);
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
            (totalHealth >
              (this.lastDamage || 1) * CRITICAL_HEALTH_MULTIPLIER ||
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
            totalHealth > (this.lastDamage || 1) * CRITICAL_HEALTH_MULTIPLIER ||
            !hasTotems;
          const needsFood = this.bot.food! < LOW_FOOD_THRESHOLD;
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
            totalHealth > (this.lastDamage || 1) * CRITICAL_HEALTH_MULTIPLIER ||
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
  ): { pitch: number; arc: string } | null {
    const result = (this.bot as any).utilsManager.getBestPearlTrajectory(
      source,
      target,
    );

    if (result) {
      if (result.arc === "high") {
        this.logger.debug(
          "Low arc blocked, evaluating high arc via tolerance sampling...",
          "Combat",
        );
      }
      return { pitch: result.pitch, arc: result.arc };
    }
    return null;
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
          if (priorityNames.has(decision.name)) {
            await track(decision.action)();
            if (svc.switchedItem) break;
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
    this.logger.combat(`Combat mode set to ${this.mode}`, "Combat");
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
      DANGER_THRESHOLD,
      GAPPLE_ABSORPTION,
      ENCHANTED_GAPPLE_ABSORPTION,
      ENCHANTED_GAPPLE_RESISTANCE,
      EAT_TICKS,
      EAT_TICKS_BUFFER,
    } = Constants.COMBAT.SURVIVAL;
    const { totalHealth } = this.getHealthStatus();
    const velY = (this.bot as any).entity.velocity.y;

    // Only check if falling
    if (velY >= 0 || (this.bot as any).entity.onGround) {
      return { isDangerous: false };
    }

    const groundY = (this.bot as any).utilsManager.getGroundBelow();
    const fallDistance = this.bot.entity!.position.y - groundY;
    const predictedDamage = (this.bot as any).utilsManager.getFallDamage(
      fallDistance,
    );

    // Tolerance: 32 ticks (1.6s) to eat + 10 ticks buffer = 42 ticks
    const EAT_TICKS_WITH_TOLERANCE = EAT_TICKS + EAT_TICKS_BUFFER;
    // Rough time to impact: distance / average velocity (simplified)
    // Using current velocity as a lower bound for time (conservative)
    const ticksToImpact = Math.abs(fallDistance / (velY || -0.01));
    const hasTimeToEat = ticksToImpact > EAT_TICKS_WITH_TOLERANCE;

    const isDangerous = predictedDamage >= totalHealth - DANGER_THRESHOLD; // Dangerous if it leaves us with < DANGER_THRESHOLD HP
    if (!isDangerous) return { isDangerous: false };

    // Survival with Regular Gapple: +8 Absorption HP
    const canEatGapple =
      hasTimeToEat && predictedDamage < totalHealth + GAPPLE_ABSORPTION;
    // Survival with Enchanted Gapple: +32 Absorption HP and 20% Resistance
    const damageWithResistance = predictedDamage * ENCHANTED_GAPPLE_RESISTANCE;
    const canEatEGapple =
      hasTimeToEat &&
      damageWithResistance < totalHealth + ENCHANTED_GAPPLE_ABSORPTION;

    const needsTotem = !canEatGapple && !canEatEGapple;

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
      if ((this.bot as any).pvp.target) this.doStrafe();
      await this.executeDecisions();
    } catch (error: unknown) {
      const err = error as Error;
      err.message = `Error in combat loop: ${err.message}`;
      this.logger.error(err, "Combat");
    } finally {
      this._isDeciding = false;
    }
  };

  /**
   * Decide whether to toss junk items from inventory.
   */
  async decideIfToss(): Promise<void> {
    const junk = ["compass", "knowledge_book", "glass_bottle"].map(
      (name) => (this.bot as any).registry.itemsByName[name]?.id,
    );
    for (const id of junk) {
      if (!id) continue;
      const item = (this.bot as any).inventory.findInventoryItem(id, null);
      if (item) {
        this.logger.combat(
          `Tossing junk: ${item.name} x${item.count}...`,
          "Combat",
        );
        await this.bot.toss!(item.type, item.metadata, item.count);
        await this.bot.waitForTicks!(Constants.TIMING.EQUIP_WAIT_TICKS);
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
    if (!(bot as any).entity.onGround) return;

    const pos = bot.entity!.position;
    const blockX = Math.floor(pos.x) + 0.5;
    const blockZ = Math.floor(pos.z) + 0.5;

    const dx = Math.abs(pos.x - blockX);
    const dz = Math.abs(pos.z - blockZ);

    if (dx < 0.5 && dz < 0.5) {
      // Centered — release sneak if we set it
      if (this._edgeSneaking) {
        (bot as any).setControlState("sneak", false);
        this._edgeSneaking = false;
      }
      return;
    }

    // Edge detected — sneak and nudge toward center
    (bot as any).setControlState("sneak", true);
    this._edgeSneaking = true;

    const nudgeX = dx >= 0.5 ? Math.sign(blockX - pos.x) * 0.02 : 0;
    const nudgeZ = dz >= 0.5 ? Math.sign(blockZ - pos.z) * 0.02 : 0;

    if (nudgeX !== 0 || nudgeZ !== 0) {
      (bot as any).entity.velocity.add(new Vec3(nudgeX, 0, nudgeZ));
    }
  }

  /**
   * Performs strafe movement around a target using validated strafe points.
   *
   * **Ground:** Computes an orbital direction (perpendicular to the target)
   * using `getStrafeYaw()`, picks a solid-surface point in that direction,
   * validates its trajectory with `isJumpPathClear()`, and jumps toward it.
   * **Air:** Steers the current velocity toward the strafe point.
   *
   * The strafe point is cached (`strafePoint`) but re-validated only when
   * on ground to avoid false "blocked" reports from velocity mismatches mid-air.
   *
   * @param overrideTarget - Optional fixed point to strafe around
   */
  doStrafe(overrideTarget?: Vec3): void {
    const source = this.bot.entity!.position;
    const target = overrideTarget || (this.bot as any).pvp?.target?.position;
    if (!source || !target) {
      this.strafePoint = null;
      return;
    }

    const utils = (this.bot as any).utilsManager;
    const dist2D = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
    const distToTarget = source.distanceTo(target);

    const strafeRange =
      (this.bot as any).runtimeConfig?.get("COMBAT", "STRAFE_RANGE") ??
      Constants.COMBAT.STRAFE_RANGE;

    if (distToTarget > strafeRange + 1) {
      this.strafePoint = null;
      return;
    }

    // Flip direction on horizontal collision
    if ((this.bot as any).entity.isCollidedHorizontally) {
      this.strafeDirection = -this.strafeDirection;
      this.strafePoint = null;
    }

    if ((this.bot as any).entity.onGround) {
      // --- Stale strafe point cleanup (ground only) ---
      if (this.strafePoint) {
        const distToPoint = dist2D(source, this.strafePoint);
        if (distToPoint > strafeRange + 1) {
          this.strafePoint = null;
        } else {
          const isBlocked = !utils.isJumpPathClear(source, this.strafePoint);
          if (isBlocked) {
            this.logger.debug("Clearing blocked strafe point", "Combat");
            this.strafePoint = null;
          } else if (distToPoint < 0.2) {
            // Reached the point, clear so we pick a new one
            this.strafePoint = null;
          }
        }
      }

      // --- Pick a new strafe point if needed ---
      if (!this.strafePoint && distToTarget <= strafeRange) {
        // Try all 4 cardinal directions relative to the target to find a
        // valid strafe point.  The directions are ordered by preference:
        // perpendicular (orbital), then forward/backward (radial).
        const strafeDist = Constants.MOVEMENT.STRAFE_POINT_MAX_DISTANCE;
        const directions: { dir: number; label: string }[] = [
          { dir: this.strafeDirection, label: "strafe" },
          { dir: -this.strafeDirection, label: "opposite" },
          { dir: 0, label: "forward" },
          { dir: 2, label: "backward" }, // 2 = PI rad = 180°
        ];

        for (const { dir, label } of directions) {
          const yaw = utils.getStrafeYaw(source, target, dir);
          const candidate = source.offset(
            -Math.sin(yaw) * strafeDist,
            0,
            Math.cos(yaw) * strafeDist,
          );
          this.strafePoint = utils.getStrafePoint(source, candidate, target);
          if (this.strafePoint) {
            if (dir !== this.strafeDirection) {
              this.strafeDirection = dir;
            }
            this.logger.debug(`Strafe point found (${label})`, "Combat");
            break;
          }
        }

        if (!this.strafePoint) {
          this.logger.debug("No strafe point found in any direction", "Combat");
        }
      }

      // --- Jump toward the strafe point ---
      if (this.strafePoint) {
        // Enable sprint so prismarine-physics uses sprint ground acceleration
        // (otherwise it would use walking acceleration and slow us down).
        // The sprint-jump boost from prismarine-physics gets overwritten
        // by our impulse below, so we include it in getJumpVelocity instead.
        (this.bot as any).setControlState("sprint", true);

        const impulse = utils.getJumpVelocity(source, this.strafePoint);
        if (impulse) {
          this.logger.combat(
            `Jump strafe to ${this.strafePoint.x.toFixed(1)}, ${this.strafePoint.z.toFixed(1)} (dist=${distToTarget.toFixed(1)}, dir=${this.strafeDirection})`,
            "Combat",
          );
          utils.applyImpulse(impulse, "set", true);
        }
      }
    } else if (this.strafePoint) {
      // --- Airborne: steer toward the strafe point ---
      const currentSpeed = utils.getHorizontalSpeed();
      if (currentSpeed > 0.001) {
        // Steer velocity toward the strafe point using the air acceleration
        const airAccel =
          Constants.PHYSICS.ACCELERATION.AIR *
          Constants.PHYSICS.ACCELERATION.SPRINT_MULTIPLIER;

        const dx = this.strafePoint.x - source.x;
        const dz = this.strafePoint.z - source.z;
        const len = Math.hypot(dx, dz) || 1e-6;

        // Add air acceleration in the direction of the strafe point
        const impulse = new Vec3(
          (dx / len) * airAccel,
          0,
          (dz / len) * airAccel,
        );
        utils.applyImpulse(impulse, "add");
      }
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

    // Final snap for precision
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
      (this.bot as any).pvp.attack(target);
    } else {
      (this.bot as any).pvp.forceStop();
    }
  }
}

/**
 * Attach the CombatManager to a bot instance.
 * @param bot - Mineflayer bot instance
 * @returns The same bot instance with combatManager attached
 */
export default function attach(bot: Bot): Bot {
  (bot as any).combatManager = new CombatManager(bot);
  return bot;
}

export { CombatDecision, CombatManager };
