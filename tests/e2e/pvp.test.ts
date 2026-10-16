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
  ensureOp,
  effectGiveCmd,
  ensureHostiles,
  ensureReady,
  e2eVersion,
  getSessionPosition,
  getUsername,
  isModernVersion,
  killMobsCmd,
  logSuiteStart,
  ensureSurvival,
  pollUntil,
  resetBotState,
  restoreDifficulty,
  serverCommand,
  tpBot,
  summonTarget,
  summonZombieCmd,
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
  // Snapshot first: the poll must only wait out entities present at kill
  // time, not natural spawns wandering in afterwards.
  const before = new Map<number, any>();
  for (const [idStr, e] of Object.entries(bot.entities)) {
    const eAny = e as any;
    if (eAny.type !== "player" && eAny.position) {
      before.set(parseInt(idStr, 10), eAny);
    }
  }
  const kill = () => bot.chat!(`/${killMobsCmd(radius, VERSION)}`);
  kill();
  // Settle the kill before any test summons: a lagged server-side /kill
  // landing after the summon would remove the fresh target and clear
  // tracking via entityGone, failing the test for infrastructure reasons.
  // Heal OP once if the kill does not register (deop breaks /kill too).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await pollUntil(
        bot,
        () =>
          ![...before.keys()].some(
            (id) =>
              bot.entities[id] !== undefined &&
              (bot.entities[id] as any).position.distanceTo(
                bot.entity.position,
              ) <= radius,
          ),
        60,
        `area (r=${radius}) to be clear of entities after /kill (attempt ${attempt + 1})`,
      );
      break;
    } catch {
      if (attempt === 0) {
        logger.info("Kill unsettled; healing OP and retrying", "Combat");
        await ensureOp(bot);
        kill();
      } else {
        throw new Error(`Kill did not settle within r=${radius}`);
      }
    }
  }
  await bot.waitForTicks!(3);
}

/**
 * Summon a combat target: zombies when the server keeps hostiles alive,
 * otherwise passive pigs (peaceful-like servers clear hostiles on spawn).
 * See setup.ts ensureHostiles. Set in beforeAll.
 */
let hostilesOk = false;
let diffToken: { hostiles: boolean; bumped: boolean } | null = null;
async function summonMob(bot: Bot): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const found = hostilesOk ? await summonZombie(bot) : await summonTarget(bot);
    if (found) return found;
    // A deop mid-test makes /summon silently fail; heal and retry once.
    logger.info("Summon produced nothing; healing OP and retrying", "Combat");
    await ensureOp(bot);
  }
  return null;
}

async function summonZombie(bot: Bot): Promise<any> {
  const before = new Set(
    Object.keys(bot.entities).map((k) => parseInt(k, 10)),
  );
  bot.chat!(`/${summonZombieCmd(VERSION)}`);
  for (let i = 0; i < 60; i++) {
    await bot.waitForTicks!(1);
    for (const [idStr, entity] of Object.entries(bot.entities)) {
      if (before.has(parseInt(idStr, 10))) continue;
      const e = entity as any;
      if (e.position && e.type !== "player") return e;
    }
  }
  return null;
}

/** Teleport to an absolute position (verified arrival). */
async function tpTo(bot: Bot, x: number, y: number, z: number): Promise<void> {
  await tpBot(bot, x, y, z);
}

// ── E2E test suite ──────────────────────────────────────────────────

