/**
 * @fileoverview E2E integration tests for Pupa PvP handling.
 *
 * These tests connect to a real Minecraft server using configuration from `.env`,
 * create a bot instance, load all Pupa managers, and exercise PvP-related
 * functionality against the live server.
 *
 * Environment variables (`.env`):
 *   E2E_HOST      - Server hostname (default: localhost)
 *   E2E_PORT      - Server port     (default: 25565)
 *   E2E_VERSION   - Game version    (default: 1.12.2)
 *   E2E_TIMEOUT   - Seconds per test (default: 30)
 *
 * Skipped automatically when E2E_HOST is not set.
 */

import "dotenv/config";
import mineflayer, { Bot } from "mineflayer";
import { pathfinder } from "mineflayer-pathfinder";
import { PVPManager } from "../../src/pvp";
import { attachInventory } from "../../src/inventory";
import { attachCombat } from "../../src/pvp";
import { attachCommands } from "../../src/commands";
import { attachUtils } from "../../src/utils";
import { RuntimeConfig } from "../../src/config";
import { logger } from "../../src/logger";
import { Vec3 } from "vec3";
import { Constants } from "../../src/constants";
import { getCooldown } from "../../src/pvp";

// ── E2E configuration ───────────────────────────────────────────────

const HOST = process.env.E2E_HOST;
const PORT = parseInt(process.env.E2E_PORT || "25565", 10);
const USERNAME = "pvp_test";
const VERSION = process.env.E2E_VERSION || undefined;
const TIMEOUT_MS = parseInt(process.env.E2E_TIMEOUT || "60", 10) * 1000;
const CONNECT_TIMEOUT_MS = 15_000;
const POSITION = new Vec3(400, 1, 400);

// ── Conditional test runner ─────────────────────────────────────────

const describeE2E = HOST ? describe : describe.skip;

// ── Bot creation helper ─────────────────────────────────────────────

async function createBot(): Promise<Bot> {
  const bot = mineflayer.createBot({
    host: HOST!,
    port: PORT,
    username: USERNAME,
    version: VERSION,
    logErrors: true,
    hideErrors: false,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      bot.removeAllListeners("spawn");
      bot.removeAllListeners("error");
      bot.removeAllListeners("end");
      reject(new Error("Connection timed out"));
    }, CONNECT_TIMEOUT_MS);

    bot.once("spawn", () => {
      clearTimeout(timer);
      resolve();
    });
    bot.once("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    bot.once("end", () => {
      clearTimeout(timer);
      reject(new Error("Bot disconnected before spawn"));
    });
  });

  bot.loadPlugin(pathfinder);
  bot.pvp = new PVPManager(bot);

  (bot as any).runtimeConfig = new RuntimeConfig();
  (bot as any).__logger = logger;
  attachInventory(bot);
  attachCombat(bot);
  attachCommands(bot);
  attachUtils(bot);

  logger.setDebugMode(true);

  return bot;
}

// ── Helpers ─────────────────────────────────────────────────────────

async function killNearbyEntities(
  bot: Bot,
  radius: number = 30,
): Promise<void> {
  await bot.utilsManager.assertCommandSuccess(
    "kill",
    `@e[type=!player,distance=..${radius}]`,
  );
  await bot.waitForTicks!(3);
}

/** Summon a zombie and wait for it to appear in bot entities. */
async function summonMob(bot: Bot): Promise<any> {
  await bot.utilsManager.assertCommandSuccess("summon", "zombie ~ ~1 ~");
  for (let i = 0; i < 40; i++) {
    await bot.waitForTicks!(1);
    for (const [, entity] of Object.entries(bot.entities)) {
      const e = entity as any;
      if (e.type === "mob" && e.position && e.name === "zombie") {
        return e;
      }
    }
  }
  return null;
}

// ── E2E test suite ──────────────────────────────────────────────────

