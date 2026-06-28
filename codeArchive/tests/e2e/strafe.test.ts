/**
 * Original Path: tests/e2e/strafe.test.ts
 * Archive Date: June 28, 2026
 * Note: This code snippet has been archived pending a complete rewrite.
 */

/**
 * @fileoverview E2E integration tests for Pupa strafe functionality.
 *
 * These tests connect to a real Minecraft server using configuration from `.env`,
 * create a bot instance, load all Pupa managers, and run strafe-related debug methods
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
import { terrain, STRAFE_FIXTURES } from "../helpers/terrain";

// ── E2E configuration ───────────────────────────────────────────────

const HOST = process.env.E2E_HOST;
const PORT = parseInt(process.env.E2E_PORT || "25565", 10);
const USERNAME = "strafe_test";
const VERSION = process.env.E2E_VERSION || undefined;
const TIMEOUT_MS = parseInt(process.env.E2E_TIMEOUT || "60", 10) * 1000;
const CONNECT_TIMEOUT_MS = 15_000;
const POSITION = new Vec3(200, 1, 200);

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

describeE2E("E2E Strafe Tests", () => {
  let bot: Bot;

  // ── Helpers ───────────────────────────────────────────────────────

  const getCm = (): any => bot.combatManager;

  /**
   * Reset bot state between tests: stop pathfinding/PVP, switch to creative.
   */
  async function resetBotState(): Promise<void> {
    bot.clearControlStates();
    (bot as any).pathfinder?.stop();
    (bot as any).pvp?.stop();
    if (bot.combatManager) {
      bot.combatManager.setMode(0);
    }
    await bot.utilsManager.assertCommandSuccess("gamemode", "creative");
    await bot.waitForTicks!(2);
  }

  // Set overall suite timeout to 5 minutes (300 seconds)
  jest.setTimeout(TIMEOUT_MS * 5);

  beforeAll(async () => {
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
        logger.error(error, "Movement");
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
        logger.error(error, "Movement");
      }
    }
  }, TIMEOUT_MS);

  afterAll(async () => {
    if (bot) {
      try {
        bot.quit!();
        bot.end!();
      } catch (error) {
        logger.error(error, "Movement");
      }
    }
    logger.setDebugMode(false);
  }, TIMEOUT_MS);

  // ────────────────────────────────────────────────────────────────
  // Flat terrain
  // ────────────────────────────────────────────────────────────────

  describe("Flat terrain", () => {
    test(
      "executeStrafe — executes single strafe",
      async () => {
        const cm = getCm();
        const targetPos = bot.entity.position;
        const distToStrafe = await cm.executeStrafe(targetPos);
        expect(distToStrafe).toBeGreaterThanOrEqual(0);
        expect(distToStrafe).toBeLessThanOrEqual(0.5);
        const distToTarget = bot.entity.position.distanceTo(targetPos);
        expect(distToTarget).toBeLessThanOrEqual(
          Constants.MOVEMENT.STRAFE_RADIUS,
        );
      },
      TIMEOUT_MS,
    );

    test(
      "executeStrafeLoop — loops strafe 3 times",
      async () => {
        const cm = getCm();
        const targetPos = bot.entity.position;
        const distances = await cm.executeStrafeLoop(targetPos, 3);
        expect(distances.length).toBe(3);
        distances.forEach((distToStrafe) => {
          expect(distToStrafe).toBeGreaterThanOrEqual(0);
          expect(distToStrafe).toBeLessThanOrEqual(0.5);
        });
        const distToTarget = bot.entity.position.distanceTo(targetPos);
        expect(distToTarget).toBeLessThanOrEqual(
          Constants.MOVEMENT.STRAFE_RADIUS,
        );
      },
      TIMEOUT_MS,
    );

    test(
      "executeStrafeLoop — loops strafe 15 times",
      async () => {
        const cm = getCm();
        const targetPos = bot.entity.position;
        const distances = await cm.executeStrafeLoop(targetPos, 15);
        expect(distances.length).toBe(15);
        distances.forEach((distToStrafe) => {
          expect(distToStrafe).toBeGreaterThanOrEqual(0);
          expect(distToStrafe).toBeLessThanOrEqual(0.5);
        });
        const distToTarget = bot.entity.position.distanceTo(targetPos);
        expect(distToTarget).toBeLessThanOrEqual(
          Constants.MOVEMENT.STRAFE_RADIUS,
        );
      },
      TIMEOUT_MS,
    );
  });

  // ────────────────────────────────────────────────────────────────
  // Modified terrain
  // ────────────────────────────────────────────────────────────────

  describe("Modified terrain", () => {
    // Clear y=0 and y=1 in a 20x20 area around the bot before each test
    beforeEach(async () => {
      const pos = bot.entity.position;
      await bot.utilsManager.assertCommandSuccess("fill", `${pos.x - 10} ${pos.y} ${pos.z - 10} ${pos.x + 10} ${pos.y} ${pos.z + 10} air`);
      await bot.utilsManager.assertCommandSuccess("fill", `${pos.x - 10} ${pos.y + 1} ${pos.z - 10} ${pos.x + 10} ${pos.y + 1} ${pos.z + 10} air`);
      await bot.waitForTicks!(2);
    });

    // Clean up the cleared area after all modified terrain tests
    afterEach(async () => {
      const pos = bot.entity.position;
      await bot.utilsManager.assertCommandSuccess("fill", `${pos.x - 10} ${pos.y} ${pos.z - 10} ${pos.x + 10} ${pos.y} ${pos.z + 10} air`);
      await bot.utilsManager.assertCommandSuccess("fill", `${pos.x - 10} ${pos.y + 1} ${pos.z - 10} ${pos.x + 10} ${pos.y + 1} ${pos.z + 10} air`);
      await bot.waitForTicks!(2);
    });

    // Dynamically generate one test per fixture
    for (const fixture of Object.values(STRAFE_FIXTURES)) {
      test(
        `executeStrafeLoop — 15 iterations on ${fixture.name}`,
        async () => {
          const base = bot.entity.position.clone();
          await terrain.with(bot, base, fixture, async () => {
            const cm = getCm();
            const distances = await cm.executeStrafeLoop(base, 15);
            expect(distances.length).toBe(15);
            distances.forEach((distToStrafe) => {
              expect(distToStrafe).toBeGreaterThanOrEqual(0);
              expect(distToStrafe).toBeLessThanOrEqual(0.5);
            });
            const distToTarget = bot.entity.position.distanceTo(base);
            expect(distToTarget).toBeLessThanOrEqual(
              Constants.MOVEMENT.STRAFE_RADIUS,
            );
          });
        },
        TIMEOUT_MS,
      );
    }
  });
});
