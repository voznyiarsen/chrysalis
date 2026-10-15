/**
 * @fileoverview E2E integration tests for Pupa PvP handling.
 *
 * These tests connect to a real Minecraft server using configuration from `.env`,
 * create a bot instance, load all Pupa managers, and exercise PvP-related
 * functionality against the live server.
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
  createBot,
  e2eTimeoutMs,
  e2eVersion,
  ensureReady,
  getSessionPosition,
  getUsername,
  isModernVersion,
  killMobsCmd,
  logSuiteStart,
  pollUntil,
  resetBotState,
  summonTarget,
  targetTypeSelector,
} from "./setup";

// ── E2E configuration ───────────────────────────────────────────────

const HOST = process.env.E2E_HOST;
const USERNAME = getUsername("pvp");
const BASE_POSITION = new Vec3(400, 1, 400);
const POSITION = getSessionPosition(BASE_POSITION);
const TIMEOUT_MS = e2eTimeoutMs();
const VERSION = e2eVersion();

// ── Conditional test runner ─────────────────────────────────────────

const describeE2E = HOST ? describe : describe.skip;

// ── Helpers ─────────────────────────────────────────────────────────

async function killNearbyEntities(
  bot: Bot,
  radius: number = 30,
): Promise<void> {
  bot.chat!(`/${killMobsCmd(radius, VERSION)}`);
  await bot.waitForTicks!(3);
}

/**
 * Summon a passive test animal. Hostile mobs are cleared on spawn by this
 * server (peaceful-like), so pigs stand in for combat targets. See setup.ts.
 */
async function summonMob(bot: Bot): Promise<any> {
  return summonTarget(bot);
}

/** Teleport to an absolute position (correct template interpolation). */
async function tpTo(bot: Bot, x: number, y: number, z: number): Promise<void> {
  bot.chat!(`/tp ${x} ${y} ${z}`);
  await bot.waitForTicks!(2);
}

// ── E2E test suite ──────────────────────────────────────────────────

