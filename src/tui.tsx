/**
 * @fileoverview Terminal UI module for Pupa bot.
 * Provides createTerminalUI() which builds an Ink-based TUI
 * or returns a minimal headless console logger.
 *
 * Headless mode uses console.log — its primary purpose, not a logger bypass.
 */
/* eslint-disable no-console */

import { tokenize, resolve, getSuggestions, type SuggestionResult } from "./cli-engine";
import type { CommandNode } from "./cli-engine";
// @ts-ignore - ink is ESM-only; may fail in CJS test runtimes
import React, { useState, useEffect, useCallback } from "react";

let ink: any = null;
let inkPromise: Promise<any> | null = null;

/**
 * Load ink via dynamic import() — ink v8 is ESM-only and uses top-level
 * await, so require() fails on all Node versions. Concurrent calls share
 * the same promise.
 */
function loadInk(): Promise<any> {
  if (ink) return Promise.resolve(ink);
  if (!inkPromise) {
    inkPromise = import("ink")
      .then((mod) => {
        ink = mod;
        return mod;
      })
      .catch(() => {
        inkPromise = null; // Allow retry on transient failures
        return null;
      });
  }
  return inkPromise;
}

let uiInstance: UIBackend | null = null;
let uiPromise: Promise<UIBackend> | null = null;

const HEADLESS =
  process.argv.includes("--headless") ||
  process.env.JEST_WORKER_ID !== undefined;

interface UIBackend {
  _debugMode: boolean;
  _commandManager: { tree: Record<string, CommandNode> } | null;
  setDebugMode(enabled: boolean): void;
  setCommandManager(cm: { tree: Record<string, unknown> } | null): void;
  setBots(bots: number[]): void;
  log(message: unknown, tag?: string, level?: string): void;
  onInput(cb: (text: string, botNumber?: number) => void): void;
  getHistory(): string[];
  getScrollPosition(): number;
  destroy(): void;
}

interface LogEntry {
  id: number;
  timestamp: string;
  tag: string;
  level: string;
  message: string;
  count: number;
  botNumber: number | null;
}

let logIdCounter = 0;

/**
 * Extract the bot number from a logger tag such as "[bot2] Client".
 * Returns null for logs that don't belong to a specific bot.
 */
export function getBotNumberFromTag(tag: string): number | null {
  const m = /^\[bot(\d+)\]/.exec(tag);
  return m ? Number(m[1]) : null;
}

function getLevelColor(level: string): string {
  switch (level) {
    case "DEBUG": return "gray";
    case "WARN": return "yellow";
    case "ERROR": return "red";
    default: return "cyan";
  }
}

function formatMessage(message: unknown): string {
  if (message instanceof Error) return message.stack || String(message);
  if (typeof message === "object" && message !== null) return JSON.stringify(message, null, 2);
  return String(message);
}

// ── Ink TUI Component ────────────────────────────────────────────────

/**
 * Command tree source of truth, set once a bot's CommandManager exists.
 * The TUI component subscribes to changes so it re-renders through normal
 * React state (Ink's rerender cannot be used after the fact).
 */
let tuiCommandManager: { tree: Record<string, CommandNode> } | null = null;
let tuiDebugMode = false;
let tuiBotList: number[] = [];
const cmListeners = new Set<() => void>();
function notifyTuiListeners(): void {
  cmListeners.forEach((l) => l());
}

interface TuiComponentProps {
  onInputSubmit: (text: string, botNumber?: number) => void;
}

