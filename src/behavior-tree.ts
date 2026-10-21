/**
 * @fileoverview Behavior tree for combat decision-making.
 *
 * Replaces the old decision array with a proper behavior tree.
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
 *   used here: maintenance branches that always succeed return SUCCESS on
 *   every tick, which would permanently block the branches behind them
 *   (Selector stops at the first SUCCESS child).
 */

import { Selector, Sequence, Node, SUCCESS, FAILURE } from "behaviortree";
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
  getPearlMitigation: (options?: {
    ignoreCooldown?: boolean;
    source?: Vec3;
  }) => {
    canMitigate: boolean;
    launchPos?: Vec3;
    targetPos?: Vec3;
    flightTime?: number;
    offset?: number;
    isFallMitigation?: boolean;
    isEnemyAbove?: boolean;
    ticksToImpact?: number;
  };
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

function condition(
  name: string,
  fn: (ctx: CombatTreeContext, bb: Blackboard) => boolean,
): Node {
  return new Node({
    name,
    run: (bb: Blackboard): RunResult => {
      const ctx = bb.ctx as CombatTreeContext;
      return fn(ctx, bb) ? SUCCESS : FAILURE;
    },
  });
}

function action(
  name: string,
  fn: (ctx: CombatTreeContext, bb: Blackboard) => void | Promise<void>,
): Node {
  return new Node({
    name,
    run: (bb: Blackboard): RunResult => {
      const ctx = bb.ctx as CombatTreeContext;
      // Actions are fire-and-forget: the tree decides what to do, it does
      // not wait for the work. A rejected operation must not become an
      // unhandled rejection though — that is reported as an uncaught
      // error far away from its cause and hides the real message.
      try {
        const result = fn(ctx, bb);
        if (result && typeof result.catch === "function") {
          result.catch((error: unknown) => {
            const err = error as Error;
            ctx.logger.error(err, "Combat");
          });
        }
      } catch (error: unknown) {
        const err = error as Error;
        ctx.logger.error(err, "Combat");
      }
      return SUCCESS;
    },
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
 * The tree holds no state: the context is read from the blackboard on
 * every run (`tree.run({ ctx })`), so the callers can hand it a fresh
 * snapshot per tick.
 *
 * Crisis priority (mutually exclusive, highest first):
 *   1. Fall protection (gapple/totem when fall is dangerous)
 *   2. Critical HP totem
 *   3. Heal (gapple when low HP)
 *
 * Maintenance (dispatched together every non-crisis tick):
 *   4. Armor
 *   5. Pearl mitigation (combat throw + fall mitigation)
 *   6. Weapon
 *   7. Buff (strength potion)
 *   8. Food
 *   9. Gapple utility
 * All branches can be toggled individually via the `tg` command.
 *
 * ORDER MATTERS: the pearl branch runs BEFORE the weapon branch. Both want
 * the main hand, and the weapon branch's equip is a queued window operation
 * that lands a tick or more later. With the weapon branch first, its swap
 * is queued before the throw and lands while the pearl is in the hand: the
 * pearl's equip is a no-op when the hand already holds a pearl, so nothing
 * re-asserts the projectile and the throw aborts with "not held after equip
 * (holding iron_sword)". Running the pearl first lets it claim the hand —
 * `equipWeapon` then defers for the duration of the throw.
 */
export function buildCombatTree(): Node {
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
              action("mitigateFall", (c) => c.inv().equipTotem()),
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
              action("equipTotem", (c) => c.inv().equipTotem()),
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
                if (!hasGapple || healthPoints >= 20 || regeneration) {
                  return false;
                }
                // A lethal pearl throw (pearl damage 5 HP, no armor) has
                // its own eat-vs-throw ordering. Defer healing so the pearl
                // branch can throw first when the flight outlasts an eat,
                // or when a fall leaves no time to finish eating.
                const { PEARL_DAMAGE, EAT_TICKS } = Constants.COMBAT.SURVIVAL;
                const cm = c.bot.combatManager;
                if (healthPoints < PEARL_DAMAGE && !cm.hasAnyArmor()) {
                  const mitigation = cm.isFeatureEnabled("pearl")
                    ? c.getPearlMitigation()
                    : { canMitigate: false };
                  if (
                    mitigation.canMitigate &&
                    (mitigation.isFallMitigation ||
                      cm.isFeatureEnabled("enemyAbovePearl"))
                  ) {
                    const flight = mitigation.flightTime ?? 0;
                    if (flight > EAT_TICKS) return false;
                    if (
                      mitigation.isFallMitigation &&
                      (mitigation.ticksToImpact ?? 0) <= EAT_TICKS + flight
                    ) {
                      return false;
                    }
                  }
                }
                return (
                  totalHealth > (c.lastDamage || 1) * CRITICAL_HP_MULT ||
                  !hasTotems
                );
              }),
              action("heal", (c) => c.inv().equipGapple()),
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
            action("equipArmor", (c) => c.inv().equipArmor()),
          ],
        }),

        // 5. Pearl mitigation — throw ender pearl at a target (combat throw)
        // or teleport to solid ground/ceiling to mitigate a dangerous fall.
        // If a valid trajectory exists from the current position, throw immediately.
        // Otherwise, pathfind to a nearby launch point and throw from there.
        // Runs BEFORE the weapon branch: the pearl needs the main hand, and
        // a weapon swap queued first lands while the pearl is in the hand.
        new Sequence({
          name: "pearlMitigation",
          nodes: [
            condition("pearlEnabled", (c) => (c.bot as any).combatManager.isFeatureEnabled("pearl")),
            condition("canPearlMitigate", (c, bb) => {
              // The mitigation is solved once per tick and handed to the
              // action: the launch point search runs in a worker, so a
              // second query could come back empty (the target moved and
              // the cached launch point was dropped) while the condition
              // had already passed.
              const mitigation = c.getPearlMitigation();
              bb.mitigation = mitigation;
              if (!mitigation.canMitigate) return false;
              // Falls are always mitigated when possible; elevated-target
              // throws respect the enemyAbovePearl toggle.
              if (mitigation.isFallMitigation) return true;
              if (mitigation.isEnemyAbove) {
                return (c.bot as any).combatManager.isFeatureEnabled(
                  "enemyAbovePearl",
                );
              }
              return true;
            }),
            action("mitigateWithPearl", (c, bb) => {
              const mitigation = (bb.mitigation ??
                c.getPearlMitigation()) as ReturnType<
                CombatTreeContext["getPearlMitigation"]
              >;
              if (!mitigation.canMitigate) return;
              const inv = c.inv();
              const cm = c.bot.combatManager;
              const entity = c.bot.entity;
              const launchPos = mitigation.launchPos;

              // If a launch point was found, pathfind to it before throwing.
              if (launchPos) {
                // Arrival is judged horizontally: the launch point sits on
                // the ground plane, and a 3D distance would keep a bot that
                // is standing one block higher in a permanent "not there
                // yet" state. The bot has to be on the launch point's ground
                // level too: the throw is solved for that eye level, so
                // throwing from a different height tilts the arc.
                if (!cm.isAtLaunchPoint(launchPos)) {
                  cm._enemyAboveLaunchPoint = launchPos;
                  const key = `${Math.round(launchPos.x)}:${Math.round(launchPos.z)}`;
                  const pf = c.bot.pathfinder;
                  // Re-issuing the goal every tick resets the path and the
                  // control states, which freezes the bot in place. Issue it
                  // once per launch point, and again only when the pathfinder
                  // dropped the goal (reached or failed) while the bot is
                  // still short of it.
                  if (pf && (cm._enemyAboveGoalKey !== key || !pf.goal)) {
                    const movements = c.bot.pvp?.movements;
                    if (movements && pf.movements !== movements) {
                      pf.setMovements(movements);
                    }
                    pf.setGoal(
                      new goals.GoalNear(
                        launchPos.x,
                        launchPos.y,
                        launchPos.z,
                        Constants.COMBAT.ENEMY_ABOVE_PEARL.LAUNCH_ARRIVAL_RADIUS,
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
                if (pf && pf.goal) pf.setGoal(null);
              }

              if (inv.isItemUseActive()) return;

              // A pearl teleport deals 5 HP. At less health with no armor
              // the throw itself is lethal: eat a golden apple first so its
              // absorption/regeneration lands before the teleport damage.
              // Only when the pearl's flight is short enough that eat-then-
              // throw still fits; a long flight is better served by throwing
              // now and eating while the pearl is in the air.
              const health = c.getHealthStatus();
              const { EAT_TICKS } = Constants.COMBAT.SURVIVAL;
              const enoughTimeForEat =
                !mitigation.isFallMitigation ||
                (mitigation.ticksToImpact ?? 0) >
                  EAT_TICKS + (mitigation.flightTime ?? 0);
              if (
                enoughTimeForEat &&
                cm.isFeatureEnabled("gapple") &&
                cm.shouldEatBeforePearl(
                  mitigation.flightTime,
                  health.healthPoints,
                  cm.hasAnyArmor(),
                  inv.hasItem("golden_apple"),
                ) &&
                !(c.bot.entity as any).effects["10"]
              ) {
                void inv.equipGapple().catch((error: unknown) => {
                  const err = error as Error;
                  c.logger.error(err, "Combat");
                });
                return;
              }

              void inv
                .equipPearl(
                  mitigation.targetPos!,
                  mitigation.offset!,
                  undefined,
                  undefined,
                  // Re-plan the throw for the position the bot is at when
                  // the projectile actually leaves the hand: it keeps
                  // moving (or sliding to a stop) while the pearl is
                  // equipped, and the offset was measured against the
                  // position the throw was solved from.
                  () => {
                    // The bot is still moving while the pearl is
                    // equipped, so the throw is solved for the spot the
                    // bot will be at when the pearl is released — not the
                    // one it is at now.
                    const entity = c.bot.entity;
                    const velocity = entity?.velocity;
                    const source =
                      entity && velocity
                        ? entity.position
                            .plus(
                              velocity.scaled(
                                Constants.COMBAT.ENDER_PEARL.RELEASE_DELAY_TICKS,
                              ),
                            )
                            .offset(0, Constants.PHYSICS.PEARL_SPAWN_OFFSET, 0)
                        : undefined;
                    const fresh = c.getPearlMitigation({
                      ignoreCooldown: true,
                      source,
                    });
                    if (
                      !fresh.canMitigate ||
                      !fresh.targetPos ||
                      fresh.offset === undefined
                    ) {
                      return null;
                    }
                    // A plan that still needs a launch point is no throw
                    // from where the bot stands now — unless it is already
                    // standing on that launch point: the offset was solved
                    // for that spot, and the bot is within a few tenths of
                    // a block of it. Aborting here cancelled every
                    // enemy-above throw.
                    if (fresh.launchPos) {
                      const pos = c.bot.entity?.position;
                      const distToLaunch = Math.hypot(
                        (pos?.x ?? 0) - fresh.launchPos.x,
                        (pos?.z ?? 0) - fresh.launchPos.z,
                      );
                      if (
                        distToLaunch >
                        Constants.COMBAT.ENEMY_ABOVE_PEARL.LAUNCH_ARRIVAL_RADIUS
                      ) {
                        return null;
                      }
                    }
                    return {
                      targetPos: fresh.targetPos,
                      offset: fresh.offset,
                    };
                  },
                )
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

        // 6. Weapon — runs AFTER the pearl branch so a throw in flight
        // keeps the main hand: `equipWeapon` defers while a pearl throw is
        // active, and the sword is re-equipped once the throw is done.
        new Sequence({
          name: "weapon",
          nodes: [
            condition("weaponEnabled", (c) => (c.bot as any).combatManager.isFeatureEnabled("weapon")),
            action("equipWeapon", (c) => c.inv().equipWeapon()),
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
            action("buff", (c) => c.inv().equipBuff()),
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
            action("eat", (c) => c.inv().equipFood()),
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
            action("equipGappleUtility", (c) => c.inv().equipUtility()),
          ],
        }),
      ]),
    ],
  });
}
