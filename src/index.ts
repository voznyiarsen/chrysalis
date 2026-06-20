/**
 * Pupa — Minecraft bot entry point
 *
 * Multi-bot registry: supports 1-4 bots via --bot1 through --bot4 flags.
 * Each bot operates independently with its own connection, plugins, and
 * command execution, sharing a single logger/TUI instance.
 */

import "dotenv/config";
import mineflayer, { Bot } from "mineflayer";
import { pathfinder } from "mineflayer-pathfinder";
import { plugin as pvpPlugin } from "./pvp-manager";

import { logger, Logger } from "./logger";
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

const HEADLESS = process.argv.includes("--headless");

// Optional headless timeout flag: --timeout <SECONDS>
const timeoutIdx = process.argv.indexOf("--timeout");
const HEADLESS_TIMEOUT_MS: number | null =
  timeoutIdx !== -1 ? parseInt(process.argv[timeoutIdx + 1], 10) * 1000 : null;

// ── Bot configuration types ────────────────────────────────────────

interface BotDefinition {
  number: number; // 1-4
  host?: string;
  port?: number;
  username?: string;
  version?: string;
  headlessCommand?: string; // command to execute in headless mode
}

interface BotConfig {
  host: string;
  port: number;
  username: string;
  version: string | undefined;
}



// ── Parse bot definitions from argv ────────────────────────────────

/**
 * Parse --bot1 through --bot4 flags and per-bot config overrides.
 * Also supports global --host, --port, --username, --version for backward compat.
 */
function parseBotDefinitions(): BotDefinition[] {
  const bots: BotDefinition[] = [];
  const botFlags = ["bot1", "bot2", "bot3", "bot4"];

  for (const flag of botFlags) {
    const idx = process.argv.indexOf(`--${flag}`);
    if (idx === -1) continue;

    // Deduplicate: only the first occurrence counts
    const num = parseInt(flag.replace("bot", ""), 10);
    if (bots.some((b) => b.number === num)) continue;

    const def: BotDefinition = { number: num };

    // Per-bot config overrides: --bot<N>-host, --bot<N>-port, --bot<N>-username, --bot<N>-version
    const hostIdx = process.argv.indexOf(`--${flag}-host`);
    if (hostIdx !== -1 && hostIdx + 1 < process.argv.length)
      def.host = process.argv[hostIdx + 1];

    const portIdx = process.argv.indexOf(`--${flag}-port`);
    if (portIdx !== -1 && portIdx + 1 < process.argv.length)
      def.port = parseInt(process.argv[portIdx + 1], 10);

    const usernameIdx = process.argv.indexOf(`--${flag}-username`);
    if (usernameIdx !== -1 && usernameIdx + 1 < process.argv.length)
      def.username = process.argv[usernameIdx + 1];

    const versionIdx = process.argv.indexOf(`--${flag}-version`);
    if (versionIdx !== -1 && versionIdx + 1 < process.argv.length)
      def.version = process.argv[versionIdx + 1];

    // In headless mode, the command follows the --bot<N> flag (next non-flag arg)
    if (HEADLESS) {
      const cmdStart = idx + 1;
      if (cmdStart < process.argv.length) {
        const next = process.argv[cmdStart];
        // Only consume if it looks like a command (not a --flag)
        if (!next.startsWith("--")) {
          def.headlessCommand = next;
        }
      }
    }

    bots.push(def);
  }

  // If no --bot flags were specified, default to a single bot for backward compatibility
  if (bots.length === 0) {
    bots.push({
      number: 1,
      host: process.argv[2] || undefined,
      port: process.argv[3] ? parseInt(process.argv[3], 10) : undefined,
      username: process.argv[4] || undefined,
      version: process.argv[5] || undefined,
    });
  }

  return bots;
}

/**
 * Resolve the full configuration for a bot definition by merging with
 * global overrides and process.argv defaults.
 */
function resolveConfig(def: BotDefinition): BotConfig {
  // Global overrides (--host, --port, --username, --version)
  const globalHostIdx = process.argv.indexOf("--host");
  const globalPortIdx = process.argv.indexOf("--port");
  const globalUsernameIdx = process.argv.indexOf("--username");
  const globalVersionIdx = process.argv.indexOf("--version");

  const baseUsername =
    def.username ||
    (globalUsernameIdx !== -1
      ? process.argv[globalUsernameIdx + 1]
      : undefined) ||
    process.env.PUPA_NAME ||
    "Pupa";

  // Append bot number to username to prevent conflicts when multiple bots
  // connect to the same server. Single-bot mode (bot 1) gets "Pupa1".
  const username = `${baseUsername}${def.number}`;

  return {
    host:
      def.host ||
      (globalHostIdx !== -1 ? process.argv[globalHostIdx + 1] : undefined) ||
      process.env.PUPA_HOST ||
      "localhost",
    port:
      def.port ||
      (globalPortIdx !== -1
        ? parseInt(process.argv[globalPortIdx + 1], 10)
        : undefined) ||
      parseInt(process.env.PUPA_PORT || "25565", 10),
    username,
    version:
      def.version ||
      (globalVersionIdx !== -1
        ? process.argv[globalVersionIdx + 1]
        : undefined) ||
      undefined,
  };
}

