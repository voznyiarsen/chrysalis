# AGENTS.md

## Project: Pupa

Pupa is a Node.js Minecraft bot. Its design and features are developed by
studying the **source code** of established community clients, which are available
for reference under the `minecraft-clients/` directory. That code is **read-only**;
it is not part of Pupa's own codebase and must not be altered.

---

## 🔒 CRITICAL: `minecraft-clients/` is Read-Only

The `minecraft-clients/` directory contains **reference implementations** of
popular Minecraft clients (Lambda, LiquidBounce, Meteor, Wurst7). **Do not
modify any file inside this tree.** It is included solely so that developers
and coding agents can study how these clients implement specific mechanics
(movement, combat, inventory, packet handling, rendering, etc.) and use that
understanding to design or improve Pupa's own features.

### When to consult `minecraft-clients/`

- Understanding client-side physics exploits (e.g., velocity, flight, speed).
- Implementing advanced PvP modules (aura, surround, scaffold).
- Packet-level tricks (bypasses, prediction, animation).

### Rules for agents

- **Never** write, delete, or edit any file inside `minecraft-clients/`.
- If you need to reuse a piece of logic, copy it and adapt it to JavaScript.
- Treat the reference code as **informational** – the final implementation must
  fit Pupa's Node.js architecture and style.
- When implementing new features, prefer enhancing existing modules over creating new top-level files.

---

## Development Guidelines

- **Runtime**: Node.js (see `package.json` engines).
- **Language**: TypeScript. Source files live under `src/` with a `.ts` extension.
  Compiled JavaScript output goes to `dist/`. Run `npm run build` to compile.
- **Linting**: ESLint (`eslint.config.mjs`) with Prettier (`.prettierrc`). The config covers
  `*.js` and `tests/**/*.js` with Node + Jest globals.
- **Style**: Follow existing code patterns (async/await, event-driven, class-based modules).
  The `tsconfig.json` targets ES2022 with CommonJS module output (`"type": "commonjs"` in package.json).
- **Environment**: Configuration goes into `.env`.
- **Dependencies**: Use `npm install` / `npm ci`; do not add heavy native modules without discussion.
- **File naming**: Use lowercase and hyphens for non-module scripts; modules are camelCase or single-word.

---

## Logging Conventions

All output flows through the unified Logger facade in `logger.js`. **Do not call
`ui.log()` or `console.log/error` directly** from any module other than `tui.js` or `logger.js`.

### Available API

```js
const logger = require("./logger");

// Level-based
logger.debug(msg, tag?);   // DEBUG level
logger.info(msg, tag?);    // INFO level
logger.warn(msg, tag?);    // WARN level
logger.error(msg, tag?);   // ERROR level

// Semantic helpers (tag is set automatically)
logger.client(msg, level?);
logger.combat(msg, level?);
logger.inventory(msg, level?);
logger.command(msg, level?);
logger.status(msg, level?);
logger.config(msg, level?);
logger.chat(msg);
logger.exception(msg);     // always ERROR
logger.warning(msg);       // always WARN
```

### Canonical Tags

| Tag         | Domain                                                                                 | Default Level |
| ----------- | -------------------------------------------------------------------------------------- | ------------- |
| `Client`    | Bot lifecycle (login, kick, end, reconnect)                                            | INFO          |
| `Combat`    | Decisions, modes, pearls, strafing                                                     | INFO/DEBUG    |
| `Inventory` | Equip, toss, record, restore, consume                                                  | INFO          |
| `Command`   | User commands, run loops, pause                                                        | INFO          |
| `Status`    | Health, food, position, version                                                        | INFO          |
| `Config`    | Runtime config get/set/list                                                            | INFO          |
| `Chat`      | Incoming chat messages                                                                 | INFO          |
| `Error`     | Recoverable failures                                                                   | ERROR         |
| `Exception` | Uncaught exceptions, unhandled rejections                                              | ERROR         |
| `Warning`   | Node warnings                                                                          | WARN          |
| `Debug`     | Verbose debug commands (debug_strafe_once, debug_strafe_loop, debug_pearl_throw, etc.) | DEBUG         |

