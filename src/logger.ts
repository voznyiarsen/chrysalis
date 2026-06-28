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

  private _messageLogEnabled = false;
  private _messageListener: ((...args: any[]) => void) | null = null;
  private _bot: any = null;
  /** Parent logger for child loggers created via forBot(). */
  protected _parent: Logger | null = null;

  constructor() {
    this._backend = createTerminalUI() as unknown as UIBackend;
  }

  get isMessageLogEnabled(): boolean {
    return this._messageLogEnabled;
  }

  /**
   * Attach the bot instance so the message listener can be registered.
   * Called once after bot creation.
   */
  attachBot(bot: any): void {
    this._bot = bot;
  }

  /**
   * Enable logging of all incoming server chat packets.
   *
   * For >=1.19 the underlying `message` event is used (catches system/chat/actionBar).
   * For older protocols (e.g. 1.12.2) the `message` event is never emitted, so we
   * fall back to the parsed `chat` event which is always available.
   *
   * Received packets are logged with the Packet tag so the raw server traffic
   * is visible for debugging.
   */
  enableMessageLog(): void {
    if (this._parent) return this._parent.enableMessageLog();
    if (this._messageLogEnabled || !this._bot) return;
    this._messageLogEnabled = true;

    this._messageListener = (jsonMsg: any, position: string) => {
      const text = jsonMsg?.toString?.() ?? String(jsonMsg);
      this._log(`[${position}] ${text}`, "Packet", "DEBUG");
    };
    this._bot.on("message", this._messageListener);
    this._log("Message logging enabled", "Packet", "INFO");
  }

  /**
   * Disable logging of server chat packets and remove the listener.
   */
  disableMessageLog(): void {
    if (this._parent) return this._parent.disableMessageLog();
    if (!this._messageLogEnabled) return;
    this._messageLogEnabled = false;

    if (this._bot && this._messageListener) {
      this._bot.removeListener("message", this._messageListener);
    }
    this._messageListener = null;
    this._log("Message logging disabled", "Packet", "INFO");
  }

  /**
   * Toggle message logging on/off.
   * @returns The new enabled state.
   */
  toggleMessageLog(): boolean {
    if (this._parent) return this._parent.toggleMessageLog();
    if (this._messageLogEnabled) {
      this.disableMessageLog();
    } else {
      this.enableMessageLog();
    }
    return this._messageLogEnabled;
  }

  get isDebugMode(): boolean {
    return this._debugMode;
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
    child._parent = this; // delegate message listener ops to parent
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
