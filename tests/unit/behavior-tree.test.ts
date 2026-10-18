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
  food?: number;
}) {
  const has: Record<string, number | boolean> = overrides.has ?? {};
  const health = overrides.health ?? { total: 20, hp: 20 };
  const fallStatus = overrides.fall ?? { isDangerous: false };
  const invCalls: string[] = [];
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
    combatManager: { _lastFallPearlTime: 0 },
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
    getFallPearlMitigation: () => ({
      canMitigate: overrides.pearlMitigation ?? false,
    }),
    getBestPearlOffset: () => {
      // Only reachable if the cooldown check already passed.
      pearlCondPastCooldown.push(Date.now() - lastPearlTime);
      return overrides.pearlOffset === undefined || overrides.pearlOffset === null
        ? null
        : { offset: overrides.pearlOffset, arc: "low" as const };
    },
    lastDamage: 0,
    lastPearlTime,
    setLastPearlTime: (ts: number) => {
      lastPearlTime = ts;
      setPearlCalls.push(ts);
    },
    logger: { debug: () => {}, inventory: () => {} },
  };

  return {
    bot,
    // Mirrors PVPManager._buildTreeContext(): a fresh snapshot per run so
    // the write-back through setLastPearlTime is visible next tick.
    nextRunCtx: (): CombatTreeContext => ({ ...ctx, lastPearlTime }),
    build: (): Node => buildCombatTree(ctx),
    invCalls,
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
      "equipPearl",
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
      pearlMitigation: true,
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

  test("pearl branch honors the cooldown through setLastPearlTime", () => {
    const h = makeCtx({
      target: true,
      pearlOffset: 2,
      has: { ender_pearl: true },
    });
    const tree = h.build();

    tree.run({ ctx: h.nextRunCtx() });
    const run1 = [...h.invCalls].filter((c) => c.startsWith("equip"));
    expect(run1).toEqual([
      "equipArmor",
      "equipWeapon",
      "equipPearl",
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
    // The condition must have been blocked before reaching the offset probe.
    expect(h.pearlCondPastCooldown.length).toBe(2);
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
});
