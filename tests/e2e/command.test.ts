/**
 * @fileoverview E2E integration tests for command assertion functionality.
 *
 * These tests verify that `assertCommandSuccess` correctly captures server
 * success messages across a variety of commands, validating the pattern-based
 * `translate` key detection (commands.<verb>.<...>.success).
 *
 * Environment variables (`.env`):
 *   E2E_HOST      - Server hostname (default: localhost)
 *   E2E_PORT      - Server port     (default: 25565)
 *   E2E_VERSION   - Game version    (default: 1.12.2)
 *   E2E_TIMEOUT   - Seconds per test (default: 60)
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
const USERNAME = "command_test";
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

describeE2E("E2E Command Assertion Tests", () => {
  let bot: Bot;

  // ── Helpers ───────────────────────────────────────────────────────

  /**
   * Reset bot state between tests: stop pathfinding/PVP, switch to creative.
   * Uses bot.creative for gamemode to avoid depending on assertCommandSuccess
   * during setup (which is the system under test).
   */
  async function resetBotState(): Promise<void> {
    bot.clearControlStates();
    (bot as any).pathfinder?.stop();
    (bot as any).pvp?.stop();
    if ((bot.game as any).gameMode !== "creative") {
      (bot as any).creative?.flyTo?.(bot.entity.position.offset(0, 1, 0));
      await bot.utilsManager.assertCommandSuccess("gamemode", "creative", 40);
    }
    await bot.waitForTicks!(2);
  }

  /**
   * Capture the next message's translate key for debugging.
   */
  function captureNextTranslate(): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        bot.removeListener("message", onMessage);
        resolve(undefined);
      }, 5000);

      const onMessage = (jsonMsg: any) => {
        const translate: unknown =
          (jsonMsg as any)?.json?.translate ?? (jsonMsg as any)?.translate;
        clearTimeout(timer);
        bot.removeListener("message", onMessage);
        resolve(typeof translate === "string" ? translate : undefined);
      };

      bot.on("message", onMessage);
    });
  }

  // Set overall suite timeout
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
        await bot.utilsManager.assertCommandSuccess(
          "gamemode",
          "creative",
          40,
        );
      } catch (error) {
        logger.error(error, "Command");
      }
    }
  }, TIMEOUT_MS);

  beforeEach(async () => {
    if (bot && bot.entity) {
      try {
        await resetBotState();
      } catch (error) {
        logger.error(error, "Command");
      }
    }
  }, TIMEOUT_MS);

  afterAll(async () => {
    if (bot) {
      try {
        bot.quit!();
        bot.end!();
      } catch (error) {
        logger.error(error, "Command");
      }
    }
    logger.setDebugMode(false);
  }, TIMEOUT_MS);

  // ── Tests ─────────────────────────────────────────────────────────

  describe("assertCommandSuccess", () => {
    test("captures success from /gamemode command", async () => {
      const result = await bot.utilsManager.assertCommandSuccess(
        "gamemode",
        "survival",
        40,
      );
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);

      // Verify the gamemode actually changed
      await bot.waitForTicks!(2);
      expect((bot.game as any).gameMode).toBe("survival");

      // Restore creative mode for subsequent tests
      await bot.utilsManager.assertCommandSuccess(
        "gamemode",
        "creative",
        40,
      );
      await bot.waitForTicks!(2);
    });

    test("captures success from /give command", async () => {
      const result = await bot.utilsManager.assertCommandSuccess(
        "give",
        "@p stone 1",
      );
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    test("captures success from /tp command", async () => {
      const result = await bot.utilsManager.assertCommandSuccess("tp", "0 1 0");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    test("captures success from /effect command", async () => {
      const result = await bot.utilsManager.assertCommandSuccess(
        "effect",
        "@p speed 30 1",
      );
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    test("captures success from /kill command", async () => {
      // Kill then respawn — /kill sends commands.kill.successful
      const result = await bot.utilsManager.assertCommandSuccess("kill", "");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    test("rejects on timeout when no success message arrives", async () => {
      // An invalid command that produces no success message should time out.
      // Use a very short timeout to keep the test fast.
      await expect(
        bot.utilsManager.assertCommandSuccess(
          "nonexistent_command_that_fails",
          "",
          2, // 2 ticks = 100ms timeout
        ),
      ).rejects.toThrow(/Timed out/);
    });

    test("resolves with the raw message string", async () => {
      const result = await bot.utilsManager.assertCommandSuccess(
        "gamemode",
        "creative",
        40,
      );
      // The resolved value should be the stringified chat message
      // (human-readable, not the raw translate key)
      expect(result.length).toBeGreaterThan(0);
      expect(result.toLowerCase()).toContain("game mode");
    });
  });

  describe("translate key diagnostics", () => {
    test("captures the translate key from /gamemode feedback", async () => {
      const pending = captureNextTranslate();
      bot.chat!("/gamemode survival");
      const translate = await pending;

      // Restore gamemode
      await bot.waitForTicks!(2);
      const restorePending = captureNextTranslate();
      bot.chat!("/gamemode creative");
      await restorePending;
      await bot.waitForTicks!(2);

      // Log for debugging — this reveals what translate key the server uses
      logger.command(
        `gamemode translate key: ${translate ?? "(none)"}`,
        "DEBUG",
        "Command",
      );

      // The key should exist and indicate command success
      expect(translate).toBeDefined();
      const isCommandSuccess =
        translate!.startsWith("commands.") &&
        translate!.includes("success");
      const isLegacyKey =
        translate === "gameMode.changed" ||
        translate === "gameMode.changed.other";
      expect(isCommandSuccess || isLegacyKey).toBe(true);
    });
  });
});
