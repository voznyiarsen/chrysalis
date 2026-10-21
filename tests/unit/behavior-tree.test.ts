/**
 * @fileoverview Unit tests for the combat behavior tree dispatch semantics.
 *
 * The tree is `Selector(crisis, maintenance)`:
 * - crisis branches (fall protection, critical totem, heal) are mutually
 *   exclusive — a dispatched crisis preempts everything else that tick;
 * - the maintenance group (armor, weapon, pearl, buff, food) runs every
 *   non-crisis tick. These tests guard against the Selector short-circuit
 *   regression (armor once permanently blocked every lower branch) and the
 *   fall-protection `inv()` TypeError.
 */

import { buildCombatTree, CombatTreeContext } from "../../src/behavior-tree";
import { Node } from "behaviortree";
import { Vec3 } from "vec3";

function makeCtx(overrides: {
  has?: Record<string, number | boolean>;
  health?: { total: number; hp: number };
  fall?: { isDangerous: boolean; needsTotem?: boolean };
  target?: boolean;
  pearlOffset?: number | null;
  pearlMitigation?: boolean;
  enemyAbovePearlMitigation?: boolean;
  /** Launch point to report; defaults to the bot's own position (arrived). */
  launchPos?: Vec3;
  food?: number;
  features?: Record<string, boolean>;
}) {
  const has: Record<string, number | boolean> = overrides.has ?? {};
  const health = overrides.health ?? { total: 20, hp: 20 };
  const fallStatus = overrides.fall ?? { isDangerous: false };
  const invCalls: string[] = [];
  const goalCalls: Array<{ x: number; y: number; z: number } | null> = [];
  const inv = {
    hasItem: (name: string, metadata?: number) => {
      invCalls.push(`has:${name}${metadata ? ":" + metadata : ""}`);
      const v = has[metadata !== undefined ? name + ":" + metadata : name];
      return v !== undefined ? v !== false : false;
    },
    hasFood: () => has.food !== undefined,
    equipArmor: () => invCalls.push("equipArmor"),
    equipWeapon: () => invCalls.push("equipWeapon"),
    equipGapple: () => invCalls.push("equipGapple"),
    equipTotem: () => invCalls.push("equipTotem"),
    equipPearl: async () => invCalls.push("equipPearl"),
    equipBuff: () => invCalls.push("equipBuff"),
    equipFood: () => invCalls.push("equipFood"),
    equipUtility: () => invCalls.push("equipUtility"),
    isItemUseActive: () => false,
  };

  const pvp = overrides.target
    ? { target: { position: new Vec3(8, 64, 0), height: 1.8 }, attackRange: 3 }
    : { target: null, attackRange: 3 };

  const bot: any = {
    pvp,
    entity: {
      effects: {} as Record<string, unknown>,
      position: new Vec3(0, 64, 0),
      height: 1.8,
    },
    food: overrides.food ?? 20,
    combatManager: {
      _lastFallPearlTime: 0,
      _enemyAboveLaunchPoint: null as Vec3 | null,
      _enemyAboveGoalKey: null as string | null,
      movements: {},
      isFeatureEnabled: (name: string) =>
        overrides.features?.[name] ?? true,
      hasAnyArmor: () => false,
      shouldEatBeforePearl: () => false,
      // The launch point check: the bot stands on the launch point unless
      // the test moves it away.
      isAtLaunchPoint: (launchPos: Vec3) => {
        const pos = bot.entity.position;
        const horizontal = Math.hypot(
          pos.x - launchPos.x,
          pos.z - launchPos.z,
        );
        if (horizontal > 0.75) return false;
        return Math.abs(pos.y - launchPos.y) <= 1;
      },
    },
    pathfinder: {
      goal: null,
      movements: null,
      setMovements: (m: unknown) => {
        bot.pathfinder.movements = m;
      },
      setGoal: (goal: unknown) => {
        bot.pathfinder.goal = goal;
        goalCalls.push(
          goal && typeof goal === "object" && "x" in (goal as object)
            ? { x: (goal as any).x, y: (goal as any).y, z: (goal as any).z }
            : null,
        );
      },
    },
    getEquipmentDestSlot: (dest: string) => ({ head: 5, torso: 6, legs: 7, feet: 8, "off-hand": 45 }[dest] ?? 0),
    inventory: { slots: [] },
  };

  let lastPearlTime = 0;
  const setPearlCalls: number[] = [];
  const pearlCondPastCooldown: number[] = [];

  const ctx: CombatTreeContext = {
    bot,
    inv: () => inv,
    getHealthStatus: () => ({
      totalHealth: health.total,
      healthPoints: health.hp,
      absorbPoints: 0,
    }),
    getFallProtectionStatus: () => ({
      isDangerous: fallStatus.isDangerous,
      needsTotem: (fallStatus as any).needsTotem,
    }),
    getPearlMitigation: () => ({
      canMitigate: (overrides.pearlMitigation ?? false) && lastPearlTime === 0,
      launchPos: overrides.pearlMitigation
        ? overrides.launchPos ?? new Vec3(0, 64, 0) // at bot's position: arrived
        : undefined,
      isFallMitigation: (overrides.fall ?? { isDangerous: false }).isDangerous,
      isEnemyAbove: overrides.enemyAbovePearlMitigation ?? false,
    }),
    lastDamage: 0,
    lastPearlTime,
    setLastPearlTime: (ts: number) => {
      lastPearlTime = ts;
      setPearlCalls.push(ts);
    },
    logger: { debug: () => {}, inventory: () => {}, error: () => {} },
  };

  return {
    bot,
    // Mirrors PVPManager._buildTreeContext(): a fresh snapshot per run so
    // the write-back through setLastPearlTime is visible next tick.
    nextRunCtx: (): CombatTreeContext => ({ ...ctx, lastPearlTime }),
    build: (): Node => buildCombatTree(),
    invCalls,
    goalCalls,
    setPearlCalls,
    pearlCondPastCooldown,
  };
}

