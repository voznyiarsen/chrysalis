/**
 * @fileoverview Behavior tree for combat decision-making.
 *
 * Replaces the CombatDecision[] array with a proper behavior tree.
 * Uses the `behaviortree` library (pure JS, no native deps).
 *
 * Actions are fire-and-forget: they start async work and return SUCCESS
 * immediately. The tree's job is to decide which action to take, not to
 * wait for completion.
 *
 * Structure: `Selector(crisis, maintenance)`.
 * - Crisis branches (fall protection, critical totem, heal) are mutually
 *   exclusive — when one dispatches, the selector stops and nothing else
 *   runs this tick.
 * - The maintenance group (armor, weapon, pearl, buff, food) runs EVERY
 *   tick the crisis selector lets it through. A flat `Selector` cannot be
 *   used here: `alwaysTrue`-style maintenance branches return SUCCESS on
 *   every tick, which would permanently block the branches behind them
 *   (Selector stops at the first SUCCESS child).
 */

import { Selector, Sequence, Node, SUCCESS, FAILURE, RUNNING } from "behaviortree";
import { goals } from "mineflayer-pathfinder";
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
    needsTotem?: boolean;
  };
  getPearlMitigation: () => {
    canMitigate: boolean;
    launchPos?: Vec3;
    targetPos?: Vec3;
    flightTime?: number;
    offset?: number;
  };
  getBestPearlOffset: (source: Vec3, target: Vec3, arc?: "low" | "high") => { offset: number; arc: "low" | "high" } | null;
  lastDamage: number;
  lastPearlTime: number;
  /**
   * Persist a new pearl-throw timestamp on the manager. The tree context is
   * rebuilt per run, so mutating `lastPearlTime` on it would be lost — the
   * cooldown must be written back to survive the next tick.
   */
  setLastPearlTime: (ts: number) => void;
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
 * Run every child branch on the same tick, regardless of each branch's own
 * result. Unlike a Selector it never short-circuits; unlike a Sequence a
 * child FAILURE does not stop the siblings. Always returns SUCCESS.
 */
function maintenance(name: string, children: Node[]): Node {
  return new Node({
    name,
    run: (bb: Blackboard): RunResult => {
      for (const child of children) {
        child.run(bb);
      }
      return SUCCESS;
    },
  });
}

/**
 * Build the combat behavior tree.
 *
 * Crisis priority (mutually exclusive, highest first):
 *   1. Fall protection (gapple/totem when fall is dangerous)
 *   2. Critical HP totem
 *   3. Heal (gapple when low HP)
 *
 * Maintenance (dispatched together every non-crisis tick):
 *   4. Armor
 *   5. Weapon
 *   6. Pearl mitigation (combat throw + fall mitigation)
 *   7. Buff (strength potion)
 *   8. Food
 *   9. Gapple utility
 * All branches can be toggled individually via the `tg` command.
 */
