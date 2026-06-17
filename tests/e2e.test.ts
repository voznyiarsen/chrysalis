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
const TIMEOUT_MS = parseInt(process.env.E2E_TIMEOUT || "30", 10) * 1000;
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

  jest.setTimeout(TIMEOUT_MS + CONNECT_TIMEOUT_MS);

  beforeAll(async () => {
    bot = await createBot();
    // Wait for chunks to load before running tests
    await bot.waitForChunksToLoad();
  });

  afterAll(() => {
    if (bot && bot.end) {
      bot.end();
    }
  });

  // ----------------------------------------------------------------
  // Strafe Tests
  // ----------------------------------------------------------------

  test("debugStrafeOnce — executes single strafe", async () => {
    const dm = (bot as any).debugManager;
    const dist = await dm.debugStrafeOnce();
    expect(dist).toBeGreaterThanOrEqual(0);
    expect(dist).toBeLessThanOrEqual(0.3);
  });

  test("debugStrafeLoop — loops strafe 3 times", async () => {
    const dm = (bot as any).debugManager;
    const distances = await dm.debugStrafeLoop();
    expect(distances.length).toBe(3);
    distances.forEach((dist) => {
      expect(dist).toBeGreaterThanOrEqual(0);
      expect(dist).toBeLessThanOrEqual(0.3);
    });
  });

  // ----------------------------------------------------------------
  // Jump Tests
  // ----------------------------------------------------------------

  test("debugJumpTest — jumps to default (+3, 0, 0) offset", async () => {
    const dm = (bot as any).debugManager;
    const dist = await dm.debugJumpTest();
    expect(dist).toBeGreaterThanOrEqual(0);
    expect(dist).toBeLessThanOrEqual(0.3);
  });

  test("debugJumpPath — checks isJumpPathClear at default offset", async () => {
    const dm = (bot as any).debugManager;
    await dm.debugJumpPath();
  });

  test("debugCollisionStress — runs all 9 obstacle scenarios", async () => {
    const dm = (bot as any).debugManager;
    await dm.debugCollisionStress();
  });

  // ----------------------------------------------------------------
  // Pearl Tests
  // ----------------------------------------------------------------

  describe("Pearl Arc: auto", () => {
    test("debugPearlArc — throws pearl to bot position (offset: 25, 0, 0) (arc: auto)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(25, 0, 0);
      await dm.debugPearlArc("auto", targetPos);
    });

    test("debugPearlArc — throws pearl to bot position (offset: -25, 0, 0) (arc: auto)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(-25, 0, 0);
      await dm.debugPearlArc("auto", targetPos);
    });

    test("debugPearlArc — throws pearl to bot position (offset: 0, 0, 25) (arc: auto)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(0, 0, 25);
      await dm.debugPearlArc("auto", targetPos);
    });

    test("debugPearlArc — throws pearl to bot position (offset: 0, 0, -25) (arc: auto)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(0, 0, -25);
      await dm.debugPearlArc("auto", targetPos);
    });

    test("debugPearlArc — throws pearl to bot position (offset: 25, 0, 25) (arc: auto)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(25, 0, 25);
      await dm.debugPearlArc("auto", targetPos);
    });

    test("debugPearlArc — throws pearl to bot position (offset: -25, 0, -25) (arc: auto)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(-25, 0, -25);
      await dm.debugPearlArc("auto", targetPos);
    });
  });

  describe("Pearl Arc: low", () => {
    test("debugPearlArc — throws pearl to bot position (offset: 25, 0, 0) (arc: low)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(25, 0, 0);
      await dm.debugPearlArc("low", targetPos);
    });

    test("debugPearlArc — throws pearl to bot position (offset: -25, 0, 0) (arc: low)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(-25, 0, 0);
      await dm.debugPearlArc("low", targetPos);
    });

    test("debugPearlArc — throws pearl to bot position (offset: 0, 0, 25) (arc: low)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(0, 0, 25);
      await dm.debugPearlArc("low", targetPos);
    });

    test("debugPearlArc — throws pearl to bot position (offset: 0, 0, -25) (arc: low)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(0, 0, -25);
      await dm.debugPearlArc("low", targetPos);
    });

    test("debugPearlArc — throws pearl to bot position (offset: 25, 0, 25) (arc: low)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(25, 0, 25);
      await dm.debugPearlArc("low", targetPos);
    });

    test("debugPearlArc — throws pearl to bot position (offset: -25, 0, -25) (arc: low)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(-25, 0, -25);
      await dm.debugPearlArc("low", targetPos);
    });
  });

  describe("Pearl Arc: high", () => {
    test("debugPearlArc — throws pearl to bot position (offset: 25, 0, 0) (arc: high)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(25, 0, 0);
      await dm.debugPearlArc("high", targetPos);
    });

    test("debugPearlArc — throws pearl to bot position (offset: -25, 0, 0) (arc: high)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(-25, 0, 0);
      await dm.debugPearlArc("high", targetPos);
    });

    test("debugPearlArc — throws pearl to bot position (offset: 0, 0, 25) (arc: high)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(0, 0, 25);
      await dm.debugPearlArc("high", targetPos);
    });

    test("debugPearlArc — throws pearl to bot position (offset: 0, 0, -25) (arc: high)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(0, 0, -25);
      await dm.debugPearlArc("high", targetPos);
    });

    test("debugPearlArc — throws pearl to bot position (offset: 25, 0, 25) (arc: high)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(25, 0, 25);
      await dm.debugPearlArc("high", targetPos);
    });

    test("debugPearlArc — throws pearl to bot position (offset: -25, 0, -25) (arc: high)", async () => {
      const dm = (bot as any).debugManager;
      const targetPos = bot.entity!.position.offset(-25, 0, -25);
      await dm.debugPearlArc("high", targetPos);
    });
  });
});
