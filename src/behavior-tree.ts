/**
 * @fileoverview Behavior tree for combat decision-making.
 *
 * Replaces the CombatDecision[] array with a proper behavior tree.
 * Uses the `behaviortree` library (pure JS, no native deps).
 *
 * Actions are fire-and-forget: they start async work and return SUCCESS
 * immediately. The tree's job is to decide which action to take, not to
 * wait for completion.
 */

import { Selector, Sequence, Node, SUCCESS, FAILURE, RUNNING } from "behaviortree";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { Constants } from "./constants";

export interface CombatTreeContext {
  bot: Bot;
  inv: () => any;
  getHealthStatus: () => { totalHealth: number; healthPoints: number; absorbPoints: number };
  getFallProtectionStatus: () => {
    isDangerous: boolean;
    predictedDamage?: number;
    ticksToImpact?: number;
    hasTimeToEat?: boolean;
    canEatGapple?: boolean;
    canEatEGapple?: boolean;
    needsTotem?: boolean;
  };
  getBestPearlOffset: (source: Vec3, target: Vec3, arc?: "low" | "high") => { offset: number; arc: "low" | "high" } | null;
  lastDamage: number;
  lastPearlTime: number;
  logger: any;
}

type Blackboard = Record<string, any>;
type RunResult = symbol | boolean | undefined;

function condition(name: string, fn: (ctx: CombatTreeContext) => boolean): Node {
  return new Node({
    name,
    run: (bb: Blackboard): RunResult => {
      const ctx = bb.ctx as CombatTreeContext;
      return fn(ctx) ? SUCCESS : FAILURE;
    },
  });
}

function action(name: string, fn: (ctx: CombatTreeContext) => void): Node {
  return new Node({
    name,
    run: (bb: Blackboard): RunResult => {
      const ctx = bb.ctx as CombatTreeContext;
      fn(ctx);
      return SUCCESS;
    },
  });
}

function alwaysTrue(): Node {
  return new Node({
    name: "alwaysTrue",
    run: (): RunResult => SUCCESS,
  });
}

/**
 * Build the combat behavior tree.
 *
 * Priority order (highest first):
 *   1. Fall protection (gapple/totem when fall is dangerous)
 *   2. Critical HP totem
 *   3. Heal (gapple when low HP)
 *   4. Armor
 *   5. Weapon
 *   6. Pearl throw
 *   7. Buff (strength potion)
 *   8. Food
 */