### Multi-Bot Logging

In multi-bot mode, each bot's logs are prefixed with a bot identifier integrated into the tag:

```
# Single bot (no prefix):
[Client] Successfully logged into account
[Status] Health: 20.0, Food: 20

# Multi-bot (bot number integrated into tag):
[bot1 Status] Health: 20.0, Food: 20
[bot2 Combat] Fall: Mitigating with Enchanted Golden Apple
[bot1 Client] Connecting to localhost:25565 as Bot1...
```

This makes it immediately clear which bot each status message belongs to.

### Debug Mode

DEBUG-level logs are suppressed by default. The `DebugManager` (`debug.js`)
enables debug mode in its constructor. To enable/disable manually:

```js
logger.setDebugMode(true); // enable DEBUG output
logger.setDebugMode(false); // suppress DEBUG output
```

---

## Architecture Overview

| File                | Purpose                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `src/index.ts`      | Entry point, listener management, plugin loading                                                 |
| `src/tui.ts`        | Terminal UI (blessed) or headless console logger                                                 |
| `src/logger.ts`     | Unified logging facade — all modules must use this                                               |
| `src/commands.ts`   | Hierarchical command tree with context-sensitive Cisco IOS-style CLI                             |
| `src/cli-engine.ts` | CLI engine — tokenization, tree resolution, suggestions, abbreviation expansion, help generation |
| `src/pvp.ts`        | Combat manager, strafing, targeting, decision tree                                               |
| `src/inventory.ts`  | Inventory manager, equipment, item caching                                                       |
| `src/utils.ts`      | Physics (AABB, trajectory, collision), movement utilities, LRU block cache                       |
| `src/config.ts`     | Runtime configuration manager for mutable constants                                              |
| `src/debug.ts`      | Debug/test commands for development                                                              |
| `src/constants.ts`  | Centralized constants (physics, combat, materials, timing)                                       |
| `tests/`            | Unit tests for `utils.ts` and `pvp.ts` (`.test.ts` files)                                        |

---

## Command System

The command system uses a **hierarchical command tree** instead of flat regex matching
(`cli-engine.ts` + `commands.ts`).

**Key features for agents:**

- **Tree nodes** have `{ name, description, handler?, subcommands?, positional? }` shape.
- **Positional params** use `<argName>` syntax and are matched by position, not by name.
- **`resolve(tree, tokens)`** walks the tree following tokens, returns deepest match.
- **`registerCommand(name, node)`** is the plugin API used by `debug.js` to inject debug commands.
- **Variable substitution**: `${variable}` tokens in commands are resolved by `evaluatePlaceholders()`
  against built-in variables (`${x}`, `${y}`, `${z}`, `${health}`, `${food}`, `${yaw}`, `${pitch}`,
  `${version}`, `${target}`) before execution.
- **Tab completion** and **`?` context-sensitive help** are handled by `tui.ts` using the CLI engine,
  not by the command tree itself.

---

## Runtime Configuration

Combat and movement constants can be adjusted at runtime via the `cfg` command,
without restarting the bot. Example:

```
cfg COMBAT.ATTACK_RANGE 4.0
cfg COMBAT.STRAFE_RANGE 4.0
cfg                    # list all active overrides
```

Adjustable values are routed through `config.js` (the `RuntimeConfig` class),
which wraps `constants.js` and allows per-key overrides via a `Map`.

---

## Testing

### Unit Tests (Jest)

Test files live in `tests/` and follow the `*.test.ts` naming convention. Suites:

- `tests/utils.test.ts` — AABB collision detection, fall damage, projectile prediction
- `tests/pvp.test.ts` — CombatDecision, health status, targeting, fall protection

Run all tests:

```bash
npm test
```

### Headless Testing

The bot can run in headless mode for automated testing without a TUI.
Run from compiled output (via npm start):

