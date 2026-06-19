/**
 * E2E integration tests for Pupa debug methods.
 *
 * These tests connect to a real Minecraft server using configuration from `.env`,
 * create a bot instance, load all Pupa managers, and run each debug method
 * against the live server.
 *
 * Environment variables (`.env`):
 *   E2E_HOST      - Server hostname (default: localhost)
 *   E2E_PORT      - Server port     (default: 25565)
 *   E2E_USERNAME  - Bot username    (default: E2ETestBot)
 *   E2E_VERSION   - Game version    (default: auto-detect)
 *   E2E_TIMEOUT   - Seconds per test (default: 30)
 *
 * Skipped automatically when E2E_HOST is not set.
 */

import "dotenv/config";
import mineflayer, { Bot } from "mineflayer";
import { pathfinder } from "mineflayer-pathfinder";
import { plugin as pvpPlugin } from "../src/pvp-manager";
import attachInventory from "../src/inventory";
import attachCombat from "../src/pvp";
import attachCommands from "../src/commands";
import attachUtils from "../src/utils";
import attachDebug from "../src/debug";
import { RuntimeConfig } from "../src/config";
import { logger } from "../src/logger";
import { Vec3 } from "vec3";

// ── E2E configuration ───────────────────────────────────────────────

const HOST = process.env.E2E_HOST;
const PORT = parseInt(process.env.E2E_PORT || "25565", 10);
const USERNAME = process.env.E2E_USERNAME || "E2ETestBot";
const VERSION = process.env.E2E_VERSION || undefined;
const TIMEOUT_MS = parseInt(process.env.E2E_TIMEOUT || "60", 10) * 1000;
const CONNECT_TIMEOUT_MS = 15_000;

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
  bot.loadPlugin(pvpPlugin);

  // Load Pupa managers
  (bot as any).runtimeConfig = new RuntimeConfig();
  (bot as any).__logger = logger;
  attachInventory(bot);
  attachCombat(bot);
  attachCommands(bot);
  attachUtils(bot);
  attachDebug(bot);

  logger.setDebugMode(true);

  return bot;
}

// ── E2E test suite ──────────────────────────────────────────────────