// ── Bot Registry ───────────────────────────────────────────────────

/**
 * Manages multiple bot instances, their loggers, and coordinated lifecycle.
 */
class BotRegistry {
  /** Map of bot number -> bot instance */
  public bots: Map<number, Bot> = new Map();
  /** Map of bot number -> child logger */
  public loggers: Map<number, Logger> = new Map();
  /** Map of bot number -> resolved config */
  public configs: Map<number, BotConfig> = new Map();
  /** Map of bot number -> runtime config */
  public runtimeConfigs: Map<number, RuntimeConfig> = new Map();
  /** How many bots have finished executing (headless mode) */
  private _completedCount = 0;
  /** Total bots to wait for (headless mode) */
  private _totalBots = 0;

  /**
   * Resolve the config for a bot number (must have been parsed already).
   */
  getConfig(botNumber: number): BotConfig {
    const c = this.configs.get(botNumber);
    if (!c) throw new Error(`No config for bot ${botNumber}`);
    return c;
  }

  /**
   * Get a child logger for a specific bot.
   */
  getLogger(botNumber: number): Logger {
    let l = this.loggers.get(botNumber);
    if (!l) {
      l = logger.forBot(botNumber);
      this.loggers.set(botNumber, l);
    }
    return l;
  }

  /**
   * Create and start a bot instance.
   */
  async createBot(botNumber: number): Promise<Bot> {
    if (this.bots.has(botNumber)) {
      throw new Error(`Bot ${botNumber} already exists`);
    }
    if (botNumber < 1 || botNumber > 4) {
      throw new Error(`Invalid bot number ${botNumber}; must be 1-4`);
    }

    const cfg = this.getConfig(botNumber);
    const botLog = this.getLogger(botNumber);

    botLog.client(
      `Connecting to ${cfg.host}:${cfg.port} as ${cfg.username}...`,
    );

    const bot = mineflayer.createBot({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      version: cfg.version,
      logErrors: true,
      hideErrors: false,
    });

    this.bots.set(botNumber, bot);

    // Create per-bot RuntimeConfig
    const runtimeConfig = new RuntimeConfig();
    this.runtimeConfigs.set(botNumber, runtimeConfig);
    (bot as any).runtimeConfig = runtimeConfig;

    // Store the logger on the bot for plugin access
    (bot as any).__botNumber = botNumber;
    (bot as any).__logger = botLog;

    this._setupBotListeners(bot, botNumber, cfg);

    return bot;
  }