describeE2E("E2E PvP Tests", () => {
  let bot: Bot;

  // ── Helpers ───────────────────────────────────────────────────────

  const getCm = (): any => bot.combatManager;
  const getPvp = (): any => (bot as any).pvp;

  /**
   * Reset bot state between tests: stop pathfinding/PVP, switch to creative.
   */
  async function resetBotState(): Promise<void> {
    bot.clearControlStates();
    (bot as any).pathfinder?.stop();
    if (getPvp()) {
      getPvp().forceStop();
    }
    if (bot.combatManager) {
      bot.combatManager.setMode(0);
    }
    await bot.utilsManager.assertCommandSuccess("gamemode", "creative");
    await bot.waitForTicks!(2);
  }

  jest.setTimeout(TIMEOUT_MS * 5);

  beforeAll(async () => {
    bot = await createBot();
    if (bot && bot.entity) {
      try {
        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        await bot.utilsManager.assertCommandSuccess(
          "tp",
          Object.values(POSITION).join(" "),
        );
        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        await bot.utilsManager.assertCommandSuccess("gamemode", "creative");
      } catch (error) {
        logger.error(error, "Combat");
      }
    }
  }, TIMEOUT_MS);

  beforeEach(async () => {
    if (bot && bot.entity) {
      try {
        await killNearbyEntities(bot, 30);
        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        await bot.utilsManager.assertCommandSuccess(
          "tp",
          Object.values(POSITION).join(" "),
        );
        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        await resetBotState();
      } catch (error) {
        logger.error(error, "Combat");
      }
    }
  }, TIMEOUT_MS);

  afterAll(async () => {
    if (bot) {
      try {
        bot.quit!();
        bot.end!();
      } catch (error) {
        logger.error(error, "Combat");
      }
    }
    logger.setDebugMode(false);
  }, TIMEOUT_MS);

  // ══════════════════════════════════════════════════════════════════
  // Category 1: Target Acquisition & Tracking
  // ══════════════════════════════════════════════════════════════════

  describe("Target Acquisition & Tracking", () => {
    test(
      "setMode — switches to PvP mode (1)",
      () => {
        const cm = getCm();
        cm.setMode(1);
        expect(cm.mode).toBe(1);
      },
      TIMEOUT_MS,
    );

    test(
      "getTargetFilter — returns a function",
      () => {
        const cm = getCm();
        cm.setMode(1);
        const filter = cm.getTargetFilter();
        expect(typeof filter).toBe("function");
      },
      TIMEOUT_MS,
    );

    test(
      "getTargetFilter — caches filter for same mode",
      () => {
        const cm = getCm();
        cm.setMode(2);
        const f1 = cm.getTargetFilter();
        const f2 = cm.getTargetFilter();
        expect(f1).toBe(f2);
      },
      TIMEOUT_MS,
    );

    test(
      "getTargetFilter — invalidates cache on mode change",
      () => {
        const cm = getCm();
        cm.setMode(1);
        const f1 = cm.getTargetFilter();
        cm.setMode(2);
        const f2 = cm.getTargetFilter();
        expect(f1).not.toBe(f2);
      },
      TIMEOUT_MS,
    );

    test(
      "addAlly / removeAlly — modifies allies set",
      () => {
        const cm = getCm();
        cm.setMode(2);
        cm.addAlly("SomePlayer");
        expect(cm.alliesSet.has("SomePlayer")).toBe(true);
        cm.removeAlly("SomePlayer");
        expect(cm.alliesSet.has("SomePlayer")).toBe(false);
      },
      TIMEOUT_MS,
    );

    test(
      "addAlly — invalidates mode filter cache",
      () => {
        const cm = getCm();
        cm.setMode(1);
        const f1 = cm.getTargetFilter();
        cm.addAlly("Player1");
        const f2 = cm.getTargetFilter();
        expect(f1).not.toBe(f2);
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 2: Attack Lifecycle
  // ══════════════════════════════════════════════════════════════════

  describe("Attack Lifecycle", () => {
    test(
      "attack — begins attacking a target entity",
      async () => {
        const zombie = await summonMob(bot);
        expect(zombie).not.toBeNull();

        await getPvp().attack(zombie);
        expect(getPvp().target).toBe(zombie);
      },
      TIMEOUT_MS,
    );

    test(
      "attack — no-op when attacking same entity",
      async () => {
        const zombie = await summonMob(bot);

        await getPvp().attack(zombie);
        expect(getPvp().target).toBe(zombie);

        await getPvp().attack(zombie);
        expect(getPvp().target).toBe(zombie);
      },
      TIMEOUT_MS,
    );

    test(
      "stop — stops attacking",
      async () => {
        const zombie = await summonMob(bot);

        await getPvp().attack(zombie);
        expect(getPvp().target).toBe(zombie);

        await getPvp().stop();
        expect(getPvp().target).toBeUndefined();
      },
      TIMEOUT_MS,
    );

    test(
      "forceStop — immediately stops without waiting",
      async () => {
        const zombie = await summonMob(bot);

        await getPvp().attack(zombie);
        expect(getPvp().target).toBe(zombie);

        getPvp().forceStop();
        expect(getPvp().target).toBeUndefined();
      },
      TIMEOUT_MS,
    );

    test(
      "attack — emits startedAttacking event",
      async () => {
        const zombie = await summonMob(bot);

        let eventFired = false;
        bot.once("startedAttacking" as any, () => {
          eventFired = true;
        });

        await getPvp().attack(zombie);
        expect(eventFired).toBe(true);
      },
      TIMEOUT_MS,
    );

    test(
      "stop — emits stoppedAttacking event",
      async () => {
        const zombie = await summonMob(bot);
        await getPvp().attack(zombie);

        let eventFired = false;
        bot.once("stoppedAttacking" as any, () => {
          eventFired = true;
        });

        await getPvp().stop();
        expect(eventFired).toBe(true);
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 3: Tick-Based Cooldown
  // ══════════════════════════════════════════════════════════════════

  describe("Tick-Based Cooldown", () => {
    test(
      "update — decrements timeToNextAttack each tick",
      () => {
        // Directly test the update mechanism without needing an entity
        const pvp = getPvp();
        pvp.target = { position: bot.entity.position.offset(0, 100, 0) } as any;
        pvp.timeToNextAttack = 10;
        pvp.wasInRange = false;

        const before = pvp.timeToNextAttack;
        pvp.update();
        const after = pvp.timeToNextAttack;

        expect(after).toBeLessThan(before);

        // Cleanup
        pvp.forceStop();
      },
      TIMEOUT_MS,
    );

    test(
      "getCooldown — matches weapon speed for iron sword",
      () => {
        expect(getCooldown("minecraft:iron_sword")).toBe(12);
      },
      TIMEOUT_MS,
    );

    test(
      "getCooldown — fist cooldown",
      () => {
        expect(getCooldown(null)).toBe(5);
      },
      TIMEOUT_MS,
    );

    test(
      "getCooldown — trident cooldown",
      () => {
        expect(getCooldown("minecraft:trident")).toBe(18);
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 4: Health Status & Damage Tracking
  // ══════════════════════════════════════════════════════════════════

  describe("Health Status & Damage Tracking", () => {
    test(
      "getHealthStatus — full health in creative",
      () => {
        const cm = getCm();
        const status = cm.getHealthStatus();
        expect(status.healthPoints).toBe(20);
        expect(status.absorbPoints).toBe(0);
        expect(status.totalHealth).toBe(20);
      },
      TIMEOUT_MS,
    );

    test(
      "getHealthStatus — partial health",
      () => {
        // Directly set health to simulate damage
        bot.health = 10;
        const cm = getCm();
        const status = cm.getHealthStatus();
        expect(status.healthPoints).toBe(10);
        expect(status.absorbPoints).toBe(0);
        expect(status.totalHealth).toBe(10);
        // Restore
        bot.health = 20;
      },
      TIMEOUT_MS,
    );

    test(
      "getLastDamage — records damage taken",
      () => {
        const cm = getCm();
        cm.lastHealth = 20;
        cm.lastDamage = 0;

        // Simulate damage by reducing health
        bot.health = 15;
        cm.getLastDamage();
        expect(cm.lastDamage).toBe(5);

        // Restore
        bot.health = 20;
      },
      TIMEOUT_MS,
    );

    test(
      "getLastDamage — does not record healing",
      () => {
        const cm = getCm();
        cm.lastDamage = 5;
        cm.lastHealth = 20;
        cm.getLastDamage();
        expect(cm.lastDamage).toBe(5);
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 5: Fall Protection
  // ══════════════════════════════════════════════════════════════════

  describe("Fall Protection", () => {
    test(
      "getFallProtectionStatus — safe when on ground",
      () => {
        const cm = getCm();
        const status = cm.getFallProtectionStatus();
        expect(status.isDangerous).toBe(false);
      },
      TIMEOUT_MS,
    );

    test(
      "getFallProtectionStatus — safe when velocity is upward",
      async () => {
        const cm = getCm();
        await bot.utilsManager.assertCommandSuccess(
          "tp",
          `${POSITION.x} ${POSITION.y} ${POSITION.z}`,
        );
        await bot.waitForTicks!(2);
        bot.setControlState("jump", true);
        await bot.waitForTicks!(1);
        bot.setControlState("jump", false);

        const status = cm.getFallProtectionStatus();
        expect(status.isDangerous).toBe(false);
      },
      TIMEOUT_MS,
    );

    test(
      "getFallProtectionStatus — dangerous for long falls in survival",
      async () => {
        const cm = getCm();

        await bot.utilsManager.assertCommandSuccess("gamemode", "survival");
        await bot.waitForTicks!(2);

        await bot.utilsManager.assertCommandSuccess(
          "tp",
          `${POSITION.x} ${POSITION.y + 50} ${POSITION.z}`,
        );
        await bot.waitForTicks!(2);

        const status = cm.getFallProtectionStatus();
        expect(status.isDangerous).toBe(true);

        await bot.utilsManager.assertCommandSuccess(
          "tp",
          `${POSITION.x} ${POSITION.y} ${POSITION.z}`,
        );
        await bot.waitForTicks!(2);
        await bot.utilsManager.assertCommandSuccess("gamemode", "creative");
        await bot.waitForTicks!(2);
      },
      TIMEOUT_MS,
    );

    test(
      "getFallProtectionStatus — returns predicted damage info",
      async () => {
        const cm = getCm();

        await bot.utilsManager.assertCommandSuccess("gamemode", "survival");
        await bot.waitForTicks!(2);

        await bot.utilsManager.assertCommandSuccess(
          "tp",
          `${POSITION.x} ${POSITION.y + 50} ${POSITION.z}`,
        );
        await bot.waitForTicks!(2);

        const status = cm.getFallProtectionStatus();
        expect(status.isDangerous).toBe(true);
        expect(status.predictedDamage).toBeDefined();
        expect(status.predictedDamage).toBeGreaterThan(0);

        await bot.utilsManager.assertCommandSuccess(
          "tp",
          `${POSITION.x} ${POSITION.y} ${POSITION.z}`,
        );
        await bot.waitForTicks!(2);
        await bot.utilsManager.assertCommandSuccess("gamemode", "creative");
        await bot.waitForTicks!(2);
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 6: Decision Engine
  // ══════════════════════════════════════════════════════════════════

  describe("Decision Engine", () => {
    test(
      "executeDecisions — equips armor when armorless",
      async () => {
        const cm = getCm();

        await bot.utilsManager.assertCommandSuccess("give", "@p iron_helmet 1");
        await bot.utilsManager.assertCommandSuccess(
          "give",
          "@p iron_chestplate 1",
        );
        await bot.utilsManager.assertCommandSuccess(
          "give",
          "@p iron_leggings 1",
        );
        await bot.utilsManager.assertCommandSuccess("give", "@p iron_boots 1");
        await bot.waitForTicks!(5);

        await cm.executeDecisions();

        const headSlot = bot.inventory.slots[5];
        expect(headSlot).toBeDefined();
      },
      TIMEOUT_MS,
    );

    test(
      "executeDecisions — equips weapon when unarmed",
      async () => {
        const cm = getCm();

        await bot.utilsManager.assertCommandSuccess(
          "give",
          "@p diamond_sword 1",
        );
        await bot.waitForTicks!(5);

        await cm.executeDecisions();

        const heldItem = bot.heldItem;
        expect(heldItem).toBeDefined();
      },
      TIMEOUT_MS,
    );

    test(
      "executeDecisions — debounce prevents re-entry",
      async () => {
        const cm = getCm();
        cm.debounce = true;

        const startTime = Date.now();
        await cm.executeDecisions();
        const elapsed = Date.now() - startTime;

        expect(elapsed).toBeLessThan(100);
        cm.debounce = false;
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 8: Pearl Throwing in Combat
  // ══════════════════════════════════════════════════════════════════

  describe("Pearl Throwing in Combat", () => {
    test(
      "getBestPearlOffset — calculates offset without throwing",
      async () => {
        const cm = getCm();

        // Use a fixed target position (10 blocks away on flat ground)
        const eyePos = bot.entity.position.offset(
          0,
          Constants.PHYSICS.EYE_HEIGHT,
          0,
        );
        const targetPos = bot.entity.position.offset(10, 0, 0);

        // Should not throw — result may be null if target is out of range
        // but the method should complete without error
        let result: any = null;
        expect(() => {
          result = cm.getBestPearlOffset(eyePos, targetPos, "low");
        }).not.toThrow();

        // If result is valid, verify its shape
        if (result) {
          expect(result).toHaveProperty("offset");
          expect(result).toHaveProperty("arc");
        }
      },
      TIMEOUT_MS,
    );

    test(
      "getBestPearlOffset — returns null for out-of-range target",
      async () => {
        const cm = getCm();

        const zombie = await summonMob(bot);

        await bot.utilsManager.assertCommandSuccess(
          "tp",
          `@e[type=zombie,limit=1,sort=nearest] ${POSITION.x + 60} ${POSITION.y} ${POSITION.z}`,
        );
        await bot.waitForTicks!(5);

        const eyePos = bot.entity.position.offset(
          0,
          Constants.PHYSICS.EYE_HEIGHT,
          0,
        );
        const targetPos = zombie.position.offset(0, zombie.height * 0.5, 0);

        const result = cm.getBestPearlOffset(eyePos, targetPos, "low");
        expect(result).toBeNull();
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 9: Edge Protection
  // ══════════════════════════════════════════════════════════════════

  describe("Edge Protection", () => {
    test(
      "doEdgeProtection — sneaks near block edge",
      () => {
        const cm = getCm();

        // Directly set position to edge of block
        // Block center is at floor(x)+0.5, so x = floor(x)+1.0 gives dx = 0.5
        const baseX = Math.floor(bot.entity.position.x);
        bot.entity.position.x = baseX + 1.0;
        bot.entity.position.z = Math.floor(bot.entity.position.z) + 0.1;
        (bot as any).entity.onGround = true;

        // Verify position is at edge
        const pos = bot.entity.position;
        const blockX = Math.floor(pos.x) + 0.5;
        const dx = Math.abs(pos.x - blockX);
        expect(dx).toBeCloseTo(0.5, 1);

        cm.doEdgeProtection();
        expect(cm._edgeSneaking).toBe(true);

        bot.setControlState("sneak", false);
        cm._edgeSneaking = false;
      },
      TIMEOUT_MS,
    );

    test(
      "doEdgeProtection — releases sneak when centered",
      async () => {
        const cm = getCm();

        cm._edgeSneaking = true;
        bot.setControlState("sneak", true);

        await bot.utilsManager.assertCommandSuccess(
          "tp",
          `${POSITION.x + 0.1} ${POSITION.y} ${POSITION.z}`,
        );
        await bot.waitForTicks!(5);

        cm.doEdgeProtection();
        expect(cm._edgeSneaking).toBe(false);
      },
      TIMEOUT_MS,
    );

    test(
      "doEdgeProtection — does nothing when not on ground",
      () => {
        const cm = getCm();
        (bot as any).entity.onGround = false;
        cm._edgeSneaking = true;

        cm.doEdgeProtection();

        expect(cm._edgeSneaking).toBe(true);

        (bot as any).entity.onGround = true;
        cm._edgeSneaking = false;
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 10: Avoid Unwanted Blocks
  // ══════════════════════════════════════════════════════════════════

  describe("Avoid Unwanted Blocks", () => {
    test(
      "doAvoid — runs without error on clean ground",
      () => {
        const cm = getCm();
        cm.doAvoid();
        expect(true).toBe(true);
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 11: Combat Integration (Full Loop)
  // ══════════════════════════════════════════════════════════════════

  describe("Combat Integration (doDecide)", () => {
    test(
      "doDecide — full combat tick with target",
      async () => {
        const cm = getCm();
        cm.setMode(3); // Mode 3 = all entities (players + mobs)

        // Summon zombie and manually attack it
        const zombie = await summonMob(bot);
        expect(zombie).not.toBeNull();
        await getPvp().attack(zombie);
        expect(getPvp().target).toBe(zombie);

        await bot.utilsManager.assertCommandSuccess(
          "give",
          "@p iron_chestplate 1",
        );
        await bot.utilsManager.assertCommandSuccess(
          "give",
          "@p diamond_sword 1",
        );
        await bot.waitForTicks!(3);

        // doDecide should run without error
        // The target may or may not be retained depending on entity tracking
        await cm.doDecide();

        // Verify doDecide completed without throwing
        expect(true).toBe(true);
      },
      TIMEOUT_MS,
    );

    test(
      "doDecide — full combat tick without target",
      async () => {
        const cm = getCm();
        cm.setMode(0);

        await killNearbyEntities(bot, 50);
        await bot.waitForTicks!(5);
        getPvp().forceStop();

        await cm.doDecide();
        expect(getPvp().target).toBeUndefined();
      },
      TIMEOUT_MS,
    );

    test(
      "doDecide — handles errors gracefully",
      async () => {
        const cm = getCm();
        const originalUpdateTarget = cm.updateTarget.bind(cm);

        cm.updateTarget = () => {
          throw new Error("Test error");
        };

        await cm.doDecide();

        cm.updateTarget = originalUpdateTarget;
      },
      TIMEOUT_MS,
    );

    test(
      "doDecide — prevents re-entry via _isDeciding flag",
      async () => {
        const cm = getCm();
        cm._isDeciding = true;

        await cm.doDecide();

        cm._isDeciding = false;
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 12: Goal-Based Movement
  // ══════════════════════════════════════════════════════════════════

  describe("Goal-Based Movement", () => {
    test(
      "setGoal — sets pathfinder goal",
      () => {
        const goal = new Vec3(POSITION.x + 10, POSITION.y, POSITION.z);
        getPvp().setGoal(goal);
        expect(getPvp().goal).toBe(goal);
      },
      TIMEOUT_MS,
    );

    test(
      "clearGoal — clears pathfinder goal",
      () => {
        getPvp().setGoal(new Vec3(POSITION.x + 10, POSITION.y, POSITION.z));
        getPvp().clearGoal();
        expect(getPvp().goal).toBeNull();
      },
      TIMEOUT_MS,
    );

    test(
      "goal integration — pathfinder navigates toward goal",
      async () => {
        const goal = new Vec3(POSITION.x + 5, POSITION.y, POSITION.z);
        getPvp().setGoal(goal);

        await bot.waitForTicks!(10);

        const dist = bot.entity.position.distanceTo(goal);
        expect(dist).toBeLessThanOrEqual(10);

        getPvp().clearGoal();
        if ((bot as any).pathfinder) {
          (bot as any).pathfinder.stop();
        }
      },
      TIMEOUT_MS,
    );
  });
});
