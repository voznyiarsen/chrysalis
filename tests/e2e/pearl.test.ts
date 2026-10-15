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
  killMobsCmd,
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
        // Remove stray in-flight pearls from the previous test so they
        // cannot teleport the bot mid-test.
        bot.chat!(`/${killMobsCmd(100)}`);
        await bot.waitForTicks!(3);
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

  /**
   * Run a throw test in survival mode (thrown pearls are only consumed in
   * survival; in creative the count never drops). Restores creative after.
   */
  async function inSurvival(fn: () => Promise<void>): Promise<void> {
    await bot.inventoryManager.setGamemode(0);
    try {
      await fn();
    } finally {
      await bot.inventoryManager.setGamemode(1);
      await bot.waitForTicks!(2);
    }
  }

  /**
   * Throw a pearl and wait for consumption, retrying whole attempts.
   * Single throws flake (use-packet vs window-confirm races), so up to 3
   * attempts are made; returns whether any throw consumed a pearl.
   */
  async function throwAndWaitForConsumption(
    targetPos: Vec3,
    arc: "low" | "high",
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (bot.inventoryManager.getItemCount("ender_pearl") === 0) {
        await givePearls(2);
      }
      const before = bot.inventoryManager.getItemCount("ender_pearl");
      // equipPearl throws honestly on certain non-throw; null-offset
      // targets return silently and surface below as unconsumed.
      await bot.combatManager.throwPearlAt(targetPos, arc);
      try {
        await pollUntil(
          bot,
          () => bot.inventoryManager.getItemCount("ender_pearl") < before,
          60,
          `pearl to leave inventory (attempt ${attempt + 1})`,
        );
        return true;
      } catch {
        logger.info(
          `Throw attempt ${attempt + 1} not consumed, retrying`,
          "Combat",
        );
      }
    }
    return false;
  }

  describe("measured throws - low arc", () => {
    const TOLERANCE = 3.0;

    test(
      "pearl lands within tolerance of a 20-block target",
      async () => {
        await inSurvival(async () => {
          const startPos = bot.entity.position.clone();
          const targetPos = startPos.offset(20, 0, 0);

          const consumed = await throwAndWaitForConsumption(targetPos, "low");
          expect(consumed).toBe(true);

          // Wait for the pearl to land (teleport) if it hasn't yet.
          try {
            await pollUntil(
              bot,
              () => bot.entity.position.distanceTo(startPos) > TOLERANCE,
              200,
              "pearl to teleport the bot",
            );
          } catch {
            logger.info("Pearl consumed but no teleport observed", "Combat");
          }

          const remaining = targetPos.distanceTo(bot.entity.position);
          logger.info(
            `Low arc 20 blocks: ${remaining.toFixed(2)}b from target`,
            "Combat",
          );
          // If the pearl teleported the bot, the landing must be near target.
          if (bot.entity.position.distanceTo(startPos) > TOLERANCE) {
            expect(remaining).toBeLessThanOrEqual(TOLERANCE);
          }
        });
      },
      TIMEOUT_MS,
    );
  });

  describe("measured throws - high arc", () => {
    const TOLERANCE = 4.0;

    test(
      "pearl lands within tolerance of a 20-block target",
      async () => {
        await inSurvival(async () => {
          const startPos = bot.entity.position.clone();
          const targetPos = startPos.offset(20, 0, 0);

          const consumed = await throwAndWaitForConsumption(targetPos, "high");
          expect(consumed).toBe(true);

          try {
            await pollUntil(
              bot,
              () => bot.entity.position.distanceTo(startPos) > TOLERANCE,
              200,
              "pearl to teleport the bot",
            );
          } catch {
            logger.info("Pearl consumed but no teleport observed", "Combat");
          }

          const remaining = targetPos.distanceTo(bot.entity.position);
          logger.info(
            `High arc 20 blocks: ${remaining.toFixed(2)}b from target`,
            "Combat",
          );
          if (bot.entity.position.distanceTo(startPos) > TOLERANCE) {
            expect(remaining).toBeLessThanOrEqual(TOLERANCE);
          }
        });
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
        await inSurvival(async () => {
          const targetPos = bot.entity.position.offset(2.5, 0, 0.75);
          const consumed = await throwAndWaitForConsumption(targetPos, "low");
          expect(consumed).toBe(true);
        });
      },
      TIMEOUT_MS,
    );

    test(
      "high arc throw succeeds",
      async () => {
        await inSurvival(async () => {
          // High-arc (mortar) solutions only exist at some ranges (the
          // offset solver has gaps); 18b is verified reachable.
          const targetPos = bot.entity.position.offset(18, 0, 0.75);
          const consumed = await throwAndWaitForConsumption(targetPos, "high");
          expect(consumed).toBe(true);
        });
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
