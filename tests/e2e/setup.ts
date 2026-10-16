/**
 * @fileoverview Shared E2E setup for Pupa integration tests.
 *
 * Provides session identity (concurrent-safe usernames/positions), bot
 * creation, OP probing, polling helpers, and 1.12.2 vs 1.13+ command
 * branching. All `tests/e2e/*.test.ts` files build on these helpers so
 * server-command syntax and lifecycle handling stay in one place.
 */

// Surface async crashes with full stacks: several E2E flakes turned out to
// be unhandled rejections surfacing as bare "Test suite failed to run".
process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error(`[e2e-setup] unhandledRejection: ${reason}`);
});
process.on("uncaughtException", (error) => {
  // eslint-disable-next-line no-console
  console.error(`[e2e-setup] uncaughtException: ${error}`);
});

import mineflayer, { Bot } from "mineflayer";
import { pathfinder } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { createRequire } from "node:module";
import * as dns from "node:dns";

type RconFn = (
  host: string,
  port: number,
  pass: string,
  cmds: string[],
) => Promise<string[]>;

/**
 * Eagerly load the plain-JS RCON client at module load: lazy require() from
 * a dangling async continuation can fire after Jest tears the environment
 * down ("require after teardown"), failing the whole suite file.
 */
let rconCommands: RconFn | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeRequire = createRequire(__filename);
  rconCommands =
    (nodeRequire("../../scripts/rcon") as { rconCommands: RconFn })
      .rconCommands ?? null;
} catch {
  rconCommands = null;
}

let rconHostCache: string | null = null;

/** RCON command runner, or null when unavailable (logs the reason once). */
async function rcon(cmds: string[]): Promise<string[] | null> {
  if (!process.env.RCON_PASS || !rconCommands) return null;
  // Cache the resolved IP: local DNS has been observed flapping mid-run
  // (ENOTFOUND), which turns every per-call lookup into a failure.
  if (!rconHostCache) {
    try {
      const r = await dns.promises.lookup(
        process.env.RCON_HOST || process.env.E2E_HOST || "localhost",
      );
      rconHostCache = r.address;
    } catch {
      return null;
    }
  }
  try {
    return await rconCommands(
      rconHostCache,
      parseInt(process.env.RCON_PORT || "25575", 10),
      process.env.RCON_PASS,
      cmds,
    );
  } catch (error) {
    logger.warning(
      `E2E: RCON failed (${(error as Error).message})`,
      "Command",
    );
    return null;
  }
}

let rconUnavailableWarned = false;

/**
 * Run a server command, preferring RCON (server-console privileges, immune
 * to player OP flaps) with in-game chat fallback. `cmd` has no leading
 * slash. Returns the server response (RCON) or "" (chat fallback).
 *
 * NOTE: position-relative selectors (~) and radius selectors (r=,
 * distance=) only resolve for in-game executors. Callers needing them must
 * either pass absolute coordinates/usernames (preferred) or use bot.chat
 * directly.
 */
