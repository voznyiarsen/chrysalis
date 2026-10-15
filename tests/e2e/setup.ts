/**
 * @fileoverview Shared E2E setup for Pupa integration tests.
 *
 * Provides session identity (concurrent-safe usernames/positions), bot
 * creation, OP probing, polling helpers, and 1.12.2 vs 1.13+ command
 * branching. All `tests/e2e/*.test.ts` files build on these helpers so
 * server-command syntax and lifecycle handling stay in one place.
 */

import mineflayer, { Bot } from "mineflayer";
import { pathfinder } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { PVPManager } from "../../src/pvp";
import { attachInventory } from "../../src/inventory";
import { attachCombat } from "../../src/pvp";
import { attachCommands } from "../../src/commands";
import { attachUtils } from "../../src/utils";
import { RuntimeConfig } from "../../src/config";
import { logger } from "../../src/logger";

// ── Timeouts ─────────────────────────────────────────────────────────

/** Per-test timeout in ms, from `E2E_TIMEOUT` (seconds, default 60). */
export function e2eTimeoutMs(): number {
  return parseInt(process.env.E2E_TIMEOUT || "60", 10) * 1000;
}

// ── Session identity (concurrent-safe) ───────────────────────────────
// Minecraft usernames are limited to 16 chars, so suite keys stay short.

/** Short per-suite keys; full usernames are `<key>_<suffix>`. */
export type SuiteKey = "inv" | "jmp" | "prl" | "pvp";

/** Hash a string to a non-negative integer (djb2). */
export function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Session suffix for concurrent runs. Explicit `E2E_SUFFIX` wins (CI);
 * otherwise a short generated suffix from time+pid. Sanitized to
 * alphanumerics, max 12 chars so usernames stay within the 16-char limit.
 */
export function getSessionSuffix(): string {
  const raw =
    process.env.E2E_SUFFIX ||
    `${Date.now().toString(36)}${process.pid.toString(36)}`;
  return raw.replace(/[^A-Za-z0-9_]/g, "").slice(-12) || "s0";
}

/** Concurrent-safe username for a suite key. */
export function getUsername(key: SuiteKey): string {
  const name = `${key}_${getSessionSuffix()}`;
  if (name.length > 16) {
    throw new Error(
      `E2E username '${name}' exceeds Minecraft's 16-char limit; set a shorter E2E_SUFFIX`,
    );
  }
  return name;
}

/**
 * Session-specific spawn position: base plus a deterministic slot offset
 * (0–700 blocks on X) so concurrent sessions of the same suite do not share
 * ground. Assumes a reasonably flat test world near the base positions.
 */
export function getSessionPosition(base: Vec3): Vec3 {
  const slot = simpleHash(getSessionSuffix()) % 8;
  return base.offset(slot * 100, 0, 0);
}

// ── Version branching (1.12.2 vs 1.13+) ──────────────────────────────

/** Raw version string under test (default 1.12.2). */
export function e2eVersion(): string {
  return process.env.E2E_VERSION || "1.12.2";
}

/** True for 1.13+ command syntax (flattened IDs, new selectors/NBT). */
export function isModernVersion(version: string = e2eVersion()): boolean {
  const parts = version.split(".").map(Number);
  if (parts[0] > 1) return true;
  if (parts[0] < 1) return false;
  return (parts[1] ?? 0) >= 13;
}

/** `/summon` command for a zombie above the bot (no leading slash). */
export function summonZombieCmd(version: string = e2eVersion()): string {
  return isModernVersion(version)
    ? "summon zombie ~ ~1 ~"
    : "summon Zombie ~ ~1 ~";
}

/**
 * `/summon` command for a passive test animal (no leading slash).
 * Passive mobs survive on peaceful-like servers where hostiles are cleared
 * on spawn, so combat E2E uses pigs instead of zombies.
 */
export function summonTargetCmd(version: string = e2eVersion()): string {
  return isModernVersion(version) ? "summon pig ~ ~1 ~" : "summon Pig ~ ~1 ~";
}

