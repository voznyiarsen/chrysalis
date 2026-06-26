/**
 * @fileoverview Multi-bot registry for managing bot instances, their loggers,
 * configs, and coordinated lifecycle. Supports 1-4 concurrent bot connections.
 */

import mineflayer, { Bot } from "mineflayer";
import { pathfinder } from "mineflayer-pathfinder";
import { PVPManager } from "./pvp";
import { logger, Logger } from "./logger";
import { attachInventory } from "./inventory";
import { attachCombat } from "./pvp";
import { attachCommands } from "./commands";
import { attachUtils } from "./utils";
import { RuntimeConfig } from "./config";
import { Constants } from "./constants";
import { ListenerManager } from "./listener-manager";

const HEADLESS = process.argv.includes("--headless");

const timeoutIdx = process.argv.indexOf("--timeout");
const HEADLESS_TIMEOUT_MS: number | null =
  timeoutIdx !== -1 ? parseInt(process.argv[timeoutIdx + 1], 10) * 1000 : null;

export interface BotDefinition {
  number: number;
  host?: string;
  port?: number;
  username?: string;
  version?: string;
  headlessCommand?: string;
}

export interface BotConfig {
  host: string;
  port: number;
  username: string;
  version: string | undefined;
}

/** Manages multiple bot instances, their loggers, and coordinated lifecycle. */
export class BotRegistry {
  bots: Map<number, Bot> = new Map();
  loggers: Map<number, Logger> = new Map();
  configs: Map<number, BotConfig> = new Map();
  runtimeConfigs: Map<number, RuntimeConfig> = new Map();
  private _completedCount = 0;
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
    bot.runtimeConfig = runtimeConfig;

    // Store the logger on the bot for plugin access
    bot.__botNumber = botNumber;
    bot.__logger = botLog;

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
    const lm = new ListenerManager();

    lm.on(bot, "login", () => {
      botLog.client("Successfully logged into account");

      // Load standard plugins
      botLog.client("Loading standard plugins...");
      try {
        bot.loadPlugin(pathfinder);
        bot.pvp = new PVPManager(bot);
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

      // Update CommandManager function registry with any newly available manager functions
      if (loaded.includes("CommandManager") && bot.commandManager) {
        try {
          (bot.commandManager as any)._addManagerFunctions();
        } catch (e: unknown) {
          botLog.error(
            `CommandManager function registry update failed: ${(e as Error).message}`,
          );
        }
      }

      // Apply PVP movement settings
      Object.assign(bot.pvp.movements, {
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
      bot.runtimeConfig = new RuntimeConfig();
      bot.pvp.attackRange = bot.runtimeConfig.get("COMBAT", "ATTACK_RANGE");
      bot.pvp.followRange = bot.runtimeConfig.get("COMBAT", "FOLLOW_RANGE");
      bot.pvp.viewDistance = bot.runtimeConfig.get("COMBAT", "VIEW_DISTANCE");

      bot.listenerManager = lm;
      bot.botNumber = botNumber;

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
                await bot.commandManager.query(cmd);
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
        botLog.client("Attempting reconnect in 6s...");
        if (bot.listenerManager) {
          bot.listenerManager.offAll(bot);
        }
        const attemptReconnect = (attempt: number = 1) => {
          const delay = Constants.TIMING.RECONNECT_MS * Math.min(attempt, 5);
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
      err.message = `Mineflayer connection error for bot ${botNumber} (${cfg.username}@${cfg.host}:${cfg.port}): ${err.message}`;
      botLog.error(err);
    });

    lm.on(bot, "chat", (username: string, message: string) => {
      botLog.chat(`<${username}> ${message}`);
    });

    lm.on(bot, "entityHurt" as any, async (entity: any) => {
      if (entity.type === "player" && entity.username === bot.username) {
        await bot.waitForTicks!(1);
        bot.combatManager.getLastDamage();
        botLog.status(`Health: ${bot.health.toFixed(1)}, Food: ${bot.food}`);
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
      if (bot.listenerManager) {
        bot.listenerManager.offAll(bot);
      }
      bot.end();
    }
  }
}
