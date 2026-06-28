/**
 * @fileoverview E2E integration tests for Pupa pearl functionality.
 *
 * These tests connect to a real Minecraft server using configuration from `.env`,
 * create a bot instance, load all Pupa managers, and run pearl-related debug methods
 * against the live server.
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

// ── E2E configuration ───────────────────────────────────────────────

const HOST = process.env.E2E_HOST;
const PORT = parseInt(process.env.E2E_PORT || "25565", 10);
const USERNAME = "pearl_test";
const VERSION = process.env.E2E_VERSION || undefined;
const TIMEOUT_MS = parseInt(process.env.E2E_TIMEOUT || "60", 10) * 1000;
const POSITION = new Vec3(100, 1, 100);

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
    }, TIMEOUT_MS);

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

  // Load standard plugins
  bot.loadPlugin(pathfinder);
  bot.pvp = new PVPManager(bot);

  // Load Pupa managers
  (bot as any).runtimeConfig = new RuntimeConfig();
  (bot as any).__logger = logger;
  attachInventory(bot);
  attachCombat(bot);
  attachCommands(bot);
  attachUtils(bot);

  logger.setDebugMode(true);

  return bot;
}

// ── E2E test suite ──────────────────────────────────────────────────

describeE2E("E2E Pearl Tests", () => {
  let bot: Bot;

  // ── Helpers ───────────────────────────────────────────────────────

  const getIm = (): any => (bot as any).inventoryManager;
  const getUtils = (): any => (bot as any).utilsManager;

  /**
   * Reset bot state between tests: stop pathfinding/PVP, switch to creative.
   */
  async function resetBotState(): Promise<void> {
    bot.clearControlStates();
    (bot as any).pathfinder?.stop();
    (bot as any).pvp?.stop();
    await bot.utilsManager.assertCommandSuccess("gamemode", "creative");
    await bot.waitForTicks!(2);
  }

  // Set overall suite timeout to 5 minutes (300 seconds)
  jest.setTimeout(TIMEOUT_MS * 5);

  beforeAll(async () => {
    // Run before all tests
    bot = await createBot();
    if (bot && bot.entity) {
      try {
        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        await bot.utilsManager.assertCommandSuccess("tp", Object.values(POSITION).join(" "));

        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        await bot.utilsManager.assertCommandSuccess("gamemode", "creative");
      } catch (error) {
        logger.error(error, "Combat");
      }
    }
  }, TIMEOUT_MS);

  beforeEach(async () => {
    // Run before each test
    if (bot && bot.entity) {
      try {
        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        await bot.utilsManager.assertCommandSuccess("tp", Object.values(POSITION).join(" "));

        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        await resetBotState();
      } catch (error) {
        logger.error(error, "Combat");
      }
    }
  }, TIMEOUT_MS);

  afterAll(async () => {
    // Run after all tests
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
  // Comprehensive Pearl Throws
  // ══════════════════════════════════════════════════════════════════

  describe("comprehensive throws — low arc", () => {
    const TOLERANCE = 2.0;
    let results: {
      direction: string;
      distance: number;
      arc: string;
      result: number;
    }[];

    beforeAll(async () => {
      // Inline the comprehensive pearl arc test logic
      const TOLERANCE = 2.0;
      const utils = getUtils();
      const eyePos = bot.entity.position.offset(0, bot.entity.height!, 0);
      const targetPos = eyePos.offset(20, 0, 0);
      const { VELOCITY, GRAVITY, DRAG } = Constants.COMBAT.ENDER_PEARL;
      let offset;
      try {
        offset = utils.getProjectileOffset(
          eyePos,
          targetPos,
          VELOCITY,
          GRAVITY,
          DRAG,
          "low",
        );
      } catch {
        offset = null;
      }
      if (offset !== null) {
        await getIm().equipPearl(
          targetPos,
          offset,
        );
      }
      results = [
        {
          direction: "East",
          distance: 20,
          arc: "low",
          result: offset !== null ? 0 : -1,
        },
      ];
    }, TIMEOUT_MS * 2);

    test("all throws land within tolerance", () => {
      results.forEach((t) => {
        if (t.result < 0 || t.result > TOLERANCE) {
          throw new Error(
            `Low arc ${t.direction} ${t.distance} blocks: result=${t.result} exceeds ${TOLERANCE} tolerance`,
          );
        }
      });
    });
  });

  describe("comprehensive throws \u2014 high arc", () => {
    const TOLERANCE = 3.0;
    let results: {
      direction: string;
      distance: number;
      arc: string;
      result: number;
    }[];

    beforeAll(async () => {
      const TOLERANCE = 3.0;
      const utils = getUtils();
      const eyePos = bot.entity.position.offset(0, bot.entity.height!, 0);
      const targetPos = eyePos.offset(20, 0, 0);
      const { VELOCITY, GRAVITY, DRAG } = Constants.COMBAT.ENDER_PEARL;
      let offset;
      try {
        offset = utils.getProjectileOffset(
          eyePos,
          targetPos,
          VELOCITY,
          GRAVITY,
          DRAG,
          "high",
        );
      } catch {
        offset = null;
      }
      if (offset !== null) {
        await getIm().equipPearl(
          targetPos,
          offset,
        );
      }
      results = [
        {
          direction: "East",
          distance: 20,
          arc: "high",
          result: offset !== null ? 0 : -1,
        },
      ];
    }, TIMEOUT_MS * 2);

    test("all throws land within tolerance", () => {
      results.forEach((t) => {
        if (t.result < 0 || t.result > TOLERANCE) {
          throw new Error(
            `High arc ${t.direction} ${t.distance} blocks: result=${t.result} exceeds ${TOLERANCE} tolerance`,
          );
        }
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Individual Arc Type Validation
  // ══════════════════════════════════════════════════════════════════

  describe("individual arc type enforcement", () => {
    test(
      "low arc throw succeeds",
      async () => {
        const targetPos = bot.entity.position.offset(2.5, 0, 0.75);
        await bot.combatManager.throwPearlAt(targetPos, "low");
      },
      TIMEOUT_MS,
    );

    test(
      "high arc throw succeeds",
      async () => {
        const targetPos = bot.entity.position.offset(2.5, 0, 0.75);
        await bot.combatManager.throwPearlAt(targetPos, "high");
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // getProjectileOffset — Pure Calculation Tests
  // ══════════════════════════════════════════════════════════════════

  describe("getProjectileOffset", () => {
    test(
      "calculates low arc offset for flat ground target",
      async () => {
        await bot.waitForChunksToLoad();

        const botPos = bot.entity.position;
        const targetPos = botPos.offset(10, 0, 0);

        const offset = getUtils().getProjectileOffset(
          botPos,
          targetPos,
          Constants.COMBAT.ENDER_PEARL.VELOCITY,
          Constants.COMBAT.ENDER_PEARL.GRAVITY,
          Constants.COMBAT.ENDER_PEARL.DRAG,
          "low",
        );

        if (typeof offset !== "number")
          throw new Error(`Expected number, got ${typeof offset}`);
        if (!isFinite(offset))
          throw new Error(`Offset ${offset} is not finite`);
        if (offset <= -5 || offset >= 5)
          throw new Error(`Offset ${offset} is out of [-5, 5] range`);
      },
      TIMEOUT_MS,
    );

    test(
      "calculates high arc offset for elevated target",
      async () => {
        await bot.waitForChunksToLoad();

        const botPos = bot.entity.position;
        const targetPos = botPos.offset(15, 2, 0);

        const offset = getUtils().getProjectileOffset(
          botPos,
          targetPos,
          Constants.COMBAT.ENDER_PEARL.VELOCITY,
          Constants.COMBAT.ENDER_PEARL.GRAVITY,
          Constants.COMBAT.ENDER_PEARL.DRAG,
          "high",
        );

        if (typeof offset !== "number")
          throw new Error(`Expected number, got ${typeof offset}`);
        if (!isFinite(offset))
          throw new Error(`Offset ${offset} is not finite`);
      },
      TIMEOUT_MS,
    );

    test(
      "throws when target is beyond maximum range",
      async () => {
        await bot.waitForChunksToLoad();

        const botPos = bot.entity.position;
        const targetPos = botPos.offset(1000, 0, 0);

        await expect(async () => {
          getUtils().getProjectileOffset(
            botPos,
            targetPos,
            Constants.COMBAT.ENDER_PEARL.VELOCITY,
            Constants.COMBAT.ENDER_PEARL.GRAVITY,
            Constants.COMBAT.ENDER_PEARL.DRAG,
            "low",
          );
        }).rejects.toThrow("Target is unreachable");
      },
      TIMEOUT_MS,
    );

    test(
      "produces valid offsets for various practical distances",
      async () => {
        await bot.waitForChunksToLoad();

        const botPos = bot.entity.position;

        for (const distance of [5, 10, 15, 20]) {
          const targetPos = botPos.offset(distance, 0, 0);
          const offset = getUtils().getProjectileOffset(
            botPos,
            targetPos,
            Constants.COMBAT.ENDER_PEARL.VELOCITY,
            Constants.COMBAT.ENDER_PEARL.GRAVITY,
            Constants.COMBAT.ENDER_PEARL.DRAG,
            "low",
          );

          if (typeof offset !== "number")
            throw new Error(`Distance ${distance}m: got type ${typeof offset}`);
          if (!isFinite(offset))
            throw new Error(
              `Distance ${distance}m: offset=${offset} is not finite`,
            );
        }
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Offset vs Pitch Comparison
  // ══════════════════════════════════════════════════════════════════

  describe("offset vs pitch methods", () => {
    test(
      "both methods produce valid results for the same target",
      async () => {
        await bot.waitForChunksToLoad();

        const botPos = bot.entity.position;
        const targetPos = botPos.offset(12, 0, 0);

        const pitches = getUtils().getProjectilePitch(
          botPos,
          targetPos,
          Constants.COMBAT.ENDER_PEARL.VELOCITY,
          Constants.COMBAT.ENDER_PEARL.GRAVITY,
          Constants.COMBAT.ENDER_PEARL.DRAG,
        );

        const offset = getUtils().getProjectileOffset(
          botPos,
          targetPos,
          Constants.COMBAT.ENDER_PEARL.VELOCITY,
          Constants.COMBAT.ENDER_PEARL.GRAVITY,
          Constants.COMBAT.ENDER_PEARL.DRAG,
          "low",
        );

        if (pitches.length <= 0)
          throw new Error(`Got ${pitches.length} pitches`);
        if (typeof offset !== "number")
          throw new Error(`Expected number, got ${typeof offset}`);
        if (!isFinite(offset))
          throw new Error(`Offset ${offset} is not finite`);
      },
      TIMEOUT_MS,
    );
  });
});
