/**
 * @fileoverview Unit tests for pupa/src/pvp.ts.
 * Tests CombatDecision logic and health status calculations.
 */

import { CombatDecision, CombatManager } from "../../src/pvp";
import { Constants } from "../../src/constants";

describe("CombatDecision", () => {
  test("creates a decision with condition, action, and name", () => {
    const condition = () => true;
    const action = async () => {};
    const decision = new CombatDecision(condition, action, "test");
    expect(decision.condition).toBe(condition);
    expect(decision.action).toBe(action);
    expect(decision.name).toBe("test");
  });

  test("condition can be evaluated", () => {
    const decision = new CombatDecision(
      () => true,
      async () => {},
      "true",
    );
    expect(decision.condition()).toBe(true);

    const falseDecision = new CombatDecision(
      () => false,
      async () => {},
      "false",
    );
    expect(falseDecision.condition()).toBe(false);
  });

  test("action can be awaited", async () => {
    let executed = false;
    const decision = new CombatDecision(
      () => true,
      async () => {
        executed = true;
      },
      "action-test",
    );
    await decision.action();
    expect(executed).toBe(true);
  });

  test("multiple decisions are independent", () => {
    const d1 = new CombatDecision(
      () => true,
      async () => {},
      "d1",
    );
    const d2 = new CombatDecision(
      () => false,
      async () => {},
      "d2",
    );
    expect(d1.condition()).toBe(true);
    expect(d2.condition()).toBe(false);
  });
});

