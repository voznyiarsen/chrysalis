/**
 * @fileoverview Unit tests for the pearl launch point handling.
 *
 * Two things decide whether a throw from a launch point is worth making:
 * the bot has to be on the launch point (horizontally and on the same
 * ground level), and the throw has to be solved for the spot the bot will
 * be at when the pearl actually leaves the hand.
 */

import { CombatManager } from "../../src/pvp";
import { Vec3 } from "vec3";

function makeManager(): { manager: CombatManager; bot: any } {
  const bot: any = {
    health: 20,
    entity: {
      metadata: { 11: 0 } as Record<number, number>,
      effects: {},
      position: new Vec3(0, 2, 0),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      height: 1.8,
      eyeHeight: 1.62,
    },
    time: { age: 0 },
    inventory: { slots: [], items: () => [] },
    getEquipmentDestSlot: () => 45,
    registry: { itemsByName: {}, foodsByName: {}, effectsByName: {} },
    pvp: { target: null, attackRange: 3, viewDistance: 32 },
    inventoryManager: {
      hasItem: (name: string) => name === "ender_pearl",
      equipPearl: async () => {},
      equipGapple: async () => {},
    },
    utilsManager: {
      getGroundBelow: () => 2,
      getGroundAbove: () => -64,
      getGroundTopAbove: () => -64,
      getFallDamage: () => 0,
      getFallTicks: () => 999,
      isInUnwanted: () => false,
      getFlatVelocity: () => ({ x: 0, y: 0, z: 0 }),
      applyImpulse: () => {},
      getBestPearlTrajectory: () => null,
      getPearlTopLanding: () => null,
    },
    blockAt: () => null,
    on: () => undefined,
    off: () => undefined,
    __logger: {
      combat: () => undefined,
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      inventory: () => undefined,
      status: () => undefined,
    },
  };
  const manager = new CombatManager(bot);
  return { manager, bot };
}

describe("isAtLaunchPoint", () => {
  test("accepts the bot standing on the launch point", () => {
    const { manager, bot } = makeManager();
    const launch = new Vec3(0.4, 2, 0.2);
    expect(manager.isAtLaunchPoint(launch)).toBe(true);
    expect(bot.entity.position).toBeDefined();
  });

  test("rejects a bot that is still walking to the launch point", () => {
    const { manager } = makeManager();
    expect(manager.isAtLaunchPoint(new Vec3(3, 2, 0))).toBe(false);
  });

  test("rejects a bot on a different ground level", () => {
    // The throw is solved for the launch point's eye level: throwing from
    // another height tilts the arc and the pearl lands beside the
    // platform instead of on it.
    const { manager } = makeManager();
    expect(manager.isAtLaunchPoint(new Vec3(0, 5, 0))).toBe(false);
    expect(manager.isAtLaunchPoint(new Vec3(0, 1, 0))).toBe(false);
    // The same level, a little off: still fine.
    expect(manager.isAtLaunchPoint(new Vec3(0, 2.3, 0))).toBe(true);
  });
});

describe("getPearlMitigation with an explicit source", () => {
  test("solves the throw from the given launch position", () => {
    const { manager, bot } = makeManager();
    // A target at the bot's own level: the direct throw.
    bot.pvp.target = {
      position: new Vec3(10, 2, 0),
      height: 1.8,
    } as any;
    const sources: Vec3[] = [];
    bot.utilsManager.getBestPearlTrajectory = (source: Vec3) => {
      sources.push(source.clone());
      return {
        pitch: 45,
        arc: "high" as const,
        flightTime: 8,
        landingPoint: source.clone(),
        landingDist: 0,
      };
    };

    // Without a source the throw is solved from the bot's spawn point.
    manager.getPearlMitigation();
    expect(sources.length).toBe(1);
    expect(sources[0].y).toBeCloseTo(2 + 1.52, 5);

    // With a source the throw is solved from there — this is how a throw
    // that is re-planned just before the release is aimed at the spot the
    // bot will be at by then.
    const predicted = new Vec3(3, 4, 0);
    manager.getPearlMitigation({ source: predicted });
    expect(sources.length).toBe(2);
    expect(sources[1].x).toBeCloseTo(3, 5);
    expect(sources[1].y).toBeCloseTo(4, 5);
  });
});
