/**
 * @fileoverview Pupa — Minecraft bot entry point.
 *
 * Multi-bot registry: supports multiple bots via --bot flags.
 * Each bot operates independently with its own connection, plugins, and
 * command execution, sharing a single logger/TUI instance.
 */

import "dotenv/config";

import { logger } from "./logger";
import { createTerminalUI } from "./tui";
import { BotRegistry, BotDefinition, BotConfig } from "./bot-registry";

(process as any).noDeprecation = true;

const HEADLESS = process.argv.includes("--headless");

/**
 * Parse --bot flags and extract usernames/commands.
 * Supported syntaxes:
 *   --bot "USERNAME"
 *   --bot
 *   --bot "USERNAME" "COMMANDS"
 *   --bot "COMMANDS"
 *
 * Also supports global --host, --port, --version for shared configuration.
 */
function parseBotDefinitions(): BotDefinition[] {
  const bots: BotDefinition[] = [];
  const seenUsernames = new Set<string>();
  const defaultUsername = process.env.PUPA_NAME || "Pupa";

  // Find all --bot flags
  const botIndices: number[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === "--bot") {
      botIndices.push(i);
    }
  }

  // If no --bot flags, create a single bot with default username
  if (botIndices.length === 0) {
    bots.push({ number: 1 });
    return bots;
  }

  for (let i = 0; i < botIndices.length; i++) {
    const idx = botIndices[i];
    const def: BotDefinition = { number: i + 1 };

    // In headless mode, check if there are two args (username + command) or one arg (command only)
    if (HEADLESS) {
      const arg1 =
        idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
      const arg2 =
        idx + 2 < process.argv.length ? process.argv[idx + 2] : undefined;

      if (arg1 && !arg1.startsWith("--") && arg2 && !arg2.startsWith("--")) {
        // Two args: first is username, second is command
        def.username = arg1;
        def.headlessCommand = arg2;
      } else if (arg1 && !arg1.startsWith("--")) {
        // One arg: could be command (contains semicolon) or username
        if (arg1.includes(";")) {
          def.headlessCommand = arg1;
        } else {
          def.username = arg1;
        }
      }
    } else {
      // Non-headless mode: next arg is username
      const nextArg =
        idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
      if (nextArg && !nextArg.startsWith("--")) {
        def.username = nextArg;
      }
    }

    // Handle duplicate usernames
    const baseUsername = def.username || defaultUsername;
    if (seenUsernames.has(baseUsername)) {
      logger.warning(
        `Duplicate username "${baseUsername}" detected for bot ${def.number}. Using first instance only.`,
        "Client",
      );
      // Skip this bot definition
      continue;
    }
    seenUsernames.add(baseUsername);

    bots.push(def);
  }

  return bots;
}

/**
 * Resolve the full configuration for a bot definition by merging with
 * global overrides and process.argv defaults.
 */
function resolveConfig(
  def: BotDefinition,
  botNumber: number,
  allBots: BotDefinition[],
): BotConfig {
  // Global overrides (--host, --port, --version)
  const globalHostIdx = process.argv.indexOf("--host");
  const globalPortIdx = process.argv.indexOf("--port");
  const globalVersionIdx = process.argv.indexOf("--version");

  const defaultUsername = process.env.PUPA_NAME || "Pupa";

  // Determine base username
  let baseUsername = def.username || defaultUsername;

  // If using default username and there are multiple bots, append number to prevent collisions
  const usingDefault = !def.username;
  const hasMultipleBots = allBots.length > 1;

  if (usingDefault && hasMultipleBots) {
    baseUsername = `${defaultUsername}${botNumber}`;
  }

  return {
    host:
      (globalHostIdx !== -1 ? process.argv[globalHostIdx + 1] : undefined) ||
      process.env.PUPA_HOST ||
      "localhost",
    port:
      (globalPortIdx !== -1
        ? parseInt(process.argv[globalPortIdx + 1], 10)
        : undefined) || parseInt(process.env.PUPA_PORT || "25565", 10),
    username: baseUsername,
    version:
      (globalVersionIdx !== -1
        ? process.argv[globalVersionIdx + 1]
        : undefined) || undefined,
  };
}

