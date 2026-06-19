# AGENTS.md

## Project: Pupa

Pupa is a Node.js Minecraft bot written in TypeScript.

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

### Rules for agents

- When implementing new features, prefer enhancing existing modules over creating new top-level files.
- **Formatting**: Run linters to auto-fix formatting issues instead of manual fixes:
  ```bash
  npm run lint   # Run ESLint (includes --fix)
  npm run format # Run Prettier
  ```
- **Build**: After making code changes, run `npm run build` to compile TypeScript and verify functionality.
- **Documentation**: After making code changes, update `README.md` and `AGENTS.md` to reflect any changes to:
  - Command signatures and behavior
  - File structure and architecture overview
  - Test commands and examples
  - API signatures and type definitions
  - Configuration options and environment variables

- **Jest Tests**: NEVER modify values inside `.expect()` calls in Jest tests. These values represent the expected behavior and should only be changed when the actual implementation changes. Instead, optimize the implementation or test infrastructure to meet the existing expectations.

---

## Development Guidelines

- **Runtime**: Node.js (see `package.json` engines).
- **Language**: TypeScript. Source files live under `src/` with a `.ts` extension.
  Compiled JavaScript output goes to `dist/`.
- **Linting**: ESLint (`eslint.config.mjs`) with Prettier (`.prettierrc`).
- **Style**: Follow existing code patterns (async/await, event-driven, class-based modules).
  The `tsconfig.json` targets ES2022 with CommonJS module output (`"type": "commonjs"` in package.json).
- **Environment**: Configuration goes into `.env`.
- **Dependencies**: Use `npm install` / `npm ci`; do not add heavy native modules without discussion.
- **File naming**: Use lowercase with hyphens for multi-word module names (e.g., `cli-engine.ts`, `pvp-manager.ts`).
  Single-word names are acceptable (e.g., `utils.ts`, `config.ts`). Avoid camelCase file names.

---

## Naming Conventions

### Variables

- **Constants**: `SCREAMING_SNAKE_CASE` (e.g., `TICK_GRAVITY`, `MOMENTUM_THRESHOLD_1_8`)
- **Private properties**: `_camelCase` with leading underscore (e.g., `_itemCache`, `_edgeSneaking`, `_runRunning`)
- **Local variables**: `camelCase` (e.g., `eyePos`, `targetPos`, `dist2D`, `strafeRange`)
- **Loop counters/indices**: Short names like `i`, `j`, `k` or descriptive short names like `dx`, `dy`, `dz` for deltas

### Methods

- **Public methods**: `camelCase` (e.g., `getItemCount`, `equipArmor`, `doStrafe`, `setupDecisions`)
- **Private methods**: `_camelCase` with leading underscore (e.g., `_equipItem`, `_computeArmorScore`, `_initializeLiquidCache`)
- **Async methods**: `camelCase` with `async` keyword (e.g., `async equipGapple`, `async restoreInventory`)

### Classes

- **Classes**: `PascalCase` (e.g., `CombatManager`, `InventoryManager`, `UtilsManager`, `AABB`)

### Abbreviations

Common abbreviations used throughout the codebase:

| Abbreviation               | Meaning                                 |
| -------------------------- | --------------------------------------- |
| `bot`                      | Mineflayer bot instance                 |
| `svc`                      | Service or saved context                |
| `inv`                      | Inventory                               |
| `pos`                      | Position (Vec3)                         |
| `AABB`                     | Axis-Aligned Bounding Box               |
| `St`                       | Slipperiness factor                     |
| `Mt`                       | Momentum                                |
| `Et`                       | Effective speed multiplier              |
| `dx`, `dy`, `dz`           | Delta/difference in X, Y, Z coordinates |
| `dist`, `dist2D`, `distSq` | Distance, 2D distance, squared distance |
| `GAPPLE`                   | Golden Apple                            |
| `EGAPPLE`                  | Enchanted Golden Apple                  |
| `HP`                       | Health Points                           |
| `AP`                       | Absorption Points                       |

### Pitch Calculation
The Mineflayer library uses an inverted pitch compared to Minecraft.

- **Positive pitch** means looking **UP**
- **Negative pitch** means looking **DOWN**

Since the pitch is applied using the Mineflayer library, the input pitch values should be inverted.

This is the absolute truth; do not question it.

### Method Naming Patterns

