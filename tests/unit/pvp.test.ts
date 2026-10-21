/**
 * @fileoverview Unit tests for pupa/src/pvp.ts.
 * Tests the combat manager's health status calculations.
 */

import { CombatManager } from "../../src/pvp";
import { Constants } from "../../src/constants";
import { UtilsManager } from "../../src/utils";
import { Vec3 } from "vec3";

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
      entities: {},
      pvp: {
        attack: () => {},
        stop: () => {},
        target: null,
        attackRange: 3.5,
        followRange: 3.45,
        viewDistance: 32,
        getHurtTicks: () => 0,
        getTargetDistance: () => 0,
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
        getGroundTopAbove: () => -64,
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

  describe("getPearlMitigation", () => {
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
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate false when no ender pearl", () => {
      mockBot.inventoryManager.hasItem = (name: string) => name === "totem_of_undying";
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate false when no ground found", () => {
      mockBot.utilsManager.getGroundBelow = () => -64;
      mockBot.utilsManager.getGroundTopAbove = () => -64;
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("throws for the block above's top surface when the void is below", () => {
      mockBot.utilsManager.getGroundBelow = () => -64; // void below
      // A block at y=65: its top surface is at y=66.
      mockBot.utilsManager.getGroundTopAbove = () => 66;
      mockBot.utilsManager.getPearlTopLanding = () => ({
        pitch: 88,
        offset: 20,
        flightTime: 10,
        landingPoint: { x: 0, y: 66, z: 0 },
        landingDist: 0,
      });
      mockBot.entity.position.y = 25;
      mockBot.entity.height = 1.8;
      mockBot.utilsManager.getFallTicks = () => 20;
      mockBot.utilsManager.getFallDamage = (d: number) => Math.floor(d - 3);
      (manager as any).lastMaxFallY = 25;

      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(true);
      // The aim is the top surface of the block above, not its underside.
      expect(result.targetPos?.y).toBe(66);
      expect(result.isFallMitigation).toBe(true);
      expect(result.flightTime).toBe(10);
      expect(result.offset).toBe(20);
    });

    test("returns canMitigate false when the block above cannot be reached", () => {
      mockBot.utilsManager.getGroundBelow = () => -64;
      mockBot.utilsManager.getGroundTopAbove = () => 66;
      // No throw lands on that surface: there is nothing to throw.
      mockBot.utilsManager.getPearlTopLanding = () => null;
      const result = manager.getPearlMitigation();
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
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate true with target and flight time", () => {
      const result = manager.getPearlMitigation();
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

  describe("getPearlMitigation (enemy above)", () => {
    /** A block in the mock world. */
    const block = (x: number, y: number, z: number, name = "stone") => ({
      position: new Vec3(x, y, z),
      boundingBox: "block",
      shapes: [[0, 0, 0, 1, 1, 1]],
      name,
    });

    /** Landing solution for a throw onto a platform top. */
    const topLanding = (flightTime = 10) => ({
      pitch: 88,
      offset: 20,
      flightTime,
      landingPoint: new Vec3(0, 5, 0),
      landingDist: 0,
    });

    /**
     * The launch point search runs in a worker thread, so the mitigation
     * only becomes available once the worker has reported a launch point.
     */
    const answerLaunchPointSearch = (
      manager: any,
      launchPos = new Vec3(1.5, 0, 0),
      flightTime = 12,
    ): void => {
      // The request has to exist first: the answer is matched against the
      // aim point it was requested for.
      manager.getPearlMitigation();
      manager._pearlSolver?.onSolution?.({
        launchPos,
        landing: topLanding(flightTime),
      });
    };

    beforeEach(() => {
      // Default: target above bot, has pearl, ground at 0, valid trajectory
      mockBot.health = 20;
      mockBot.entity.metadata[11] = 0;
      mockBot.entity.position = new Vec3(0, 0, 0);
      mockBot.entity.height = 1.8;
      mockBot.entity.eyeHeight = 1.62;
      mockBot.entity.onGround = true;
      mockBot.utilsManager.getGroundBelow = () => 0;
      mockBot.utilsManager.getBestPearlTrajectory = () => ({
        pitch: 45,
        arc: "high" as const,
        flightTime: 10,
        landingPoint: { x: 0, y: 10, z: 0 },
        landingDist: 0,
      });
      mockBot.utilsManager.getPearlTopLanding = () => topLanding();
      // Ground block at y=-1 below launch positions, plus the 1x1 platform
      // the target stands on (top surface at y=5).
      mockBot.blockAt = (pos: Vec3) => {
        const x = Math.floor(pos.x);
        const y = Math.floor(pos.y);
        const z = Math.floor(pos.z);
        if (y === -1 && x >= -4 && x <= 4 && z >= -4 && z <= 4) {
          return block(x, y, z, "grass");
        }
        if (x === 0 && z === 0 && y === 4) return block(x, y, z);
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
      (manager as any)._launchPointCache = null;
      // No worker in the unit tests: the launch point search falls back to
      // the synchronous path.
      (manager as any)._pearlSolver = null;
    });

    test("returns canMitigate false when no target", () => {
      mockBot.pvp.target = null;
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate false when target in melee range", () => {
      // Same height, within the attack range: the bot can just swing.
      mockBot.pvp.target.position = new Vec3(0, 0, 3);
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("an overhead target is out of melee reach and needs the pearl", () => {
      // The target is three blocks up: the platform blocks every melee
      // swing, so the pearl is the only way up — even though the 3D
      // distance is inside the attack range.
      mockBot.pvp.target.position = new Vec3(0, 3, 0);
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(true);
      expect(result.isEnemyAbove).toBe(true);
    });

    test("returns canMitigate false when no ender pearl", () => {
      mockBot.inventoryManager.hasItem = (name: string) => name === "totem_of_undying";
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate false when on cooldown", () => {
      (manager as any).lastPearlTime = Date.now() - 1000; // 1s ago, cooldown is 10000ms
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate false when no ground below (target in range)", () => {
      // No ground means no launch point, and an elevated target is never
      // thrown at directly — so there is no usable throw at all.
      mockBot.utilsManager.getPearlTopLanding = (source: Vec3) =>
        source.x === 0 && source.z === 0 ? null : topLanding();
      mockBot.utilsManager.getGroundBelow = () => -64;
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate false when no launch point works", () => {
      mockBot.utilsManager.getPearlTopLanding = () => null;
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("an elevated target needs a launch point, never a direct throw", () => {
      // The direct throw from below the platform lands on the side face, so
      // the mitigation must come from a launch point instead.
      mockBot.utilsManager.getPearlTopLanding = (source: Vec3) =>
        source.x === 0 && source.z === 0 ? null : topLanding();
      answerLaunchPointSearch(manager, new Vec3(1.5, 0, 0), 10);
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(true);
      expect(result.launchPos).toBeDefined();
      expect(result.targetPos).toBeDefined();
      expect(result.flightTime).toBe(10);
      expect(result.offset).toBeDefined();
      expect(result.isFallMitigation).toBe(false);
      expect(result.isEnemyAbove).toBe(true);
    });

    test("a target at the bot's own level can be thrown at directly", () => {
      // Same height: the pearl does not have to climb a platform face.
      mockBot.pvp.target.position = new Vec3(5, 0, 0);
      mockBot.utilsManager.getBestPearlTrajectory = (source, target) => ({
        pitch: 45,
        arc: "high" as const,
        flightTime: 8,
        landingPoint: target.clone(),
        landingDist: 0,
      });
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(true);
      expect(result.launchPos).toBeUndefined();
      expect(result.flightTime).toBe(8);
      expect(result.isEnemyAbove).toBe(false);
    });

    test("an elevated target is reached by walking to a launch point first", () => {
      // Scenario 1 geometry: a 1x1 pillar with the target standing on top.
      // Ground surface at y=0, pillar top at y=4, bot beside the pillar.
      const real = new UtilsManager({
        version: "1.12.2",
        registry: { blocksByName: {} },
        entity: { effects: {} },
        blockAt: (pos: Vec3) => {
          const x = Math.floor(pos.x);
          const y = Math.floor(pos.y);
          const z = Math.floor(pos.z);
          if (y === -1 && x >= -4 && x <= 4 && z >= -4 && z <= 4) {
            return { position: new Vec3(x, y, z), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], name: "grass" };
          }
          if (x === 2 && z === 2 && y >= 0 && y <= 3) {
            return { position: new Vec3(x, y, z), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], name: "stone" };
          }
          return null;
        },
        entities: {},
      } as any);
      mockBot.utilsManager.getBestPearlTrajectory = (source: Vec3, target: Vec3, v: number, g: number, d: number, tol: number, step: number) =>
        real.getBestPearlTrajectory(source, target, v, g, d, tol, step);
      mockBot.utilsManager.getPearlTopLanding = (source: Vec3, aim: Vec3) =>
        real.getPearlTopLanding(source, aim);

      // The bot stands directly under the pillar: the only way up is a
      // pearl thrown from a launch point beside it.
      mockBot.entity.position = new Vec3(2.5, 0, 2.5);
      mockBot.utilsManager.getGroundBelow = () => 0;
      mockBot.pvp = {
        target: { position: new Vec3(2.5, 4, 2.5), height: 1.8 },
        attackRange: 3,
      };

      answerLaunchPointSearch(manager, new Vec3(3.5, 0, 2.5));
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(true);
      expect(result.isEnemyAbove).toBe(true);
      expect(result.launchPos).toBeDefined();
      // The aim point is the platform's top surface, not the target's body.
      expect(result.targetPos!.y).toBeCloseTo(4, 5);
      expect(result.targetPos!.y).toBeGreaterThan(3);
      // The pearl lands on the platform top from the launch point.
      expect(result.flightTime).toBeGreaterThan(0);
    });

    test("the launch point search runs off the main thread", () => {
      // With the worker in place the search is asynchronous: the bot has
      // no launch point (and therefore no throw) until the worker answers.
      const solver = {
        available: true,
        requests: 0,
        request: () => {
          solver.requests++;
        },
      };
      (manager as any)._pearlSolver = solver;
      (manager as any)._launchPointCache = null;
      mockBot.utilsManager.getPearlTopLanding = (source: Vec3) =>
        source.x === 0 && source.z === 0 ? null : topLanding();

      const pending = manager.getPearlMitigation();
      expect(pending.canMitigate).toBe(false);
      expect(pending.launchPos).toBeUndefined();
      // The search was handed to the worker.
      expect(solver.requests).toBe(1);

      // The worker's answer makes the launch point available.
      (manager as any)._applyLaunchPointSolution({
        launchPos: new Vec3(1.5, 0, 0),
        landing: topLanding(12),
      });
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(true);
      expect(result.launchPos).toBeDefined();
    });

    test("marks a same-height out-of-range target as a combat throw", () => {
      mockBot.pvp.target.position = new Vec3(10, 0, 0);
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(true);
      expect(result.isFallMitigation).toBe(false);
      expect(result.isEnemyAbove).toBe(false);
    });

    test("prefers fall mitigation over an enemy target", () => {
      // Descending with a lethal predicted fall; the enemy target is
      // within pearl range but the ground throw takes priority.
      mockBot.entity.onGround = false;
      mockBot.entity.velocity = { x: 0, y: -0.5, z: 0 };
      mockBot.entity.position = new Vec3(0, 25, 0);
      mockBot.utilsManager.getFallDamage = () => 27;
      mockBot.utilsManager.getFallTicks = () => 40;
      (manager as any).lastMaxFallY = 25;

      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(true);
      expect(result.isFallMitigation).toBe(true);
      expect(result.isEnemyAbove).toBe(false);
      expect(result.targetPos).toBeDefined();
    });

    test("does not pathfind to a launch point during a fall", () => {
      // Direct trajectory blocked mid-fall: pathfinding to a ground launch
      // point can never beat the impact, so mitigation reports unavailable.
      mockBot.entity.onGround = false;
      mockBot.entity.velocity = { x: 0, y: -0.5, z: 0 };
      mockBot.entity.position = new Vec3(0, 25, 0);
      mockBot.utilsManager.getFallDamage = () => 27;
      mockBot.utilsManager.getFallTicks = () => 40;
      mockBot.utilsManager.getBestPearlTrajectory = () => null;
      (manager as any).lastMaxFallY = 25;

      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(false);
    });

    test("returns canMitigate true with launch point when direct trajectory blocked", () => {
      // Direct trajectory blocked from current position, but launch point works
      mockBot.utilsManager.getPearlTopLanding = (source: Vec3) => {
        // Block direct trajectory from current position (x=0, z=0)
        if (source.x === 0 && source.z === 0) return null;
        return topLanding(12);
      };
      answerLaunchPointSearch(manager, new Vec3(1.5, 0, 0), 12);
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(true);
      expect(result.launchPos).toBeDefined();
      expect(result.targetPos).toBeDefined();
      expect(result.flightTime).toBe(12);
      expect(result.offset).toBeDefined();
    });

    test("caches the launch-point search while the target stays put", () => {
      (manager as any)._launchPointCache = null;
      let calls = 0;
      mockBot.utilsManager.getPearlTopLanding = (source: Vec3) => {
        // The direct throw from the bot's own spot is blocked; every other
        // source is a launch-point candidate.
        if (source.x === 0 && source.z === 0) return null;
        calls++;
        return topLanding(12);
      };
      (mockBot.pvp.target as any).id = 7;

      const first = manager.getPearlMitigation();
      expect(first.canMitigate).toBe(true);
      const callsAfterSearch = calls;
      expect(callsAfterSearch).toBeGreaterThanOrEqual(1); // the candidate scan ran

      // Second call with an unmoved target reuses the cached launch point:
      // the candidate scan does not run again.
      const second = manager.getPearlMitigation();
      expect(second.canMitigate).toBe(true);
      expect(second.launchPos).toEqual(first.launchPos);
      expect(calls - callsAfterSearch).toBe(0);
    });

    test("re-runs the launch search when the target moves", () => {
      (manager as any)._launchPointCache = null;
      let calls = 0;
      mockBot.utilsManager.getPearlTopLanding = (source: Vec3) => {
        calls++;
        if (source.x === 0 && source.z === 0) return null;
        return topLanding(12);
      };
      (mockBot.pvp.target as any).id = 7;

      manager.getPearlMitigation();
      const callsAfterSearch = calls;

      // Move the target two blocks: cached position is stale.
      (mockBot.pvp.target as any).position = new Vec3(0, 5, 2);
      const result = manager.getPearlMitigation();
      expect(result.canMitigate).toBe(true);
      // The stale cache was discarded, so the search ran again.
      expect(calls - callsAfterSearch).toBeGreaterThanOrEqual(1);
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

  describe("selectTarget", () => {
    const makeEntity = (
      id: number,
      type: string,
      kind: string,
      x: number,
      options: { valid?: boolean; username?: string } = {},
    ) => ({
      id,
      type,
      kind,
      username: options.username,
      isValid: options.valid ?? true,
      position: new Vec3(x, 0, 0),
    });

    const setEntities = (entities: Record<number, unknown>) => {
      mockBot.entities = entities;
    };

    test("prefers players over hostile mobs and other entities", () => {
      setEntities({
        1: makeEntity(1, "mob", "Hostile mobs", 1),
        2: makeEntity(2, "player", "Player", 10, { username: "Steve" }),
        3: makeEntity(3, "animal", "Passive mobs", 0.5),
      });

      const target = manager.selectTarget(() => true);
      expect(target?.id).toBe(2);
    });

    test("prefers a hostile mob over a passive one", () => {
      setEntities({
        1: makeEntity(1, "animal", "Passive mobs", 1),
        2: makeEntity(2, "mob", "Hostile mobs", 10),
      });

      const target = manager.selectTarget(() => true);
      expect(target?.id).toBe(2);
    });

    test("prefers the target with less hurt immunity within a type", () => {
      mockBot.pvp.getHurtTicks = (e: { id: number }) => (e.id === 1 ? 5 : 0);
      setEntities({
        1: makeEntity(1, "player", "Player", 1, { username: "Near" }),
        2: makeEntity(2, "player", "Player", 5, { username: "Hurt" }),
      });

      const target = manager.selectTarget(() => true);
      expect(target?.id).toBe(2);
    });

    test("prefers the closer hitbox when type and hurt time tie", () => {
      mockBot.pvp.getTargetDistance = (e: { id: number }) =>
        e.id === 1 ? 3 : 1;
      setEntities({
        1: makeEntity(1, "player", "Player", 1, { username: "Far" }),
        2: makeEntity(2, "player", "Player", 5, { username: "Close" }),
      });

      const target = manager.selectTarget(() => true);
      expect(target?.id).toBe(2);
    });

    test("skips invalid entities and the bot's own entity", () => {
      const self = makeEntity(1, "player", "Player", 0, { username: "Self" });
      mockBot.entity = self;
      setEntities({
        1: self,
        2: makeEntity(2, "player", "Player", 1, {
          username: "Dead",
          valid: false,
        }),
        3: makeEntity(3, "player", "Player", 2, { username: "Alive" }),
      });

      const target = manager.selectTarget(() => true);
      expect(target?.id).toBe(3);
    });

    test("returns null when no entity passes the filter", () => {
      setEntities({
        1: makeEntity(1, "player", "Player", 1, { username: "Steve" }),
      });

      expect(manager.selectTarget(() => false)).toBeNull();
      expect(manager.selectTarget(() => true)?.id).toBe(1);
    });
  });

  describe("hasAnyArmor", () => {
    test("is false when every armor slot is empty", () => {
      mockBot.inventory.slots = [];
      expect(manager.hasAnyArmor()).toBe(false);
    });

    test("is true when any armor slot is occupied", () => {
      mockBot.inventory.slots = [];
      mockBot.inventory.slots[5] = { name: "iron_helmet" };
      expect(manager.hasAnyArmor()).toBe(true);
    });
  });

  describe("shouldEatBeforePearl", () => {
    const eat = Constants.COMBAT.SURVIVAL.EAT_TICKS;

    test("eats before a lethal pearl with a short flight", () => {
      expect(manager.shouldEatBeforePearl(eat, 4, false, true)).toBe(true);
    });

    test("does not eat when health survives the pearl damage", () => {
      expect(manager.shouldEatBeforePearl(eat, 5, false, true)).toBe(false);
      expect(manager.shouldEatBeforePearl(eat, 20, false, true)).toBe(false);
    });

    test("does not eat when armor is worn", () => {
      expect(manager.shouldEatBeforePearl(eat, 1, true, true)).toBe(false);
    });

    test("does not eat without a golden apple", () => {
      expect(manager.shouldEatBeforePearl(eat, 1, false, false)).toBe(false);
    });

    test("throws first when the flight outlasts the eat", () => {
      expect(manager.shouldEatBeforePearl(eat + 1, 1, false, true)).toBe(false);
    });

    test("eats when the flight is exactly the eat time", () => {
      expect(manager.shouldEatBeforePearl(eat, 1, false, true)).toBe(true);
    });
  });
});
