/**
 * Pupa — Minecraft bot entry point
 *
 * verification CHECKLIST
 * INDEX - with listener management
 * COMBAT - with decision framework
 * INVENTORY - with generic equipment helper
 * COMMANDS - with command registry
 * UI - TUI with safe initialization
 * UTILS - with caching and debouncing
 */

import "dotenv/config";
import mineflayer, { Bot } from "mineflayer";
import { pathfinder } from "mineflayer-pathfinder";
import { plugin as pvpPlugin } from "mineflayer-pvp";

import { logger } from "./logger";
import { createTerminalUI } from "./tui";
import attachInventory from "./inventory";
import attachCombat from "./pvp";
import attachCommands from "./commands";
import attachUtils from "./utils";
import attachDebug from "./debug";
import { RuntimeConfig } from "./config";
import { Constants } from "./constants";

// Suppress Node.js internal deprecation warnings
(process as any).noDeprecation = true;

// ── Argument parsing ───────────────────────────────────────────────

// Headless mode: parse --headless <COMMAND> from argv
const headlessIndex = process.argv.indexOf("--headless");
const HEADLESS = headlessIndex !== -1;
const HEADLESS_COMMAND: string | null = HEADLESS ? process.argv[headlessIndex + 1] : null;
if (HEADLESS) {
  // Remove --headless and its argument so the remaining args are host/port/name/version
  process.argv.splice(headlessIndex, 2);
}

// Optional headless timeout flag: --timeout <SECONDS>
const timeoutIndex = process.argv.indexOf("--timeout");
const HEADLESS_TIMEOUT_MS: number | null =
  timeoutIndex !== -1 ? parseInt(process.argv[timeoutIndex + 1], 10) * 1000 : null;
if (timeoutIndex !== -1) {
  process.argv.splice(timeoutIndex, 2);
}

// ── Configuration ──────────────────────────────────────────────────

const config = {
  host: process.argv[2] || process.env.PUPA_HOST,
  port: parseInt(process.argv[3] || process.env.PUPA_PORT || "25565", 10),
  username: process.argv[4] || process.env.PUPA_NAME,
  version: process.argv[5] || process.env.PUPA_VERSION || undefined,
  logErrors: true,
  hideErrors: false,
};

// ── TUI initialization ─────────────────────────────────────────────

const tui = createTerminalUI();

// ── Bot state ──────────────────────────────────────────────────────

let bot: Bot;

/**
 * Manages event listeners to ensure clean state on bot reconnects
 */
class ListenerManager {
  private listeners: Map<string, Set<(...args: any[]) => void>> = new Map();