/** Entity type selector for the test animal, branched by version. */
export function targetTypeSelector(version: string = e2eVersion()): string {
  return isModernVersion(version) ? "type=pig" : "type=Pig";
}

/**
 * Summon a passive test animal and wait for it to appear in bot entities.
 * Matches by entity id (snapshot before summon) so no version-specific name
 * strings are needed. Returns null on timeout (~60 ticks).
 */
export async function summonTarget(bot: Bot): Promise<any> {
  const before = new Set(Object.keys(bot.entities).map((k) => parseInt(k, 10)));
  bot.chat!(`/${summonTargetCmd()}`);
  for (let i = 0; i < 60; i++) {
    await bot.waitForTicks!(1);
    for (const [idStr, entity] of Object.entries(bot.entities)) {
      const id = parseInt(idStr, 10);
      if (before.has(id)) continue;
      const e = entity as any;
      // A freshly summoned creature: has position, is not a player.
      if (e.position && e.type !== "player") return e;
    }
  }
  return null;
}

/** `/kill` command for all non-player entities within radius. */
export function killMobsCmd(
  radius: number,
  version: string = e2eVersion(),
): string {
  return isModernVersion(version)
    ? `kill @e[type=!player,distance=..${radius}]`
    : `kill @e[type=!Player,r=${radius}]`;
}

/** `/effect` give command (no leading slash). */
export function effectGiveCmd(
  target: string,
  effect: string,
  seconds: number,
  amplifier: number,
  version: string = e2eVersion(),
): string {
  return isModernVersion(version)
    ? `effect give ${target} ${effect} ${seconds} ${amplifier} true`
    : `effect ${target} ${effect} ${seconds} ${amplifier} true`;
}

/** `/effect` clear command (no leading slash). */
export function effectClearCmd(
  target: string = "@p",
  version: string = e2eVersion(),
): string {
  return isModernVersion(version)
    ? `effect clear ${target}`
    : `effect ${target} clear`;
}

export interface GiveOpts {
  count?: number;
  /** 1.12.2 data value (ignored on 1.13+, which uses distinct items). */
  metadata?: number;
  /** Raw NBT tag, e.g. `{ench:[{id:0,lvl:5}]}` (legacy form). */
  nbt?: string;
}

/**
 * Build a full `/give` command for either syntax generation.
 * Modern NBT uses `{...}` appended to the item: pass `modernNbt` when it
 * differs from the legacy tag.
 */
export function buildGiveCmd(
  itemName: string,
  opts: GiveOpts = {},
  version: string = e2eVersion(),
  modernNbt?: string,
): string {
  const count = opts.count ?? 1;
  if (isModernVersion(version)) {
    const tag = modernNbt ?? opts.nbt ?? "";
    return `/give @p ${itemName}${tag} ${count}`;
  }
  let args = `@p ${itemName}`;
  const hasExtra = opts.metadata !== undefined || opts.nbt !== undefined;
  if (count !== 1 || hasExtra) args += ` ${count}`;
  if (opts.metadata !== undefined) {
    args += ` ${opts.metadata}`;
  } else if (opts.nbt) {
    // 1.12.2 requires a data value before the dataTag; default to 0.
    args += ` 0`;
  }
  if (opts.nbt) args += ` ${opts.nbt}`;
  return `/give ${args}`;
}

export interface EnchantSpec {
  /** 1.12.2 numeric enchantment ID. */
  id: number;
  /** 1.13+ enchantment key. */
  key: string;
  lvl: number;
}

/** Enchantment NBT tag for `/give`, branched by version. */
export function enchNbt(
  enchants: EnchantSpec[],
  version: string = e2eVersion(),
): { legacy?: string; modern?: string } {
  if (isModernVersion(version)) {
    const list = enchants.map((e) => `{id:"${e.key}",lvl:${e.lvl}}`).join(",");
    return { modern: `{Enchantments:[${list}]}` };
  }
  const list = enchants.map((e) => `{id:${e.id},lvl:${e.lvl}}`).join(",");
  return { legacy: `{ench:[${list}]}` };
}

