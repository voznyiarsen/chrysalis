/**
 * @fileoverview Unified Logger facade for Pupa bot.
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

  /**
   * Log a structured entry through the backend.
   * Includes the calling function name for better traceability.
   */
  private _log(
    message: unknown,
    tag: string,
    level: LogLevel,
    caller?: string,
  ): void {
    const botTag = this._botPrefix();
    const combinedTag = botTag && tag ? `${botTag} ${tag}` : botTag || tag;
    const messageWithCaller = caller ? `[${caller}] ${message}` : message;
    this._backend.log(messageWithCaller, combinedTag, level);
  }

  debug(msg: unknown, tag = "", caller?: string): void {
    this._log(msg, tag, "DEBUG", caller);
  }

  info(msg: unknown, tag = "", caller?: string): void {
    this._log(msg, tag, "INFO", caller);
  }

  warn(msg: unknown, tag = "", caller?: string): void {
    this._log(msg, tag, "WARN", caller);
  }

  error(msg: unknown, tag = "", caller?: string): void {
    this._log(msg, tag, "ERROR", caller);
  }

  client(msg: unknown, level: LogLevel = "INFO", caller?: string): void {
    this._log(msg, "Client", level, caller);
  }

  combat(msg: unknown, level: LogLevel = "INFO", caller?: string): void {
    this._log(msg, "Combat", level, caller);
  }

  inventory(msg: unknown, level: LogLevel = "INFO", caller?: string): void {
    this._log(msg, "Inventory", level, caller);
  }

  command(msg: unknown, level: LogLevel = "INFO", caller?: string): void {
    this._log(msg, "Command", level, caller);
  }

  status(msg: unknown, level: LogLevel = "INFO", caller?: string): void {
    this._log(msg, "Status", level, caller);
  }

  config(msg: unknown, level: LogLevel = "INFO", caller?: string): void {
    this._log(msg, "Config", level, caller);
  }

  chat(msg: unknown, caller?: string): void {
    this._log(msg, "Chat", "INFO", caller);
  }

  exception(msg: unknown, caller?: string): void {
    this._log(msg, "Exception", "ERROR", caller);
  }

  warning(msg: unknown, caller?: string): void {
    this._log(msg, "Warning", "WARN", caller);
  }

  movement(msg: unknown, level: LogLevel = "INFO", caller?: string): void {
    this._log(msg, "Movement", level, caller);
  }

  pathfinding(msg: unknown, level: LogLevel = "INFO", caller?: string): void {
    this._log(msg, "Pathfinding", level, caller);
  }

  entity(msg: unknown, level: LogLevel = "INFO", caller?: string): void {
    this._log(msg, "Entity", level, caller);
  }

  packet(msg: unknown, level: LogLevel = "INFO", caller?: string): void {
    this._log(msg, "Packet", level, caller);
  }
}

export const logger = new Logger();
