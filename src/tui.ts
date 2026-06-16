/**
 * Terminal UI module for Pupa bot.
 * Provides createTerminalUI() which either builds a full blessed-based TUI
 * or returns a minimal headless console logger depending on the environment.
 */

import * as cli from "./cli-engine";
import type { CommandNode } from "./cli-engine";

// Lazily-initialized instance (singleton)
let uiInstance: UIBackend | null = null;

// ── Headless mode detection ────────────────────────────────────────
// Check argv before blessed is even required
// Also detect Jest test environment
const HEADLESS =
  process.argv.includes("--headless") ||
  process.env.JEST_WORKER_ID !== undefined;

// ── Interface definitions ──────────────────────────────────────────

interface UIBackend {
  _debugMode: boolean;
  _commandManager: { tree: Record<string, CommandNode> } | null;
  setDebugMode(enabled: boolean): void;
  log(message: unknown, tag?: string, level?: string): void;
  onInput(cb: (text: string) => void): void;
  getHistory(): string[];
  getScrollPosition(): number;
  destroy(): void;
}

interface CliBackend {
  _debugMode: boolean;
  setDebugMode(enabled: boolean): void;
  log(message: unknown, tag?: string, level?: string): void;
  onInput(cb: (text: string) => void): void;
  getHistory(): string[];
  getScrollPosition(): number;
  destroy(): void;
}

// ── Helpers ────────────────────────────────────────────────────────

const CRASH_LOG_DIR = (() => {
  const p = require("node:path");
  const fs = require("node:fs");
  const dir = p.join(__dirname, "logs");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
  return dir;
})();

