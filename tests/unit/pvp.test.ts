/**
 * @fileoverview Unit tests for pupa/src/pvp.ts.
 * Tests CombatDecision logic and health status calculations.
 */

import { CombatDecision, CombatManager } from "../../src/pvp";
import { Constants } from "../../src/constants";
import { Vec3 } from "vec3";

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
        position: new Vec3(0, 0, 0),
        velocity: { x: 0, y: 0, z: 0 },
        onGround: true,
        width: 0.6,
        height: 1.8,
      },
      getEquipmentDestSlot: (dest: string) => ({ head: 5, torso: 6, legs: 7, feet: 8, "off-hand": 45 }[dest] ?? 0),
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
        getGroundAbove: () => -64,
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
      expect(status.needsTotem).toBeUndefined();
    });

    test("dangerous fall equips totem (gapple mid-fall unreachable)", () => {
      mockBot.health = 20;
      mockBot.entity.metadata[11] = 0;
      mockBot.entity.onGround = false;
      mockBot.entity.velocity.y = -0.5;
      mockBot.entity.position.y = 25;
      mockBot.utilsManager.getGroundBelow = () => 0;
      mockBot.utilsManager.getFallDamage = (d: number) => Math.floor(d - 3);
      mockBot.utilsManager.getFallTicks = () => 15; // impact well before any eat budget
      (manager as any).lastMaxFallY = 25;

      const status = manager.getFallProtectionStatus();
      expect(status.isDangerous).toBe(true); // 22 >= 18
      expect(status.predictedDamage).toBe(22);
      expect(status.needsTotem).toBe(true);
    });

    test("very long fall equips totem", () => {
      mockBot.health = 20;
      mockBot.entity.metadata[11] = 0;
      mockBot.entity.onGround = false;
      mockBot.entity.velocity.y = -0.5;
      mockBot.entity.position.y = 50;
      mockBot.utilsManager.getGroundBelow = () => 0;
      mockBot.utilsManager.getFallDamage = (d: number) => Math.floor(d - 3);
      mockBot.utilsManager.getFallTicks = () => 20;
      (manager as any).lastMaxFallY = 50;

      const status = manager.getFallProtectionStatus();
      expect(status.isDangerous).toBe(true); // 47 >= 18
      expect(status.predictedDamage).toBe(47);
      expect(status.needsTotem).toBe(true);
    });

    test("any dangerous fall needs totem regardless of fall time", () => {
      mockBot.health = 20;
      mockBot.entity.metadata[11] = 0;
      mockBot.entity.onGround = false;
      mockBot.entity.velocity.y = -0.01; // slow fall
      mockBot.entity.position.y = 60;
      mockBot.utilsManager.getGroundBelow = () => 0;
      mockBot.utilsManager.getFallDamage = (d: number) => Math.floor(d - 3);
      mockBot.utilsManager.getFallTicks = () => 200; // slow fall, lots of time
      (manager as any).lastMaxFallY = 60;

      const status = manager.getFallProtectionStatus();
      expect(status.isDangerous).toBe(true); // 57 >= 18
      expect(status.predictedDamage).toBe(57);
      // Even with plenty of time, gapple mid-fall is not a mitigation;
      // only a totem handles dangerous falls.
      expect(status.needsTotem).toBe(true);
    });
  });

  describe("getFallPearlMitigation", () => {
    beforeEach(() => {
      // Default: dangerous fall, has pearl, ground at 0, pearl can reach
      mockBot.health = 20;
      mockBot.entity.metadata[11] = 0;
      mockBot.entity.onGround = false;
      mockBot.entity.velocity.y = -0.5;
      mockBot.entity.position.y = 25;
      mockBot.entity.height = 1.8;
      mockBot.utilsManager.getGroundBelow = () => 0;
      mockBot.utilsManager.getFallTicks = () => 20;
      mockBot.utilsManager.getFallDamage = (d: number) => Math.floor(d - 3);
      mockBot.utilsManager.getBestPearlTrajectory = () => ({
        pitch: -45,
        arc: "low" as const,
        flightTime: 10,
        landingPoint: { x: 0, y: 0, z: 0 },
        landingDist: 0,
      });
      mockBot.inventoryManager = {
        hasItem: (name: string) => name === "ender_pearl",
        equipPearl: async () => {},
        equipGapple: async () => {},
      };
      mockBot.inventory = { slots: [] };
      (manager as any).lastMaxFallY = 25;
    });

    test("returns canMitigate false when not falling", () => {
      mockBot.entity.onGround = true;
      mockBot.entity.velocity.y = 0;
      const result = manager.getFallPearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate false when no ender pearl", () => {
      mockBot.inventoryManager.hasItem = (name: string) => name === "totem_of_undying";
      const result = manager.getFallPearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate false when no ground found", () => {
      mockBot.utilsManager.getGroundBelow = () => -64;
      mockBot.utilsManager.getGroundAbove = () => -64;
      const result = manager.getFallPearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate true when void below but overhead blocks exist", () => {
      mockBot.utilsManager.getGroundBelow = () => -64; // void below
      mockBot.utilsManager.getGroundAbove = () => 65; // ceiling above
      mockBot.utilsManager.getBestPearlTrajectory = () => ({
        pitch: 45,
        arc: "high" as const,
        flightTime: 10,
        landingPoint: { x: 0, y: 64, z: 0 },
        landingDist: 0,
      });
      mockBot.entity.position.y = 25;
      mockBot.entity.height = 1.8;
      mockBot.utilsManager.getFallTicks = () => 20;
      mockBot.utilsManager.getFallDamage = (d: number) => Math.floor(d - 3);
      (manager as any).lastMaxFallY = 25;

      const result = manager.getFallPearlMitigation();
      expect(result.canMitigate).toBe(true);
      expect(result.targetPos?.y).toBe(65);
      expect(result.flightTime).toBe(10);
      expect(result.offset).toBeDefined();
    });

    test("returns canMitigate false when no ground below or above", () => {
      mockBot.utilsManager.getGroundBelow = () => -64;
      mockBot.utilsManager.getGroundAbove = () => -64;
      const result = manager.getFallPearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate false when pearl flight too slow", () => {
      mockBot.utilsManager.getBestPearlTrajectory = () => ({
        pitch: -45,
        arc: "low" as const,
        flightTime: 30, // >= ticksToImpact (20)
        landingPoint: { x: 0, y: 0, z: 0 },
        landingDist: 0,
      });
      const result = manager.getFallPearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate true with target and flight time", () => {
      const result = manager.getFallPearlMitigation();
      expect(result.canMitigate).toBe(true);
      expect(result.targetPos).toEqual({ x: 0, y: 0, z: 0 });
      expect(result.flightTime).toBe(10);
      expect(result.offset).toBeDefined();
    });

    test("_hasAnyArmor returns false with empty armor slots", () => {
      mockBot.inventory = { slots: [] };
      expect((manager as any)._hasAnyArmor()).toBe(false);
    });

    test("_hasAnyArmor returns true with armor in a slot", () => {
      mockBot.inventory = { slots: [null, null, null, null, null, { name: "iron_helmet" }] };
      mockBot.getEquipmentDestSlot = (dest: string) => ({ head: 5, torso: 6, legs: 7, feet: 8, "off-hand": 45 }[dest] ?? 0);
      expect((manager as any)._hasAnyArmor()).toBe(true);
    });
  });

  describe("getEnemyAbovePearlMitigation", () => {
    beforeEach(() => {
      // Default: target above bot, has pearl, ground at 0, valid trajectory
      mockBot.health = 20;
      mockBot.entity.metadata[11] = 0;
      mockBot.entity.position = new Vec3(0, 0, 0);
      mockBot.entity.height = 1.8;
      mockBot.entity.onGround = true;
      mockBot.utilsManager.getGroundBelow = () => 0;
      mockBot.utilsManager.getBestPearlTrajectory = () => ({
        pitch: 45,
        arc: "high" as const,
        flightTime: 10,
        landingPoint: { x: 0, y: 10, z: 0 },
        landingDist: 0,
      });
      // Ground block at y=-1 below launch positions, air elsewhere
      mockBot.blockAt = (pos: Vec3) => {
        if (pos.y === -1) return { name: "grass", boundingBox: "block" };
        return null;
      };
      mockBot.inventoryManager = {
        hasItem: (name: string) => name === "ender_pearl",
        equipPearl: async () => {},
        equipGapple: async () => {},
      };
      mockBot.inventory = { slots: [] };
      mockBot.pvp = {
        target: {
          position: new Vec3(0, 5, 0),
          height: 1.8,
        },
        attackRange: 3,
      };
      (manager as any).lastPearlTime = 0;
    });

    test("returns canMitigate false when no target", () => {
      mockBot.pvp.target = null;
      const result = manager.getEnemyAbovePearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate false when target not above bot", () => {
      mockBot.pvp.target.position = new Vec3(0, 1, 0); // only 1 block above, below MIN_HEIGHT=2
      const result = manager.getEnemyAbovePearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate false when target in melee range", () => {
      mockBot.pvp.target.position = new Vec3(0, 3, 0); // distance 3 = attackRange
      const result = manager.getEnemyAbovePearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate false when no ender pearl", () => {
      mockBot.inventoryManager.hasItem = (name: string) => name === "totem_of_undying";
      const result = manager.getEnemyAbovePearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate false when on cooldown", () => {
      (manager as any).lastPearlTime = Date.now() - 1000; // 1s ago, cooldown is 10000ms
      const result = manager.getEnemyAbovePearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate false when no ground below", () => {
      mockBot.utilsManager.getGroundBelow = () => -64;
      const result = manager.getEnemyAbovePearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate false when no valid trajectory", () => {
      mockBot.utilsManager.getBestPearlTrajectory = () => null;
      const result = manager.getEnemyAbovePearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate true with valid launch point and trajectory", () => {
      const result = manager.getEnemyAbovePearlMitigation();
      expect(result.canMitigate).toBe(true);
      expect(result.launchPos).toBeDefined();
      expect(result.targetPos).toBeDefined();
      expect(result.flightTime).toBe(10);
      expect(result.offset).toBeDefined();
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