  /**
   * Register an event listener and track it for later cleanup.
   * @param emitter - The event emitter
   * @param event - Event name
   * @param handler - Event handler function
   */
  on(emitter: any, event: string, handler: (...args: any[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    emitter.on(event, handler);
  }

  /**
   * Remove all tracked listeners from the emitter.
   * @param emitter - The event emitter
   */
  offAll(emitter: any): void {
    for (const [event, handlers] of this.listeners) {
      for (const handler of handlers) {
        emitter.off(event, handler);
      }
    }
    this.listeners.clear();
  }
}

/**
 * Create a new bot client and attach all listeners and plugins.
 */
function start_client(): void {
  bot = mineflayer.createBot(config);
  const lm = new ListenerManager();

  lm.on(bot, "login", () => {
    logger.client("Successfully logged into account");

    // Load standard plugins
    logger.client("Loading standard plugins...");
    try {
      bot.loadPlugin(pathfinder);
      bot.loadPlugin(pvpPlugin);
      logger.client("  ✓ Standard plugins loaded (pathfinder, pvp)");
    } catch (e: unknown) {
      logger.error(`  ✗ Standard plugins failed: ${(e as Error).message}`);
    }

    // Load Pupa managers
    logger.client("Loading Pupa managers...");
    const managers: { name: string; plugin: (bot: Bot) => Bot }[] = [
      { name: "InventoryManager", plugin: attachInventory },
      { name: "CombatManager", plugin: attachCombat },
      { name: "CommandManager", plugin: attachCommands },
      { name: "UtilsManager", plugin: attachUtils },
      { name: "DebugManager", plugin: attachDebug },
    ];
    const loaded: string[] = [];
    const failed: { name: string; error: string }[] = [];

    for (const mgr of managers) {
      try {
        mgr.plugin(bot);
        loaded.push(mgr.name);
      } catch (e: unknown) {
        failed.push({ name: mgr.name, error: (e as Error).message });
      }
    }

    // Batch log results
    if (loaded.length > 0) {
      logger.client(`  ✓ Loaded: ${loaded.join(", ")}`);
    }
    if (failed.length > 0) {
      logger.error(
        `  ✗ Failed: ${failed.map((f) => f.name).join(", ")}`,
      );
    }

    logger.client(
      `Pupa managers: ${loaded.length}/${managers.length} loaded`,
    );

    // Wire up TUI command manager reference for auto-complete / help
    if (tui && (bot as any).commandManager) {
      (tui as any)._commandManager = (bot as any).commandManager;
    }

    // Apply PVP movement settings
    Object.assign((bot as any).pvp.movements, {
      infiniteLiquidDropdownDistance: true,
      allowEntityDetection: true,
      allowFreeMotion: true,
      allowParkour: true,
      maxDropDown: 256,
      allow1by1towers: false,
      canOpenDoors: false,
      canDig: false,
      scafoldingBlocks: [null],
    });

    // Apply PVP movement settings using runtime config
    (bot as any).runtimeConfig = new RuntimeConfig();
    (bot as any).pvp.attackRange = (bot as any).runtimeConfig.get("COMBAT", "ATTACK_RANGE");
    (bot as any).pvp.followRange = (bot as any).runtimeConfig.get("COMBAT", "FOLLOW_RANGE");
    (bot as any).pvp.viewDistance = (bot as any).runtimeConfig.get("COMBAT", "VIEW_DISTANCE");

    (bot as any).listenerManager = lm;

    // Headless mode: execute command(s) and exit
    if (HEADLESS && HEADLESS_COMMAND && (bot as any).commandManager) {
      const commands = HEADLESS_COMMAND.split(";").map((c) => c.trim());
      logger.client(`Headless mode: executing [${commands.join(", ")}]`);
      // Wait a tick for everything to settle, then run each command in sequence
      bot.once("physicsTick" as any, async () => {
        try {
          for (const cmd of commands) {
            if (!cmd) continue;
            await (bot as any).commandManager.query(cmd);
          }
        } catch (error: unknown) {
          logger.error(`Headless command failed: ${(error as Error).message}`);
        } finally {
          // Give the last command a tick to produce output, then exit
          setTimeout(() => {
            bot.end();
            process.exit(0);
          }, HEADLESS_TIMEOUT_MS ?? 10000);
        }
      });
    }
  });

  lm.on(bot, "kicked", (reason: string) => {
    logger.client(
      `Bot kicked from ${config.host}:${config.port}, reason: '${reason}'`,
    );
    if (HEADLESS) {
      process.exit(1);
    }
  });

  lm.on(bot, "end", (reason: string) => {
    logger.client(
      `Bot ended from ${config.host}:${config.port}, reason: '${reason}'`,
    );
    if (HEADLESS) {
      process.exit(0);
    }
    logger.client(`Attempting reconnect in 6s...`);

    if ((bot as any).listenerManager) {
      (bot as any).listenerManager.offAll(bot);
    }

    setTimeout(start_client, Constants.TIMING.RECONNECT_DELAY);
  });

  lm.on(bot, "error", (err: Error) => {
    err.message = `Mineflayer Error: ${err.message}`;
    logger.error(err);
  });

  lm.on(bot, "chat", (username: string, message: string) => {
    logger.chat(`<${username}> ${message}`);
  });

  lm.on(bot, "entityHurt" as any, async (entity: any) => {
    if (entity.type === "player" && entity.username === bot.username) {
      await bot.waitForTicks!(1);
      (bot as any).combatManager.getLastDamage();
      logger.status(`Health: ${(bot as any).health.toFixed(1)}, Food: ${(bot as any).food}`);
    }
  });
}

tui.onInput((text: string) => {
  if (text.trim() && (bot as any).commandManager) {
    try {
      (bot as any).commandManager.query(text);
    } catch (error: unknown) {
      const err = error as Error;
      err.message = `Command execution failed: ${err.message}`;
      logger.error(err);
    }
  }
});

// ── Process-level error handling ───────────────────────────────────

process.on("uncaughtException", (err: Error, origin: string) => {
  err.message = `Uncaught Exception: ${err.message} at ${origin}`;
  logger.exception(err);
  // Attempt to clean up bot but don't exit, allowing potential reconnects or TUI to stay alive
  if (bot && (bot as any).listenerManager) (bot as any).listenerManager.offAll(bot);
  if (HEADLESS) process.exit(1);
});

process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  err.message = `Unhandled Rejection at: ${promise}, reason: ${err.message}`;
  logger.exception(err);
});

process.on("warning", (warn: Error) => {
  // Suppress mineflayer's physicTick deprecation warning
  const msg = warn?.message || String(warn);
  if (msg.includes("physicTick")) return;
  // Also suppress punycode deprecation from Node internals
  if (msg.includes("punycode")) return;
  logger.warning(warn);
});

// Also suppress warnings via console
// eslint-disable-next-line no-console
const originalWarn = console.warn;
// eslint-disable-next-line no-console
console.warn = (...args: any[]) => {
  const msg = args.join(" ");
  if (msg.includes("physicTick") || msg.includes("punycode")) return;
  originalWarn.apply(console, args);
};

process.on("SIGINT", () => {
  logger.client("Shutting down...");
  if (bot && (bot as any).listenerManager) (bot as any).listenerManager.offAll(bot);
  bot?.end();
  setTimeout(() => process.exit(0), 500);
});

// ── Start ──────────────────────────────────────────────────────────

(() => {
  try {
    start_client();
  } catch (error: unknown) {
    const err = error as Error;
    err.message = `Bot initialization failed: ${err.message}`;
    logger.error(err);
    if (HEADLESS) process.exit(1);
  }
})();