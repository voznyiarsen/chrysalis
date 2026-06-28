/**
 * @fileoverview Command handler module for Pupa bot.
 * Processes and executes user commands via a hierarchical command tree.
 */

import util from "node:util";
import { Logger, logger } from "./logger";
import { tokenize, resolve, getHelp, CommandNode } from "./cli-engine";
import type { Bot, EquipmentDestination } from "mineflayer";

/**
 * Manages the command tree and execution flow
 */
export class CommandManager {
  bot: Bot;
  logger: Logger;
  autosend = false;
  tree: Record<string, CommandNode> = {};
  variables: Record<string, unknown> = {};

  private _runRunning = false;
  private _runCounter = 0;
  private _runTotal = 0;
  private _runCmd = "";

  constructor(bot: Bot) {
    this.bot = bot;
    this.logger = bot.__logger;
    this.setupCommandTree();
    this.initializeFunctionRegistry();
  }

  /**
   * Build the hierarchical command tree.
   */
  setupCommandTree(): void {
    this.tree = {
      as: {
        description: "Toggle autosend mode (unmatched commands sent as chat)",
        handler: () => {
          this.autosend = !this.autosend;
          this.logger.command(
            `Autosending ${this.autosend ? "enabled" : "disabled"}`,
          );
        },
      },
      ts: {
        description: "Toss a single item or stack",
        subcommands: {
          "<item>": {
            description: "Item name or numeric ID",
            positional: true,
            subcommands: {
              "<count>": {
                description: "Number of items to toss (default: 1)",
                positional: true,
                handler: async (args: string[]) => {
                  await this.tossSingle(args);
                },
              },
            },
            handler: async (args: string[]) => {
              await this.tossSingle(args);
            },
          },
        },
      },
      tsall: {
        description: "Toss all items from inventory",
        handler: async () => {
          await this.tossAll();
        },
      },
      eq: {
        description: "Equip an item to a slot",
        subcommands: {
          "<item>": {
            description: "Item name or numeric ID",
            positional: true,
            subcommands: {
              "<slot>": {
                description:
                  "Destination slot (hand, off-hand, head, torso, legs, feet)",
                positional: true,
                handler: async (args: string[]) => {
                  await this.equip(args);
                },
              },
            },
          },
        },
      },
      uneq: {
        description: "Unequip an item from a slot",
        subcommands: {
          "<slot>": {
            description:
              "Slot to unequip from (head, torso, legs, feet, off-hand)",
            positional: true,
            handler: async (args: string[]) => {
              await this.unequip(args);
            },
          },
        },
      },
      uneqall: {
        description: "Unequip all items",
        handler: async () => {
          await this.unequipAll();
        },
      },
      rec: {
        description: "Record inventory to a JSON file",
        subcommands: {
          "<slot>": {
            description: "Recording slot index (default: 0)",
            positional: true,
            handler: async (args: string[]) => {
              await this.record(args);
            },
          },
        },
        handler: async () => {
          await this.record(["rec", "0"]);
        },
      },
      res: {
        description: "Restore inventory from a recorded JSON file",
        subcommands: {
          "<slot>": {
            description: "Recording slot index (default: 0)",
            positional: true,
            handler: async (args: string[]) => {
              await this.restore(args);
            },
          },
        },
        handler: async () => {
          await this.restore(["res", "0"]);
        },
      },
      clear: {
        description: "Clear inventory via creative mode",
        handler: async () => {
          // mineflayer plugin property access
          await (this.bot as any).inventoryManager.clearInventory();
        },
      },
      v: {
        description: "Show bot's Minecraft version",
        handler: () => this.showVersion(),
      },
      pos: {
        description: "Show bot's current position",
        handler: () => this.showPosition(),
      },
      com: {
        description: "Toggle combat mode on/off",
        handler: () => this.toggleCombat(),
      },
      cm: {
        description:
          "Change combat mode (0=Mobs, 1=Players Survival, 2=Players All, 3=All Entities)",
        subcommands: {
          "<mode>": {
            description: "Mode number 0-3",
            positional: true,
            handler: (args: string[]) => this.changeMode(args),
          },
        },
        handler: () => this.changeMode(["cm"]),
      },
      s: {
        description: "Pacify bot — stop combat and any active run loop",
        handler: () => this.pacify(),
      },
      q: {
        description: "Quit the bot",
        handler: () => this.quit(),
      },
      blockat: {
        description: "Get the block at the bot's current position",
        handler: () => {
          const block = this.bot.world.getBlock(this.bot.entity.position);
          if (block) {
            this.logger.status(`Block at current position: ${block.name} (id: ${block.type})`);
          } else {
            this.logger.status("No block at current position");
          }
        },
      },
      cfg: {
        description: "View or edit runtime configuration",
        subcommands: {
          "<path>": {
            description: "Config path (e.g., COMBAT.ATTACK_RANGE)",
            positional: true,
            subcommands: {
              "<value>": {
                description: "New value to set",
                positional: true,
                handler: (args: string[]) => this.configCommand(args),
              },
            },
            handler: (args: string[]) => this.configCommand(args),
          },
        },
        handler: (args: string[]) => this.configCommand(args),
      },
      run: {
        description:
          "Run a command N times with M ticks between each (run <cmd> <N> <M>)",
        subcommands: {
          "<cmd>": {
            description: "Command string to execute",
            positional: true,
            subcommands: {
              "<N>": {
                description: "Number of iterations",
                positional: true,
                subcommands: {
                  "<M>": {
                    description: "Ticks between iterations",
                    positional: true,
                    handler: async (args: string[]) => {
                      await this.run(args);
                    },
                  },
                },
              },
            },
          },
        },
      },
      dud: {
        description: "Dud command for headless mode testing",
        handler: () => {
          this.logger.command("Dud command ran successfully");
        },
      },
      debug: {
        description: "Toggle DEBUG level logging on/off",
        handler: () => {
          const newState = !this.logger.isDebugMode;
          this.logger.setDebugMode(newState);
          this.logger.command(
            `Debug logging ${newState ? "enabled" : "disabled"}`,
          );
        },
      },
      msglog: {
        description:
          "Toggle server message event logging on/off (raw chat/system/command packets)",
        handler: () => {
          const enabled = this.logger.toggleMessageLog();
          this.logger.command(
            `Message logging ${enabled ? "enabled" : "disabled"}`,
          );
        },
      },
      vel: {
        description: "Show bot's current velocity",
        handler: () => {
          this.logger.command(
            `Velocity: ${this.bot.entity!.velocity.toString()}`,
          );
        },
      },
      pause: {
        description: "Pause the bot for N ticks",
        subcommands: {
          "<ticks>": {
            description: "Number of ticks to pause",
            positional: true,
            handler: async (args: string[]) => {
              await this.pause(args);
            },
          },
        },
      },
      jump: {
        description: "Jump toward an offset position and return distance remaining",
        subcommands: {
          "<xoffset>": {
            description: "X offset from current position",
            positional: true,
            subcommands: {
              "<yoffset>": {
                description: "Y offset from current position",
                positional: true,
                subcommands: {
                  "<zoffset>": {
                    description: "Z offset from current position",
                    positional: true,
                    handler: async (args: string[]) => {
                      await this.jump(args);
                    },
                  },
                },
              },
            },
          },
        },
      },
      query_player_db: {
        description: "Query player database by username",
        subcommands: {
          "<username>": {
            description: "Player username",
            positional: true,
            handler: (args: string[]) => this.queryPlayerDB(args),
          },
        },
      },
      query_slot_db: {
        description: "Query inventory slot info by slot number",
        subcommands: {
          "<slot>": {
            description: "Slot number",
            positional: true,
            handler: (args: string[]) => this.querySlotDB(args),
          },
        },
      },
      func: {
        description:
          "Call a function directly by name or list available functions",
        subcommands: {
          "<functionName>": {
            description: "Function name to call",
            positional: true,
            handler: async (args: string[]) => {
              await this.callFunction(args);
            },
          },
        },
        handler: async () => {
          await this.listFunctions();
        },
      },
    };
  }