export async function serverCommand(bot: Bot, cmd: string): Promise<string> {
  const clean = cmd.startsWith("/") ? cmd.slice(1) : cmd;
  if (process.env.RCON_PASS && rconCommands) {
    const out = await rcon([clean]);
    if (out) return out[0] ?? "";
    // RCON failed despite configured password; fall through to chat.
  } else if (!rconUnavailableWarned) {
    rconUnavailableWarned = true;
    logger.warning(
      "E2E: RCON_PASS unset, falling back to in-game commands (flakier under OP loss)",
      "Command",
    );
  }
  bot.chat!(`/${clean}`);
  return "";
}
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
  target: string = "@p",
): string {
  const count = opts.count ?? 1;
  if (isModernVersion(version)) {
    const tag = modernNbt ?? opts.nbt ?? "";
    return `/give ${target} ${itemName}${tag} ${count}`;
  }
  let args = `${target} ${itemName}`;
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

/**
 * `/give` command for RCON/chat-agnostic sending: no leading slash and an
 * explicit player (RCON has no @p context).
 */
export function buildServerGiveCmd(
  username: string,
  itemName: string,
  opts: GiveOpts = {},
  version: string = e2eVersion(),
  modernNbt?: string,
): string {
  return buildGiveCmd(itemName, opts, version, modernNbt, username).replace(
    /^\//,
    "",
  );
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
  const t0 = Date.now();
  for (let i = 0; i < ticks; i++) {
    if (condition()) return;
    await bot.waitForTicks!(1);
  }
  const wallMs = Date.now() - t0;
  throw new Error(
    `Timed out after ${ticks} ticks (${wallMs}ms wall) waiting for: ${desc}`,
  );
}

/**
 * Verify the bot has operator permission by switching to creative and
 * polling `gameMode`. Throws a fail-fast error naming the `/op` fix;
 * every E2E suite requires OP for `/give`, `/tp`, `/effect`, etc.
 */
export async function ensureOp(bot: Bot, ticks: number = 40): Promise<void> {
  // Grant via RCON up front when available: server ops are revoked at
  // unpredictable times, and starting opped makes verification one round.
  if (process.env.RCON_PASS) {
    logger.info(`E2E: ensuring OP for '${bot.username}' via RCON`, "Command");
    await rcon([`op ${bot.username}`]);
  }
  // Three rounds with wall-clock breathers: transient stalls (server or
  // worker event-loop freezes of ~1min have been observed) look exactly
  // like missing OP; spacing rounds lets them pass instead of failing.
  for (let round = 0; round < 3; round++) {
    if (round > 0) {
      await new Promise((resolve) => setTimeout(resolve, 20000));
    }
    await serverCommand(bot, "gamemode creative");
    try {
      await pollUntil(
        bot,
        () => bot.game.gameMode === "creative",
        ticks,
        "creative gamemode (OP check)",
      );
      return;
    } catch {
      // Fall through to the OP heal below.
    }
    // Re-grant (covers mid-run revocation) and retry once.
    if (!process.env.RCON_PASS) break;
    logger.info(
      `E2E: OP lost for '${bot.username}', re-granting via RCON`,
      "Command",
    );
    await rcon([`op ${bot.username}`]);
  }
  throw new Error(
    `E2E bot '${bot.username}' lacks operator permission: /gamemode creative had no effect. ` +
      `Grant OP first: \`npm run e2e:op\` (with RCON_PASS set) or ` +
      `\`/op ${bot.username}\` on the server console, then re-run.`,
  );
}

/**
 * Set server difficulty, preferring RCON (works even when the bot's OP was
 * revoked mid-run) with in-game chat fallback. Never throws for the chat
 * path — callers poll functionally afterwards.
 */
export async function setDifficulty(
  bot: Bot,
  level: "normal" | "peaceful",
): Promise<void> {
  if (process.env.RCON_PASS) {
    try {
      await rcon([`difficulty ${level}`]);
      logger.info(`E2E: difficulty ${level} via RCON`, "Command");
      return;
    } catch (error) {
      logger.warning(
        `E2E: RCON difficulty ${level} failed (${(error as Error).message}), falling back to chat`,
        "Command",
      );
    }
  }
  bot.chat!(`/difficulty ${level}`);
  await bot.waitForTicks!(10);
}

/**
 * Send a server command and verify its effect, healing OP once via RCON on
 * failure. Fire-and-forget /commands are the top E2E flake source: the
 * server silently drops them when the bot is (often transiently) deopped.
 */
export async function sendCommandVerified(
  bot: Bot,
  command: string,
  verify: () => boolean,
  desc: string,
  ticks: number = 60,
): Promise<void> {
  const full = command.startsWith("/") ? command.slice(1) : command;
  for (let attempt = 0; attempt < 2; attempt++) {
    await serverCommand(bot, full);
    try {
      await pollUntil(bot, verify, ticks, `${desc} (attempt ${attempt + 1})`);
      return;
    } catch {
      logger.info(`E2E: '${desc}' unverified, re-granting OP and retrying`, "Command");
      await rcon([`op ${bot.username}`]);
    }
  }
  throw new Error(`E2E: '${desc}' unverified after 2 attempts`);
}

/**
 * Whether hostile mobs survive on this server. Peaceful-like servers clear
 * hostiles on spawn (1.12.2 has no readable difficulty command, so probe
 * functionally: summon a zombie and check it is still alive after 40 ticks).
 */
export async function probeHostiles(bot: Bot): Promise<boolean> {
  const before = new Set(Object.keys(bot.entities).map((k) => parseInt(k, 10)));
  bot.chat!(`/${summonZombieCmd()}`);
  for (let i = 0; i < 40; i++) {
    await bot.waitForTicks!(1);
    for (const [idStr, entity] of Object.entries(bot.entities)) {
      if (before.has(parseInt(idStr, 10))) continue;
      const e = entity as any;
      if (e.position && e.type !== "player") return true;
    }
  }
  return false;
}

export interface DifficultyToken {
  /** Hostiles survive (either natively or after our bump). */
  hostiles: boolean;
  /** We changed the difficulty and the caller should restore it. */
  bumped: boolean;
}

/**
 * Ensure hostiles survive for combat E2E, bumping difficulty to normal when
 * the server runs peaceful-like. Per project policy the suite sets the
 * difficulty its tests require; call restoreDifficulty in afterAll.
 */
export async function ensureHostiles(bot: Bot): Promise<DifficultyToken> {
  if (await probeHostiles(bot)) return { hostiles: true, bumped: false };
  logger.info("E2E: no hostiles (peaceful-like); setting difficulty normal", "Command");
  await setDifficulty(bot, "normal");
  await bot.waitForTicks!(20);
  for (let round = 0; round < 3; round++) {
    if (await probeHostiles(bot)) return { hostiles: true, bumped: true };
  }
  logger.warning("E2E: hostiles still cleared; falling back to passive targets", "Command");
  return { hostiles: false, bumped: true };
}

/** Restore peaceful difficulty if ensureHostiles bumped it. */
export async function restoreDifficulty(
  bot: Bot,
  token: DifficultyToken,
): Promise<void> {
  if (!token.bumped) return;
  logger.info("E2E: restoring difficulty peaceful", "Command");
  await setDifficulty(bot, "peaceful");
}

/**
 * Enter survival, verifying the switch (heals OP once on failure: a
 * deopped bot silently stays creative, where falls and eating do nothing).
 */
export async function ensureSurvival(bot: Bot): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await serverCommand(bot, `gamemode survival ${bot.username}`);
    try {
      await pollUntil(
        bot,
        () => bot.game.gameMode === "survival",
        40,
        `survival gamemode (attempt ${attempt + 1})`,
      );
      return;
    } catch {
      if (attempt === 0) {
        logger.info(
          "Survival switch unverified; healing OP and retrying",
          "Command",
        );
        await ensureOp(bot);
      }
    }
  }
  throw new Error("Could not enter survival gamemode");
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
  // ensureOp (not bare setGamemode): server ops are revoked mid-run, and
  // this re-grants via RCON when RCON_PASS is set. Never throws here —
  // beforeAll already proved OP once; a later loss surfaces per-test.
  try {
    await ensureOp(bot, 40);
  } catch (error) {
    logger.warning(
      `resetBotState: ${(error as Error).message}`,
      "Command",
    );
  }
  await bot.waitForTicks!(2);
}

/**
 * Teleport with arrival verification (heals OP once on failure: a deopped
 * /tp silently leaves the bot behind, invalidating everything after it).
 */
export async function tpBot(
  bot: Bot,
  x: number,
  y: number,
  z: number,
): Promise<void> {
  const target = new Vec3(x, y, z);
  for (let attempt = 0; attempt < 2; attempt++) {
    await serverCommand(bot, `tp ${bot.username} ${x} ${y} ${z}`);
    try {
      await pollUntil(
        bot,
        () => bot.entity.position.distanceTo(target) < 1.0,
        60,
        `teleport to ${x} ${y} ${z} (attempt ${attempt + 1})`,
      );
      return;
    } catch {
      if (attempt === 0) {
        logger.info("Teleport unverified; healing OP and retrying", "Command");
        await ensureOp(bot);
      }
    }
  }
  throw new Error(`Teleport to ${x} ${y} ${z} unverified after 2 attempts`);
}

/** Log a skip-safe suite header describing live-server assumptions. */
export function logSuiteStart(name: string, username: string): void {
  logger.info(
    `${name}: user=${username} host=${process.env.E2E_HOST} version=${e2eVersion()} modern=${isModernVersion()}`,
    "Command",
  );
}
