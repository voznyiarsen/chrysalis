/**
 * @fileoverview Unit tests for the PVPManager target lifecycle.
 *
 * These cover the async edges of target acquisition and release: the
 * pathfinder stop handshake and the "latest call wins" rule when two
 * target switches overlap.
 */

import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import { PVPManager } from "../../src/pvp";
import { StrafeController } from "../../src/strafe";

/**
 * Minimal bot double: the pathfinder emits 'path_stop' inline, exactly
 * like mineflayer-pathfinder does.
 */
function makeBot(): any {
  const bot: any = new EventEmitter();
  bot.entity = {
    position: new Vec3(0, 64, 0),
    velocity: new Vec3(0, 0, 0),
    onGround: true,
    height: 1.8,
    eyeHeight: 1.62,
    effects: {},
    metadata: [],
  };
  bot.inventory = { slots: [], items: () => [] };
  bot.getEquipmentDestSlot = () => 45;
  bot.pathfinder = {
    stop: () => bot.emit("path_stop"),
    setGoal: () => undefined,
    setMovements: () => undefined,
    goal: null,
    movements: null,
  };
  bot.combatManager = { isFeatureEnabled: () => true };
  bot.inventoryManager = { releaseShieldBreaker: () => undefined };
  return bot;
}

/** A PVPManager with just the state stop()/attack() touch. */
function makeManager(bot: any): PVPManager {
  const pvp = Object.create(PVPManager.prototype) as PVPManager;
  const internals = pvp as unknown as Record<string, unknown>;
  internals.bot = bot;
  internals.target = undefined;
  internals.goal = null;
  internals._pfGoalKey = null;
  internals._explosionTimeout = null;
  internals._shieldRearmTicks = 0;
  internals._shieldBreakWaitTicks = 0;
  internals._strafeEngaged = false;
  internals.strafeController = new StrafeController();
  internals.hurtTimers = new Map();
  internals.timeToNextAttack = 0;
  internals.followRange = 3;
  internals.attackRange = 3.5;
  internals.viewDistance = 32;
  // Class field initializers do not run for Object.create(), so the
  // fields the lifecycle touches are set up by hand.
  internals._attackSeq = 0;
  return pvp;
}

describe("PVPManager target lifecycle", () => {
  test("stop() resolves as soon as the pathfinder stops", async () => {
    // mineflayer-pathfinder's stop() emits 'path_stop' synchronously. A
    // listener registered after the call never fires, so waiting for the
    // event after the call always ran into the 5s timeout: every target
    // switch stalled for five seconds.
    const bot = makeBot();
    const pvp = makeManager(bot);
    (pvp as any).target = { position: new Vec3(0, 64, 0) };

    const started = Date.now();
    await pvp.stop();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1000);
    expect((pvp as any).target).toBeUndefined();
  });

  test("stop() leaves other 'path_stop' listeners alone", async () => {
    const bot = makeBot();
    const pvp = makeManager(bot);
    (pvp as any).target = { position: new Vec3(0, 64, 0) };

    let otherSaw = 0;
    bot.on("path_stop", () => {
      otherSaw++;
    });

    await pvp.stop();

    expect(otherSaw).toBe(1);
  });

  test("the newest attack() wins when two target switches overlap", async () => {
    // attack() awaits stop(), so a second call can resolve first and be
    // overwritten by the older one when it finally resumes.
    const bot = makeBot();
    const pvp = makeManager(bot);

    const old = { position: new Vec3(0, 64, 0), isValid: true } as any;
    const first = { position: new Vec3(1, 64, 0), isValid: true } as any;
    const second = { position: new Vec3(2, 64, 0), isValid: true } as any;
    (pvp as any).target = old;

    const a = pvp.attack(first);
    const b = pvp.attack(second);
    await Promise.all([a, b]);

    expect((pvp as any).target).toBe(second);
  });

  test("a swing is skipped while the main hand is in use", async () => {
    // The combat tree runs right after this manager in the same tick, so a
    // pearl throw can start between the attack dispatch and the
    // microtask that sends it. The swing must not go out with the pearl
    // in hand, and the target must not be marked hurt for a swing that
    // never happened.
    const bot = makeBot();
    const target = {
      position: new Vec3(2, 64, 0),
      isValid: true,
      username: "enemy",
      height: 1.8,
    } as any;
    let attacked = 0;
    bot.lookAt = () => undefined;
    bot.attack = () => {
      attacked++;
    };
    bot.blockAt = () => null;
    bot.version = "1.12.2";
    // The dispatch-time gate sees no item use; the microtask (which runs
    // after the combat tree had its turn in the same tick) does.
    let useChecks = 0;
    bot.inventoryManager = {
      isMainHandUseActive: () => {
        useChecks++;
        return useChecks > 1;
      },
      isItemUseActive: () => false,
      releaseShieldBreaker: () => undefined,
    };
    const pvp = makeManager(bot);
    (pvp as any).target = target;
    (pvp as any).wasInRange = true;

    (pvp as any).attemptAttack();
    await Promise.resolve();
    await Promise.resolve();

    expect(attacked).toBe(0);
    // The target was never hit, so it must not be in the immunity window.
    expect(pvp.getHurtTicks(target)).toBe(0);
    // The swing is retried as soon as the throw is done.
    expect((pvp as any).timeToNextAttack).toBe(1);
  });

  test("a swing that goes out marks the target hurt", async () => {
    const bot = makeBot();
    const target = {
      position: new Vec3(2, 64, 0),
      isValid: true,
      username: "enemy",
      height: 1.8,
    } as any;
    let attacked = 0;
    bot.lookAt = () => undefined;
    bot.attack = () => {
      attacked++;
    };
    bot.blockAt = () => null;
    bot.version = "1.12.2";
    bot.inventoryManager = {
      isMainHandUseActive: () => false,
      isItemUseActive: () => false,
      releaseShieldBreaker: () => undefined,
    };
    const pvp = makeManager(bot);
    (pvp as any).target = target;
    (pvp as any).wasInRange = true;

    (pvp as any).attemptAttack();
    await Promise.resolve();
    await Promise.resolve();

    expect(attacked).toBe(1);
    expect(pvp.getHurtTicks(target)).toBeGreaterThan(0);
  });
});
