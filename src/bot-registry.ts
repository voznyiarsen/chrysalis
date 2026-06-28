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
        botLog.error(`  ✗ Standard plugins failed: ${(e as Error).message}`, "Client");
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
        botLog.error(`  ✗ Failed: ${failed.map((f) => f.name).join(", ")}`, "Client");
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
            "Command",
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
                "Command",
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
              botLog.error(`Reconnect failed: ${(err as Error).message}`, "Client");
              attemptReconnect(attempt + 1);
            });
          }, delay);
        };
        attemptReconnect();
      }
    });

    lm.on(bot, "error", (err: Error) => {
      err.message = `Mineflayer connection error for bot ${botNumber} (${cfg.username}@${cfg.host}:${cfg.port}): ${err.message}`;
      botLog.error(err, "Client");
    });

    lm.on(bot, "chat", (username: string, message: string) => {
      botLog.chat(`<${username}> ${message}`);
    });

    // Translation keys for command success messages.
    // The message event provides raw JSON with a `translate` field that
    // identifies the message type on all protocol versions.
    // Reference: https://minecraft.wiki/w/Commands and en_US.lang
    const translateKeys = new Set([
      "commands.advancement.grant.criterion.success",
      "commands.advancement.grant.criterion.to.many.success",
      "commands.advancement.grant.criterion.to.one.success",
      "commands.advancement.grant.everything.success",
      "commands.advancement.grant.from.success",
      "commands.advancement.grant.many.to.many.success",
      "commands.advancement.grant.many.to.one.success",
      "commands.advancement.grant.one.to.many.success",
      "commands.advancement.grant.one.to.one.success",
      "commands.advancement.grant.only.success",
      "commands.advancement.grant.through.success",
      "commands.advancement.grant.until.success",
      "commands.advancement.revoke.criterion.success",
      "commands.advancement.revoke.criterion.to.many.success",
      "commands.advancement.revoke.criterion.to.one.success",
      "commands.advancement.revoke.everything.success",
      "commands.advancement.revoke.from.success",
      "commands.advancement.revoke.many.to.many.success",
      "commands.advancement.revoke.many.to.one.success",
      "commands.advancement.revoke.one.to.many.success",
      "commands.advancement.revoke.one.to.one.success",
      "commands.advancement.revoke.only.success",
      "commands.advancement.revoke.through.success",
      "commands.advancement.revoke.until.success",
      "commands.advancement.test.advancement.success",
      "commands.advancement.test.criterion.success",
      "commands.attribute.base_value.get.success",
      "commands.attribute.base_value.set.success",
      "commands.attribute.modifier.add.success",
      "commands.attribute.modifier.remove.success",
      "commands.attribute.modifier.value.get.success",
      "commands.attribute.value.get.success",
      "commands.ban.success",
      "commands.banip.success",
      "commands.banip.success.players",
      "commands.blockdata.success",
      "commands.bossbar.create.success",
      "commands.bossbar.remove.success",
      "commands.bossbar.set.color.success",
      "commands.bossbar.set.max.success",
      "commands.bossbar.set.name.success",
      "commands.bossbar.set.players.success.none",
      "commands.bossbar.set.players.success.some",
      "commands.bossbar.set.style.success",
      "commands.bossbar.set.value.success",
      "commands.bossbar.set.visible.success.hidden",
      "commands.bossbar.set.visible.success.visible",
      "commands.clear.success",
      "commands.clear.success.multiple",
      "commands.clear.success.single",
      "commands.clone.success",
      "commands.compare.success",
      "commands.damage.success",
      "commands.datapack.list.available.success",
      "commands.datapack.list.enabled.success",
      "commands.debug.function.success.multiple",
      "commands.debug.function.success.single",
      "commands.defaultgamemode.success",
      "commands.deop.success",
      "commands.difficulty.success",
      "commands.downfall.success",
      "commands.drop.success.multiple",
      "commands.drop.success.multiple_with_table",
      "commands.drop.success.single",
      "commands.drop.success.single_with_table",
      "commands.effect.clear.everything.success.multiple",
      "commands.effect.clear.everything.success.single",
      "commands.effect.clear.specific.success.multiple",
      "commands.effect.clear.specific.success.single",
      "commands.effect.give.success.multiple",
      "commands.effect.give.success.single",
      "commands.effect.success",
      "commands.effect.success.removed",
      "commands.effect.success.removed.all",
      "commands.enchant.success",
      "commands.enchant.success.multiple",
      "commands.enchant.success.single",
      "commands.entitydata.success",
      "commands.experience.add.levels.success.multiple",
      "commands.experience.add.levels.success.single",
      "commands.experience.add.points.success.multiple",
      "commands.experience.add.points.success.single",
      "commands.experience.set.levels.success.multiple",
      "commands.experience.set.levels.success.single",
      "commands.experience.set.points.success.multiple",
      "commands.experience.set.points.success.single",
      "commands.fill.success",
      "commands.fillbiome.success",
      "commands.fillbiome.success.count",
      "commands.forceload.query.success",
      "commands.function.success",
      "commands.function.success.multiple",
      "commands.function.success.multiple.result",
      "commands.function.success.single",
      "commands.function.success.single.result",
      "commands.gamemode.success.other",
      "commands.gamemode.success.self",
      "commands.gamerule.success",
      "commands.give.success",
      "commands.give.success.multiple",
      "commands.give.success.single",
      "commands.item.block.set.success",
      "commands.item.entity.set.success.multiple",
      "commands.item.entity.set.success.single",
      "commands.kick.success",
      "commands.kick.success.reason",
      "commands.kill.success.multiple",
      "commands.kill.success.single",
      "commands.kill.successful",
      "commands.locate.biome.success",
      "commands.locate.poi.success",
      "commands.locate.structure.success",
      "commands.locate.success",
      "commands.op.success",
      "commands.pardon.success",
      "commands.pardonip.success",
      "commands.particle.success",
      "commands.place.feature.success",
      "commands.place.jigsaw.success",
      "commands.place.structure.success",
      "commands.place.template.success",
      "commands.playsound.success",
      "commands.playsound.success.multiple",
      "commands.playsound.success.single",
      "commands.publish.success",
      "commands.random.reset.all.success",
      "commands.random.reset.success",
      "commands.random.sample.success",
      "commands.recipe.give.success.all",
      "commands.recipe.give.success.multiple",
      "commands.recipe.give.success.one",
      "commands.recipe.give.success.single",
      "commands.recipe.take.success.all",
      "commands.recipe.take.success.multiple",
      "commands.recipe.take.success.one",
      "commands.recipe.take.success.single",
      "commands.reload.success",
      "commands.replaceitem.success",
      "commands.ride.dismount.success",
      "commands.ride.mount.success",
      "commands.save.success",
      "commands.schedule.cleared.success",
      "commands.scoreboard.objectives.add.success",
      "commands.scoreboard.objectives.list.success",
      "commands.scoreboard.objectives.remove.success",
      "commands.scoreboard.objectives.setdisplay.successCleared",
      "commands.scoreboard.objectives.setdisplay.successSet",
      "commands.scoreboard.players.add.success.multiple",
      "commands.scoreboard.players.add.success.single",
      "commands.scoreboard.players.display.name.clear.success.multiple",
      "commands.scoreboard.players.display.name.clear.success.single",
      "commands.scoreboard.players.display.name.set.success.multiple",
      "commands.scoreboard.players.display.name.set.success.single",
      "commands.scoreboard.players.display.numberFormat.clear.success.multiple",
      "commands.scoreboard.players.display.numberFormat.clear.success.single",
      "commands.scoreboard.players.display.numberFormat.set.success.multiple",
      "commands.scoreboard.players.display.numberFormat.set.success.single",
      "commands.scoreboard.players.enable.success",
      "commands.scoreboard.players.enable.success.multiple",
      "commands.scoreboard.players.enable.success.single",
      "commands.scoreboard.players.get.success",
      "commands.scoreboard.players.list.entity.success",
      "commands.scoreboard.players.list.success",
      "commands.scoreboard.players.operation.success",
      "commands.scoreboard.players.operation.success.multiple",
      "commands.scoreboard.players.operation.success.single",
      "commands.scoreboard.players.remove.success.multiple",
      "commands.scoreboard.players.remove.success.single",
      "commands.scoreboard.players.reset.success",
      "commands.scoreboard.players.resetscore.success",
      "commands.scoreboard.players.set.success",
      "commands.scoreboard.players.set.success.multiple",
      "commands.scoreboard.players.set.success.single",
      "commands.scoreboard.players.tag.success.add",
      "commands.scoreboard.players.tag.success.remove",
      "commands.scoreboard.players.test.success",
      "commands.scoreboard.teams.add.success",
      "commands.scoreboard.teams.empty.success",
      "commands.scoreboard.teams.join.success",
      "commands.scoreboard.teams.leave.success",
      "commands.scoreboard.teams.option.success",
      "commands.scoreboard.teams.remove.success",
      "commands.seed.success",
      "commands.setblock.success",
      "commands.setidletimeout.success",
      "commands.setworldspawn.success",
      "commands.spawnpoint.success",
      "commands.spawnpoint.success.multiple",
      "commands.spawnpoint.success.single",
      "commands.spectate.success.started",
      "commands.spectate.success.stopped",
      "commands.spreadplayers.success.entities",
      "commands.spreadplayers.success.players",
      "commands.spreadplayers.success.teams",
      "commands.stats.success",
      "commands.stopsound.success.all",
      "commands.stopsound.success.individualSound",
      "commands.stopsound.success.soundSource",
      "commands.stopsound.success.source.any",
      "commands.stopsound.success.source.sound",
      "commands.stopsound.success.sourceless.any",
      "commands.stopsound.success.sourceless.sound",
      "commands.summon.success",
      "commands.tag.add.success.multiple",
      "commands.tag.add.success.single",
      "commands.tag.list.multiple.success",
      "commands.tag.list.single.success",
      "commands.tag.remove.success.multiple",
      "commands.tag.remove.success.single",
      "commands.team.add.success",
      "commands.team.empty.success",
      "commands.team.join.success.multiple",
      "commands.team.join.success.single",
      "commands.team.leave.success.multiple",
      "commands.team.leave.success.single",
      "commands.team.list.members.success",
      "commands.team.list.teams.success",
      "commands.team.option.collisionRule.success",
      "commands.team.option.color.success",
      "commands.team.option.deathMessageVisibility.success",
      "commands.team.option.name.success",
      "commands.team.option.nametagVisibility.success",
      "commands.team.option.prefix.success",
      "commands.team.option.suffix.success",
      "commands.team.remove.success",
      "commands.teleport.success.coordinates",
      "commands.teleport.success.entity.multiple",
      "commands.teleport.success.entity.single",
      "commands.teleport.success.location.multiple",
      "commands.teleport.success.location.single",
      "commands.testfor.success",
      "commands.testforblock.success",
      "commands.tick.rate.success",
      "commands.tick.sprint.stop.success",
      "commands.tick.step.stop.success",
      "commands.tick.step.success",
      "commands.title.success",
      "commands.tp.success",
      "commands.tp.success.coordinates",
      "commands.transfer.success.multiple",
      "commands.transfer.success.single",
      "commands.trigger.add.success",
      "commands.trigger.set.success",
      "commands.trigger.simple.success",
      "commands.trigger.success",
      "commands.unban.success",
      "commands.unbanip.success",
      "commands.whitelist.add.success",
      "commands.whitelist.remove.success",
      "commands.worldborder.center.success",
      "commands.worldborder.damage.amount.success",
      "commands.worldborder.damage.buffer.success",
      "commands.worldborder.get.success",
      "commands.worldborder.set.success",
      "commands.worldborder.setSlowly.grow.success",
      "commands.worldborder.setSlowly.shrink.success",
      "commands.worldborder.warning.distance.success",
      "commands.worldborder.warning.time.success",
      "commands.xp.success",
      "commands.xp.success.levels",
      "commands.xp.success.negative.levels"
    ]);

    lm.on(bot, "message", (jsonMsg: any) => {
      const translate =
        (jsonMsg as any)?.json?.translate ?? (jsonMsg as any)?.translate;
      if (translate && translateKeys.has(translate)) {
        botLog.command(`Command success: ${translate}`, "INFO", "Command");
      }
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