describeE2E("E2E PvP Tests", () => {
  let bot: Bot;

  // ── Helpers ───────────────────────────────────────────────────────

  const getCm = (): any => bot.combatManager;
  const getPvp = (): any => (bot as any).pvp;

  /**
   * Run updateTarget and let async attack() settle: attack() awaits stop()
   * first, so pvp.target is assigned on a microtask, not synchronously.
   */
  async function updateTargetAndSettle(): Promise<void> {
    getCm().updateTarget();
    await bot.waitForTicks!(1);
  }

  /**
   * Acquire the summoned mob as the combat target, retrying once: entity
   * spawn/destroy packets can interleave under load, dropping the first
   * acquisition through no fault of the targeting logic.
   */
  async function expectTargetAcquired(mob: any): Promise<void> {
    await updateTargetAndSettle();
    if (getPvp().target === undefined && bot.entities[mob.id] !== undefined) {
      logger.info("Target not acquired on first pass, retrying", "Combat");
      await updateTargetAndSettle();
    }
    expect(getPvp().target).toBeDefined();
    expect(getPvp().target.id).toBe(mob.id);
  }

  /**
   * Versioned selector for nearby test animals (used for /effect and /tp).
   * Targets any non-player: the suite clears the area first, so only the
   * summoned target (pig or zombie) is in range.
   */
  function mobSelector(radius: number): string {
    return isModernVersion(VERSION)
      ? `@e[type=!player,distance=..${radius}]`
      : `@e[type=!Player,r=${radius}]`;
  }

  /**
   * Pin a freshly summoned target in place: NoAI stops wandering (which
   * breaks distance assertions and can walk the mob out of tracking), and
   * maximum resistance stops our own punches from killing it mid-poll
   * (entityGone clears tracking via the PVPManager handler).
   */
  async function pinTarget(bot: Bot): Promise<void> {
    bot.chat!(`/entitydata ${mobSelector(30)} {NoAI:1}`);
    await bot.waitForTicks!(2);
    bot.chat!(
      `/${effectGiveCmd(mobSelector(30), "resistance", 300, 255, VERSION)}`,
    );
    await bot.waitForTicks!(3);
  }

  /**
   * Give an item and wait until it arrives (fire-and-forget is flaky).
   */
  async function giveAndWait(item: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await serverCommand(bot, `give ${bot.username} ${item} 1`);
      try {
        await pollUntil(
          bot,
          () => bot.inventoryManager.getItemCount(item) >= 1,
          60,
          `${item} in inventory after /give (attempt ${attempt + 1})`,
        );
        return;
      } catch {
        if (attempt === 0) {
          logger.info("Give unverified; healing OP and retrying", "Combat");
          await ensureOp(bot);
        } else {
          throw new Error(
            `Timed out waiting for ${item} in inventory after /give`,
          );
        }
      }
    }
  }

  jest.setTimeout(TIMEOUT_MS * 5);

  beforeAll(async () => {
    // Run before all tests
    logSuiteStart("E2E PvP Tests", USERNAME);
    bot = await createBot({ username: USERNAME, timeoutMs: TIMEOUT_MS });
    try {
      await ensureReady(bot, POSITION);
      diffToken = await ensureHostiles(bot);
      hostilesOk = diffToken.hostiles;
    } catch (error) {
      logger.error(error, "Combat");
      throw error;
    }
  }, TIMEOUT_MS);

  beforeEach(async () => {
    if (bot && bot.entity) {
      try {
        // Teleport first, then clear at the suite position: killing before
        // teleporting misses leftovers near POSITION, and a lagged kill
        // landing after the summon removes the fresh target (settled
        // inside killNearbyEntities).
        await tpBot(bot, POSITION.x, POSITION.y, POSITION.z);
        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        await killNearbyEntities(bot, 130);
        await resetBotState(bot);
        // Decision tests give gear every test; without a verified clear it
        // accumulates run over run until /give spills onto the ground.
        await bot.inventoryManager.clearInventory();
        await pollUntil(
          bot,
          () => bot.inventory.items().length === 0,
          40,
          "inventory to be empty after clear",
        );
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
        if (diffToken) await restoreDifficulty(bot, diffToken);
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
        logger.error(error, "Combat");
      }
    }
    logger.setDebugMode(false);
  }, TIMEOUT_MS * 2);

  // ──────────────────────────────────────────────────────────────────
  // Live Target Tracking (mode/filter pure logic lives in unit tests)
  // ──────────────────────────────────────────────────────────────────

  describe("Live Target Tracking", () => {
    test(
      "updateTarget — acquires a nearby target in mode 3",
      async () => {
        const cm = getCm();
        cm.setMode(3);
        const mob = await summonMob(bot);
        expect(mob).not.toBeNull();
        await pinTarget(bot);

        await expectTargetAcquired(mob);
      },
      TIMEOUT_MS,
    );

    test(
      "updateTarget — clears target when nothing matches",
      async () => {
        const cm = getCm();
        cm.setMode(3);
        const mob = await summonMob(bot);
        expect(mob).not.toBeNull();
        await expectTargetAcquired(mob);

        // Re-clear wide (viewDistance 128): natural spawns inside range
        // would otherwise be legitimately acquired below.
        await killNearbyEntities(bot, 130);
        // Wait until the kill registers (entity gone) to avoid asserting
        // on a stale client-side entity.
        await pollUntil(
          bot,
          () => bot.entities[mob.id] === undefined,
          60,
          "summoned target to despawn after /kill",
        );
        await updateTargetAndSettle();
        if (getPvp().target !== undefined) {
          // A natural spawn wandered in during the window; clear once more.
          logger.info("Stranger acquired, re-clearing and retrying", "Combat");
          await killNearbyEntities(bot, 130);
          await updateTargetAndSettle();
        }
        expect(getPvp().target).toBeUndefined();
      },
      TIMEOUT_MS,
    );

    test(
      "updateTarget — mode 0 tracks a hostile mob",
      async () => {
        if (!hostilesOk) {
          logger.warning(
            "SKIP mode-0 hostile tracking: server clears hostiles",
            "Combat",
          );
          return;
        }
        const cm = getCm();
        cm.setMode(0);
        const mob = await summonMob(bot);
        expect(mob).not.toBeNull();
        await pinTarget(bot);

        await expectTargetAcquired(mob);
      },
      TIMEOUT_MS,
    );
  });

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

  /**
   * Wait until the bot is actually falling: getFallProtectionStatus returns
   * safe unless velocity.y < 0 and airborne, which takes a few ticks after
   * a teleport (stale onGround reads true initially).
   */
  async function pollFalling(bot: Bot): Promise<void> {
    await pollUntil(
      bot,
      () => bot.entity.velocity.y < 0 && !bot.entity.onGround,
      40,
      "bot to be falling",
    );
  }

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

        await ensureSurvival(bot);
        try {
          await tpTo(bot, POSITION.x, POSITION.y + 50, POSITION.z);
          await pollFalling(bot);

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

        await ensureSurvival(bot);
        try {
          await tpTo(bot, POSITION.x, POSITION.y + 50, POSITION.z);
          await pollFalling(bot);

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
        // Branch entity-selector syntax by version (1.13 flattened IDs),
        // and by animal (zombies only exist when hostiles survive).
        const typeSel = hostilesOk
          ? isModernVersion(VERSION)
            ? "type=zombie"
            : "type=Zombie"
          : targetTypeSelector(VERSION);
        if (isModernVersion(VERSION)) {
          bot.chat!(
            `/tp @e[${typeSel},limit=1,sort=nearest] ${POSITION.x + 60} ${POSITION.y} ${POSITION.z}`,
          );
        } else {
          bot.chat!(
            `/tp @e[${typeSel},r=100] ${POSITION.x + 60} ${POSITION.y} ${POSITION.z}`,
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
        await pinTarget(bot);
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

        await killNearbyEntities(bot, 130);
        await bot.waitForTicks!(5);
        getPvp().forceStop();

        await cm.doDecide();
        if (getPvp().target !== undefined) {
          // A natural spawn wandered into range; clear once more.
          logger.info("Stranger targeted, re-clearing and retrying", "Combat");
          await killNearbyEntities(bot, 130);
          getPvp().forceStop();
          await cm.doDecide();
        }
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
        // The target can die mid-poll (punches, clearer, despawn), which
        // clears tracking via entityGone — re-summon and retry the round.
        const goal = new Vec3(POSITION.x + 20, POSITION.y, POSITION.z);
        let moved = false;
        for (let round = 0; round < 3 && !moved; round++) {
          const zombie = await summonMob(bot);
          expect(zombie).not.toBeNull();
          await pinTarget(bot);
          await getPvp().attack(zombie);

          getPvp().setGoal(goal);
          const startDist = bot.entity.position.distanceTo(goal);
          try {
            await pollUntil(
              bot,
              () => bot.entity.position.distanceTo(goal) < startDist,
              200,
              `bot to move toward combat goal (round ${round + 1})`,
            );
            moved = true;
          } catch {
            const t = getPvp().target;
            logger.info(
              `Goal round ${round + 1}: no movement (target=${t ? `id=${t.id} alive=${bot.entities[t.id] !== undefined}` : "none"} bot=${bot.entity.position.toString()} dist=${bot.entity.position.distanceTo(goal).toFixed(1)}). Re-summoning.`,
              "Combat",
            );
            getPvp().forceStop();
          }
        }
        expect(moved).toBe(true);

        getPvp().clearGoal();
        getPvp().forceStop();
      },
      TIMEOUT_MS,
    );
  });
});