describe("CombatManager - Health Status", () => {
  let manager: CombatManager;
  let mockBot: any;

  beforeEach(() => {
    mockBot = {
      health: 20,
      entity: {
        metadata: {},
        effects: {},
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        onGround: true,
        width: 0.6,
        height: 1.8,
      },
      inventory: {
        items: () => [],
        slots: [],
      },
      registry: {
        itemsByName: {},
        foodsByName: {},
        effectsByName: {
          Strength: { id: 5, name: "Strength" },
          Speed: { id: 1, name: "Speed" },
          Regeneration: { id: 10, name: "Regeneration" },
          InstantHealth: { id: 6, name: "InstantHealth" },
          InstantDamage: { id: 7, name: "InstantDamage" },
        },
      },
      time: { age: 0 },
      blockAt: () => null,
      player: { gamemode: 0 },
      version: "1.12.2",
      pvp: {
        attack: () => {},
        stop: () => {},
        target: null,
        attackRange: 3.5,
        followRange: 3.45,
        viewDistance: 128,
      },
      nearestEntity: () => null,
      waitForTicks: async () => {},
      chat: async () => {},
      listeners: () => [],
      on: () => {},
      off: () => {},
      listenerCount: () => 0,
      clearControlStates: () => {},
      setControlState: () => {},
      equip: async () => {},
      toss: async () => {},
      creative: {
        setInventorySlot: async () => {},
        clearInventory: async () => {},
      },
      inventoryManager: {
        hasItem: () => false,
        hasFood: () => false,
        equipTotem: async () => {},
        equipGapple: async () => {},
        equipFood: async () => {},
        equipBuff: async () => {},
        equipArmor: async () => {},
        equipWeapon: async () => {},
        equipUtility: async () => {},
        equipPearl: async () => {},
        tossAllItems: async () => {},
      },
      utilsManager: {
        isInUnwanted: () => false,
        getFlatVelocity: () => ({ x: 0, y: 0, z: 0 }),
        applyImpulse: () => {},
        getHorizontalSpeed: () => 0,
        getGroundBelow: () => 0,
        getFallDamage: (d: number) => {
          if (d <= 3) return 0;
          return Math.floor(d - 3);
        },
        getFallTicks: () => 999,
        isJumpPathClear: () => true,
        getJumpVelocity: () => ({ x: 0, y: 0.42, z: 0 }),
      },
      runtimeConfig: {
        get: () => Constants.MOVEMENT.AIR_SPEED,
      },
      pathfinder: { stop: async () => {} },
      __logger: {
        combat: (...args: unknown[]) => {},
        debug: (...args: unknown[]) => {},
        error: (...args: unknown[]) => {},
        info: (...args: unknown[]) => {},
        warn: (...args: unknown[]) => {},
        command: (...args: unknown[]) => {},
        inventory: (...args: unknown[]) => {},
        status: (...args: unknown[]) => {},
        config: (...args: unknown[]) => {},
        client: (...args: unknown[]) => {},
        chat: (...args: unknown[]) => {},
        exception: (...args: unknown[]) => {},
        warning: (...args: unknown[]) => {},
      },
    };

    manager = new CombatManager(mockBot);
  });

  describe("getHealthStatus", () => {
    test("returns full health with no absorption", () => {
      mockBot.health = 20;
      mockBot.entity.metadata[11] = 0;
      const status = manager.getHealthStatus();
      expect(status.totalHealth).toBe(20);
      expect(status.healthPoints).toBe(20);
      expect(status.absorbPoints).toBe(0);
    });

    test("returns correct values with absorption", () => {
      mockBot.health = 15;
      mockBot.entity.metadata[11] = 8;
      const status = manager.getHealthStatus();
      expect(status.totalHealth).toBe(23);
      expect(status.healthPoints).toBe(15);
      expect(status.absorbPoints).toBe(8);
    });

    test("returns correct values with zero health", () => {
      mockBot.health = 0;
      mockBot.entity.metadata[11] = 0;
      const status = manager.getHealthStatus();
      expect(status.totalHealth).toBe(0);
      expect(status.healthPoints).toBe(0);
      expect(status.absorbPoints).toBe(0);
    });

    test("returns correct values with max health and absorption", () => {
      mockBot.health = 20;
      mockBot.entity.metadata[11] = 16;
      const status = manager.getHealthStatus();
      expect(status.totalHealth).toBe(36);
      expect(status.healthPoints).toBe(20);
      expect(status.absorbPoints).toBe(16);
    });
  });

  describe("getFallProtectionStatus", () => {
    test("returns not dangerous when on ground", () => {
      mockBot.entity.onGround = true;
      mockBot.entity.velocity.y = 0;
      const status = manager.getFallProtectionStatus();
      expect(status.isDangerous).toBe(false);
    });

    test("returns not dangerous when velocity is upward", () => {
      mockBot.entity.onGround = false;
      mockBot.entity.velocity.y = 0.5;
      const status = manager.getFallProtectionStatus();
      expect(status.isDangerous).toBe(false);
    });

    test("returns not dangerous for short falls with full health", () => {
      mockBot.health = 20;
      mockBot.entity.onGround = false;
      mockBot.entity.velocity.y = -0.5;
      mockBot.entity.position.y = 10;
      mockBot.utilsManager.getGroundBelow = () => 8;
      const status = manager.getFallProtectionStatus();
      expect(status.isDangerous).toBe(false);
    });

    test("considers dangerous fall when damage exceeds health - threshold", () => {
      mockBot.health = 2;
      mockBot.entity.onGround = false;
      mockBot.entity.velocity.y = -0.5;
      mockBot.entity.position.y = 50;
      mockBot.utilsManager.getGroundBelow = () => 20;
      mockBot.utilsManager.getFallDamage = () => 27;
      const status = manager.getFallProtectionStatus();
      expect(status.isDangerous).toBe(true);
    });

    test("safe fall below danger threshold takes no action", () => {
      mockBot.health = 20;
      mockBot.entity.metadata[11] = 0;
      mockBot.entity.onGround = false;
      mockBot.entity.velocity.y = -0.5;
      mockBot.entity.position.y = 10;
      mockBot.utilsManager.getGroundBelow = () => 0;
      mockBot.utilsManager.getFallDamage = (d: number) => Math.floor(d - 3);
      (manager as any).lastMaxFallY = 10;

      const status = manager.getFallProtectionStatus();
      expect(status.isDangerous).toBe(false);
      expect(status.predictedDamage).toBe(7); // (10 - 3) * 1
    });

    test("dangerous fall too fast to eat equips totem (regular gapple case)", () => {
      mockBot.health = 20;
      mockBot.entity.metadata[11] = 0;
      mockBot.entity.onGround = false;
      mockBot.entity.velocity.y = -0.5;
      mockBot.entity.position.y = 25;
      mockBot.utilsManager.getGroundBelow = () => 0;
      mockBot.utilsManager.getFallDamage = (d: number) => Math.floor(d - 3);
      mockBot.utilsManager.getFallTicks = () => 15; // impact before 42-tick eat budget
      (manager as any).lastMaxFallY = 25;

      const status = manager.getFallProtectionStatus();
      expect(status.isDangerous).toBe(true); // 22 >= 18
      expect(status.hasTimeToEat).toBe(false);
      expect(status.canEatGapple).toBe(false);
      expect(status.canEatEGapple).toBe(false);
      expect(status.needsTotem).toBe(true);
    });

    test("very long fall equips totem and cannot be saved by eating", () => {
      mockBot.health = 20;
      mockBot.entity.metadata[11] = 0;
      mockBot.entity.onGround = false;
      mockBot.entity.velocity.y = -0.5;
      mockBot.entity.position.y = 50;
      mockBot.utilsManager.getGroundBelow = () => 0;
      mockBot.utilsManager.getFallDamage = (d: number) => Math.floor(d - 3);
      mockBot.utilsManager.getFallTicks = () => 20; // still too fast to eat
      (manager as any).lastMaxFallY = 50;

      const status = manager.getFallProtectionStatus();
      expect(status.isDangerous).toBe(true); // 47 >= 18
      expect(status.predictedDamage).toBe(47);
      expect(status.hasTimeToEat).toBe(false);
      expect(status.needsTotem).toBe(true);
    });

    test("dangerous fall fast enough to eat equips enchanted gapple when held", () => {
      mockBot.health = 20;
      mockBot.entity.metadata[11] = 0;
      mockBot.entity.onGround = false;
      mockBot.entity.velocity.y = -0.01; // slow fall
      mockBot.entity.position.y = 60;
      mockBot.utilsManager.getGroundBelow = () => 0;
      mockBot.utilsManager.getFallDamage = (d: number) => Math.floor(d - 3);
      mockBot.utilsManager.getFallTicks = () => 50; // more than 42-tick eat budget
      (manager as any).lastMaxFallY = 60;

      const status = manager.getFallProtectionStatus();
      expect(status.isDangerous).toBe(true); // 57 >= 18
      expect(status.predictedDamage).toBe(57);
      expect(status.hasTimeToEat).toBe(true);
      // Regular gapple alone (28 HP) can't survive 57 damage.
      expect(status.canEatGapple).toBe(false);
      // Enchanted gapple: 57*0.8 = 45.6 damage vs 52 HP threshold → survives.
      expect(status.canEatEGapple).toBe(true);
      expect(status.needsTotem).toBe(false);
    });
  });

  describe("getLastDamage", () => {
    test("records positive health delta as damage", () => {
      mockBot.health = 20;
      mockBot.entity.metadata[11] = 0;
      (manager as any).lastHealth = 20;

      mockBot.health = 15;
      manager.getLastDamage();
      expect((manager as any).lastDamage).toBe(5);
    });

    test("does not record negative health delta (healing)", () => {
      mockBot.health = 20;
      mockBot.entity.metadata[11] = 0;
      (manager as any).lastHealth = 15;
      (manager as any).lastDamage = 5;

      mockBot.health = 20;
      manager.getLastDamage();
      expect((manager as any).lastDamage).toBe(5);
    });

    test("accounts for absorption when calculating damage", () => {
      mockBot.health = 20;
      mockBot.entity.metadata[11] = 8;
      (manager as any).lastHealth = 28;

      mockBot.health = 15;
      mockBot.entity.metadata[11] = 4;
      manager.getLastDamage();
      expect((manager as any).lastDamage).toBe(9);
    });
  });

  describe("setMode", () => {
    test("sets combat mode to specified value", () => {
      manager.setMode(0);
      expect(manager.mode).toBe(0);
    });

    test("invalidates mode filter cache", () => {
      (manager as any).modeFilterCache = {};
      manager.setMode(1);
      expect((manager as any).modeFilterCache).toBeNull();
    });
  });

  describe("getTargetFilter", () => {
    test("mode 0 filters for hostile mobs", () => {
      manager.setMode(0);
      const filter = manager.getTargetFilter();
      expect(filter).toBeDefined();
    });

    test("mode 1 filters for survival players", () => {
      manager.setMode(1);
      const filter = manager.getTargetFilter();
      expect(filter).toBeDefined();
    });

    test("mode 2 filters for all players", () => {
      manager.setMode(2);
      const filter = manager.getTargetFilter();
      expect(filter).toBeDefined();
    });

    test("mode 3 filters for all entities", () => {
      manager.setMode(3);
      const filter = manager.getTargetFilter();
      expect(filter).toBeDefined();
    });

    test("returns cached filter when mode hasn't changed", () => {
      manager.setMode(1);
      const filter1 = manager.getTargetFilter();
      const filter2 = manager.getTargetFilter();
      expect(filter1).toBe(filter2);
    });
  });

  describe("addAlly / removeAlly", () => {
    test("addAlly adds username to allies set", () => {
      manager.addAlly("Player1");
      expect((manager as any).alliesSet.has("Player1")).toBe(true);
    });

    test("removeAlly removes username from allies set", () => {
      manager.addAlly("Player1");
      manager.removeAlly("Player1");
      expect((manager as any).alliesSet.has("Player1")).toBe(false);
    });

    test("addAlly invalidates mode filter cache", () => {
      manager.getTargetFilter();
      manager.addAlly("Player2");
      expect((manager as any).modeFilterCache).toBeNull();
    });
  });
});
