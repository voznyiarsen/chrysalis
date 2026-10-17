/**
 * @fileoverview Shared E2E setup for Pupa integration tests.
 *
 * Provides session identity (concurrent-safe usernames/positions), bot
 * creation, polling helpers, and 1.12.2 vs 1.13+ command branching.
 *
 * Design: environment setup goes EXCLUSIVELY through RCON (server-console
 * privileges — bots never need OP), bot setup is pure client-side, and
 * test execution only plays the game. All `tests/e2e/*.test.ts` files
 * build on these helpers so server-command syntax stays in one place.
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
  // Retry with backoff: the server thread occasionally stalls 10s+
  // (RCON timeouts observed), then recovers. A failed transport here must
  // not silently degrade into an unauthenticated fallback.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    try {
      return await rconCommands(
        rconHostCache,
        parseInt(process.env.RCON_PORT || "25575", 10),
        process.env.RCON_PASS,
        cmds,
      );
    } catch (error) {
      lastError = error;
      logger.warning(
        `E2E: RCON attempt ${attempt + 1} failed (${(error as Error).message})`,
        "Command",
      );
    }
  }
  logger.warning(
    `E2E: RCON failed after retries (${(lastError as Error)?.message})`,
    "Command",
  );
  return null;
}

let rconUnavailableWarned = false;

/**
 * Require RCON for E2E environment setup. Throws a clear error when
 * RCON_PASS is unset so suites fail fast instead of flaking on
 * permission-dependent commands.
 */
export function requireRcon(): void {
  if (!process.env.RCON_PASS || !rconCommands) {
    throw new Error(
      "E2E requires RCON_PASS (RCON_HOST/RCON_PORT optional). " +
        "Set it in .env — see .env.example. Bots themselves need no OP.",
    );
  }
}

/**
 * Run a server command, preferring RCON (server-console privileges; bots
 * never need OP) with in-game chat fallback. `cmd` has no leading slash.
 * Returns the server response (RCON) or "" (chat fallback).
 *
 * NOTE: position-relative selectors (~) and radius selectors (r=,
 * distance=) only resolve for in-game executors. Callers needing them must
 * either pass absolute coordinates/usernames (preferred) or use bot.chat
 * directly (last resort — untestable without OP).
 */