// ── Bot lifecycle ────────────────────────────────────────────────────

export interface CreateBotOpts {
  username: string;
  timeoutMs: number;
}

/** Connect a bot and attach all Pupa managers. No world setup yet. */
export async function createBot(opts: CreateBotOpts): Promise<Bot> {
  const bot = mineflayer.createBot({
    host: process.env.E2E_HOST!,
    port: parseInt(process.env.E2E_PORT || "25565", 10),
    username: opts.username,
    version: process.env.E2E_VERSION || undefined,
    logErrors: true,
    hideErrors: false,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      bot.removeAllListeners("spawn");
      bot.removeAllListeners("error");
      bot.removeAllListeners("end");
      reject(
        new Error(
          `Connection timed out after ${opts.timeoutMs}ms — is the server at ${process.env.E2E_HOST}:${process.env.E2E_PORT || "25565"} reachable?`,
        ),
      );
    }, opts.timeoutMs);

    bot.once("spawn", () => {
      clearTimeout(timer);
      resolve();
    });
    bot.once("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    bot.once("end", () => {
      clearTimeout(timer);
      reject(new Error("Bot disconnected before spawn"));
    });
  });

  bot.loadPlugin(pathfinder);
  bot.pvp = new PVPManager(bot);

  bot.runtimeConfig = new RuntimeConfig();
  bot.__logger = logger;
  attachInventory(bot);
  attachCombat(bot);
  attachCommands(bot);
  attachUtils(bot);

  logger.setDebugMode(true);

  return bot;
}

/**
 * Poll a condition once per tick until true or ticks run out.
 * Throws a descriptive error on timeout so failures name the missing state.
 */
export async function pollUntil(
  bot: Bot,
  condition: () => boolean,
  ticks: number,
  desc: string,
): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (condition()) return;
    await bot.waitForTicks!(1);
  }
  throw new Error(`Timed out after ${ticks} ticks waiting for: ${desc}`);
}

/**
 * Verify the bot has operator permission by switching to creative and
 * polling `gameMode`. Throws a fail-fast error naming the `/op` fix;
 * every E2E suite requires OP for `/give`, `/tp`, `/effect`, etc.
 */
export async function ensureOp(bot: Bot, ticks: number = 40): Promise<void> {
  bot.chat!("/gamemode creative");
  try {
    await pollUntil(
      bot,
      () => bot.game.gameMode === "creative",
      ticks,
      "creative gamemode (OP check)",
    );
  } catch {
    throw new Error(
      `E2E bot '${bot.username}' lacks operator permission: /gamemode creative had no effect. ` +
        `Run \`/op ${bot.username}\` on the server console and re-run. ` +
        `Note: RCON (nibble.internal:25575) refused connection, so OP must be granted via console.`,
    );
  }
}

/**
 * Ready a bot for tests: teleport to position, wait for chunks, verify OP.
 * Call once in `beforeAll`; `beforeEach` only needs re-teleport + reset.
 */
export async function ensureReady(bot: Bot, position: Vec3): Promise<void> {
  bot.chat!(`/tp ${position.x} ${position.y} ${position.z}`);
  await bot.waitForChunksToLoad!();
  await bot.waitForTicks!(1);
  await ensureOp(bot);
  bot.chat!(`/tp ${position.x} ${position.y} ${position.z}`);
  await bot.waitForChunksToLoad!();
  await bot.waitForTicks!(1);
}

/** Common reset between tests: stop movement, clear entities state, creative. */
export async function resetBotState(bot: Bot): Promise<void> {
  bot.clearControlStates();
  bot.pathfinder?.stop();
  bot.pvp?.forceStop();
  await bot.inventoryManager.setGamemode(1);
  await bot.waitForTicks!(2);
}

/** Log a skip-safe suite header describing live-server assumptions. */
export function logSuiteStart(name: string, username: string): void {
  logger.info(
    `${name}: user=${username} host=${process.env.E2E_HOST} version=${e2eVersion()} modern=${isModernVersion()}`,
    "Command",
  );
}