describe("combat tree dispatch", () => {
  test("maintenance branches dispatch every tick without short-circuiting", () => {
    const h = makeCtx({});
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });
    tree.run({ ctx: h.nextRunCtx() });

    const dispatches = h.invCalls.filter((c) => c.startsWith("equip"));
    // Armor and weapon must BOTH dispatch on every tick — under the old
    // flat Selector, armor's always-true SUCCESS stopped the tree before
    // the weapon branch ever ran.
    expect(dispatches.filter((c) => c === "equipArmor").length).toBe(2);
    expect(dispatches.filter((c) => c === "equipWeapon").length).toBe(2);
    // No crisis, no target, no potion/food: the gated branches stay quiet.
    expect(dispatches).toEqual([
      "equipArmor",
      "equipWeapon",
      "equipArmor",
      "equipWeapon",
    ]);
  });

  test("a crisis dispatch preempts maintenance for that tick", () => {
    const h = makeCtx({
      fall: { isDangerous: true, needsTotem: true },
      has: { totem_of_undying: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });

    expect(h.invCalls.filter((c) => c.startsWith("equip"))).toEqual([
      "equipTotem",
    ]);
  });

  test("fall pearl equips pearl when dangerous fall, no totem, can mitigate", () => {
    const h = makeCtx({
      fall: { isDangerous: true, needsTotem: true },
      pearlMitigation: true,
      has: { ender_pearl: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });

    expect(h.invCalls.filter((c) => c.startsWith("equip"))).toEqual([
      "equipArmor",
      "equipPearl",
      "equipWeapon",
    ]);
  });

  test("fall pearl does nothing when no totem and cannot mitigate", () => {
    const h = makeCtx({
      fall: { isDangerous: true, needsTotem: true },
      pearlMitigation: false,
      has: {},
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });

    const dispatches = h.invCalls.filter((c) => c.startsWith("equip"));
    // Maintenance armor + weapon always run; no fall mitigation.
    expect(dispatches).toEqual(["equipArmor", "equipWeapon"]);
  });

  test("fall pearl does nothing when not dangerous", () => {
    const h = makeCtx({
      fall: { isDangerous: false, needsTotem: true },
      pearlMitigation: false,
      has: { ender_pearl: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });

    const dispatches = h.invCalls.filter((c) => c.startsWith("equip"));
    // No crisis, maintenance armor + weapon run.
    expect(dispatches).toEqual(["equipArmor", "equipWeapon"]);
  });

  test("totem takes priority over pearl when both available", () => {
    const h = makeCtx({
      fall: { isDangerous: true, needsTotem: true },
      pearlMitigation: true,
      has: { totem_of_undying: true, ender_pearl: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });

    expect(h.invCalls.filter((c) => c.startsWith("equip"))).toEqual([
      "equipTotem",
    ]);
  });

  test("enemy above pearl equips pearl when dangerous, no totem, can mitigate", () => {
    const h = makeCtx({
      fall: { isDangerous: false },
      pearlMitigation: true,
      has: { ender_pearl: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });

    const dispatches = h.invCalls.filter((c) => c.startsWith("equip"));
    expect(dispatches).toEqual(["equipArmor", "equipPearl", "equipWeapon"]);
  });

  test("enemy above pearl does nothing when cannot mitigate", () => {
    const h = makeCtx({
      fall: { isDangerous: false },
      pearlMitigation: false,
      has: { ender_pearl: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });

    const dispatches = h.invCalls.filter((c) => c.startsWith("equip"));
    expect(dispatches).toEqual(["equipArmor", "equipWeapon"]);
  });

  test("enemy above pearl does nothing when not dangerous", () => {
    const h = makeCtx({
      fall: { isDangerous: false },
      pearlMitigation: false,
      has: { ender_pearl: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });

    const dispatches = h.invCalls.filter((c) => c.startsWith("equip"));
    expect(dispatches).toEqual(["equipArmor", "equipWeapon"]);
  });

  test("enemy above pearl respects the enemyAbovePearl toggle", () => {
    const h = makeCtx({
      fall: { isDangerous: false },
      pearlMitigation: true,
      enemyAbovePearlMitigation: true,
      features: { enemyAbovePearl: false },
      has: { ender_pearl: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });

    const dispatches = h.invCalls.filter((c) => c.startsWith("equip"));
    expect(dispatches).toEqual(["equipArmor", "equipWeapon"]);
  });

  test("fall mitigation ignores the enemyAbovePearl toggle", () => {
    const h = makeCtx({
      fall: { isDangerous: true },
      pearlMitigation: true,
      enemyAbovePearlMitigation: true,
      features: { enemyAbovePearl: false },
      has: { ender_pearl: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });

    const dispatches = h.invCalls.filter((c) => c.startsWith("equip"));
    expect(dispatches).toEqual(["equipArmor", "equipPearl", "equipWeapon"]);
  });

  test("heal crisis dispatches the gapple eat", () => {
    const h = makeCtx({
      health: { total: 8, hp: 8 },
      has: { golden_apple: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });

    expect(h.invCalls.filter((c) => c.startsWith("equip"))).toEqual([
      "equipGapple",
    ]);
  });

  test("gapplesUtility equips gapple to offhand when no totem and offhand empty", () => {
    const h = makeCtx({
      has: { golden_apple: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });

    const dispatches = h.invCalls.filter((c) => c.startsWith("equip"));
    // Maintenance armor + weapon always run; gapplesUtility equips gapple.
    expect(dispatches).toEqual([
      "equipArmor",
      "equipWeapon",
      "equipUtility",
    ]);
  });

  test("gapplesUtility does nothing when totem available", () => {
    const h = makeCtx({
      has: { golden_apple: true, totem_of_undying: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });

    const dispatches = h.invCalls.filter((c) => c.startsWith("equip"));
    expect(dispatches).toEqual(["equipArmor", "equipWeapon"]);
  });

  test("gapplesUtility does nothing when no gapple", () => {
    const h = makeCtx({
      has: { ender_pearl: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });

    const dispatches = h.invCalls.filter((c) => c.startsWith("equip"));
    expect(dispatches).toEqual(["equipArmor", "equipWeapon"]);
  });

  test("gapplesUtility does nothing when offhand occupied by non-gapple", () => {
    const h = makeCtx({
      has: { golden_apple: true },
    });
    const tree = h.build();
    // Simulate food in offhand: gapplesUtility should not unequip it.
    h.bot.inventory.slots[45] = { name: "cooked_beef", type: 1, count: 1 };

    tree.run({ ctx: h.nextRunCtx() });

    const dispatches = h.invCalls.filter((c) => c.startsWith("equip"));
    expect(dispatches).toEqual(["equipArmor", "equipWeapon"]);
  });

  test("pearl branch waits at the launch point instead of throwing", () => {
    // A launch point two blocks away: the tree must pathfind there and NOT
    // throw yet — throwing from here lands on the platform's side face.
    const h = makeCtx({
      fall: { isDangerous: false },
      pearlMitigation: true,
      enemyAbovePearlMitigation: true,
      launchPos: new Vec3(0, 64, 2),
      has: { ender_pearl: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });

    expect(h.invCalls.filter((c) => c.startsWith("equip"))).toEqual([
      "equipArmor",
      "equipWeapon",
    ]);
    // The pathfinder was handed a goal at the launch point.
    expect(h.goalCalls.length).toBe(1);
    expect(h.goalCalls[0]).toEqual({ x: 0, y: 64, z: 2 });
    // The launch point is remembered for the next tick.
    expect(h.bot.combatManager._enemyAboveLaunchPoint).toEqual(
      new Vec3(0, 64, 2),
    );
    expect(h.bot.combatManager._enemyAboveGoalKey).toBe("0:2");
  });

  test("pearl branch throws once the launch point is reached", () => {
    // Launch point at the bot's own position: arrival, so the pearl is thrown.
    const h = makeCtx({
      fall: { isDangerous: false },
      pearlMitigation: true,
      enemyAbovePearlMitigation: true,
      launchPos: new Vec3(0, 64, 0),
      has: { ender_pearl: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });

    expect(h.invCalls.filter((c) => c.startsWith("equip"))).toEqual([
      "equipArmor",
      "equipPearl",
      "equipWeapon",
    ]);
    expect(h.setPearlCalls.length).toBe(1);
    // Pathfinding state is cleared once the throw is away.
    expect(h.bot.combatManager._enemyAboveLaunchPoint).toBeNull();
    expect(h.bot.combatManager._enemyAboveGoalKey).toBeNull();
  });

  test("pearl branch honors the cooldown through setLastPearlTime", () => {
    const h = makeCtx({
      target: true,
      pearlMitigation: true,
      pearlOffset: 2,
      has: { ender_pearl: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });
    const run1 = [...h.invCalls].filter((c) => c.startsWith("equip"));
    expect(run1).toEqual([
      "equipArmor",
      "equipPearl",
      "equipWeapon",
    ]);
    expect(h.setPearlCalls.length).toBe(1);
    expect(h.setPearlCalls[0]).toBeGreaterThan(0);

    // The next run rebuilds the context; the persisted timestamp (set via
    // setLastPearlTime, as PVPManager would) puts the pearl on cooldown.
    const before = h.invCalls.length;
    tree.run({ ctx: h.nextRunCtx() });
    const run2 = [...h.invCalls.slice(before)].filter((c) =>
      c.startsWith("equip"),
    );
    expect(run2).toEqual(["equipArmor", "equipWeapon"]);
    // The cooldown prevented a second setLastPearlTime call.
    expect(h.setPearlCalls.length).toBe(1);
  });

  test("crisis selectors fall through to maintenance when nothing is critical", () => {
    // Health low but no gapples, no totems → all three crisis branches fail;
    // maintenance must still dispatch.
    const h = makeCtx({ health: { total: 4, hp: 4 } });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });
    const dispatches = h.invCalls.filter((c) => c.startsWith("equip"));
    expect(dispatches).toContain("equipArmor");
    expect(dispatches).toContain("equipWeapon");
  });

  test("pearl branch dispatches before the weapon branch", () => {
    // Both branches want the main hand. The weapon branch's equip is a
    // queued window operation that lands a tick or more later, so a throw
    // that runs after it finds the sword in the hand: the pearl's equip is
    // a no-op when the hand already holds a pearl, nothing re-asserts the
    // projectile, and the throw aborts ("not held after equip (holding
    // iron_sword)"). The pearl must claim the hand first.
    const h = makeCtx({
      fall: { isDangerous: false },
      pearlMitigation: true,
      enemyAbovePearlMitigation: true,
      launchPos: new Vec3(0, 64, 0),
      has: { ender_pearl: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });

    const dispatches = h.invCalls.filter((c) => c.startsWith("equip"));
    expect(dispatches).toEqual(["equipArmor", "equipPearl", "equipWeapon"]);
    expect(dispatches.indexOf("equipPearl")).toBeLessThan(
      dispatches.indexOf("equipWeapon"),
    );
  });

  test("a rejected action is reported instead of becoming unhandled", async () => {
    // The tree's actions are fire-and-forget. A rejected inventory
    // operation (a window transaction the server refused, for example)
    // must not escape as an unhandled rejection — it would be reported
    // as an uncaught error far away from its cause.
    const h = makeCtx({});
    const errors: Error[] = [];
    const ctx = h.nextRunCtx();
    ctx.logger = {
      debug: () => undefined,
      inventory: () => undefined,
      error: (err: Error) => errors.push(err),
    };
    (ctx.inv() as any).equipArmor = () =>
      Promise.reject(new Error("window transaction rejected"));

    h.build().run({ ctx });

    // The rejection is handled asynchronously (the catch runs in a
    // microtask).
    await Promise.resolve();
    await Promise.resolve();

    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("window transaction rejected");
  });
});