export async function serverCommand(bot: Bot, cmd: string): Promise<string> {
  const clean = cmd.startsWith("/") ? cmd.slice(1) : cmd;
  if (process.env.RCON_PASS && rconCommands) {
    // Outer retry: server stalls can exceed the inner rcon() retry budget.
    // Retry the whole command with a longer backoff to ride out multi-second
    // server freezes without failing the test.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
      const out = await rcon([clean]);
      if (out) {
        const response = out[0] ?? "";
        // Fail fast on RCON error responses instead of polling to timeout:
        // a targetless /gamemode, bad selector, or unloaded-chunk summon
        // reports here, not in-game.
        if (/unknown command|usage:|incorrect|error|failed|invalid|could not|cannot summon|no entity|not found/i.test(response)) {
          throw new Error(`E2E RCON '${clean}' rejected: ${response}`);
        }
        return response;
      }
      lastError = new Error(`E2E RCON transport returned null for '${clean}'`);
    }
    // RCON was configured but unreachable even after retries: falling back
    // to unauthenticated chat would silently fail every privileged command,
    // so fail loudly instead.
    throw lastError ?? new Error(
      `E2E RCON transport failed for '${clean}' (see warnings above)`,
    );
  }
  if (!rconUnavailableWarned) {
    rconUnavailableWarned = true;
    logger.warning(
      "E2E: RCON_PASS unset, falling back to in-game commands (requires OP, flakier)",
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
export type SuiteKey =
  | "inv"
  | "jmp"
  | "prl"
  | "pvp"
  /** 2-bot combat-loop suite: attacker / target */
  | "pva"
  | "pvt";

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
/**
 * `/summon` command with absolute coordinates (no leading slash), suitable
 * for RCON (console has no ~ context). `name` is version-appropriate
 * ("Zombie"/"Pig" legacy, lowercase modern).
 */
export function summonCmd(
  name: string,
  x: number,
  y: number,
  z: number,
  version: string = e2eVersion(),
): string {
  const id = isModernVersion(version) ? name.toLowerCase() : name;
  return `summon ${id} ${x} ${y} ${z}`;
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
/**
 * Summon a passive test animal one block above the bot via RCON and wait
 * for it to appear in bot entities. Matches by entity id (snapshot before
 * summon) so no version-specific name strings are needed. Returns null on
 * timeout (~60 ticks).
 */
export async function summonTarget(bot: Bot): Promise<any> {
  return summonNear(bot, "Pig");
}

/**
 * Summon a mob one block above the bot via RCON and return the new entity
 * CLOSEST to the bot. First-found matching is racy: a natural spawn packet
 * arriving in the same window would be picked instead. Our summon lands at
 * the bot's feet while natural spawns occur 24+ blocks out, so closest wins.
 */
export async function summonNear(bot: Bot, name: string): Promise<any> {
  const before = new Set(Object.keys(bot.entities).map((k) => parseInt(k, 10)));
  const p = bot.entity.position;
  await serverCommand(bot, summonCmd(name, p.x, p.y + 1, p.z));
  const nameRe = new RegExp(name, "i");
  let seen = false;
  for (let i = 0; i < 60; i++) {
    await bot.waitForTicks!(1);
    for (const [idStr, entity] of Object.entries(bot.entities)) {
      const id = parseInt(idStr, 10);
      if (before.has(id)) continue;
      const e = entity as any;
      if (e.position && e.type !== "player" && nameRe.test(e.name ?? "")) {
        seen = true;
        break;
      }
    }
    if (seen) break;
  }
  if (!seen) return null;
  // Settle a few ticks so same-window natural spawns also arrive, then pick
  // the closest matching entity: our summon lands at the bot's feet while
  // natural spawns occur 24+ blocks out.
  await bot.waitForTicks!(3);
  let best: any = null;
  let bestDist = Number.MAX_VALUE;
  for (const [idStr, entity] of Object.entries(bot.entities)) {
    const id = parseInt(idStr, 10);
    if (before.has(id)) continue;
    const e = entity as any;
    if (!e.position || e.type === "player") continue;
    if (!nameRe.test(e.name ?? "")) continue;
    const d = e.position.distanceTo(bot.entity.position);
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  return best;
}

/**
 * `/kill` command for all non-player entities within radius of an explicit
 * position (no leading slash). Positioned selectors resolve from RCON;
 * bare radius selectors only work for in-game executors.
 */
export function killMobsCmd(
  radius: number,
  x: number,
  y: number,
  z: number,
  version: string = e2eVersion(),
): string {
  return isModernVersion(version)
    ? `kill @e[type=!player,x=${x},y=${y},z=${z},distance=..${radius}]`
    : `kill @e[type=!Player,x=${x},y=${y},z=${z},r=${radius}]`;
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

  // Liveness flag for reconnect-resume: a server restart mid-suite kills
  // the socket without failing the worker. beforeEach checks isBotAlive
  // and rebuilds the bot + environment when set.
  bot.once("end", () => {
    (bot as any)._e2eDead = true;
  });

  return bot;
}

/** False when the bot's connection died (e.g. server restart mid-suite). */
export function isBotAlive(bot: Bot | undefined): bot is Bot {
  return !!bot && !(bot as any)._e2eDead && bot.entity !== undefined;
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
 * Set server difficulty via RCON (environment setup never depends on
 * player OP). Callers verify functionally afterwards (e.g. probeHostiles).
 */
export async function setDifficulty(
  level: "normal" | "peaceful",
): Promise<void> {
  const out = await rcon([`difficulty ${level}`]);
  if (!out) {
    throw new Error("E2E: RCON unavailable for setDifficulty");
  }
  logger.info(`E2E: difficulty ${level} via RCON`, "Command");
}

/**
 * Send a server command (RCON-first) and verify its effect with a generous
 * poll. Single send: RCON executes synchronously server-side, so a missing
 * effect is a real anomaly, not a permission flap — fail loudly.
 */
export async function sendCommandVerified(
  bot: Bot,
  command: string,
  verify: () => boolean,
  desc: string,
  ticks: number = 60,
): Promise<void> {
  const full = command.startsWith("/") ? command.slice(1) : command;
  await serverCommand(bot, full);
  await pollUntil(bot, verify, ticks, desc);
}

/**
 * Whether hostile mobs survive on this server. Peaceful-like servers clear
 * hostiles on spawn (1.12.2 has no readable difficulty command, so probe
 * functionally: summon a zombie and check a zombie is still alive after 40
 * ticks). Must match by NAME: accepting any new entity false-positives on
 * wandering pigs/items, which silently disables every zombie test.
 */
export async function probeHostiles(bot: Bot): Promise<boolean> {
  const before = new Set(Object.keys(bot.entities).map((k) => parseInt(k, 10)));
  const p = bot.entity.position;
  await serverCommand(bot, summonCmd("Zombie", p.x, p.y + 1, p.z));
  const seen = new Set<number>();
  for (let i = 0; i < 40; i++) {
    await bot.waitForTicks!(1);
    for (const [idStr, entity] of Object.entries(bot.entities)) {
      const id = parseInt(idStr, 10);
      if (before.has(id)) continue;
      const e = entity as any;
      if (e.position && /zombie/i.test(e.name ?? "")) seen.add(id);
    }
  }
  // A Peaceful server clears the just-summoned zombie within a tick or two,
  // but its spawn packet can still reach the client first. A sighting alone
  // is therefore not proof of hostile support: the zombie must still exist
  // when the window ends.
  let survived = false;
  for (const id of seen) {
    if (bot.entities[id]) {
      survived = true;
      break;
    }
  }
  // Remove the probe zombie before returning. Where hostiles are enabled it
  // survives the window and would otherwise stand at the bot's side,
  // attacking it for the rest of the suite (its knockback and damage break
  // health/threshold assertions in unrelated tests).
  try {
    await serverCommand(bot, killMobsCmd(6, p.x, p.y, p.z));
    await bot.waitForTicks!(2);
  } catch (error) {
    logger.warning(
      `E2E: probe zombie cleanup failed: ${(error as Error).message}`,
      "Command",
    );
  }
  return survived;
}

export interface EnvToken {
  /** Difficulty was bumped (caller should restore). */
  difficultyBumped: boolean;
  /** Daylight cycle was frozen (caller should unfreeze). */
  timeFrozen: boolean;
  /** Hostiles survive (functional probe). */
  hostiles: boolean;
}

async function rconOrThrow(cmds: string[]): Promise<string[]> {
  const out = await rcon(cmds);
  if (!out) {
    throw new Error(
      "E2E environment setup requires RCON (RCON_PASS unset or unreachable)",
    );
  }
  return out;
}

/**
 * Authoritative E2E environment setup via RCON (server-console level,
 * immune to player OP flaps):
 * - difficulty normal (unless already survivable), verified by zombie probe
 * - optionally frozen night (no zombie burn, deterministic mob behavior)
 *
 * Without RCON_PASS, degrades gracefully: probes current state and returns
 * it, leaving adaptive fallbacks (pigs, skips) to the caller. Call
 * restoreTestEnvironment in afterAll.
 */
export async function ensureTestEnvironment(
  bot: Bot,
  opts: { difficulty?: "normal"; freezeNight?: boolean } = {},
): Promise<EnvToken> {
  const token: EnvToken = {
    difficultyBumped: false,
    timeFrozen: false,
    hostiles: false,
  };
  if (!process.env.RCON_PASS || !rconCommands) {
    logger.warning(
      "E2E: no RCON, probing environment instead of managing it",
      "Command",
    );
    token.hostiles = await probeHostiles(bot);
    return token;
  }
  if (opts.difficulty === "normal") {
    if (!(await probeHostiles(bot))) {
      logger.info("E2E: setting difficulty normal via RCON", "Command");
      await rconOrThrow(["difficulty normal"]);
      token.difficultyBumped = true;
    }
    for (let round = 0; round < 3; round++) {
      if (await probeHostiles(bot)) {
        token.hostiles = true;
        break;
      }
    }
    if (!token.hostiles) {
      logger.warning(
        "E2E: hostiles still cleared after difficulty normal",
        "Command",
      );
    }
  } else {
    token.hostiles = await probeHostiles(bot);
  }
  if (opts.freezeNight) {
    logger.info("E2E: freezing night via RCON", "Command");
    await rconOrThrow(["time set 18000", "gamerule doDaylightCycle false"]);
    await pollUntil(
      bot,
      () => bot.time.timeOfDay > 17500 && bot.time.timeOfDay < 18500,
      40,
      "night to hold after freeze",
    );
    token.timeFrozen = true;
  } else {
    // Without this, a suite inherits whatever world time the previous suite
    // left behind. The PvP suite freezes midnight and only unfreezes the
    // daylight cycle on restore, so the next suite can start in darkness
    // with nocturnal mobs wandering in: their knockback and damage break
    // movement and health assertions in unrelated tests. Pin daytime and
    // clear hostiles that already spawned under the previous night.
    logger.info("E2E: setting daytime via RCON", "Command");
    await rconOrThrow(["time set day", "gamerule doDaylightCycle true"]);
    const p = bot.entity.position;
    try {
      await serverCommand(bot, killMobsCmd(130, p.x, p.y, p.z));
      await bot.waitForTicks!(10);
    } catch (error) {
      logger.warning(
        `E2E: daytime mob cleanup failed: ${(error as Error).message}`,
        "Command",
      );
    }
  }
  return token;
}

/** Restore difficulty/time changes made by ensureTestEnvironment. */
export async function restoreTestEnvironment(
  bot: Bot,
  token: EnvToken,
): Promise<void> {
  if (token.timeFrozen) {
    logger.info("E2E: restoring daylight cycle", "Command");
    try {
      await rconOrThrow(["gamerule doDaylightCycle true"]);
    } catch (error) {
      logger.warning(`E2E: time restore failed: ${(error as Error).message}`, "Command");
    }
  }
  if (token.difficultyBumped) {
    logger.info("E2E: restoring difficulty peaceful", "Command");
    try {
      await rconOrThrow(["difficulty peaceful"]);
    } catch (error) {
      logger.warning(
        `E2E: difficulty restore failed: ${(error as Error).message}`,
        "Command",
      );
    }
  }
}

/**
 * Enter survival via RCON, verifying the switch (a deopped-chat fallback
 * would silently stay creative, where falls and eating do nothing).
 */
export async function ensureSurvival(bot: Bot): Promise<void> {
  await serverCommand(bot, `gamemode survival ${bot.username}`);
  await pollUntil(bot, () => bot.game.gameMode === "survival", 60, "survival gamemode");
}

/**
 * Ready a bot for tests: teleport to position and set creative, all via
 * RCON. Call once in `beforeAll`; `beforeEach` only needs re-teleport +
 * reset. No OP needed at any point.
 */
export async function ensureReady(bot: Bot, position: Vec3): Promise<void> {
  await tpBot(bot, position.x, position.y, position.z);
  await bot.waitForChunksToLoad!();
  await bot.waitForTicks!(1);
  await serverCommand(bot, `gamemode creative ${bot.username}`);
  await pollUntil(bot, () => bot.game.gameMode === "creative", 60, "creative gamemode");
  await tpBot(bot, position.x, position.y, position.z);
  await bot.waitForChunksToLoad!();
  await bot.waitForTicks!(1);
}

/**
 * Common reset between tests: pure client-side (stop movement, clear
 * pathfinder/PVP goals). Gamemode and inventory are managed explicitly by
 * each suite via RCON; this function sends no server commands.
 */
export async function resetBotState(bot: Bot): Promise<void> {
  bot.clearControlStates();
  bot.pathfinder?.stop();
  bot.pvp?.forceStop();
  await bot.waitForTicks!(2);
}

/**
 * Teleport via RCON with arrival verification. Client physics is frozen
 * around the teleport: mineflayer keeps simulating locally, and a position
 * packet sent from the stale prediction trips the server's "moved too
 * quickly" check, rubber-banding the bot back (arrival poll then fails).
 */
export async function tpBot(
  bot: Bot,
  x: number,
  y: number,
  z: number,
): Promise<void> {
  const target = new Vec3(x, y, z);
  (bot as any).physicsEnabled = false;
  try {
    await serverCommand(bot, `tp ${bot.username} ${x} ${y} ${z}`);
    await pollUntil(
      bot,
      () => bot.entity.position.distanceTo(target) < 1.0,
      90,
      `teleport to ${x} ${y} ${z}`,
    );
  } finally {
    (bot as any).physicsEnabled = true;
  }
}

/**
 * Enter creative via RCON, verifying the switch. Companion to
 * ensureSurvival for tests that must leave survival reliably.
 */
export async function ensureCreative(bot: Bot): Promise<void> {
  await serverCommand(bot, `gamemode creative ${bot.username}`);
  await pollUntil(bot, () => bot.game.gameMode === "creative", 60, "creative gamemode");
}

/** Log a skip-safe suite header describing live-server assumptions. */
export function logSuiteStart(name: string, username: string): void {
  logger.info(
    `${name}: user=${username} host=${process.env.E2E_HOST} version=${e2eVersion()} modern=${isModernVersion()}`,
    "Command",
  );
}
