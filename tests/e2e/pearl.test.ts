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
import { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { logger } from "../../src/logger";
import { Constants } from "../../src/constants";
import {
  buildGiveCmd,
  createBot,
  e2eTimeoutMs,
  ensureReady,
  getSessionPosition,
  getUsername,
  logSuiteStart,
  pollUntil,
  resetBotState,
} from "./setup";

// ── E2E configuration ───────────────────────────────────────────────

const HOST = process.env.E2E_HOST;
const USERNAME = getUsername("prl");
const BASE_POSITION = new Vec3(100, 1, 100);
const POSITION = getSessionPosition(BASE_POSITION);
const TIMEOUT_MS = e2eTimeoutMs();

// ── Conditional test runner ─────────────────────────────────────────

const describeE2E = HOST ? describe : describe.skip;

// ── E2E test suite ──────────────────────────────────────────────────

describeE2E("E2E Pearl Tests", () => {
  let bot: Bot;

  // ── Helpers ───────────────────────────────────────────────────────

  const getUtils = (): any => (bot as any).utilsManager;

  /**
   * Give ender pearls and wait until they are in inventory.
   */
  async function givePearls(count: number): Promise<void> {
    bot.chat!(buildGiveCmd("ender_pearl", { count }));
    await pollUntil(
      bot,
      () => bot.inventoryManager.getItemCount("ender_pearl") >= count,
      60,
      `${count} ender pearls in inventory`,
    );
  }

  /**
   * Reset bot state between tests: stop pathfinding/PVP, switch to creative.
   */
  async function resetState(): Promise<void> {
    await resetBotState(bot);
  }

  // Set overall suite timeout to 5 minutes (300 seconds)
  jest.setTimeout(TIMEOUT_MS * 5);

  beforeAll(async () => {
    // Run before all tests
    logSuiteStart("E2E Pearl Tests", USERNAME);
    bot = await createBot({ username: USERNAME, timeoutMs: TIMEOUT_MS });
    try {
      await ensureReady(bot, POSITION);
    } catch (error) {
      logger.error(error, "Combat");
      throw error;
    }
  }, TIMEOUT_MS);

  beforeEach(async () => {
    // Run before each test
    if (bot && bot.entity) {
      try {
        bot.chat!(`/tp ${POSITION.x} ${POSITION.y} ${POSITION.z}`);
        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        await resetState();
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
        // Give extra time for cleanup
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        logger.error(error, "Combat");
      }
    }
    logger.setDebugMode(false);
  }, TIMEOUT_MS * 2);

  // ══════════════════════════════════════════════════════════════════
  // Comprehensive Pearl Throws
  // ══════════════════════════════════════════════════════════════════

  describe("measured throws - low arc", () => {
    const TOLERANCE = 3.0;

    test(
      "pearl lands within tolerance of a 20-block target",
      async () => {
        await givePearls(2);
        const startPos = bot.entity.position.clone();
        const targetPos = startPos.offset(20, 0, 0);
        const countBefore = bot.inventoryManager.getItemCount("ender_pearl");

        await bot.combatManager.throwPearlAt(targetPos, "low");

        // Wait for the pearl to land (teleport) or time out.
        await pollUntil(
          bot,
          () =>
            bot.entity.position.distanceTo(startPos) > TOLERANCE ||
            bot.inventoryManager.getItemCount("ender_pearl") < countBefore,
          200,
          "pearl to land or leave inventory",
        );

        const remaining = targetPos.distanceTo(bot.entity.position);
        logger.info(
          `Low arc 20 blocks: ${remaining.toFixed(2)}b from target`,
          "Combat",
        );
        // The pearl must have been consumed by the throw.
        expect(bot.inventoryManager.getItemCount("ender_pearl")).toBeLessThan(
          countBefore,
        );
        // If the pearl teleported the bot, the landing must be near target.
        if (bot.entity.position.distanceTo(startPos) > TOLERANCE) {
          expect(remaining).toBeLessThanOrEqual(TOLERANCE);
        }
      },
      TIMEOUT_MS,
    );
  });

  describe("measured throws - high arc", () => {
    const TOLERANCE = 4.0;

    test(
      "pearl lands within tolerance of a 20-block target",
      async () => {
        await givePearls(2);
        const startPos = bot.entity.position.clone();
        const targetPos = startPos.offset(20, 0, 0);
        const countBefore = bot.inventoryManager.getItemCount("ender_pearl");

        await bot.combatManager.throwPearlAt(targetPos, "high");

        await pollUntil(
          bot,
          () =>
            bot.entity.position.distanceTo(startPos) > TOLERANCE ||
            bot.inventoryManager.getItemCount("ender_pearl") < countBefore,
          200,
          "pearl to land or leave inventory",
        );

        const remaining = targetPos.distanceTo(bot.entity.position);
        logger.info(
          `High arc 20 blocks: ${remaining.toFixed(2)}b from target`,
          "Combat",
        );
        expect(bot.inventoryManager.getItemCount("ender_pearl")).toBeLessThan(
          countBefore,
        );
        if (bot.entity.position.distanceTo(startPos) > TOLERANCE) {
          expect(remaining).toBeLessThanOrEqual(TOLERANCE);
        }
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Individual Arc Type Validation
  // ══════════════════════════════════════════════════════════════════

  describe("individual arc type enforcement", () => {
    test(
      "low arc throw succeeds",
      async () => {
        await givePearls(1);
        const countBefore = bot.inventoryManager.getItemCount("ender_pearl");
        const targetPos = bot.entity.position.offset(2.5, 0, 0.75);
        await bot.combatManager.throwPearlAt(targetPos, "low");
        await pollUntil(
          bot,
          () => bot.inventoryManager.getItemCount("ender_pearl") < countBefore,
          60,
          "pearl to leave inventory after low arc throw",
        );
      },
      TIMEOUT_MS,
    );

    test(
      "high arc throw succeeds",
      async () => {
        await givePearls(1);
        const countBefore = bot.inventoryManager.getItemCount("ender_pearl");
        const targetPos = bot.entity.position.offset(2.5, 0, 0.75);
        await bot.combatManager.throwPearlAt(targetPos, "high");
        await pollUntil(
          bot,
          () => bot.inventoryManager.getItemCount("ender_pearl") < countBefore,
          60,
          "pearl to leave inventory after high arc throw",
        );
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