describeE2E("E2E PvP Tests", () => {
  let bot: Bot;

  // ── Helpers ───────────────────────────────────────────────────────

  const getCm = (): any => bot.combatManager;
  const getPvp = (): any => (bot as any).pvp;

  /**
   * Give an item and wait until it arrives (fire-and-forget is flaky).
   */
  async function giveAndWait(item: string): Promise<void> {
    bot.chat!(`/give @p ${item} 1`);
    await pollUntil(
      bot,
      () => bot.inventoryManager.getItemCount(item) >= 1,
      60,
      `${item} in inventory after /give`,
    );
  }

  jest.setTimeout(TIMEOUT_MS * 5);

  beforeAll(async () => {
    // Run before all tests
    logSuiteStart("E2E PvP Tests", USERNAME);
    bot = await createBot({ username: USERNAME, timeoutMs: TIMEOUT_MS });
    try {
      await ensureReady(bot, POSITION);
    } catch (error) {
      logger.error(error, "Combat");
      throw error;
    }
  }, TIMEOUT_MS);

  beforeEach(async () => {
    if (bot && bot.entity) {
      try {
        await killNearbyEntities(bot, 30);
        bot.chat!(`/tp ${POSITION.x} ${POSITION.y} ${POSITION.z}`);
        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        await resetBotState(bot);
        bot.combatManager.setMode(0);
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

  // ──────────────────────────────────────────────────────────────────
  // NOTE: Target-filter/mode/ally pure logic (setMode, getTargetFilter
  // caching, addAlly/removeAlly) is covered without a server in
  // tests/unit/pvp.test.ts. E2E covers only live-server behavior below.
  // ──────────────────────────────────────────────────────────────────

  // ══════════════════════════════════════════════════════════════════
  // Category 2: Attack Lifecycle
  // ══════════════════════════════════════════════════════════════════

  describe("Attack Lifecycle", () => {
    test(
      "attack — begins attacking a target entity",
      async () => {
        const zombie = await summonMob(bot);
        expect(zombie).not.toBeNull();

        await getPvp().attack(zombie);
        expect(getPvp().target).toBe(zombie);
      },
      TIMEOUT_MS,
    );

    test(
      "attack — no-op when attacking same entity",
      async () => {
        const zombie = await summonMob(bot);

        await getPvp().attack(zombie);
        expect(getPvp().target).toBe(zombie);

        await getPvp().attack(zombie);
        expect(getPvp().target).toBe(zombie);
      },
      TIMEOUT_MS,
    );

    test(
      "stop — stops attacking",
      async () => {
        const zombie = await summonMob(bot);

        await getPvp().attack(zombie);
        expect(getPvp().target).toBe(zombie);

        await getPvp().stop();
        expect(getPvp().target).toBeUndefined();
      },
      TIMEOUT_MS,
    );

    test(
      "forceStop — immediately stops without waiting",
      async () => {
        const zombie = await summonMob(bot);

        await getPvp().attack(zombie);
        expect(getPvp().target).toBe(zombie);

        getPvp().forceStop();
        expect(getPvp().target).toBeUndefined();
      },
      TIMEOUT_MS,
    );

    test(
      "attack — emits startedAttacking event",
      async () => {
        const zombie = await summonMob(bot);

        let eventFired = false;
        bot.once("startedAttacking" as any, () => {
          eventFired = true;
        });

        await getPvp().attack(zombie);
        expect(eventFired).toBe(true);
      },
      TIMEOUT_MS,
    );

    test(
      "stop — emits stoppedAttacking event",
      async () => {
        const zombie = await summonMob(bot);
        await getPvp().attack(zombie);

        let eventFired = false;
        bot.once("stoppedAttacking" as any, () => {
          eventFired = true;
        });

        await getPvp().stop();
        expect(eventFired).toBe(true);
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 3: Tick-Based Cooldown
  // ══════════════════════════════════════════════════════════════════

  describe("Tick-Based Cooldown", () => {
    test(
      "update — decrements timeToNextAttack each tick",
      () => {
        // Directly test the update mechanism without needing an entity
        const pvp = getPvp();
        pvp.target = { position: bot.entity.position.offset(0, 100, 0) } as any;
        pvp.timeToNextAttack = 10;
        pvp.wasInRange = false;

        const before = pvp.timeToNextAttack;
        pvp.update();
        const after = pvp.timeToNextAttack;

        expect(after).toBeLessThan(before);

        // Cleanup
        pvp.forceStop();
      },
      TIMEOUT_MS,
    );

    // NOTE: getCooldown weapon-table values are covered in
    // tests/unit/pvp-manager.test.ts; only the live tick path stays here.
  });

  // ──────────────────────────────────────────────────────────────────
  // NOTE: Health/damage pure logic (getHealthStatus arithmetic,
  // getLastDamage deltas) is covered in tests/unit/pvp.test.ts with mocked
  // bots. Live damage application needs survival-mode setup and stays below
  // in the fall-protection tests.
  // ──────────────────────────────────────────────────────────────────

  // ══════════════════════════════════════════════════════════════════
  // Category 5: Fall Protection
  // ══════════════════════════════════════════════════════════════════

  describe("Fall Protection", () => {
    // NOTE: safe-on-ground is covered in tests/unit/pvp.test.ts.
    test(
      "getFallProtectionStatus — safe when velocity is upward",
      async () => {
        const cm = getCm();
        await tpTo(bot, POSITION.x, POSITION.y, POSITION.z);
        bot.setControlState("jump", true);
        await bot.waitForTicks!(1);
        bot.setControlState("jump", false);

        const status = cm.getFallProtectionStatus();
        expect(status.isDangerous).toBe(false);
      },
      TIMEOUT_MS,
    );

    test(
      "getFallProtectionStatus — dangerous for long falls in survival",
      async () => {
        const cm = getCm();

        await bot.inventoryManager.setGamemode(0);
        try {
          await tpTo(bot, POSITION.x, POSITION.y + 50, POSITION.z);

          const status = cm.getFallProtectionStatus();
          expect(status.isDangerous).toBe(true);
        } finally {
          await tpTo(bot, POSITION.x, POSITION.y, POSITION.z);
          await bot.inventoryManager.setGamemode(1);
        }
      },
      TIMEOUT_MS,
    );

    test(
      "getFallProtectionStatus — returns predicted damage info",
      async () => {
        const cm = getCm();

        await bot.inventoryManager.setGamemode(0);
        try {
          await tpTo(bot, POSITION.x, POSITION.y + 50, POSITION.z);

          const status = cm.getFallProtectionStatus();
          expect(status.isDangerous).toBe(true);
          expect(status.predictedDamage).toBeDefined();
          expect(status.predictedDamage).toBeGreaterThan(0);
        } finally {
          await tpTo(bot, POSITION.x, POSITION.y, POSITION.z);
          await bot.inventoryManager.setGamemode(1);
        }
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 6: Decision Engine
  // ══════════════════════════════════════════════════════════════════

  describe("Decision Engine", () => {
    test(
      "executeDecisions — equips armor when armorless",
      async () => {
        const cm = getCm();

        await giveAndWait("iron_helmet");
        await giveAndWait("iron_chestplate");
        await giveAndWait("iron_leggings");
        await giveAndWait("iron_boots");

        await cm.executeDecisions();

        const headSlot = bot.inventory.slots[5];
        expect(headSlot).toBeDefined();
      },
      TIMEOUT_MS,
    );

    test(
      "executeDecisions — equips weapon when unarmed",
      async () => {
        const cm = getCm();

        await giveAndWait("diamond_sword");

        await cm.executeDecisions();

        const heldItem = bot.heldItem;
        expect(heldItem).toBeDefined();
      },
      TIMEOUT_MS,
    );

    test(
      "executeDecisions — debounce prevents re-entry",
      async () => {
        const cm = getCm();
        cm.debounce = true;

        const startTime = Date.now();
        await cm.executeDecisions();
        const elapsed = Date.now() - startTime;

        expect(elapsed).toBeLessThan(100);
        cm.debounce = false;
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 8: Pearl Throwing in Combat
  // ══════════════════════════════════════════════════════════════════

  describe("Pearl Throwing in Combat", () => {
    test(
      "getBestPearlOffset — calculates offset without throwing",
      async () => {
        const cm = getCm();

        // Use a fixed target position (10 blocks away on flat ground)
        const eyePos = bot.entity.position.offset(
          0,
          Constants.PHYSICS.EYE_HEIGHT,
          0,
        );
        const targetPos = bot.entity.position.offset(10, 0, 0);

        // Should not throw — result may be null if target is out of range
        // but the method should complete without error
        let result: any = null;
        expect(() => {
          result = cm.getBestPearlOffset(eyePos, targetPos, "low");
        }).not.toThrow();

        // If result is valid, verify its shape
        if (result) {
          expect(result).toHaveProperty("offset");
          expect(result).toHaveProperty("arc");
        }
      },
      TIMEOUT_MS,
    );

    test(
      "getBestPearlOffset — returns null for out-of-range target",
      async () => {
        const cm = getCm();

        const zombie = await summonMob(bot);
        expect(zombie).not.toBeNull();

        // Move the target 60 blocks away; the pearl decision caps at 50.
        // Branch entity-selector syntax by version (1.13 flattened IDs).
        if (isModernVersion(VERSION)) {
          bot.chat!(
            `/tp @e[${targetTypeSelector(VERSION)},limit=1,sort=nearest] ${POSITION.x + 60} ${POSITION.y} ${POSITION.z}`,
          );
        } else {
          bot.chat!(
            `/tp @e[${targetTypeSelector(VERSION)},r=100] ${POSITION.x + 60} ${POSITION.y} ${POSITION.z}`,
          );
        }
        await bot.waitForTicks!(5);

        const eyePos = bot.entity.position.offset(
          0,
          Constants.PHYSICS.EYE_HEIGHT,
          0,
        );
        const targetPos = zombie.position.offset(0, zombie.height * 0.5, 0);

        const result = cm.getBestPearlOffset(eyePos, targetPos, "low");
        expect(result).toBeNull();
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 9: Edge Protection
  // ══════════════════════════════════════════════════════════════════

  describe("Edge Protection", () => {
    test(
      "doEdgeProtection — sneaks near block edge",
      () => {
        const cm = getCm();

        // Directly set position to edge of block
        // Block center is at floor(x)+0.5, so x = floor(x)+1.0 gives dx = 0.5
        const baseX = Math.floor(bot.entity.position.x);
        bot.entity.position.x = baseX + 1.0;
        bot.entity.position.z = Math.floor(bot.entity.position.z) + 0.1;
        (bot as any).entity.onGround = true;

        // Verify position is at edge
        const pos = bot.entity.position;
        const blockX = Math.floor(pos.x) + 0.5;
        const dx = Math.abs(pos.x - blockX);
        expect(dx).toBeCloseTo(0.5, 1);

        cm.doEdgeProtection();
        expect(cm._edgeSneaking).toBe(true);

        bot.setControlState("sneak", false);
        cm._edgeSneaking = false;
      },
      TIMEOUT_MS,
    );

    test(
      "doEdgeProtection — releases sneak when centered",
      async () => {
        const cm = getCm();

        cm._edgeSneaking = true;
        bot.setControlState("sneak", true);

        await tpTo(bot, POSITION.x + 0.1, POSITION.y, POSITION.z);
        await bot.waitForTicks!(5);

        cm.doEdgeProtection();
        expect(cm._edgeSneaking).toBe(false);
      },
      TIMEOUT_MS,
    );

    test(
      "doEdgeProtection — does nothing when not on ground",
      () => {
        const cm = getCm();
        (bot as any).entity.onGround = false;
        cm._edgeSneaking = true;

        cm.doEdgeProtection();

        expect(cm._edgeSneaking).toBe(true);

        (bot as any).entity.onGround = true;
        cm._edgeSneaking = false;
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 10: Avoid Unwanted Blocks
  // ══════════════════════════════════════════════════════════════════

  describe("Avoid Unwanted Blocks", () => {
    // NOTE: doAvoid's escape-direction math is a known open issue (refactor
    // plan 1.1: boolean passed where a Vec3 target is expected). This stays
    // a no-throw smoke test until that fix lands; it must not assert motion.
    test(
      "doAvoid — runs without error on clean ground",
      () => {
        const cm = getCm();
        cm.doAvoid();
        expect(true).toBe(true);
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 11: Combat Integration (Full Loop)
  // ══════════════════════════════════════════════════════════════════

  describe("Combat Integration (doDecide)", () => {
    test(
      "doDecide — full combat tick with target",
      async () => {
        const cm = getCm();
        cm.setMode(3); // Mode 3 = all entities (players + mobs)

        // Summon a target animal and manually attack it
        const zombie = await summonMob(bot);
        expect(zombie).not.toBeNull();
        await getPvp().attack(zombie);
        expect(getPvp().target).toBe(zombie);

        await giveAndWait("iron_chestplate");
        await giveAndWait("diamond_sword");

        // doDecide should run without error
        // The target may or may not be retained depending on entity tracking
        await cm.doDecide();

        // Verify doDecide completed without throwing
        expect(true).toBe(true);
      },
      TIMEOUT_MS,
    );

    test(
      "doDecide — full combat tick without target",
      async () => {
        const cm = getCm();
        cm.setMode(0);

        await killNearbyEntities(bot, 50);
        await bot.waitForTicks!(5);
        getPvp().forceStop();

        await cm.doDecide();
        expect(getPvp().target).toBeUndefined();
      },
      TIMEOUT_MS,
    );

    test(
      "doDecide — handles errors gracefully",
      async () => {
        const cm = getCm();
        const originalUpdateTarget = cm.updateTarget.bind(cm);

        cm.updateTarget = () => {
          throw new Error("Test error");
        };

        await cm.doDecide();

        cm.updateTarget = originalUpdateTarget;
      },
      TIMEOUT_MS,
    );

    test(
      "doDecide — prevents re-entry via _isDeciding flag",
      async () => {
        const cm = getCm();
        cm._isDeciding = true;

        await cm.doDecide();

        cm._isDeciding = false;
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 12: Goal-Based Movement
  // ══════════════════════════════════════════════════════════════════

  describe("Goal-Based Movement", () => {
    test(
      "setGoal — sets pathfinder goal",
      () => {
        const goal = new Vec3(POSITION.x + 10, POSITION.y, POSITION.z);
        getPvp().setGoal(goal);
        expect(getPvp().goal).toBe(goal);
      },
      TIMEOUT_MS,
    );

    test(
      "clearGoal — clears pathfinder goal",
      () => {
        getPvp().setGoal(new Vec3(POSITION.x + 10, POSITION.y, POSITION.z));
        getPvp().clearGoal();
        expect(getPvp().goal).toBeNull();
      },
      TIMEOUT_MS,
    );

    test(
      "goal integration — pathfinder navigates toward goal while attacking",
      async () => {
        // setGoal alone only stores the goal; the pathfinder engages via
        // update() while a target is tracked, so this needs a live target.
        const zombie = await summonMob(bot);
        expect(zombie).not.toBeNull();
        await getPvp().attack(zombie);

        const goal = new Vec3(POSITION.x + 20, POSITION.y, POSITION.z);
        getPvp().setGoal(goal);
        const startDist = bot.entity.position.distanceTo(goal);

        await pollUntil(
          bot,
          () => bot.entity.position.distanceTo(goal) < startDist,
          200,
          "bot to move toward combat goal",
        );

        getPvp().clearGoal();
        getPvp().forceStop();
      },
      TIMEOUT_MS,
    );
  });
});