  /**
   * Evaluate ${...} placeholders in a string against variables and bot state.
   */
  evaluatePlaceholders(str: string): string {
    return str.replace(/\$\{([^}]+)\}/g, (match: string, expr: string) => {
      const trimmed = expr.trim();

      // Check variables first
      if (this.variables[trimmed] !== undefined) {
        return String(this.variables[trimmed]);
      }

      // Check bot state accessors
      const botGetters: Record<string, () => unknown> = {
        x: () => this.bot?.entity?.position?.x,
        y: () => this.bot?.entity?.position?.y,
        z: () => this.bot?.entity?.position?.z,
        health: () => this.bot?.health,
        food: () => this.bot?.food,
        yaw: () => this.bot?.entity?.yaw,
        pitch: () => this.bot?.entity?.pitch,
        version: () => this.bot?.version,
        // mineflayer plugin property access
        target: () => (this.bot as any)?.pvp?.target?.username,
      };

      if (botGetters[trimmed] !== undefined) {
        const val = botGetters[trimmed]();
        return val !== undefined ? String(val) : match;
      }

      return match; // leave as-is if unresolvable
    });
  }

  /**
   * Process and execute a command query from user input.
   * Supports ${variable} substitution.
   */
  async query(data: string): Promise<void> {
    // Variable substitution
    const resolved = this.evaluatePlaceholders(data);

    const { tokens } = tokenize(resolved);
    if (tokens.length === 0) return;

    const result = resolve(this.tree, tokens);

    // Check if we found a handler at the resolved node
    if (result.node && result.node.handler) {
      try {
        // Pass all tokens as args[0..n] and the raw string
        await result.node.handler(tokens, resolved);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Error executing command '${resolved}': ${msg}`, "Command");
      }
      return;
    }

    // If we partially matched but no handler, show available subcommands as help
    if (result.node && result.matched.length > 0) {
      const subTree =
        result.node.subcommands ?? ({} as Record<string, CommandNode>);
      const helpStr = getHelp(subTree, result.matched);
      this.logger.command(`Incomplete command. Available:\n${helpStr}`);
      return;
    }

    // No command matched at all
    const status = this.autosend
      ? "sending as message..."
      : "not sending as a message";
    this.logger.command(`Command ${data} not found, ${status}`);
    if (this.autosend) this.bot.chat(data);
  }

  /**
   * Register a subtree of commands (used by debug.js and other plugins).
   */
  registerCommand(name: string, node: CommandNode): void {
    this.tree[name] = node;
  }

  /**
   * Toggle autosend mode (sends unmatched commands as chat messages).
   */
  toggleAutosend(): void {
    this.autosend = !this.autosend;
    this.logger.command(
      `Autosending ${this.autosend ? "enabled" : "disabled"}`,
    );
  }

  /**
   * Toss a single item or stack.
   * args[1] is the item name/ID, args[2] is the count
   */
  async tossSingle(args: string[]): Promise<void> {
    const item =
      (this.bot.registry as any).items[parseInt(args[1])] ||
      (this.bot.registry as any).itemsByName[args[1]];
    if (!item) {
      this.logger.error(new Error(`Item '${args[1]}' not found`), "Inventory");
      return;
    }
    const count = args.length >= 3 ? parseInt(args[2]) : 1;

    try {
      await this.bot.toss(item.id, null, count);
      this.logger.inventory(`Tossed ${item.displayName} x${count}`);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      err.message = `Failed to toss ${item.displayName}: ${err.message}`;
      this.logger.error(err, "Inventory");
    }
  }

  /**
   * Toss all items from inventory.
   */
  async tossAll(): Promise<void> {
    const count = this.bot.inventory.slots.filter(Boolean).length;
    try {
      // mineflayer plugin property access
      await (this.bot as any).inventoryManager.tossAllItems();
      this.logger.inventory(
        `Tossed ${count} ${count === 1 ? "item" : "items"}`,
      );
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      err.message = `Failed to toss all items: ${err.message}`;
      this.logger.error(err, "Inventory");
    }
  }

  /**
   * Equip an item to a specific slot.
   * args[1] is the item name/ID, args[2] is the destination
   */
  async equip(args: string[]): Promise<void> {
    const item =
      (this.bot.registry as any).items[parseInt(args[1])] ||
      (this.bot.registry as any).itemsByName[args[1]];
    const destination = args[2];
    if (!item) {
      this.logger.error(new Error(`Item '${args[1]}' not found`), "Inventory");
      return;
    }

    try {
      await this.bot.equip(
        parseInt(item.id),
        destination as EquipmentDestination,
      );
      this.logger.inventory(`Equipped ${item.displayName} to ${destination}`);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      err.message = `Failed to equip ${item.displayName} to ${destination}: ${err.message}`;
      this.logger.error(err, "Inventory");
    }
  }

  /**
   * Unequip an item from a specific slot.
   * args[1] is the destination slot
   */
  async unequip(args: string[]): Promise<void> {
    const destination = args[1];
    const slot = this.bot.getEquipmentDestSlot(destination);
    const item = this.bot.inventory.slots[slot];

    try {
      await this.bot.unequip(destination as EquipmentDestination);
      this.logger.inventory(
        `Unequipped ${item?.displayName} from ${destination}`,
      );
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      err.message = `Failed to unequip from ${destination}: ${err.message}`;
      this.logger.error(err, "Inventory");
    }
  }

  /**
   * Unequip all items.
   */
  async unequipAll(): Promise<void> {
    const count = this.bot.entity.equipment.filter(Boolean).length;
    try {
      // mineflayer plugin property access
      await (this.bot as any).inventoryManager.unequipAllItems();
      this.logger.inventory(`Unequipped ${count} items`);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      err.message = `Failed to unequip all items: ${err.message}`;
      this.logger.error(err, "Inventory");
    }
  }

  /**
   * Show bot's Minecraft version.
   */
  showVersion(): void {
    this.logger.status(`Minecraft version: ${this.bot.version}`);
  }

  /**
   * Show bot's position.
   */
  showPosition(): void {
    this.logger.status(`Position: ${this.bot.entity.position.toString()}`);
  }

  /**
   * Restore inventory from a saved JSON file.
   * args[1] is the slot index
   */
  async restore(args: string[]): Promise<void> {
    const slot = args[1] || 0;
    // mineflayer plugin property access
    await (this.bot as any).inventoryManager.restoreInventory(slot);
  }

  /**
   * Record current inventory to a JSON file.
   * args[1] is the slot index
   */
  async record(args: string[]): Promise<void> {
    const slot = args[1] || 0;
    // mineflayer plugin property access
    await (this.bot as any).inventoryManager.recordInventory(slot);
  }

  /**
   * Toggle combat mode on/off.
   */
  toggleCombat(): void {
    // mineflayer plugin property access
    const listener = (this.bot as any).combatManager.doDecide;
    if ((this.bot as any).listenerCount("physicsTick", listener) > 0) {
      this.logger.combat("Combat disabled");
      (this.bot as any).off("physicsTick", listener);
      // mineflayer plugin property access
      (this.bot as any).pvp.stop();
    } else {
      this.logger.combat("Combat enabled");
      // mineflayer plugin property access
      (this.bot as any).on("physicsTick", listener);
    }
  }

  /**
   * Change combat mode.
   * args[1] is the mode number
   */
  changeMode(args: string[]): void {
    // mineflayer plugin property access
    const cm = (this.bot as any).combatManager;
    cm.setMode(parseInt(args[1] ?? cm.mode, 10));
    this.logger.combat(`Mode changed to ${cm.mode}`);
  }

  /**
   * Pacify the bot — stops combat and any active run loop.
   */
  pacify(): void {
    this.logger.combat("Pacifying bot...");
    // mineflayer plugin property access
    (this.bot as any).combatManager.setMode(4);
    this._stopRun();
  }

  /**
   * Query player database by username.
   * @param args - Command arguments, args[1] is the username
   */
  queryPlayerDB(args: string[]): void {
    const username = args[1];
    // mineflayer plugin property access
    const player = (this.bot as any).players[username];
    if (!player) {
      this.logger.error(new Error(`Player '${username}' not found`), "Command");
      return;
    }
    this.logger.debug(`Player Debug: '${player.username}'`, "Debug");
    this.logger.debug(
      util.inspect(player, { depth: 1, colors: true }),
      "Debug",
    );
  }

  /**
   * Query slot database by slot number.
   * @param args - Command arguments, args[1] is the slot number
   */
  querySlotDB(args: string[]): void {
    const slotNumber = parseInt(args[1], 10);
    const item = this.bot.inventory!.slots![slotNumber];
    if (!item) {
      this.logger.error(new Error(`Item in slot ${slotNumber} not found`), "Inventory");
      return;
    }
    this.logger.debug(
      `Slot Debug: '${(item as any).displayName}' (slot ${slotNumber})`,
      "Debug",
    );
    this.logger.debug(util.inspect(item, { depth: 1, colors: true }), "Debug");
  }

  /**
   * Quit the bot.
   */
  quit(): void {
    this.bot.end();
    process.exit(0);
  }

  /**
   * View or edit runtime configuration values.
   */
  configCommand(args: string[]): void {
    // mineflayer plugin property access
    const rc = (this.bot as any).runtimeConfig;
    if (!rc) {
      this.logger.error(new Error("Runtime config not available"), "Config");
      return;
    }

    if (args.length === 1) {
      const overrides: Record<string, unknown> = rc.getAllOverrides();
      const keys = Object.keys(overrides);
      if (keys.length === 0) {
        this.logger.config("No active runtime overrides");
      } else {
        this.logger.config("Runtime overrides:");
        for (const key of keys) {
          this.logger.config(`  ${key}: ${overrides[key]}`);
        }
      }
      return;
    }

    const path = args[1];
    const [category, ...keyParts] = path.split(".");
    const key = keyParts.join(".");

    if (args.length === 2) {
      const value = rc.get(category, key);
      this.logger.config(`Current value of ${category}.${key}: ${value}`);
      return;
    }

    const rawValue = args.slice(2).join(" ");
    const numValue = parseFloat(rawValue);
    const value = isNaN(numValue) ? rawValue : numValue;

    rc.set(category, key, value);
    this.logger.config(`Set ${category}.${key} to ${value}`);

    if (category === "COMBAT") {
      // mineflayer plugin property access
      const pvp = (this.bot as any).pvp;
      if (key === "ATTACK_RANGE") pvp.attackRange = value;
      if (key === "FOLLOW_RANGE") pvp.followRange = value;
      if (key === "VIEW_DISTANCE") pvp.viewDistance = value;
      if (key === "USE_OFFSET_BASED_PEARLS") {
        this.logger.config(
          `Offset-based pearl throwing ${value ? "enabled" : "disabled"}`,
        );
      }
    }
  }

  /**
   * Pause the bot for N ticks.
   * args[1] is the tick count
   */
  async pause(args: string[]): Promise<void> {
    const ticks = parseInt(args[1], 10);
    this.logger.command(`Pausing the bot for ${ticks} ticks`);
    await this.bot.waitForTicks(ticks);
  }

  /**
   * Jump toward an offset position and return distance remaining.
   * args[1]=xoffset, args[2]=yoffset, args[3]=zoffset
   */
  async jump(args: string[]): Promise<void> {
    const xOffset = parseFloat(args[1]);
    const yOffset = parseFloat(args[2]);
    const zOffset = parseFloat(args[3]);

    if (isNaN(xOffset) || isNaN(yOffset) || isNaN(zOffset)) {
      this.logger.error(
        new Error("Invalid arguments: jump <xoffset> <yoffset> <zoffset>"),
        "Command",
      );
      return;
    }

    const source = this.bot.entity.position.clone();
    const target = source.offset(xOffset, yOffset, zOffset);

    // Wait until settled on ground
    await (this.bot as any).combatManager._waitUntilSettled();

    // Calculate and apply jump impulse
    const utils = (this.bot as any).utilsManager;
    const impulse = utils.getJumpVelocity(source, target);
    if (impulse) {
      utils.applyImpulse(impulse, "set", true);
    }

    // Wait until landed
    await (this.bot as any).combatManager._waitUntilSettled();

    // Calculate distance remaining to target
    const finalPos = this.bot.entity.position;
    const dist = finalPos.distanceTo(target);

    this.logger.command(
      `Jump: target position (${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)}). Final position: (${finalPos.x.toFixed(2)}, ${finalPos.y.toFixed(2)}, ${finalPos.z.toFixed(2)}). Distance remaining: ${dist.toFixed(3)}b`,
    );
  }

  /**
   * Stop any active run loop.
   */
  private _stopRun(): void {
    if (this._runRunning) {
      this._runRunning = false;
      this.logger.command("Stopped run loop");
    }
  }

  /**
   * Run a command N times with M ticks between executions.
   * args[1]=cmd, args[2]=N, args[3]=M
   */
  async run(args: string[]): Promise<void> {
    const cmd = args[1];
    const n = parseInt(args[2], 10);
    const m = parseInt(args[3], 10);

    if (n <= 0 || m < 0) {
      this.logger.error("Invalid arguments: run <cmd> <N> <M> where N>0, M>=0", "Command");
      return;
    }

    this._stopRun();

    this._runRunning = true;
    this._runCounter = 0;
    this._runTotal = n;
    this._runCmd = cmd;

    this.logger.command(`Running '${cmd}' ${n} times (${m} tick gap)`);

    await this._runLoop(cmd, n, m);
  }

  /**
   * Internal tick-based loop that fires the command each iteration.
   */
  private async _runLoop(cmd: string, n: number, m: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      if (!this._runRunning) break;

      this.query(cmd);
      this._runCounter = i + 1;

      if (i < n - 1 && m > 0) {
        await this.bot.waitForTicks(m);
      }
    }

    if (this._runRunning) {
      this._runRunning = false;
      this.logger.command(`Run loop completed (${n} iterations)`);
    }
  }

  private functionRegistry: Record<string, (...args: any[]) => any> = {};

  /**
   * Initialize the function registry with available functions.
   * This method is safe to call even if some managers are not yet loaded.
   */
  private initializeFunctionRegistry(): void {
    this.functionRegistry = {
      // CommandManager functions
      tossSingle: this.tossSingle.bind(this),
      tossAll: this.tossAll.bind(this),
      equip: this.equip.bind(this),
      unequip: this.unequip.bind(this),
      unequipAll: this.unequipAll.bind(this),
      restore: this.restore.bind(this),
      record: this.record.bind(this),
      pause: this.pause.bind(this),
      run: this.run.bind(this),
      quit: this.quit.bind(this),
      toggleCombat: this.toggleCombat.bind(this),
      changeMode: this.changeMode.bind(this),
      pacify: this.pacify.bind(this),
      queryPlayerDB: this.queryPlayerDB.bind(this),
      querySlotDB: this.querySlotDB.bind(this),
      configCommand: this.configCommand.bind(this),
      showVersion: this.showVersion.bind(this),
      showPosition: this.showPosition.bind(this),
      toggleAutosend: this.toggleAutosend.bind(this),
    };

    // Add manager-specific functions if their managers are available
    this._addManagerFunctions();
  }

  /**
   * Add functions from other managers if they are available.
   * This can be called multiple times to update the registry as managers load.
   */
  private _addManagerFunctions(): void {
    // Add inventory manager functions if available
    // mineflayer plugin property access
    if ((this.bot as any).inventoryManager) {
      const im = (this.bot as any).inventoryManager;
      const inventoryFunctions = {
        clearInventory: this._safeBind(im, im.clearInventory),
        recordInventory: this._safeBind(im, im.recordInventory),
        restoreInventory: this._safeBind(im, im.restoreInventory),
      };
      Object.assign(this.functionRegistry, inventoryFunctions);
    }

    // Add combat manager functions if available
    // mineflayer plugin property access
    if ((this.bot as any).combatManager) {
      const cm = (this.bot as any).combatManager;
      const combatFunctions = {
        toggleCombatMode: this._safeBind(cm, cm.toggleCombatMode),
        setTargetFilter: this._safeBind(cm, cm.setTargetFilter),
      };
      Object.assign(this.functionRegistry, combatFunctions);
    }
  }

  /**
   * Safely bind a method if it exists, otherwise return undefined.
   */
  private _safeBind(context: any, method: any): any {
    return method && typeof method === "function"
      ? method.bind(context)
      : undefined;
  }

  /**
   * List all available functions that can be called with the func command.
   */
  async listFunctions(): Promise<void> {
    const functionNames = Object.keys(this.functionRegistry).sort();
    if (functionNames.length === 0) {
      this.logger.info("No functions available.");
      return;
    }

    this.logger.info("Available functions:");
    for (const funcName of functionNames) {
      this.logger.info(`  ${funcName}`);
    }
    this.logger.info("\nUsage: func <functionName> [args...]");
    this.logger.info("Example: func showVersion");
  }

  /**
   * Call a function directly by name.
   * @param args - Array where args[1] is the function name and args[2..n] are arguments
   */
  async callFunction(args: string[]): Promise<void> {
    if (args.length < 2) {
      this.logger.error(
        "Function name required. Usage: func <functionName> [args...]",
        "Command",
      );
      return;
    }

    const functionName = args[1];
    const functionArgs = args.slice(2); // Extract arguments for the function

    if (!this.functionRegistry[functionName]) {
      const availableFunctions = Object.keys(this.functionRegistry).sort();
      this.logger.error(
        `Function '${functionName}' not found. Available functions:\n  ${availableFunctions.join(", ")}`,
        "Command",
      );
      return;
    }

    try {
      const result = await this.functionRegistry[functionName](functionArgs);

      if (result !== undefined) {
        this.logger.info(
          `Function '${functionName}' returned: ${JSON.stringify(result)}`,
        );
      } else {
        this.logger.info(`Function '${functionName}' executed successfully.`);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error calling function '${functionName}': ${msg}`, "Command");
    }
  }
}

/**
 * Attach the CommandManager to a bot instance.
 */
export function attachCommands(bot: Bot): Bot {
  try {
    bot.commandManager = new CommandManager(bot);
  } catch (error: unknown) {
    logger.error(`CommandManager attachment failed: ${(error as Error).message}`, "Command");
    throw error;
  }
  // Attach the bot to the logger so the message listener can be registered.
  logger.attachBot(bot);
  return bot;
}