```bash
# Run a single command
npm start -- --headless "dud"

# Chain multiple commands
npm start -- --headless "cmd1; cmd2; cmd3;"

# Repeat a command N times with M tick gap
npm start -- --headless "run t0 100 1" --timeout 60

# Test inventory recording/restoring
npm start -- --headless "rec 1; clear; res 1" --timeout 30

# Benchmark strafing performance
npm start -- --timeout 60 --headless "run t0 100 1"
```

The headless mode defaults to a 10-second timeout. Use `--timeout <seconds>` to
customize. When debugging, use the DebugManager's test commands (`debug_strafe_once`,
`debug_strafe_loop`, `debug_pearl_throw`, etc.) via headless mode.

### Collision Stress Test

```bash
npm start -- --headless "debug_collision_stress"
```

This runs 9 jump-path obstacle scenarios to verify AABB collision optimisations
haven't introduced phasing bugs.

---

## Key Implementation Details

### Inventory Caching

The `InventoryManager` in `inventory.js` maintains a per-tick item cache for
`hasItem`, `getItemCount`, `hasItemWithMetadata`, and `hasFood`. The cache is
invalidated immediately on inventory change events (`windowUpdate`, `changedSlot`)
or via the public `invalidateCache()` method.

`restoreInventory` uses `fs.readFileSync` + `JSON.parse` instead of `require()`
to avoid stale Node module cache.

### Solid Blocks LRU Cache

`getSolidBlocks` in `utils.js` caches block search results in a `Map`-based LRU
cache (max 16 entries), keyed by floored `(x, z)` coordinates. Use
`clearSolidCache()` to reset when the world or dimension changes.

### Combat Decision Optimizations

- **Early-exit loop**: Priority decisions (`fall`, `totem`, `heal`, `armor`,
  `weapon`) break out of the decision loop early when an item swap occurs.
- **Squared distance**: All distance comparisons in `getTargetFilter` use
  `distanceToSquared()` (manual `dx*dx + dy*dy + dz*dz`) to avoid `Math.sqrt`.
- **Target stickiness**: `updateTarget()` checks whether the current
  `bot.pvp.target` is still valid before calling `nearestEntity()`.
- **AABB short-circuiting**: `getCollisions` skips blocks whose full-voxel
  bounding box doesn't intersect the query AABB.

### `debug_pearl_throw` (Pearl Throw Test)

The `debug_pearl_throw` debug command takes four positional parameters:
`debug_pearl_throw <mode> <x-offset> <y-offset> <z-offset>`

- mode: `low` | `high` | `auto`
- offsets are per-axis, e.g. `x+2.5 y-1.0 z+0.75`
  The method finds the nearest player, applies the offset, and throws a pearl
  with the specified arc.

---

## TypeScript Infrastructure

All source code is written in TypeScript under `src/`. Key configuration:

- **`tsconfig.json`**: targets ES2022, module `Node16` (CommonJS output), strict mode off,
  `isolatedModules: true`, source maps + declarations enabled.
- **`jest.config.js`**: uses `ts-jest` transformer with `.js` extension mapping for imports.
- **Build command**: `npm run build` runs `tsc`; output lands in `dist/`.
- **Run command**: `node dist/src/index.js` (after build).
- **Type definitions**: `@types/blessed`, `@types/node`, `@types/jest` installed.
  Mineflayer ships its own types; `vec3` types come from `@minecraft/` packages.
  Plugin-added properties (e.g., `bot.inventoryManager`, `bot.combatManager`) are
  accessed via `(bot as any)` casts where mineflayer's type declarations don't cover them.

---

## Session-Specific Notes

- Operating system: Linux.
- Temporary workspace: `/home/tsuchinoko/.gemini/tmp/pupa` may be used for
  intermediate artifacts but **the canonical project is at
  `/home/tsuchinoko/code-nodejs/pupa`**.
- `.geminiignore` is present – respect its exclusions.

---

_End of AGENTS.md_