function getLevelPrefix(level: string): string {
  switch (level) {
    case "DEBUG":
      return "{gray-fg}[DEBUG]{/}";
    case "WARN":
      return "{yellow-fg}[WARN]{/}";
    case "ERROR":
      return "{red-fg}[ERROR]{/}";
    default:
      return "{cyan-fg}[INFO]{/}";
  }
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Creates the terminal UI (either blessed TUI or headless console logger).
 * Returns the same instance on subsequent calls (singleton).
 */
function createTerminalUI(): UIBackend {
  // If already initialized, return the instance
  if (uiInstance) return uiInstance;

  // Headless mode: return a plain console logger, no blessed/TUI
  if (HEADLESS) {
    uiInstance = createHeadlessUI();
    return uiInstance;
  }

  // ── Full TUI mode ──────────────────────────────────────────────
  // @ts-ignore - blessed is optional and may not resolve in all environments
  const blessed = require("blessed");
  // @ts-ignore - blessed-contrib is optional
  const contrib = require("blessed-contrib");

  const screen: any = blessed.screen({
    smartCSR: true,
    title: "Terminal UI",
    fullUnicode: true,
    dockBorders: true,
  });

  const grid = new contrib.grid({ rows: 1, cols: 1, screen });
  const logBox: any = grid.set(0, 0, 0.75, 1, blessed.log, {
    label: " Log ",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: "▓", track: { bg: "grey" }, style: { bg: "lightblue" } },
    border: { type: "line", fg: "blue" },
    style: { fg: "white", border: { fg: "#f0f0f0" } },
  });

  const inputBox: any = grid.set(0, 0, 0.25, 1, blessed.textbox, {
    bottom: 0,
    height: 3,
    width: "100%",
    label: " Input ",
    inputOnFocus: true,
    border: { type: "line", fg: "green" },
    style: {
      fg: "yellow",
      bg: "black",
      focus: { bg: "#333333" },
      border: { fg: "#a0a0a0" },
    },
  });

  logBox.add("{bold}Terminal UI Initialized{/bold}");
  logBox.add("┌─────────────────────────────────────┐");
  logBox.add("│ Type text and press {blue-fg}Enter{/} to submit │");
  logBox.add("│ Press {blue-fg}Esc{/} to clear input            │");
  logBox.add("│ Use {blue-fg}↑/↓{/} keys to scroll logs         │");
  logBox.add("└─────────────────────────────────────┘");

  // ── Input callbacks ────────────────────────────────────────────
  const inputCallbacks: ((text: string) => void)[] = [];
  inputBox.on("submit", (text: string) => {
    const timestamp = new Date().toISOString().substring(11, 19);
    logBox.add(`{cyan-fg}[${timestamp}]{/} ${text}`);
    inputCallbacks.forEach((cb) => {
      try {
        cb(text);
      } catch (error: unknown) {
        logBox.log(
          `{red-fg}[Input Handler Error]{/} ${(error as Error).message}`,
        );
      }
    });
    inputBox.clearValue();
    inputBox.focus();
    screen.render();
  });

  inputBox.key("escape", () => {
    inputBox.clearValue();
    screen.render();
  });

  // Tab: auto-complete current token
  inputBox.key("tab", () => {
    const text = inputBox.getValue();
    const { tokens, trailingSpace } = cli.tokenize(text);

    if (tokens.length === 0) return;

    // Resolve current command context
    const cmdMgr = (uiInstance as UIBackend)._commandManager;
    if (!cmdMgr || !cmdMgr.tree) return;

    const result = cli.resolve(cmdMgr.tree, tokens);
    const partial = trailingSpace ? "" : tokens[tokens.length - 1];

    // Get the subtree to explore for suggestions/help
    const getSubTree = (): Record<string, CommandNode> => {
      if (result.node?.subcommands) {
        return result.node.subcommands;
      }
      return cmdMgr.tree;
    };

    if (trailingSpace) {
      // User wants suggestions for next arg
      const subTree = getSubTree();
      const { commands } = cli.getSuggestions(subTree, "");
      if (commands.length > 0) {
        const helpStr = cli.getHelp(subTree, result.matched);
        (uiInstance as UIBackend).log(`Completions:\n${helpStr}`, "Command");
      }
    } else {
      // User is typing a token — try to expand
      const subTree = getSubTree();
      const full = cli.expandAbbreviation(subTree, partial);
      if (full) {
        // Replace last token with its full form
        const prefix = text.slice(0, text.lastIndexOf(partial));
        inputBox.setValue(prefix + full);
        screen.render();
      } else {
        // Show possible completions
        const { commands } = cli.getSuggestions(subTree, partial);
        if (commands.length > 0) {
          const helpStr = cli.getHelp(subTree, result.matched);
          (uiInstance as UIBackend).log(`Completions:\n${helpStr}`, "Command");
        }
      }
    }
  });

  inputBox.key("?", () => {
    const text = inputBox.getValue().trim();
    const cmdMgr = (uiInstance as UIBackend)._commandManager;
    if (!cmdMgr || !cmdMgr.tree) return;

    if (!text) {
      // Top-level help
      const helpStr = cli.getHelp(cmdMgr.tree, []);
      (uiInstance as UIBackend).log(
        `Available commands:\n${helpStr}`,
        "Command",
      );
      return;
    }

    const { tokens } = cli.tokenize(text);
    const result = cli.resolve(cmdMgr.tree, tokens);
    const subTree = result.node?.subcommands || cmdMgr.tree;
    const helpStr = cli.getHelp(subTree, result.matched);
    (uiInstance as UIBackend).log(`Help for "${text}":\n${helpStr}`, "Command");
  });

  screen.key(["up", "down", "pageup", "pagedown"], (_: any, key: any) => {
    const h = logBox.height - 2;
    switch (key.name) {
      case "up":
        logBox.scroll(-1);
        break;
      case "down":
        logBox.scroll(1);
        break;
      case "pageup":
        logBox.scroll(-h);
        break;
      case "pagedown":
        logBox.scroll(h);
        break;
    }
    screen.render();
  });

  screen.key("enter", () => {
    inputBox.focus();
    screen.render();
  });

  screen.key(["C-c", "escape"], () => {
    if (uiInstance) {
      uiInstance.destroy();
    }
    process.exit(0);
  });

  // ── Resize handling ────────────────────────────────────────────
  const resize = () => {
    logBox.height = Math.max(3, Math.floor(screen.height * 0.75));
    inputBox.height = 3;
    inputBox.top = screen.height - 3;
    screen.render();
  };
  screen.on("resize", resize);
  resize();

  inputBox.focus();
  screen.render();

  // ── Log deduplication state ────────────────────────────────────
  let lastLogMessage: string | null = null;
  let lastLogTag: string | null = null;
  let lastLogLevel: string | null = null;
  let lastLogCount = 0;
  let lastLogTimestamp: string | null = null;

  // ── Build and return the UI instance ───────────────────────────
  uiInstance = {
    _debugMode: false,
    _commandManager: null,
    setDebugMode(enabled: boolean): void {
      this._debugMode = enabled;
    },

    /**
     * Log a message to the TUI with an optional tag and log level.
     * Condenses identical consecutive messages into a single line with a counter.
     * @param message - The message to log
     * @param tag - Optional tag (e.g., 'Combat', 'Inventory')
     * @param level - Log level: 'DEBUG', 'INFO', 'WARN', 'ERROR'
     */
    log(message: unknown, tag: string = "", level: string = "INFO"): void {
      if (!this._debugMode && level === "DEBUG") return;
      let formattedMessage: string;
      if (message instanceof Error) {
        formattedMessage = message.stack || String(message);
      } else if (typeof message === "object" && message !== null) {
        formattedMessage = JSON.stringify(message, null, 2);
      } else {
        formattedMessage = String(message);
      }

      if (
        formattedMessage === lastLogMessage &&
        tag === lastLogTag &&
        level === lastLogLevel
      ) {
        lastLogCount++;
        // Tag is already formatted by Logger (e.g., "[bot1 Status]")
        const tagStr = tag ? `{bold}${tag}{/bold} ` : "";
        const levelStr = getLevelPrefix(level);
        const newLine = `{cyan-fg}[${lastLogTimestamp}]{/} ${tagStr}${levelStr} ${formattedMessage} {yellow-fg}(x${lastLogCount}){/}`;

        // Update the last line. Note: this works best for single-line logs.
        const lines = logBox.getLines();
        if (lines.length > 0) {
          logBox.setLine(lines.length - 1, newLine);
        }
      } else {
        lastLogMessage = formattedMessage;
        lastLogTag = tag;
        lastLogLevel = level;
        lastLogCount = 1;
        lastLogTimestamp = new Date().toISOString().substring(11, 19);

        // Tag is already formatted by Logger (e.g., "[bot1 Status]")
        const tagStr = tag ? `{bold}${tag}{/bold} ` : "";
        const levelStr = getLevelPrefix(level);
        logBox.log(
          `{cyan-fg}[${lastLogTimestamp}]{/} ${tagStr}${levelStr} ${formattedMessage}`,
        );
      }
      screen.render();
    },

    /**
     * Register a callback for user text input.
     * @param cb - Callback receiving the input text string
     */
    onInput(cb: (text: string) => void): void {
      if (typeof cb !== "function") {
        throw new Error("onInput callback must be a function");
      }
      inputCallbacks.push(cb);
    },

    /**
     * Get the full log history.
     * @returns Array of log lines
     */
    getHistory(): string[] {
      return logBox.getText().split("\n");
    },

    /**
     * Get the current scroll position of the log box.
     * @returns Scroll position
     */
    getScrollPosition(): number {
      return logBox.getScroll();
    },

    /**
     * Destroy the TUI screen and clean up.
     */
    destroy(): void {
      if (screen && !screen.destroyed) {
        try {
          screen.destroy();
        } catch (error: unknown) {
          // eslint-disable-next-line no-console
          console.error("Error destroying screen:", error);
        }
      }
      uiInstance = null;
    },
  };

  return uiInstance;
}