function TuiComponent({ onInputSubmit }: TuiComponentProps) {
  const { Box, Text, useInput, useApp, render } = ink;
  const { exit } = useApp();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState<SuggestionResult>({ commands: [], descriptions: [] });
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1);
  const [showPopup, setShowPopup] = useState(false);
  const [commandManager, setLocalCommandManager] = useState(tuiCommandManager);
  const [debugMode, setLocalDebugMode] = useState(tuiDebugMode);
  const [botNumbers, setLocalBots] = useState(tuiBotList);
  const [activeTab, setActiveTab] = useState(0); // 0 = All, otherwise bot number

  // React to command-tree / debug-mode / bot-list updates pushed by the backend.
  useEffect(() => {
    const listener = () => {
      setLocalCommandManager(tuiCommandManager);
      setLocalDebugMode(tuiDebugMode);
      setLocalBots(tuiBotList);
      setActiveTab((t) => (t !== 0 && !tuiBotList.includes(t) ? 0 : t));
    };
    cmListeners.add(listener);
    return () => { cmListeners.delete(listener); };
  }, []);

  // Command portion after a leading /; empty for general text (no popup).
  const commandInput = inputValue.startsWith("/") ? inputValue.slice(1) : "";

  /** Replace the trailing token with a completed command name. */
  const acceptSuggestion = (name: string) => {
    const { tokens } = tokenize(commandInput);
    const newTokens = tokens.length > 0 ? [...tokens.slice(0, -1), name] : [name];
    setInputValue("/" + newTokens.join(" ") + " ");
    setShowPopup(false);
    setSelectedSuggestion(-1);
  };

  /**
   * Submit an input line: accept a highlighted suggestion first, otherwise
   * record history and emit the raw text (`/cmd` routes to commands, plain
   * text goes to chat).
   */
  const submitInput = (value: string) => {
    if (showPopup && selectedSuggestion >= 0 && suggestions.commands[selectedSuggestion]) {
      acceptSuggestion(suggestions.commands[selectedSuggestion]);
      return;
    }
    const trimmed = value.trim();
    if (trimmed) {
      setHistory((h) => [...h.slice(-99), trimmed]);
      // Raw text: `/cmd` routes to commands, plain text goes to chat.
      // A specific tab targets that bot; All keeps the default routing.
      onInputSubmit(trimmed, activeTab !== 0 ? activeTab : undefined);
    }
    setInputValue("");
    setHistoryIndex(-1);
    setDraft("");
    setShowPopup(false);
    setSelectedSuggestion(-1);
  };

  /**
   * Tab-complete an input line and return the (possibly updated) value so
   * callers handling coalesced chunks can continue with the new state.
   */
  const completeTab = (value: string): string => {
    // Tab-completion only applies to commands (input starting with /)
    if (!commandManager?.tree || !value.startsWith("/")) return value;
    const cmdInput = value.slice(1);
    const { tokens, trailingSpace } = tokenize(cmdInput);
    const result = resolve(commandManager.tree, tokens);
    const partial =
      trailingSpace || tokens.length === 0 ? "" : tokens[tokens.length - 1];
    const subTree =
      result.matched.length > 0 ? result.node?.subcommands : commandManager.tree;
    if (!subTree) return value;
    const s = getSuggestions(subTree, partial);
    if (s.commands.length === 0) return value;
    if (s.commands.length === 1) {
      // Unique match: expand inline.
      const newTokens =
        tokens.length > 0 ? [...tokens.slice(0, -1), s.commands[0]] : [s.commands[0]];
      const next = "/" + newTokens.join(" ") + " ";
      setInputValue(next);
      setShowPopup(false);
      setSelectedSuggestion(-1);
      return next;
    }
    // Ambiguous: show the popup and walk the candidate list (Enter accepts).
    setSuggestions(s);
    setShowPopup(true);
    setSelectedSuggestion((prev) =>
      prev < 0 ? 0 : (prev + 1) % s.commands.length
    );
    return value;
  };

  /** Switch to a tab: 0 = All, otherwise an existing bot number. */
  const selectTab = (tab: number) => {
    if (tab === 0 || botNumbers.includes(tab)) setActiveTab(tab);
  };

  /** Cycle through All + per-bot tabs in the given direction. */
  const cycleTab = (direction: 1 | -1) => {
    const tabs = [0, ...botNumbers];
    const idx = Math.max(0, tabs.indexOf(activeTab));
    setActiveTab(tabs[(idx + direction + tabs.length) % tabs.length]);
  };

  const appendLog = useCallback((tag: string, level: string, message: string) => {
    if (level === "DEBUG" && !debugMode) return;
    const botNumber = getBotNumberFromTag(tag);
    const timestamp = new Date().toISOString().substring(11, 19);
    setLogs((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.message === message && last.tag === tag && last.level === level) {
        return [...prev.slice(0, -1), { ...last, count: last.count + 1 }];
      }
      return [...prev, { id: logIdCounter++, timestamp, tag, level, message, count: 1, botNumber }];
    });
  }, [debugMode]);

  useEffect(() => {
    (globalThis as any).__pupaAppendLog = appendLog;
    return () => { (globalThis as any).__pupaAppendLog = undefined; };
  }, [appendLog]);

  // Compute autocomplete suggestions whenever input changes
  useEffect(() => {
    if (!commandManager?.tree || !commandInput) {
      setSuggestions({ commands: [], descriptions: [] });
      setShowPopup(false);
      setSelectedSuggestion(-1);
      return;
    }
    const { tokens, trailingSpace } = tokenize(commandInput);
    if (tokens.length === 0) {
      // Just "/" typed — show all top-level commands
      const s = getSuggestions(commandManager.tree, "");
      setSuggestions(s);
      setShowPopup(s.commands.length > 0);
      setSelectedSuggestion(-1);
      return;
    }
    const result = resolve(commandManager.tree, tokens);
    const partial = trailingSpace ? "" : tokens[tokens.length - 1];
    // Matched leaf command → no subcommands → no suggestions. Unresolved
    // tokens (nothing matched) stay at the root tree.
    const subTree =
      result.matched.length > 0 ? result.node?.subcommands : commandManager.tree;
    const s = subTree
      ? getSuggestions(subTree, partial)
      : { commands: [], descriptions: [] };
    setSuggestions(s);
    setShowPopup(s.commands.length > 0);
    setSelectedSuggestion(-1);
  }, [commandInput, commandManager]);

  useInput((input, key) => {
    if (key.return) {
      submitInput(inputValue);
    } else if (key.ctrl && (key.leftArrow || key.rightArrow)) {
      // Ctrl+Left/Right cycles through All and per-bot tabs
      cycleTab(key.leftArrow ? -1 : 1);
    } else if (key.meta && /^[0-9]$/.test(input)) {
      // Alt+0 = All tab, Alt+N = bot N tab
      selectTab(parseInt(input, 10));
    } else if (key.upArrow) {
      // Navigate popup suggestions first, then history
      if (showPopup && suggestions.commands.length > 0) {
        setSelectedSuggestion((prev) =>
          prev <= 0 ? suggestions.commands.length - 1 : prev - 1
        );
        return;
      }
      if (history.length === 0) return;
      if (historyIndex === -1) setDraft(inputValue);
      const newIndex = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(newIndex);
      setInputValue(history[history.length - 1 - newIndex]);
    } else if (key.downArrow) {
      // Navigate popup suggestions first, then history
      if (showPopup && suggestions.commands.length > 0) {
        setSelectedSuggestion((prev) =>
          prev >= suggestions.commands.length - 1 ? 0 : prev + 1
        );
        return;
      }
      if (historyIndex === -1) return;
      if (historyIndex === 0) {
        setHistoryIndex(-1);
        setInputValue(draft);
      } else {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setInputValue(history[history.length - 1 - newIndex]);
      }
    } else if (key.tab) {
      completeTab(inputValue);
    } else if (key.escape) {
      if (showPopup) {
        setShowPopup(false);
        setSelectedSuggestion(-1);
      } else {
        setInputValue("");
        setHistoryIndex(-1);
        setDraft("");
      }
    } else if (key.ctrl && input === "c") {
      exit();
    } else if (key.backspace || key.delete) {
      setInputValue((v) => v.slice(0, -1));
    } else if (input) {
      // Ink can deliver coalesced chunks when the event loop is busy (e.g.
      // "/he\t" in one read). Split out embedded control characters so Tab,
      // Enter and Backspace still act instead of becoming literal text.
      let pending = inputValue;
      for (const segment of input.split(/([\t\r\n\u007F])/)) {
        if (segment === "\t") {
          pending = completeTab(pending);
        } else if (segment === "\r" || segment === "\n") {
          submitInput(pending);
          pending = "";
        } else if (segment === "\u007F") {
          pending = pending.slice(0, -1);
          setInputValue(pending);
          setHistoryIndex(-1);
        } else if (segment) {
          pending += segment;
          setInputValue(pending);
          setHistoryIndex(-1);
        }
      }
    }
  });

  const tabLogs =
    activeTab === 0 ? logs : logs.filter((e) => e.botNumber === activeTab);
  const visibleLogs = tabLogs.slice(-50);

  return (
    <Box flexDirection="column" height="100%">
      {botNumbers.length > 0 && (
        <Box>
          {[0, ...botNumbers].map((n) => (
            <Text
              key={n}
              marginRight={1}
              bold={activeTab === n}
              color={activeTab === n ? "black" : "gray"}
              backgroundColor={activeTab === n ? "cyan" : undefined}
            >
              {n === 0 ? " All " : ` bot${n} `}
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visibleLogs.map((entry, i) => (
          <Text key={`${entry.timestamp}-${i}`} color={getLevelColor(entry.level)}>
            {entry.timestamp} {entry.tag && <Text bold>{entry.tag} </Text>}
            [{entry.level}] {entry.message}
            {entry.count > 1 && <Text color="yellow"> (x{entry.count})</Text>}
          </Text>
        ))}
        {activeTab !== 0 && visibleLogs.length === 0 && (
          <Text color="gray">(no activity on bot{activeTab} yet)</Text>
        )}
      </Box>
      {showPopup && suggestions.commands.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginBottom={1}>
          <Text color="gray">── suggestions ──</Text>
          {suggestions.commands.map((cmd, i) => (
            <Text key={cmd} color={i === selectedSuggestion ? "black" : "cyan"} backgroundColor={i === selectedSuggestion ? "cyan" : undefined}>
              {i === selectedSuggestion ? "❯ " : "  "}/{cmd}
              {suggestions.descriptions[i] ? <Text color="gray"> — {suggestions.descriptions[i]}</Text> : null}
            </Text>
          ))}
        </Box>
      )}
      <Box>
        <Text color="green">❯ </Text>
        {activeTab !== 0 && <Text color="yellow">[bot{activeTab}] </Text>}
        <Text color={inputValue.startsWith("/") ? "yellow" : "white"}>{inputValue}</Text>
      </Box>
    </Box>
  );
}

// ── Public API ─────────────────────────────────────────────────────────

async function createTerminalUI(): Promise<UIBackend> {
  if (uiInstance) return uiInstance;
  if (!uiPromise) {
    uiPromise = (async (): Promise<UIBackend> => {
      if (HEADLESS) {
        uiInstance = createHeadlessUI();
        return uiInstance;
      }

      // Ink requires a TTY for raw-mode input; fall back to headless otherwise
      if (!process.stdin.isTTY) {
        uiInstance = createHeadlessUI();
        return uiInstance;
      }

      const inkModule = await loadInk();
      if (!inkModule) {
        uiInstance = createHeadlessUI();
        return uiInstance;
      }

      const inputCallbacks: ((text: string, botNumber?: number) => void)[] = [];

      const handleInputSubmit = (text: string, botNumber?: number) => {
        inputCallbacks.forEach((cb) => {
          try { cb(text, botNumber); } catch (e: unknown) {
            console.error("[Input Handler Error]", e);
          }
        });
      };

      const inkRender = inkModule.render(
        <TuiComponent onInputSubmit={handleInputSubmit} />,
        { stdout: process.stdout }
      );

      uiInstance = {
        _debugMode: false,
        _commandManager: null,
        setDebugMode(enabled: boolean): void {
          this._debugMode = enabled;
          tuiDebugMode = enabled;
          notifyTuiListeners();
        },
        setCommandManager(cm: { tree: Record<string, CommandNode> } | null): void {
          this._commandManager = cm;
          tuiCommandManager = cm;
          notifyTuiListeners();
        },
        setBots(bots: number[]): void {
          tuiBotList = [...bots];
          notifyTuiListeners();
        },
        log(message: unknown, tag: string = "", level: string = "INFO"): void {
          if (level === "DEBUG" && !this._debugMode) return;
          const formatted = formatMessage(message);
          const appendLog = (globalThis as any).__pupaAppendLog;
          if (appendLog) {
            appendLog(tag, level, formatted);
          } else {
            const timestamp = new Date().toISOString().substring(11, 19);
            const tagStr = tag ? `${tag} ` : "";
            const levelStr = `[${level}]`;
            const line = `${timestamp} ${tagStr}${levelStr} ${formatted}`;
            if (level === "ERROR") console.error(line);
            else console.log(line);
          }
        },
        onInput(cb: (text: string, botNumber?: number) => void): void {
          inputCallbacks.push(cb);
        },
        getHistory(): string[] { return []; },
        getScrollPosition(): number { return 0; },
        destroy(): void {
          inkRender.unmount();
          uiInstance = null;
          uiPromise = null;
        },
      };

      return uiInstance;
    })();
  }
  return uiPromise;
}

function createHeadlessUI(): UIBackend {
  function formatMessage(message: unknown): string {
    if (message instanceof Error) return message.stack || String(message);
    if (typeof message === "object" && message !== null) return JSON.stringify(message);
    return String(message);
  }
  return {
    _debugMode: false,
    _commandManager: null,
    setDebugMode(enabled: boolean): void { this._debugMode = enabled; },
    setCommandManager(_cm: { tree: Record<string, CommandNode> } | null): void {},
    setBots(_bots: number[]): void {},
    log(message: unknown, tag: string = "", level: string = "INFO"): void {
      if (!this._debugMode && level === "DEBUG") return;
      const formatted = formatMessage(message);
      const tagStr = tag ? `${tag} ` : "";
      const levelStr = `[${level}]`;
      const timestamp = new Date().toISOString().substring(11, 19);
      const line = `${timestamp} ${tagStr}${levelStr} ${formatted}`;
      if (level === "ERROR") console.error(line);
      else console.log(line);
    },
    onInput(_cb: (text: string, botNumber?: number) => void): void {},
    getHistory(): string[] { return []; },
    getScrollPosition(): number { return 0; },
    destroy(): void {},
  };
}

export { createTerminalUI, createHeadlessUI };
export type { UIBackend };