  /**
   * Set up lifecycle listeners for a single bot.
   */
  private _setupBotListeners(
    bot: Bot,
    botNumber: number,
    cfg: BotConfig,
  ): void {
    const botLog = this.getLogger(botNumber);
    const lm = this._createListenerManager();

    lm.on(bot, "login", () => {
      botLog.client("Successfully logged into account");

      // Load standard plugins
      botLog.client("Loading standard plugins...");
      try {
        bot.loadPlugin(pathfinder);
        bot.loadPlugin(pvpPlugin);
        botLog.client("  ✓ Standard plugins loaded (pathfinder, pvp)");
      } catch (e: unknown) {
        botLog.error(`  ✗ Standard plugins failed: ${(e as Error).message}`);
      }

      // Load Pupa managers
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

      if (loaded.length > 0) {
        botLog.client(`  ✓ Loaded: ${loaded.join(", ")}`);
      }
      if (failed.length > 0) {
        botLog.error(`  ✗ Failed: ${failed.map((f) => f.name).join(", ")}`);
      }

      botLog.client(
        `Pupa managers: ${loaded.length}/${managers.length} loaded`,
      );

      // Initialize DebugManager after all managers are loaded (especially CommandManager)
      if (loaded.includes("DebugManager") && (bot as any).debugManager) {
        try {
          (bot as any).debugManager.initialize();
        } catch (e: unknown) {
          botLog.error(`DebugManager initialization failed: ${(e as Error).message}`);
        }
      }

      // Update CommandManager function registry with any newly available manager functions
      if (loaded.includes("CommandManager") && (bot as any).commandManager) {
        try {
          (bot as any).commandManager._addManagerFunctions();
        } catch (e: unknown) {
          botLog.error(`CommandManager function registry update failed: ${(e as Error).message}`);
        }
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
      (bot as any).pvp.attackRange = (bot as any).runtimeConfig.get(
        "COMBAT",
        "ATTACK_RANGE",
      );
      (bot as any).pvp.followRange = (bot as any).runtimeConfig.get(
        "COMBAT",
        "FOLLOW_RANGE",
      );
      (bot as any).pvp.viewDistance = (bot as any).runtimeConfig.get(
        "COMBAT",
        "VIEW_DISTANCE",
      );

      (bot as any).listenerManager = lm;
      (bot as any).botNumber = botNumber;

      // Headless mode: execute command(s) and exit
      if (HEADLESS) {
        const def = this._getDefinition(botNumber);
        if (def && def.headlessCommand) {
          const commands = def.headlessCommand.split(";").map((c) => c.trim());
          botLog.client(`Headless mode: executing [${commands.join(", ")}]`);
          bot.once("physicsTick" as any, async () => {
            try {
              for (const cmd of commands) {
                if (!cmd) continue;
                await (bot as any).commandManager.query(cmd);
              }
            } catch (error: unknown) {
              botLog.error(
                `Headless command failed: ${(error as Error).message}`,
              );
            } finally {
              bot.end();
              this._countCompletion();
            }
          });
        } else {
          // No headless command — start bot with TUI? No, headless means headless.
          // Wait and exit
          setTimeout(() => {
            this._countCompletion();
          }, HEADLESS_TIMEOUT_MS ?? 10000);
        }
      }
    });

    lm.on(bot, "kicked", (reason: string) => {
      botLog.client(
        `Bot kicked from ${cfg.host}:${cfg.port}, reason: '${reason}'`,
      );
      if (HEADLESS) {
        this._countCompletion();
      }
    });

    lm.on(bot, "end", (reason: string) => {
      botLog.client(
        `Bot ended from ${cfg.host}:${cfg.port}, reason: '${reason}'`,
      );
      if (HEADLESS) {
        this._countCompletion();
      } else {
        botLog.client(`Attempting reconnect in 6s...`);
        if ((bot as any).listenerManager) {
          (bot as any).listenerManager.offAll(bot);
        }
        const attemptReconnect = (attempt: number = 1) => {
          const delay = Constants.TIMING.RECONNECT_DELAY * Math.min(attempt, 5);
          setTimeout(() => {
            botLog.client(`Reconnect attempt ${attempt}...`);
            this.createBot(botNumber).catch((err: unknown) => {
              botLog.error(`Reconnect failed: ${(err as Error).message}`);
              attemptReconnect(attempt + 1);
            });
          }, delay);
        };
        attemptReconnect();
      }
    });

    lm.on(bot, "error", (err: Error) => {
      err.message = `Mineflayer Error: ${err.message}`;
      botLog.error(err);
    });

    lm.on(bot, "chat", (username: string, message: string) => {
      botLog.chat(`<${username}> ${message}`);
    });

    lm.on(bot, "entityHurt" as any, async (entity: any) => {
      if (entity.type === "player" && entity.username === bot.username) {
        await bot.waitForTicks!(1);
        (bot as any).combatManager.getLastDamage();
        botLog.status(
          `Health: ${(bot as any).health.toFixed(1)}, Food: ${(bot as any).food}`,
        );
      }
    });
  }

  private _getDefinition(botNumber: number): BotDefinition | undefined {
    return this._definitions?.find((d) => d.number === botNumber);
  }

  private _definitions: BotDefinition[] | null = null;

  setDefinitions(defs: BotDefinition[]): void {
    this._definitions = defs;
  }

  /**
   * Create a listener manager for a bot.
   */
  private _createListenerManager(): ListenerManager {
    return new ListenerManager();
  }

  /**
   * Count a bot as completed for headless mode.
   * When all bots complete, exit the process.
   */
  private _countCompletion(): void {
    this._completedCount++;
    if (HEADLESS && this._completedCount >= this._totalBots) {
      setTimeout(() => process.exit(0), 500);
    }
  }

  /**
   * Set the total number of bots to wait for in headless mode.
   */
  setTotalBots(n: number): void {
    this._totalBots = n;
  }

  /**
   * Get a bot by number.
   */
  getBot(botNumber: number): Bot | undefined {
    return this.bots.get(botNumber);
  }

  /**
   * Get all active bots.
   */
  getAllBots(): [number, Bot][] {
    return Array.from(this.bots.entries());
  }

  /**
   * For TUI mode: route a command to one or all bots.
   * Supports "bot1,2 command" syntax — returns which bot numbers to send to.
   */
  parseBotPrefix(
    input: string,
  ): { botNumbers: number[]; command: string } | null {
    const match = input.match(/^bot([\d,\s]+)\s(.+)/);
    if (match) {
      const list = match[1]
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => n >= 1 && n <= 4);
      if (list.length === 0) return null;
      return { botNumbers: [...new Set(list)], command: match[2] };
    }
    return null;
  }