export function buildCombatTree(ctx: CombatTreeContext): Node {
  const { CRITICAL_HP_MULT, LOW_FOOD } = Constants.COMBAT;

  return new Selector({
    name: "combatRoot",
    nodes: [
      // 1. Fall protection
      new Sequence({
        name: "fallProtection",
        nodes: [
          condition("isFallDangerous", (c) => c.getFallProtectionStatus().isDangerous),
          action("mitigateFall", (c) => {
            const status = c.getFallProtectionStatus();
            const inv = c.inv();
            if (status.needsTotem) {
              if (!inv.hasItem("totem_of_undying")) return;
              inv().equipTotem();
            } else if (status.canEatEGapple && inv.hasItem("golden_apple", 1)) {
              inv().equipGapple();
            } else if (status.canEatGapple && inv.hasItem("golden_apple", 0)) {
              inv().equipGapple();
            } else {
              if (!inv.hasItem("golden_apple") && !inv.hasItem("totem_of_undying")) return;
              inv().equipTotem();
            }
          }),
        ],
      }),

      // 2. Critical HP totem
      new Sequence({
        name: "criticalTotem",
        nodes: [
          condition("needsCriticalTotem", (c) => {
            const { totalHealth } = c.getHealthStatus();
            const hasTotems = c.inv().hasItem("totem_of_undying");
            const hasGapple = c.inv().hasItem("golden_apple");
            return hasTotems && (totalHealth <= (c.lastDamage || 1) * CRITICAL_HP_MULT || !hasGapple);
          }),
          action("equipTotem", (c) => { c.inv().equipTotem(); }),
        ],
      }),

      // 3. Heal
      new Sequence({
        name: "heal",
        nodes: [
          condition("needsHeal", (c) => {
            const { totalHealth, healthPoints } = c.getHealthStatus();
            const hasGapple = c.inv().hasItem("golden_apple");
            const hasTotems = c.inv().hasItem("totem_of_undying");
            const regeneration = (c.bot.entity as any).effects["10"];
            return hasGapple && healthPoints < 20 && !regeneration && (totalHealth > (c.lastDamage || 1) * CRITICAL_HP_MULT || !hasTotems);
          }),
          action("heal", (c) => { c.inv().equipGapple(); }),
        ],
      }),

      // 4. Armor
      new Sequence({
        name: "armor",
        nodes: [
          alwaysTrue(),
          action("equipArmor", (c) => { c.inv().equipArmor(); }),
        ],
      }),

      // 5. Weapon
      new Sequence({
        name: "weapon",
        nodes: [
          alwaysTrue(),
          action("equipWeapon", (c) => { c.inv().equipWeapon(); }),
        ],
      }),

      // 6. Pearl throw
      new Sequence({
        name: "pearl",
        nodes: [
          condition("hasTargetForPearl", (c) => {
            const target = (c.bot as any).pvp?.target;
            if (!target) return false;
            const { COOLDOWN } = Constants.COMBAT.ENDER_PEARL;
            if (Date.now() - c.lastPearlTime < COOLDOWN) return false;
            const dist = c.bot.entity!.position.distanceTo(target.position);
            const hasPearls = c.inv().hasItem("ender_pearl");
            if (!hasPearls || dist <= (c.bot as any).pvp.attackRange || dist > 50) return false;
            const eyePos = c.bot.entity!.position.offset(0, Constants.PHYSICS.EYE_HEIGHT, 0);
            const targetPos = target.position.offset(0, target.height / 2, 0);
            return c.getBestPearlOffset(eyePos, targetPos, "low") !== null;
          }),
          action("throwPearl", (c) => {
            const target = (c.bot as any).pvp?.target;
            if (!target) return;
            const eyePos = c.bot.entity!.position.offset(0, Constants.PHYSICS.EYE_HEIGHT, 0);
            const targetPos = target.position.offset(0, target.height / 2, 0);
            const result = c.getBestPearlOffset(eyePos, targetPos, "low");
            if (!result) return;
            c.inv().equipPearl(targetPos, result.offset);
            c.lastPearlTime = Date.now();
          }),
        ],
      }),

      // 7. Buff
      new Sequence({
        name: "buff",
        nodes: [
          condition("needsBuff", (c) => {
            const { totalHealth } = c.getHealthStatus();
            const hasPotion = c.inv().hasItem("potion");
            const strength = (c.bot.entity as any).effects["5"];
            const hasTotems = c.inv().hasItem("totem_of_undying");
            const hasGapple = c.inv().hasItem("golden_apple");
            return hasPotion && !strength && (totalHealth > 10 || (!hasTotems && !hasGapple));
          }),
          action("buff", (c) => { c.inv().equipBuff(); }),
        ],
      }),

      // 8. Food
      new Sequence({
        name: "food",
        nodes: [
          condition("needsFood", (c) => {
            const { totalHealth, healthPoints } = c.getHealthStatus();
            const hasGapple = c.inv().hasItem("golden_apple");
            const hasTotems = c.inv().hasItem("totem_of_undying");
            const hasFood = c.inv().hasFood();
            const regeneration = (c.bot.entity as any).effects["10"];
            const safe = totalHealth > (c.lastDamage || 1) * CRITICAL_HP_MULT || !hasTotems;
            const isHungry = (c.bot as any).food < LOW_FOOD;
            const needsHealingFood = healthPoints < 20 && !regeneration && !hasGapple;
            return hasFood && (isHungry || needsHealingFood) && safe;
          }),
          action("eat", (c) => { c.inv().equipFood(); }),
        ],
      }),
    ],
  });
}