- **Getters**: `get<Thing>` (e.g., `getItemCount`, `getTargetFilter`, `getHealthStatus`)
- **Checkers**: `has<Thing>` or `is<Thing>` (e.g., `hasItem`, `hasFood`, `isInLiquid`, `isJumpPathClear`)
- **Actions**: `do<Thing>` or `equip<Thing>` (e.g., `doStrafe`, `doAvoid`, `equipArmor`, `equipWeapon`)
- **Async operations**: Often use `async` with descriptive names (e.g., `async equipGapple`, `async recordInventory`)

---

## Logging Conventions

All output flows through the unified Logger facade in `logger.ts`. **Do not call
`ui.log()` or `console.log/error` directly** from any module other than `tui.ts` or `logger.ts`.

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

### Debug Mode

DEBUG-level logs are suppressed by default. The `DebugManager` (`debug.ts`)
enables debug mode in its constructor. To enable/disable manually:

```js
logger.setDebugMode(true); // enable DEBUG output
logger.setDebugMode(false); // suppress DEBUG output
```

---

## Architecture Overview

| File                 | Purpose                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `src/index.ts`       | Entry point, listener management, plugin loading                                                 |
| `src/tui.ts`         | Terminal UI (blessed) or headless console logger                                                 |
| `src/logger.ts`      | Unified logging facade — all modules must use this                                               |
| `src/commands.ts`    | Hierarchical command tree with context-sensitive Cisco IOS-style CLI                             |
| `src/cli-engine.ts`  | CLI engine — tokenization, tree resolution, suggestions, abbreviation expansion, help generation |
| `src/pvp.ts`         | Combat manager, strafing, targeting, decision tree                                               |
| `src/pvp-manager.ts` | PVP Manager — attack timing, cooldowns, target tracking, shield blocking                         |
| `src/inventory.ts`   | Inventory manager, equipment, item caching                                                       |
| `src/utils.ts`       | Physics (AABB, trajectory, collision), movement utilities, LRU block cache                       |
| `src/config.ts`      | Runtime configuration manager for mutable constants                                              |
| `src/debug.ts`       | Debug/test commands for development                                                              |
| `src/constants.ts`   | Centralized constants (physics, combat, materials, timing)                                       |
| `tests/`             | Unit tests for `utils.ts`, `pvp.ts`, and `e2e.test.ts` (`.test.ts` files)                        |

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

Adjustable values are routed through `config.ts` (the `RuntimeConfig` class),
which wraps `constants.ts` and allows per-key overrides via a `Map`.

---

## Testing

### Unit Tests (Jest)

Test files live in `tests/` and follow the `*.test.ts` naming convention. Suites:

- `tests/utils.test.ts` — AABB collision detection, fall damage, projectile prediction
- `tests/pvp.test.ts` — CombatDecision, health status, targeting, fall protection
- `tests/e2e.test.ts` — End-to-end debug method tests (requires E2E_HOST env var)

Run all tests:

```bash
npm test
```

### Headless Testing

The bot can run in headless mode for automated testing without a TUI.
Run from compiled output (via npm start):

```bash
# Run a single command
npm start -- --headless --bot1 "dud"

# Chain multiple commands
npm start -- --headless --bot1 "cmd1; cmd2; cmd3;"

# Repeat a command N times with M tick gap
npm start -- --headless --bot1 "run debug_strafe_once 10 1"
```

The headless mode defaults to a 10-second timeout. Use `--timeout <seconds>` to
customize. When debugging, use the DebugManager's test commands (`debug_strafe_once`,
`debug_strafe_loop`, `debug_pearl_throw`, etc.) via headless mode.

---

## Method and File Mappings

| Method Name | File Location |
|-------------|--------------|
| `getItemCount` | `src/inventory.ts` |
| `equipArmor` | `src/inventory.ts` |
| `doStrafe` | `src/pvp.ts` |
| `setupDecisions` | `src/pvp.ts` |
| `getTargetFilter` | `src/pvp.ts` |
| `getHealthStatus` | `src/pvp.ts` |
| `hasItem` | `src/inventory.ts` |
| `hasFood` | `src/inventory.ts` |
| `isInLiquid` | `src/utils.ts` |
| `isJumpPathClear` | `src/utils.ts` |
| `equipGapple` | `src/inventory.ts` |
| `restoreInventory` | `src/inventory.ts` |

---

## Session-Specific Notes

- Operating system: Linux.
- Temporary workspace: `/home/tsuchinoko/.gemini/tmp/pupa` may be used for
  intermediate artifacts but **the canonical project is at
  `/home/tsuchinoko/code-nodejs/pupa`**.
- Ignore the `temporary` directory in the root of the workspace – it is for intermediate artifacts only.

---

_End of AGENTS.md_
