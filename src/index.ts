/**
 * @fileoverview Pupa — Minecraft bot entry point.
 *
 * Multi-bot registry: supports 1-4 bots via --bot1 through --bot4 flags.
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

const tui = createTerminalUI();
const registry = new BotRegistry();

async function start(): Promise<void> {
  const botDefs = parseBotDefinitions();
  registry.setDefinitions(botDefs);

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

tui.onInput((text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return;

  const parsed = registry.parseBotPrefix(trimmed);
  const allBots = registry.getAllBots();

  if (parsed) {
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
      const cm = bot.commandManager;
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
    const chained = trimmed
      .split(";")
      .map((c) => c.trim())
      .filter(Boolean);
    for (const [botNum, bot] of allBots) {
      const cm = bot.commandManager;
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
  logger.error(err);
  if (HEADLESS) process.exit(1);
});