export function buildCombatTree(ctx: CombatTreeContext): Node {
  const { CRITICAL_HP_MULT, LOW_FOOD } = Constants.COMBAT;

  return new Selector({
    name: "combatRoot",
    nodes: [
      new Selector({
        name: "crisis",
        nodes: [
          // 1. Fall protection — totem of undying (highest priority)
          new Sequence({
            name: "fallProtection",
            nodes: [
              condition("isFallDangerous", (c) => c.getFallProtectionStatus().isDangerous),
              condition("totemEnabled", (c) => (c.bot as any).combatManager.isFeatureEnabled("totem")),
              condition("hasTotem", (c) => c.inv().hasItem("totem_of_undying")),
              action("mitigateFall", (c) => { c.inv().equipTotem(); }),
            ],
          }),

          // 3. Critical HP totem
          new Sequence({
            name: "criticalTotem",
            nodes: [
              condition("totemEnabled", (c) => (c.bot as any).combatManager.isFeatureEnabled("totem")),
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
              condition("gappleEnabled", (c) => (c.bot as any).combatManager.isFeatureEnabled("gapple")),
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
        ],
      }),

      maintenance("maintenance", [
        // 4. Armor
        new Sequence({
          name: "armor",
          nodes: [
            condition("armorEnabled", (c) => (c.bot as any).combatManager.isFeatureEnabled("armor")),
            action("equipArmor", (c) => { c.inv().equipArmor(); }),
          ],
        }),

        // 5. Weapon
        new Sequence({
          name: "weapon",
          nodes: [
            condition("weaponEnabled", (c) => (c.bot as any).combatManager.isFeatureEnabled("weapon")),
            action("equipWeapon", (c) => { c.inv().equipWeapon(); }),
          ],
        }),

        // 6. Pearl mitigation — throw ender pearl at a target (combat throw)
        // or teleport to solid ground/ceiling to mitigate a dangerous fall.
        // If a valid trajectory exists from the current position, throw immediately.
        // Otherwise, pathfind to a nearby launch point and throw from there.
        new Sequence({
          name: "pearlMitigation",
          nodes: [
            condition("pearlEnabled", (c) => (c.bot as any).combatManager.isFeatureEnabled("pearl")),
            condition("canPearlMitigate", (c) => c.getPearlMitigation().canMitigate),
            action("mitigateWithPearl", (c) => {
              const mitigation = c.getPearlMitigation();
              const inv = c.inv();
              const cm = c.bot.combatManager;
              const entity = c.bot.entity;
              const launchPos = mitigation.launchPos;

              // If a launch point was found, pathfind to it before throwing.
              if (launchPos) {
                const distToLaunch = entity.position.distanceTo(launchPos);
                if (distToLaunch > 1) {
                  cm._enemyAboveLaunchPoint = launchPos;
                  const key = `${Math.round(launchPos.x)}:${Math.round(launchPos.z)}`;
                  const pf = c.bot.pathfinder;
                  if (
                    pf &&
                    (cm._enemyAboveGoalKey !== key ||
                      !pf.goal ||
                      pf.movements !== (c.bot.combatManager as any).movements)
                  ) {
                    pf.setMovements((c.bot.combatManager as any).movements);
                    pf.setGoal(
                      new goals.GoalNear(
                        launchPos.x,
                        launchPos.y,
                        launchPos.z,
                        1,
                      ),
                      true,
                    );
                    cm._enemyAboveGoalKey = key;
                  }
                  return; // Wait for arrival before throwing
                }

                // Arrived at launch point: clear pathfinding state.
                cm._enemyAboveLaunchPoint = null;
                cm._enemyAboveGoalKey = null;
                const pf = c.bot.pathfinder;
                if (pf) pf.setGoal(null);
              }

              if (inv.isItemUseActive()) return;
              void inv
                .equipPearl(mitigation.targetPos!, mitigation.offset!)
                .catch((error: unknown) => {
                  const err = error as Error;
                  c.logger.debug(
                    `Pearl: equip/throw failed: ${err.message}`,
                    "Combat",
                  );
                });
              c.setLastPearlTime(Date.now());
            }),
          ],
        }),

        // 8. Buff
        new Sequence({
          name: "buff",
          nodes: [
            condition("buffEnabled", (c) => (c.bot as any).combatManager.isFeatureEnabled("buff")),
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
            condition("foodEnabled", (c) => (c.bot as any).combatManager.isFeatureEnabled("food")),
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

        // 9. Gapple utility — equip gapple to offhand (ready state) when no
        // totems are available. Equips without eating so the gapple is ready
        // for immediate consumption when health drops. Does not unequip food
        // or other offhand items.
        new Sequence({
          name: "gapplesUtility",
          nodes: [
            condition("gappleEnabled", (c) => (c.bot as any).combatManager.isFeatureEnabled("gapple")),
            condition("gapplesUtility", (c) => {
              const inv = c.inv();
              const hasGapple = inv.hasItem("golden_apple");
              const hasTotems = inv.hasItem("totem_of_undying");
              const offhandSlot = c.bot.getEquipmentDestSlot("off-hand");
              const offhand = c.bot.inventory.slots[offhandSlot];
              return hasGapple && !hasTotems && (!offhand || offhand.name === "golden_apple");
            }),
            action("equipGappleUtility", (c) => { c.inv().equipUtility(); }),
          ],
        }),
      ]),
    ],
  });
}
