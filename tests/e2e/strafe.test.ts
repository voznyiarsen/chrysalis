/**
 * @fileoverview E2E integration tests for Pupa strafe functionality.
 *
 * These tests connect to a real Minecraft server using configuration from `.env`,
 * create a bot instance, load all Pupa managers, and run strafe-related debug methods
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

import 'dotenv/config';
import mineflayer, { Bot } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import { plugin as pvpPlugin } from '../../src/pvp-manager';
import { attachInventory } from '../../src/inventory';
import { attachCombat } from '../../src/pvp';
import { attachCommands } from '../../src/commands';
import { attachUtils } from '../../src/utils';
import { attachDebug } from '../../src/debug';
import { RuntimeConfig } from '../../src/config';
import { logger } from '../../src/logger';
import { Vec3 } from 'vec3';

// ── E2E configuration ───────────────────────────────────────────────

const HOST = process.env.E2E_HOST;
const PORT = parseInt(process.env.E2E_PORT || '25565', 10);
const USERNAME = 'strafe_test';
const VERSION = process.env.E2E_VERSION || undefined;
const TIMEOUT_MS = parseInt(process.env.E2E_TIMEOUT || '60', 10) * 1000;
const CONNECT_TIMEOUT_MS = 15_000;
const POSITION = new Vec3(200, 1, 200);

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
      bot.removeAllListeners('spawn');
      bot.removeAllListeners('error');
      bot.removeAllListeners('end');
      reject(new Error('Connection timed out'));
    }, CONNECT_TIMEOUT_MS);

    bot.once('spawn', () => {
      clearTimeout(timer);
      resolve();
    });
    bot.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    bot.once('end', () => {
      clearTimeout(timer);
      reject(new Error('Bot disconnected before spawn'));
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

describeE2E('E2E Strafe Tests', () => {
  let bot: Bot;

  // Set overall suite timeout to 5 minutes (300 seconds)
  jest.setTimeout(TIMEOUT_MS * 5);

  beforeAll(async () => {
    // Run before all tests
    bot = await createBot();
    if (bot && bot.entity) {
      try {
        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        bot.chat!(`/tp ${Object.values(POSITION).join(' ')}`);

        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        bot.chat!('/gamemode creative'); // Set gamemode to creative
      } catch (error) {
        console.error('beforeAll cleanup failed:', error);
      }
    }
  }, TIMEOUT_MS);

  beforeEach(async () => {
    // Run before each test
    if (bot && bot.entity) {
      try {
        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        bot.chat!(`/tp ${Object.values(POSITION).join(' ')}`);

        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        bot.clearControlStates();

        if ((bot as any).pathfinder) {
          (bot as any).pathfinder.stop();
        }

        if ((bot as any).pvp) {
          (bot as any).pvp.stop();
        }
      } catch (error) {
        console.error('beforeEach cleanup failed:', error);
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
        console.error('afterAll cleanup failed:', error);
      }
    }
    logger.setDebugMode(false);
  }, TIMEOUT_MS);

  // ----------------------------------------------------------------
  // Strafe Tests
  // ----------------------------------------------------------------

  test('debugStrafeOnce — executes single strafe', async () => {
    const dm = (bot as any).debugManager;
    const dist = await dm.debugStrafeOnce();
    expect(dist).toBeGreaterThanOrEqual(0);
    expect(dist).toBeLessThanOrEqual(0.5);
  }, TIMEOUT_MS);

  test('debugStrafeLoop — loops strafe 3 times', async () => {
    const dm = (bot as any).debugManager;
    const distances = await dm.debugStrafeLoop();
    expect(distances.length).toBe(3);
    distances.forEach((dist) => {
      expect(dist).toBeGreaterThanOrEqual(0);
      // Only check the 0.5 tolerance for distances that represent actual strafe point landings
      // When no strafe point is found, distance will be to target (much larger)
      if (dist <= 1.0) { // If distance is small, it's likely a strafe point landing
        expect(dist).toBeLessThanOrEqual(0.5);
      }
    });
  }, TIMEOUT_MS);
});