describeE2E("E2E Debug Methods", () => {
  let bot: Bot;

  // Set overall suite timeout to 5 minutes (300 seconds)
  jest.setTimeout(Math.min(300000, TIMEOUT_MS + CONNECT_TIMEOUT_MS));

  beforeAll(async () => {
    bot = await createBot();
    // Wait for chunks to load before running tests with timeout
    await Promise.race([
      bot.waitForChunksToLoad(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Chunk loading timeout")), 30000),
      ),
    ]);

    // Setup test environment - teleport to origin
    if (bot.entity) {
      const dm = (bot as any).debugManager;
      await dm.setupTestEnvironment();
    }
  });

  afterAll(async () => {
    if (bot && bot.end) {
      try {
        // Immediately stop all physics and movement
        bot.clearControlStates();
        
        // Stop the physics engine: delete the physics reference
        if ((bot as any).physicsEnabled !== undefined) {
          (bot as any).physicsEnabled = false;
        }
        
        // Remove all listeners to stop physics ticks from firing after cleanup
        bot.removeAllListeners();
        
        bot.end();
        // Small delay for cleanup
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        console.error("Error ending bot:", error);
      }
    }
    // Reset the logger to ensure no lingering references
    logger.setDebugMode(false);
  }, 10000); // 10 second timeout for cleanup

  // ----------------------------------------------------------------
  // Strafe Tests
  // ----------------------------------------------------------------

  test("debugStrafeOnce — executes single strafe", async () => {
    const dm = (bot as any).debugManager;
    const dist = await dm.debugStrafeOnce();
    expect(dist).toBeGreaterThanOrEqual(0);
    expect(dist).toBeLessThanOrEqual(0.3);
  }, 30000); // 30 second timeout

  test("debugStrafeLoop — loops strafe 3 times", async () => {
    const dm = (bot as any).debugManager;
    const distances = await dm.debugStrafeLoop();
    expect(distances.length).toBe(3);
    distances.forEach((dist) => {
      expect(dist).toBeGreaterThanOrEqual(0);
      expect(dist).toBeLessThanOrEqual(0.3);
    });
  }, 45000); // 45 second timeout

  // ----------------------------------------------------------------
  // Jump Tests
  // ----------------------------------------------------------------

  test("debugJumpTest — jumps to default (+3, 0, 0) offset", async () => {
    const dm = (bot as any).debugManager;
    const dist = await dm.debugJumpTest();
    expect(dist).toBeGreaterThanOrEqual(0);
    expect(dist).toBeLessThanOrEqual(0.3);
  }, 30000); // 30 second timeout

  test("debugJumpPath — checks isJumpPathClear at default offset", async () => {
    const dm = (bot as any).debugManager;
    await dm.debugJumpPath();
  }, 15000); // 15 second timeout

  test("debugJumpComprehensive — tests jumps in all 4 directions at ranges 1-4 blocks", async () => {
    const dm = (bot as any).debugManager;
    const results = await dm.debugJumpComprehensive();

    // Should have 4 directions × 7 distances = 28 total tests
    expect(results.length).toBe(28);

    // Check that we have all 4 directions
    const directions = [...new Set(results.map((r) => r.direction))];
    expect(directions).toEqual(
      expect.arrayContaining(["North", "South", "East", "West"]),
    );

    // Check that we have all 7 distances
    const distances = [...new Set(results.map((r) => r.distance))];
    expect(distances).toEqual([1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0]);

    // All tests should be successful (100% success rate required)
    results.forEach((test) => {
      expect(test.success).toBe(true); // Every test must succeed
    });

    // Log detailed results for debugging
    console.log("Comprehensive jump test results:");
    results.forEach((result) => {
      console.log(
        `  ${result.direction} ${result.distance} blocks: ${result.result.toFixed(3)} ${result.success ? "✓" : "✗"}`,
      );
    });
  }, 120000); // 120 second timeout for comprehensive test

  test("debugCollisionStress — runs all 9 obstacle scenarios", async () => {
    const dm = (bot as any).debugManager;
    await dm.debugCollisionStress();
  }, 60000); // 60 second timeout

  // ----------------------------------------------------------------
  // Pearl Tests
  // ----------------------------------------------------------------

  test("debugPearlComprehensive — tests pearl throws in all 4 directions at 20 blocks with low and high arcs", async () => {
    const dm = (bot as any).debugManager;
    const results = await dm.debugPearlComprehensive();

    // Should have 4 directions × 1 distance × 2 arc types = 8 total tests
    expect(results.length).toBe(8);

    // Check that we have all 4 directions
    const directions = [...new Set(results.map((r) => r.direction))];
    expect(directions).toEqual(
      expect.arrayContaining(["North", "South", "East", "West"]),
    );

    // Check distance is always 20
    const distances = [...new Set(results.map((r) => r.distance))];
    expect(distances).toEqual([20]);

    // Check that we have both arc types
    const arcs = [...new Set(results.map((r) => r.arc))];
    expect(arcs).toEqual(expect.arrayContaining(["low", "high"]));

    // All tests should be successful and accurate (100% success rate required)
    results.forEach((test) => {
      expect(test.success).toBe(true); // Every test must succeed
      expect(test.result).toBeGreaterThanOrEqual(0); // Non-negative distance
      expect(test.result).toBeLessThanOrEqual(3.0); // Within 3 blocks of target
    });

    // Log detailed results for debugging
    console.log("Comprehensive pearl test results:");
    results.forEach((result) => {
      console.log(
        `  ${result.direction} ${result.distance} blocks ${result.arc} arc: ${result.result >= 0 ? result.result.toFixed(3) : "TIMEOUT"} ${result.success ? "✓" : "✗"}`,
      );
    });
  }, 180000); // 180 second timeout for comprehensive pearl test
});