/**
 * Creates a minimal console-based ui for headless mode.
 * No blessed, no TUI, no timestamps — just console.log/error with tags.
 */
function createHeadlessUI(): UIBackend {
  /**
   * Format a message for headless console output.
   * @param message - The message to format
   * @returns Formatted string
   */
  function formatMessage(message: unknown): string {
    if (message instanceof Error) {
      return message.stack || String(message);
    } else if (typeof message === "object" && message !== null) {
      return JSON.stringify(message);
    }
    return String(message);
  }
  return {
    _debugMode: false,
    _commandManager: null,
    setDebugMode(enabled: boolean): void {
      this._debugMode = enabled;
    },
    /**
     * Log a message to the headless console with an optional tag and log level.
     * @param message - The message to log
     * @param tag - Optional tag
     * @param level - Log level
     */
    log(message: unknown, tag: string = "", level: string = "INFO"): void {
      if (!this._debugMode && level === "DEBUG") return;
      const formatted = formatMessage(message);
      // Tag is already formatted by Logger (e.g., "[bot1 Status]")
      const tagStr = tag ? `${tag} ` : "";
      const levelStr = `[${level}]`;
      const timestamp = new Date().toISOString().substring(11, 19);
      const line = `${timestamp} ${tagStr}${levelStr} ${formatted}`;
      if (level === "ERROR") {
        // eslint-disable-next-line no-console
        console.error(line);
      } else {
        // eslint-disable-next-line no-console
        console.log(line);
      }
    },
    /**
     * No-op input handler for headless mode.
     * @param _cb - Callback (unused)
     */
    onInput(_cb: (text: string) => void): void {},
    /**
     * Get empty log history (headless mode has no log storage).
     * @returns Empty array
     */
    getHistory(): string[] {
      return [];
    },
    /**
     * Get scroll position (headless mode has no scrolling).
     * @returns Always 0
     */
    getScrollPosition(): number {
      return 0;
    },
    /**
     * No-op destroy for headless mode.
     */
    destroy(): void {},
  };
}

// ── Exports ────────────────────────────────────────────────────────

export default createTerminalUI;
export { createTerminalUI };
export type { UIBackend, CliBackend };
