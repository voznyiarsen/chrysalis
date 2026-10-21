/**
 * @fileoverview Unit tests for the combat manager's damage tracking.
 *
 * The effective health (the health plus the absorption that buffers
 * damage) drops on a hit — and also when a golden apple's absorption
 * wears off. Only the first is damage.
 *
 * The timing follows production: the health is sampled every tick, and
 * the damage is measured one tick after the hit was reported (the hurt
 * event and the health update are separate packets).
 */

import { CombatManager } from "../../src/pvp";
import { Vec3 } from "vec3";

function makeManager(): { manager: CombatManager; bot: any } {
  const bot: any = {
    health: 20,
    entity: {
      metadata: { 11: 0 } as Record<number, number>,
      effects: {},
      position: new Vec3(0, 64, 0),
      velocity: { x: 0, y: 0, z: 0 },
      onGround: true,
      width: 0.6,
      height: 1.8,
    },
    time: { age: 0 },
    inventory: { items: () => [], slots: [] },
    getEquipmentDestSlot: () => 45,
    registry: { itemsByName: {}, foodsByName: {}, effectsByName: {} },
    pvp: { target: null, attackRange: 3.5, viewDistance: 32 },
    inventoryManager: { hasItem: () => false, hasFood: () => false },
    utilsManager: {
      getGroundBelow: () => 0,
      getGroundAbove: () => -64,
      getGroundTopAbove: () => -64,
      getFallDamage: () => 0,
      getFallTicks: () => 999,
      isInUnwanted: () => false,
      getFlatVelocity: () => ({ x: 0, y: 0, z: 0 }),
      applyImpulse: () => {},
    },
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

/** Advance the mock clock and take a health sample. */
function tick(manager: CombatManager, bot: any): void {
  bot.time.age += 1;
  manager.sampleHealth();
}

/**
 * A hit arrives: the health changes, and the damage is measured one
 * tick later — the way the hurt handler does it.
 */
function hit(
  manager: CombatManager,
  bot: any,
  health: number,
  absorb: number,
): void {
  bot.health = health;
  bot.entity.metadata[11] = absorb;
  tick(manager, bot);
  tick(manager, bot);
  manager.getLastDamage();
}

describe("CombatManager - damage tracking", () => {
  test("a hit is recorded as damage", () => {
    const { manager, bot } = makeManager();
    manager.sampleHealth();

    // 6 points of damage.
    hit(manager, bot, 14, 0);

    expect(manager.lastDamage).toBe(6);
  });

  test("a hit absorbed by the absorption is recorded", () => {
    const { manager, bot } = makeManager();
    // The bot ate a golden apple: 4 points of absorption.
    bot.entity.metadata[11] = 4;
    manager.sampleHealth();

    // A 2 point hit, fully covered by the absorption.
    hit(manager, bot, 20, 2);

    expect(manager.lastDamage).toBe(2);
  });

  test("the absorption wearing off is not damage", () => {
    const { manager, bot } = makeManager();
    bot.entity.metadata[11] = 4;
    manager.sampleHealth();
    tick(manager, bot);

    // Two minutes later the absorption expires: the effective health
    // drops by 4 although the bot was not hit.
    bot.entity.metadata[11] = 0;
    tick(manager, bot);
    tick(manager, bot);

    // Nothing was reported as a hit, so nothing is recorded as damage.
    expect(manager.lastDamage).toBe(0);
  });

  test("an expiry between two hits is not counted as damage", () => {
    const { manager, bot } = makeManager();
    // The bot ate a golden apple: 4 points of absorption.
    bot.entity.metadata[11] = 4;
    manager.sampleHealth();

    // A first hit: a measurement, so the absorption is part of the
    // effective health from now on.
    hit(manager, bot, 20, 2);
    expect(manager.lastDamage).toBe(2);

    // The absorption wears off (no hit): the effective health drops by
    // the remaining 2 points although the bot was not hit.
    bot.entity.metadata[11] = 0;
    tick(manager, bot);
    tick(manager, bot);
    expect(manager.lastDamage).toBe(2);

    // Now a real hit: 3 points of damage. The expiry must not be
    // counted on top of it.
    hit(manager, bot, 17, 0);
    expect(manager.lastDamage).toBe(3);
  });
});
