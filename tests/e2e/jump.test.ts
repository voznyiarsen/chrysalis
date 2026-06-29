/**
 * @fileoverview E2E integration tests for Pupa jump functionality.
 *
 * These tests connect to a real Minecraft server using configuration from `.env`,
 * create a bot instance, load all Pupa managers, and run jump-related debug methods
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

// ── E2E configuration ───────────────────────────────────────────────

const HOST = process.env.E2E_HOST;
const PORT = parseInt(process.env.E2E_PORT || "25565", 10);
const USERNAME = "jump_test";
const VERSION = process.env.E2E_VERSION || undefined;
const TIMEOUT_MS = parseInt(process.env.E2E_TIMEOUT || "60", 10) * 1000;
const POSITION = new Vec3(0, 1, 0);

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

describeE2E("E2E Jump Tests", () => {
  let bot: Bot;

  // ── Helpers ───────────────────────────────────────────────────────

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
        await bot.utilsManager.assertCommandSuccess(
          "tp",
          Object.values(POSITION).join(" "),
        );

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
        await bot.utilsManager.assertCommandSuccess(
          "tp",
          Object.values(POSITION).join(" "),
        );

        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        await resetBotState();
      } catch (error) {
        logger.error(error, "Movement");
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
        logger.error(error, "Movement");
      }
    }
    logger.setDebugMode(false);
  }, TIMEOUT_MS);

  // ----------------------------------------------------------------
  // Jump Tests
  // ----------------------------------------------------------------

  test(
    "jumpViaOffset — jumps to default offset",
    async () => {
      const dist = await bot.utilsManager.jumpViaOffset();
      expect(dist).toBeGreaterThanOrEqual(0);
      expect(dist).toBeLessThanOrEqual(0.3);
    },
    TIMEOUT_MS,
  );

  test(
    "isJumpPathClear — checks at default offset",
    async () => {
      const source = bot.entity.position;
      const targetPos = source.offset(3, 0, 0);
      getUtils().isJumpPathClear(source, targetPos);
    },
    TIMEOUT_MS,
  );

  describe("jumpViaOffset comprehensive", () => {
    const directions = [
      { name: "North", offset: new Vec3(0, 0, -1) },
      { name: "South", offset: new Vec3(0, 0, 1) },
      { name: "East", offset: new Vec3(1, 0, 0) },
      { name: "West", offset: new Vec3(-1, 0, 0) },
    ];
    const distances = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0];

    const results: { direction: string; distance: number; result: number }[] =
      [];

    beforeEach(async () => {
      await bot.waitForChunksToLoad!();
      await bot.waitForTicks!(1);
      await bot.utilsManager.assertCommandSuccess(
        "tp",
        Object.values(POSITION).join(" "),
      );
      await bot.waitForChunksToLoad!();
      await bot.waitForTicks!(1);
    }, TIMEOUT_MS);

    for (const dir of directions) {
      for (const distance of distances) {
        test(
          `${dir.name} ${distance} blocks`,
          async () => {
            const result = await bot.utilsManager.jumpViaOffset(
              new Vec3(dir.offset.x * distance, 0, dir.offset.z * distance),
            );
            results.push({
              direction: dir.name,
              distance,
              result,
            });
            logger.info(
              `${dir.name} ${distance} blocks: ${result.toFixed(3)}b remaining`,
              "Movement",
            );
            // Assert jump accuracy: remaining distance must be <= 0.3 blocks
            expect(result).toBeLessThanOrEqual(0.3);
          },
          TIMEOUT_MS,
        );
      }
    }

    afterAll(() => {
      // Should have 4 directions × 7 distances = 28 total tests
      expect(results.length).toBe(28);

      // Check that we have all 4 directions
      const directionNames = [...new Set(results.map((r) => r.direction))];
      expect(directionNames).toEqual(
        expect.arrayContaining(["North", "South", "East", "West"]),
      );

      // Check that we have all 7 distances
      const distanceValues = [...new Set(results.map((r) => r.distance))];
      expect(distanceValues).toEqual([1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0]);

      logger.info(
        `jumpViaOffset comprehensive results: ${results.length} tests completed`,
        "Movement",
      );
    });
  });

  describe("jumpViaOffset diagonal", () => {
    const directions = [
      { name: "North-East", offset: new Vec3(1, 0, -1) },
      { name: "North-West", offset: new Vec3(-1, 0, -1) },
      { name: "South-East", offset: new Vec3(1, 0, 1) },
      { name: "South-West", offset: new Vec3(-1, 0, 1) },
    ];
    const distances = [1.0, 1.5, 2.0, 2.5, 3.0];

    const results: { direction: string; distance: number; result: number }[] =
      [];

    beforeEach(async () => {
      await bot.waitForChunksToLoad!();
      await bot.waitForTicks!(1);
      await bot.utilsManager.assertCommandSuccess(
        "tp",
        Object.values(POSITION).join(" "),
      );
      await bot.waitForChunksToLoad!();
      await bot.waitForTicks!(1);
    }, TIMEOUT_MS);

    for (const dir of directions) {
      for (const distance of distances) {
        test(
          `${dir.name} ${distance} blocks`,
          async () => {
            const result = await bot.utilsManager.jumpViaOffset(
              new Vec3(
                dir.offset.x * distance,
                0,
                dir.offset.z * distance,
              ),
            );
            results.push({
              direction: dir.name,
              distance,
              result,
            });
            logger.info(
              `${dir.name} ${distance} blocks: ${result.toFixed(3)}b remaining`,
              "Movement",
            );
            // Assert jump accuracy: remaining distance must be <= 0.3 blocks
            expect(result).toBeLessThanOrEqual(0.3);
          },
          TIMEOUT_MS,
        );
      }
    }

    afterAll(() => {
      // Should have 4 directions × 5 distances = 20 total tests
      expect(results.length).toBe(20);

      // Check that we have all 4 diagonal directions
      const directionNames = [...new Set(results.map((r) => r.direction))];
      expect(directionNames).toEqual(
        expect.arrayContaining([
          "North-East",
          "North-West",
          "South-East",
          "South-West",
        ]),
      );

      // Check that we have all 5 distances
      const distanceValues = [...new Set(results.map((r) => r.distance))];
      expect(distanceValues).toEqual([1.0, 1.5, 2.0, 2.5, 3.0]);

      logger.info(
        `jumpViaOffset diagonal results: ${results.length} tests completed`,
        "Movement",
      );
    });
  });

  test(
    "collisionStress — runs all 9 obstacle scenarios",
    async () => {
      const scenarios = [
        { name: "Test 0", obstacle: null },
        { name: "Test 1", obstacle: { x: 1, y: 1, z: 0 } },
        { name: "Test 2", obstacle: { x: 2, y: 1, z: 0 } },
        { name: "Test 3", obstacle: { x: 1, y: 2, z: 0 } },
        { name: "Test 4", obstacle: { x: 2, y: 2, z: 0 } },
        { name: "Test 5", obstacle: { x: 0, y: 3, z: 0 } },
        { name: "Test 6", obstacle: { x: 1, y: 3, z: 0 } },
        { name: "Test 7", obstacle: { x: 2, y: 3, z: 0 } },
        { name: "Test 8", obstacle: { x: 3, y: 3, z: 0 } },
      ];
      const source = new Vec3(3.5, 1, 0.5);
      const targetPos = new Vec3(0.5, 1, 0.5);
      const utils = getUtils();
      for (const scenario of scenarios) {
        await bot.utilsManager.assertCommandSuccess(
          "tp",
          `${bot.username} 3 1 0`,
        );
        await bot.waitForTicks!(3);
        if (scenario.obstacle) {
          const o = scenario.obstacle;
          await bot.utilsManager.assertCommandSuccess(
            "setblock",
            `${o.x} ${o.y} ${o.z} dirt`,
          );
          await bot.waitForTicks!(3);
        }
        utils.isJumpPathClear(source, targetPos);
        if (scenario.obstacle) {
          const o = scenario.obstacle;
          await bot.utilsManager.assertCommandSuccess(
            "setblock",
            `${o.x} ${o.y} ${o.z} air`,
          );
          await bot.waitForTicks!(3);
        }
      }
    },
    TIMEOUT_MS,
  );
});