const registry = new BotRegistry();

async function start(): Promise<void> {
  const tui = await createTerminalUI();

  tui.onInput((text: string, botNumber?: number) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const parsed = registry.parseBotPrefix(trimmed);
    const allBots = registry.getAllBots();

    const body = parsed ? parsed.command.trim() : trimmed;
    // Explicit `botN,...` prefix wins; otherwise a specific TUI tab targets
    // its bot; otherwise every bot receives the input.
    const targets: number[] = parsed
      ? parsed.botNumbers.filter((n) => registry.getBot(n))
      : botNumber !== undefined
        ? [botNumber]
        : allBots.map(([n]) => n);

    if (body.startsWith("/")) {
      // Command: strip /, support ;-chaining, process per bot internally
      const chained = body
        .slice(1)
        .split(";")
        .map((c) => c.trim())
        .filter(Boolean);
      for (const botNum of targets) {
        const bot = registry.getBot(botNum);
        const cm = bot?.commandManager;
        if (!cm) continue;
        for (const c of chained) {
          cm.query(c).catch((error: unknown) => {
            const err = error as Error;
            err.message = `Command execution on bot ${botNum} failed: ${err.message}`;
            registry.getLogger(botNum).error(err, "Command");
          });
        }
      }
    } else {
      // General text: sent as chat to each selected bot
      for (const botNum of targets) {
        const bot = registry.getBot(botNum);
        if (!bot?.commandManager) continue;
        bot.commandManager.handleInput(body).catch((error: unknown) => {
          const err = error as Error;
          err.message = `Chat send on bot ${botNum} failed: ${err.message}`;
          registry.getLogger(botNum).error(err, "Command");
        });
      }
    }
  });

  const botDefs = parseBotDefinitions();
  registry.setDefinitions(botDefs);
  // Per-bot window tabs in the TUI
  tui.setBots(botDefs.map((d) => d.number));

  for (const def of botDefs) {
    const cfg = resolveConfig(def, def.number, botDefs);
    registry.configs.set(def.number, cfg);

    try {
      const bot = await registry.createBot(def.number);
      // The CommandManager is attached on login (see BotRegistry listeners),
      // so the tree only exists after the bot has actually logged in. This
      // handler is registered after the registry's, so it runs afterwards.
      const wireAutocomplete = () => {
        if (bot.commandManager) {
          tui.setCommandManager(bot.commandManager);
        }
      };
      if (bot.commandManager) {
        wireAutocomplete();
      } else {
        bot.once("login", wireAutocomplete);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to create bot ${def.number}: ${msg}`, "Client");
      if (HEADLESS) process.exit(1);
    }
  }

  registry.setTotalBots(botDefs.length);

  // In headless mode, if no bots were created, exit
  if (HEADLESS && registry.bots.size === 0) {
    logger.error("No bots created. Exiting.", "Client");
    process.exit(1);
  }
}

process.on("uncaughtException", (err: Error, origin: string) => {
  err.message = `Uncaught Exception: ${err.message} at ${origin}`;
  logger.exception(err);
  if (HEADLESS) process.exit(1);
});

process.on(
  "unhandledRejection",
  (reason: unknown, promise: Promise<unknown>) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    err.message = `Unhandled Rejection: ${err.message}`;
    logger.exception(err);
  },
);

process.on("warning", (warn: Error) => {
  const msg = warn?.message || String(warn);
  if (msg.includes("physicTick")) return;
  if (msg.includes("punycode")) return;
  logger.warning(warn);
});

const originalWarn = console.warn;
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
  logger.error(err, "Client");
  if (HEADLESS) process.exit(1);
});
