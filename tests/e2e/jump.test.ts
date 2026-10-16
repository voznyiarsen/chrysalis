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
  requireRcon,
  pollUntil,
  resetBotState,
  serverCommand,
  tpBot,
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
    // Phase 0: RCON channel (fail fast — every setup command needs it).
    requireRcon();
    logSuiteStart("E2E Jump Tests", USERNAME);
    // Phase 1: bot setup, pure client-side (connect + attach managers).
    bot = await createBot({ username: USERNAME, timeoutMs: TIMEOUT_MS });
    try {
      // Phase 2: environment setup via RCON (position + creative).
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
        await tpBot(bot, POSITION.x, POSITION.y, POSITION.z);
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
        // Wait for the socket to actually close so no bot activity leaks
        // into the next suite file (stale packets + lazy requires crash
        // workers with post-teardown require errors).
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5000);
          bot.once("end", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
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
      await tpBot(bot, POSITION.x, POSITION.y, POSITION.z);
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
      await tpBot(bot, POSITION.x, POSITION.y, POSITION.z);
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
    'isJumpPathClear (Solid obstacles)',
    async () => {
      // Every BLOCKED scenario uses geometry a ballistic 3-block jump
      // cannot clear: 2-3 high walls (jump apex feet ~1.3) or overhead
      // blocks inside the rising head path (head starts at +1.8 with 0.2
      // clearance and rises immediately). Single low steps and blocks past
      // the target are deliberately NOT used: the sim correctly reports
      // those as landable/irrelevant, so they cannot assert BLOCKED.
      const scenarios: { name: string; blocks: { dx: number; dy: number; dz: number }[] }[] = [
        { name: 'Test 0', blocks: [] }, // Should be CLEAR
        { name: 'Test 1', blocks: [{ dx: -3, dy: 0, dz: 0 }, { dx: -3, dy: 1, dz: 0 }, { dx: -3, dy: 2, dz: 0 }] }, // 3-high wall at landing
        { name: 'Test 2', blocks: [{ dx: -2, dy: 0, dz: 0 }, { dx: -2, dy: 1, dz: 0 }, { dx: -2, dy: 2, dz: 0 }] }, // 3-high wall mid-path
        { name: 'Test 3', blocks: [{ dx: -1, dy: 0, dz: 0 }, { dx: -1, dy: 1, dz: 0 }, { dx: -1, dy: 2, dz: 0 }] }, // 3-high wall near start
        { name: 'Test 4', blocks: [{ dx: 0, dy: 2, dz: 0 }] }, // Ceiling directly above start
        { name: 'Test 5', blocks: [{ dx: -2, dy: 2, dz: 0 }] }, // Ceiling above mid-flight
        { name: 'Test 6', blocks: [{ dx: -3, dy: 2, dz: 0 }] }, // Ceiling above landing
        { name: 'Test 7', blocks: [{ dx: -3, dy: 0, dz: 0 }, { dx: -3, dy: 1, dz: 0 }] }, // 2-high wall at landing (unlandable)
        { name: 'Test 8', blocks: [{ dx: -1, dy: 0, dz: 0 }, { dx: -1, dy: 1, dz: 0 }] }, // 2-high wall near start
      ];
      /*
      Given that:
      B=Block
      A=Air
      F=Bot
      D=Destination

      The area checked is (side view, relative to bot at x=0):
      AAABBBAA  (y=2: wall tops / ceilings)
      FAABBBAD  (y=1: wall bodies — B at x=-1..-3 per scenario)
      FAAABBBD  (y=0: wall bases / platform floor)
      Only the listed scenario blocks exist; everything else is air
      above the sky-platform floor.
      */
      const utils = getUtils();
      // Build a controlled sky platform: session terrain is unprepared and
      // may slope or have cover, so Test 0 (no obstacle) is only meaningful
      // on known-flat ground. Floor at y=100 keeps clear of all terrain.
      const ax = Math.floor(POSITION.x);
      const az = Math.floor(POSITION.z);
      const floorY = 100;
      const airY = 101;
      const fillCmds = [
        `/fill ${ax - 5} ${floorY} ${az - 1} ${ax + 1} ${floorY} ${az + 1} stone`,
        `/fill ${ax - 5} ${airY} ${az - 1} ${ax + 1} ${airY + 3} ${az + 1} air`,
      ];
      const platformReady = () => {
        const f = bot.blockAt(new Vec3(ax, floorY, az));
        const a = bot.blockAt(new Vec3(ax, airY, az));
        return (
          !!f && f.boundingBox !== 'empty' && (!a || a.boundingBox === 'empty')
        );
      };
      for (const cmd of fillCmds) await serverCommand(bot, cmd);
      await pollUntil(bot, platformReady, 90, 'sky platform to be ready');
      await tpBot(bot, ax, airY, az);
      await bot.waitForChunksToLoad!();
      await bot.combatManager._waitUntilSettled();
      const source = bot.entity.position.clone();
      const targetPos = source.offset(-3, 0, 0);
      // Track placed obstacles so a failed assertion still cleans up.
      const placed: Vec3[] = [];
      try {
        for (const scenario of scenarios) {
          await bot.waitForTicks!(5);
          for (const o of scenario.blocks) {
            const obstaclePos = source.offset(o.dx, o.dy, o.dz);
            await serverCommand(
              bot,
              `/setblock ${Math.floor(obstaclePos.x)} ${Math.floor(obstaclePos.y)} ${Math.floor(obstaclePos.z)} emerald_block`,
            );
            placed.push(obstaclePos);
          }
          if (scenario.blocks.length > 0) {
            // Wait for the block updates to reach the client's world view.
            await pollUntil(
              bot,
              () =>
                scenario.blocks.every((o) => {
                  const b = bot.blockAt(source.offset(o.dx, o.dy, o.dz));
                  return !!b && b.boundingBox !== "empty";
                }),
              40,
              `obstacles for ${scenario.name} to appear`,
            );
          }
          const result = utils.isJumpPathClear(source, targetPos);
          logger.info(
            `${scenario.name}: blocks=${scenario.blocks.length} result=${result ? 'CLEAR' : 'BLOCKED'}`,
            'Movement',
          );

          // Assert expected results based on comments
          if (scenario.name === "Test 0") {
            // Should be CLEAR
            expect(result).toBe(true);
          } else {
            // All other tests should be BLOCKED
            expect(result).toBe(false);
          }

          for (let i = 0; i < scenario.blocks.length; i++) {
            const obstaclePos = placed.pop()!;
            await serverCommand(
              bot,
              `/setblock ${Math.floor(obstaclePos.x)} ${Math.floor(obstaclePos.y)} ${Math.floor(obstaclePos.z)} air`,
            );
          }
          if (scenario.blocks.length > 0) await bot.waitForTicks!(3);
        }
      } finally {
        for (const obstaclePos of placed) {
          await serverCommand(
            bot,
            `/setblock ${Math.floor(obstaclePos.x)} ${Math.floor(obstaclePos.y)} ${Math.floor(obstaclePos.z)} air`,
          );
        }
        // Tear down the sky platform and return to the suite position.
        await serverCommand(
          bot,
          `/fill ${ax - 5} ${floorY} ${az - 1} ${ax + 1} ${airY + 3} ${az + 1} air`,
        );
        await tpBot(bot, POSITION.x, POSITION.y, POSITION.z);
        if (placed.length > 0) await bot.waitForTicks!(3);
      }
    },
    TIMEOUT_MS,
  );
});