  /**
   * Shut down all bots gracefully.
   */
  shutdownAll(): void {
    for (const [, bot] of this.bots) {
      if ((bot as any).listenerManager) {
        (bot as any).listenerManager.offAll(bot);
      }
      bot.end();
    }
  }
}

/**
 * Manages event listeners to ensure clean state on bot reconnects
 */
class ListenerManager {
  private listeners: Map<string, Set<(...args: any[]) => void>> = new Map();

  on(emitter: any, event: string, handler: (...args: any[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    emitter.on(event, handler);
  }

  offAll(emitter: any): void {
    for (const [event, handlers] of this.listeners) {
      for (const handler of handlers) {
        emitter.off(event, handler);
      }
    }
    this.listeners.clear();
  }
}

// ── TUI initialization ─────────────────────────────────────────────

const tui = createTerminalUI();

// ── Startup ────────────────────────────────────────────────────────

const registry = new BotRegistry();

async function start(): Promise<void> {
  const botDefs = parseBotDefinitions();
  registry.setDefinitions(botDefs);

  // In headless mode, the --headless flag and its arguments were already consumed
  // The remaining args (positional) serve as fallback for the default single-bot case

  for (const def of botDefs) {
    const cfg = resolveConfig(def);
    registry.configs.set(def.number, cfg);

    try {
      await registry.createBot(def.number);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to create bot ${def.number}: ${msg}`);
      if (HEADLESS) process.exit(1);
    }
  }

  registry.setTotalBots(botDefs.length);

  // In headless mode, if no bots were created, exit
  if (HEADLESS && registry.bots.size === 0) {
    logger.error("No bots created. Exiting.");
    process.exit(1);
  }
}

// ── TUI Input Handling ─────────────────────────────────────────────

tui.onInput((text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return;

  // Parse bot prefix: "bot1,2 command" or "bot1 command"
  const parsed = registry.parseBotPrefix(trimmed);
  const allBots = registry.getAllBots();

  if (parsed) {
    // Route to specific bots only
    const botNumbers = parsed.botNumbers.filter((n) => registry.getBot(n));
    const cmd = parsed.command;

    // Execute chained commands (semicolons) on each selected bot
    const chained = cmd
      .split(";")
      .map((c) => c.trim())
      .filter(Boolean);
    for (const botNum of botNumbers) {
      const bot = registry.getBot(botNum);
      if (!bot) continue;
      const cm = (bot as any).commandManager;
      if (!cm) continue;
      for (const c of chained) {
        try {
          cm.query(c);
        } catch (error: unknown) {
          const err = error as Error;
          err.message = `Command execution on bot ${botNum} failed: ${err.message}`;
          registry.getLogger(botNum).error(err);
        }
      }
    }
  } else {
    // No bot prefix — execute on all bots
    const chained = trimmed
      .split(";")
      .map((c) => c.trim())
      .filter(Boolean);
    for (const [botNum, bot] of allBots) {
      const cm = (bot as any).commandManager;
      if (!cm) continue;
      for (const c of chained) {
        try {
          cm.query(c);
        } catch (error: unknown) {
          const err = error as Error;
          err.message = `Command execution on bot ${botNum} failed: ${err.message}`;
          registry.getLogger(botNum).error(err);
        }
      }
    }
  }
});

// ── Process-level error handling ───────────────────────────────────

process.on("uncaughtException", (err: Error, origin: string) => {
  err.message = `Uncaught Exception: ${err.message} at ${origin}`;
  logger.exception(err);
  if (HEADLESS) process.exit(1);
});

process.on(
  "unhandledRejection",
  (reason: unknown, promise: Promise<unknown>) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    err.message = `Unhandled Rejection at: ${promise}, reason: ${err.message}`;
    logger.exception(err);
  },
);

process.on("warning", (warn: Error) => {
  const msg = warn?.message || String(warn);
  if (msg.includes("physicTick")) return;
  if (msg.includes("punycode")) return;
  logger.warning(warn);
});

// Also suppress warnings via console
const originalWarn = console.warn;
// eslint-disable-next-line no-console
console.warn = (...args: any[]) => {
  const msg = args.join(" ");
  if (msg.includes("physicTick") || msg.includes("punycode")) return;
  originalWarn.apply(console, args);
};

process.on("SIGINT", () => {
  logger.client("Shutting down all bots...");
  registry.shutdownAll();
  setTimeout(() => process.exit(0), 500);
});

// ── Start ──────────────────────────────────────────────────────────

start().catch((err: Error) => {
  err.message = `Bot startup failed: ${err.message}`;
  logger.error(err);
  if (HEADLESS) process.exit(1);
});
