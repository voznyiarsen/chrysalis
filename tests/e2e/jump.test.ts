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
import { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { logger } from "../../src/logger";
import {
  createBot,
  e2eTimeoutMs,
  ensureReady,
  getSessionPosition,
  getSessionSuffix,
  getUsername,
  logSuiteStart,
  pollUntil,
  resetBotState,
} from "./setup";

// ── E2E configuration ───────────────────────────────────────────────

const HOST = process.env.E2E_HOST;
const USERNAME = getUsername("jmp");
const BASE_POSITION = new Vec3(0, 1, 0);
const POSITION = getSessionPosition(BASE_POSITION);
const TIMEOUT_MS = e2eTimeoutMs();

// ── Conditional test runner ─────────────────────────────────────────

const describeE2E = HOST ? describe : describe.skip;

// ── E2E test suite ──────────────────────────────────────────────────

describeE2E("E2E Jump Tests", () => {
  let bot: Bot;

  // ── Helpers ───────────────────────────────────────────────────────

  const getUtils = (): any => (bot as any).utilsManager;

  // Set overall suite timeout to 5 minutes (300 seconds)
  jest.setTimeout(TIMEOUT_MS * 5);

  beforeAll(async () => {
    // Run before all tests
    logSuiteStart("E2E Jump Tests", USERNAME);
    bot = await createBot({ username: USERNAME, timeoutMs: TIMEOUT_MS });
    try {
      await ensureReady(bot, POSITION);
    } catch (error) {
      logger.error(error, "Movement");
      throw error;
    }
  }, TIMEOUT_MS);

  beforeEach(async () => {
    // Run before each test
    if (bot && bot.entity) {
      try {
        bot.chat!(`/tp ${POSITION.x} ${POSITION.y} ${POSITION.z}`);
        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(5);
        await resetBotState(bot);
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
      const result = getUtils().isJumpPathClear(source, targetPos);
      expect(typeof result).toBe("boolean");
      logger.info(`isJumpPathClear default offset: ${result}`, "Movement");
    },
    TIMEOUT_MS,
  );

  describe("jumpViaOffset (North, South, East, West)", () => {
    const directions = [
      { name: "North", offset: new Vec3(0, 0, -1) },
      { name: "South", offset: new Vec3(0, 0, 1) },
      { name: "East", offset: new Vec3(1, 0, 0) },
      { name: "West", offset: new Vec3(-1, 0, 0) },
    ];
    const distances = [1.0, 2.0, 3.0, 4.0];

    const results: { direction: string; distance: number; result: number }[] =
      [];

    beforeEach(async () => {
      bot.chat!(`/tp ${POSITION.x} ${POSITION.y} ${POSITION.z}`);
      await bot.waitForTicks!(5);
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
      // Should have 4 directions × 4 distances = 16 total tests
      expect(results.length).toBe(16);

      // Check that we have all 4 directions
      const directionNames = [...new Set(results.map((r) => r.direction))];
      expect(directionNames).toEqual(
        expect.arrayContaining(["North", "South", "East", "West"]),
      );

      // Check that we have all 4 distances
      const distanceValues = [...new Set(results.map((r) => r.distance))];
      expect(distanceValues).toEqual([1.0, 2.0, 3.0, 4.0]);

      logger.info(
        `jumpViaOffset (North, South, East, West) results: ${results.length} tests completed`,
        "Movement",
      );
    });
  });

  describe("jumpViaOffset (North-East, North-West, South-East, South-West)", () => {
    const directions = [
      { name: "North-East", offset: new Vec3(1, 0, -1) },
      { name: "North-West", offset: new Vec3(-1, 0, -1) },
      { name: "South-East", offset: new Vec3(1, 0, 1) },
      { name: "South-West", offset: new Vec3(-1, 0, 1) },
    ];
    const distances = [1.0, 2.0, 3.0, 4.0];

    const results: { direction: string; distance: number; result: number }[] =
      [];

    beforeEach(async () => {
      bot.chat!(`/tp ${POSITION.x} ${POSITION.y} ${POSITION.z}`);
      await bot.waitForTicks!(5);
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
      // Should have 4 directions × 4 distances = 16 total tests
      expect(results.length).toBe(16);

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

      // Check that we have all 4 distances
      const distanceValues = [...new Set(results.map((r) => r.distance))];
      expect(distanceValues).toEqual([1.0, 2.0, 3.0, 4.0]);

      logger.info(
        `jumpViaOffset (North-East, North-West, South-East, South-West) results: ${results.length} tests completed`,
        "Movement",
      );
    });
  });

  test(
    "isJumpPathClear (Solid obstacles)",
    async () => {
      const scenarios = [
        { name: "Test 0", obstacle: null }, // Should be CLEAR
        { name: "Test 1", obstacle: { dx: -3, dy: 0, dz: 0 } }, // Should be BLOCKED (ground, mid-path)
        { name: "Test 2", obstacle: { dx: -2, dy: 0, dz: 0 } }, // Should be BLOCKED (ground, near start)
        { name: "Test 3", obstacle: { dx: -3, dy: 1, dz: 0 } }, // Should be BLOCKED (jump height, mid-path)
        { name: "Test 4", obstacle: { dx: -2, dy: 1, dz: 0 } }, // Should be BLOCKED (jump height, near start)
        { name: "Test 5", obstacle: { dx: -4, dy: 2, dz: 0 } }, // Should be BLOCKED (high, near landing)
        { name: "Test 6", obstacle: { dx: -3, dy: 2, dz: 0 } }, // Should be BLOCKED (high, mid-path)
        { name: "Test 7", obstacle: { dx: -2, dy: 2, dz: 0 } }, // Should be BLOCKED (high, near start)
        { name: "Test 8", obstacle: { dx: -1, dy: 2, dz: 0 } }, // Should be BLOCKED (high, at start)
      ];
      /*
      Given that:
      B=Block
      A=Air
      F=Bot
      D=Destination

      The area checked is (side view, relative to bot at x=0):
      AAAA    (y=2: above head level)
      FABA    (y=1: player feet level - B at x=-2)
      FAAD    (y=0: ground level - D at x=-3)
      Air and block are interchangeable, only one block per scenario can exist in the area
      */
      const utils = getUtils();
      const source = bot.entity.position;
      const targetPos = source.offset(-3, 0, 0);
      // Track placed obstacles so a failed assertion still cleans up.
      const placed: Vec3[] = [];
      try {
        for (const scenario of scenarios) {
          await bot.waitForTicks!(5);
          if (scenario.obstacle) {
            const o = scenario.obstacle;
            const obstaclePos = source.offset(o.dx, o.dy, o.dz);
            bot.chat!(
              `/setblock ${Math.floor(obstaclePos.x)} ${Math.floor(obstaclePos.y)} ${Math.floor(obstaclePos.z)} emerald_block`,
            );
            placed.push(obstaclePos);
            // Wait for the block update to reach the client's world view.
            await pollUntil(
              bot,
              () => {
                const b = bot.blockAt(obstaclePos);
                return !!b && b.boundingBox !== "empty";
              },
              40,
              `obstacle for ${scenario.name} to appear`,
            );
          }
          const result = utils.isJumpPathClear(source, targetPos);

          // Assert expected results based on comments
          if (scenario.name === "Test 0") {
            // Should be CLEAR
            expect(result).toBe(true);
          } else {
            // All other tests should be BLOCKED
            expect(result).toBe(false);
          }

          if (scenario.obstacle) {
            const obstaclePos = placed.pop()!;
            bot.chat!(
              `/setblock ${Math.floor(obstaclePos.x)} ${Math.floor(obstaclePos.y)} ${Math.floor(obstaclePos.z)} air`,
            );
            await bot.waitForTicks!(3);
          }
        }
      } finally {
        for (const obstaclePos of placed) {
          bot.chat!(
            `/setblock ${Math.floor(obstaclePos.x)} ${Math.floor(obstaclePos.y)} ${Math.floor(obstaclePos.z)} air`,
          );
        }
        if (placed.length > 0) await bot.waitForTicks!(3);
      }
    },
    TIMEOUT_MS,
  );
});
