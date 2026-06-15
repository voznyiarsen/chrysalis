/**
 * Unified Logger facade for Pupa bot.
 * Wraps the TUI/headless backend and provides level-based and semantic logging APIs.
 */

import { createTerminalUI } from "./tui.js";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

interface UIBackend {
  log(message: unknown, tag: string, level: LogLevel): void;
  setDebugMode(enabled: boolean): void;
}

export class Logger {
  private _debugMode = false;
  private _backend: UIBackend;
  /** Optional bot number for multi-bot tagging. 0 = no tag (single-bot mode). */
  public botNumber: number = 0;

  constructor() {
    this._backend = createTerminalUI() as unknown as UIBackend;
  }

  setDebugMode(enabled: boolean): void {
    this._debugMode = enabled;
    this._backend.setDebugMode(enabled);
  }

  /**
   * Create a child logger that prefixes all output with a bot number.
   */
  forBot(botNumber: number): Logger {
    const child = new Logger();
    child._debugMode = this._debugMode;
    child._backend = this._backend; // share the same backend
    child.botNumber = botNumber;
    return child;
  }

  /**
   * Build the bot tag prefix string.
   * Returns a format suitable for prepending to tags, e.g., "[bot1] " or "".
   */
  private _botPrefix(): string {
    return this.botNumber > 0 ? `[bot${this.botNumber}]` : "";
  }

  // ── Low-level call ────────────────────────────────────────────

  /**
   * Log a structured entry through the backend.
   */
  private _log(message: unknown, tag: string, level: LogLevel): void {
    const botTag = this._botPrefix();
    // If we have a bot tag, integrate it with the tag for cleaner output
    // e.g., "[bot1 Status]" instead of "[bot1] [Status]"
    const combinedTag = botTag && tag ? `${botTag} ${tag}` : (botTag || tag);
    this._backend.log(message, combinedTag, level);
  }

  // ── Level-based API ───────────────────────────────────────────

  debug(msg: unknown, tag = ""): void {
    this._log(msg, tag, "DEBUG");
  }

  info(msg: unknown, tag = ""): void {
    this._log(msg, tag, "INFO");
  }

  warn(msg: unknown, tag = ""): void {
    this._log(msg, tag, "WARN");
  }

  error(msg: unknown, tag = ""): void {
    this._log(msg, tag, "ERROR");
  }

  // ── Semantic helpers ──────────────────────────────────────────

  client(msg: unknown, level: LogLevel = "INFO"): void {
    this._log(msg, "Client", level);
  }

  combat(msg: unknown, level: LogLevel = "INFO"): void {
    this._log(msg, "Combat", level);
  }

  inventory(msg: unknown, level: LogLevel = "INFO"): void {
    this._log(msg, "Inventory", level);
  }

  command(msg: unknown, level: LogLevel = "INFO"): void {
    this._log(msg, "Command", level);
  }

  status(msg: unknown, level: LogLevel = "INFO"): void {
    this._log(msg, "Status", level);
  }

  config(msg: unknown, level: LogLevel = "INFO"): void {
    this._log(msg, "Config", level);
  }

  chat(msg: unknown): void {
    this._log(msg, "Chat", "INFO");
  }

  exception(msg: unknown): void {
    this._log(msg, "Exception", "ERROR");
  }

  warning(msg: unknown): void {
    this._log(msg, "Warning", "WARN");
  }
}

export const logger = new Logger();
export default logger;