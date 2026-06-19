# Pupa

A terminal-based Minecraft bot with advanced combat, inventory management, physics simulation, and a Cisco IOS-style CLI.

## Features

- **Terminal UI**: Interactive TUI using `blessed` for logs and commands. Supports log levels (DEBUG, INFO, WARN, ERROR) with color-coded output. Headless mode for automated testing.
- **Combat System**: Automated PVP split into two layers: `PVPManager` for precise attack timing and cooldowns, and `CombatManager` for high-level decision-making, strafing, pearl arc prediction, fall damage mitigation, and edge protection.
- **Cisco IOS-Style CLI**: Hierarchical command tree with context-sensitive help (`?`), Tab auto-completion, and `${variable}` substitution in commands.
- **Runtime Configuration**: Adjust combat and movement constants on the fly via `cfg` without restarting.
- **Inventory Management**: Smart equipment handling (armor scoring, weapon DPS, golden apple priority), per-tick item caching with event-driven invalidation, inventory recording/restoring via creative mode.
- **Physics Simulation**: Custom AABB-based collision detection, sprint-jump trajectory simulation, projectile path prediction, and LiquidBounce-inspired strafing mechanics.
- **LRU Block Cache**: Efficient solid-block lookup for strafing with a 16-entry LRU cache.
- **Built with TypeScript**: Fully typed source code under `src/`, compiled to CommonJS for Node.js.

## Installation

```bash
npm install
```

## Usage

Create a `.env` file from the following template:

```env
PUPA_HOST=localhost
PUPA_PORT=25565
PUPA_NAME=Pupa
PUPA_VERSION=1.12.2
```

Build and run the bot:

```bash
npm run build
npm start
```

## Commands

Commands use a hierarchical Cisco IOS-style CLI. Type `?` (Shift-/) at any prompt to see available commands and subcommands in the current context. Press **Tab** to auto-complete tokens or show completions when ambiguous.

### Command System Architecture

The command system uses a **hierarchical command tree** instead of flat regex matching (`cli-engine.ts` + `commands.ts`).

Key architectural elements:

- **Tree nodes** have `{ name, description, handler?, subcommands?, positional? }` shape.
- **Positional params** use `<argName>` syntax and are matched by position, not by name.
- **`resolve(tree, tokens)`** walks the tree following tokens, returns deepest match.
- **`registerCommand(name, node)`** is the plugin API used by `debug.ts` to inject debug commands.
- **Variable substitution**: `${variable}` tokens in commands are resolved by `evaluatePlaceholders()` against built-in variables (such as `${x}`, `${y}`, `${z}`) before execution.
- **Tab completion** and **`?` context-sensitive help** are handled by `tui.ts` using the CLI engine, not by the command tree itself.

### Command List

| Command                      | Description                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `as`                         | Toggle autosend (sends unrecognized commands as chat)                          |
| `v`                          | Show version and connection info                                               |
| `pos`                        | Show current position                                                          |
| `com`                        | Toggle combat mode on/off                                                      |
| `cm [0-3]`                   | Change combat mode (0=Mobs, 1=Players Survival, 2=Players All, 3=All Entities) |
| `s`                          | Pacify bot — stop combat and any active run loop                               |
| `q`                          | Quit the bot                                                                   |
| `ts <item> [count]`          | Toss a single item or stack                                                    |
| `tsall`                      | Toss all items from inventory                                                  |
| `eq <item> <slot>`           | Equip an item to a slot (hand, off-hand, head, torso, legs, feet)              |
| `uneq <slot>`                | Unequip an item from a slot                                                    |
| `uneqall`                    | Unequip all items                                                              |
| `rec [slot]`                 | Record inventory to a JSON file (default slot 0)                               |
| `res [slot]`                 | Restore inventory from a recorded JSON file                                    |
| `clear`                      | Clear inventory via creative mode                                              |
| `pause <ticks>`              | Pause the bot for N ticks                                                      |
| `run <cmd> <N> <M>`          | Run a command N times with M ticks between each execution                      |
| `cfg`                        | List all active runtime configuration overrides                                |
| `cfg <CATEGORY.KEY>`         | View a specific config value (e.g., `cfg COMBAT.STRAFE_RANGE`)                 |
| `cfg <CATEGORY.KEY> <value>` | Set a runtime override (e.g., `cfg COMBAT.ATTACK_RANGE 4.0`)                   |
| `dud`                        | Test command                                                                   |
| `query_player_db <username>` | Query player database for a specific user                                      |
| `query_slot_db <slot>`       | Query slot database for a specific slot                                        |

### Variable Substitution

Commands support `${variable}` substitution in their arguments. Built-in variables include:

- `${x}`, `${y}`, `${z}` — Bot's current position
- `${health}`, `${food}` — Bot's current health and food levels
- `${yaw}`, `${pitch}` — Bot's look angles
- `${version}` — Minecraft version
- `${target}` — Current PVP target username

Example: `ts ${x}` — tosses the item whose name matches the current X coordinate (numeric ID style).

### Tab Completion

- **Tab** at any prompt: If the current token uniquely matches a command, it is auto-completed. If multiple matches exist, available options are shown in the log.
- **Tab** after a trailing space: Lists available subcommands/parameters at the current level.

## Runtime Configuration

Combat and movement constants can be adjusted at runtime via the `cfg` command, without restarting the bot. Example:

```
cfg COMBAT.ATTACK_RANGE 4.0
cfg COMBAT.STRAFE_RANGE 4.0
cfg                    # list all active overrides
```

Adjustable values are routed through `config.ts` (the `RuntimeConfig` class), which wraps `constants.ts` and allows per-key overrides via a `Map`.

### Adjustable Constants

The following constants are available for runtime override:

- `COMBAT.ATTACK_RANGE` — Melee attack reach (default: 3.5)
- `COMBAT.FOLLOW_RANGE` — Follow distance for PVP (default: 3.45)
- `COMBAT.VIEW_DISTANCE` — Entity tracking range (default: 128)
- `COMBAT.STRAFE_RANGE` — Strafing activation radius (default: 3.5)

## Debug Commands

| Command                              | Description                                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `debug_strafe_once [x] [y] [z]`      | Single strafe test at Vec3 offset (default +3, 0, 0)                                                                         |
| `debug_strafe_loop [x] [y] [z]`      | Loop the strafe test (call again to stop) at Vec3 offset (default +3, 0, 0)                                                  |
| `debug_pearl_throw <mode> [offsets]` | Throw pearl at nearest player with arc mode (`low`/`high`/`auto`) and optional per-axis offsets (e.g., `x+2.5 y-1.0 z+0.75`) |
| `debug_jump_path [x] [y] [z]`        | Test isJumpPathClear against Vec3 offset (default +3, 0, 0)                                                                  |
| `debug_collision_stress`             | Run 9 jump-path obstacle scenarios                                                                                           |
| `debug_jump_test [x] [y] [z]`        | Jump test to Vec3 offset with pre/post state logging (default +3, 0, 0)                                                      |
| `debug_pvp_attack`                   | PVPManager: Basic attack flow                                                                                                |
| `debug_pvp_goal`                     | PVPManager: Goal-directed movement while in combat                                                                           |
| `debug_pvp_strafe_goal`              | PVPManager: Strafing while moving toward a goal                                                                              |

## Log Levels & Logging Conventions

All output flows through the unified Logger facade in `logger.ts`. **Do not call `ui.log()` or `console.log/error` directly** from any module other than `tui.ts` or `logger.ts`.

Four levels are supported, automatically color-coded in the TUI:

- `DEBUG` — Detailed diagnostic information (suppressed by default; enabled when the DebugManager loads)
- `INFO` — General operational messages (default)
- `WARN` — Warning conditions
- `ERROR` — Error conditions with automatic stack trace inclusion

In headless mode, ERROR-level messages are routed to stderr with a `HH:MM:SS` timestamp.

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

DEBUG-level logs are suppressed by default. The `DebugManager` (`debug.ts`) enables debug mode in its constructor. To enable/disable manually:

```js
logger.setDebugMode(true); // enable DEBUG output
logger.setDebugMode(false); // suppress DEBUG output
```

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

## Development

### TypeScript Infrastructure

All source code is written in TypeScript under `src/`. Key configuration:

- **`tsconfig.json`**: targets ES2022, module `Node16` (CommonJS output), strict mode off, `isolatedModules: true`, source maps + declarations enabled.
- **`jest.config.js`**: uses `ts-jest` transformer with `.js` extension mapping for imports.
- **Build command**: `npm run build` runs `tsc`; output lands in `dist/`.
- **Run command**: `node dist/src/index.js` (after build).
- **Type definitions**: `@types/blessed`, `@types/node`, `@types/jest` installed. Mineflayer ships its own types; `vec3` types come from `@minecraft/` packages. Plugin-added properties (e.g., `bot.inventoryManager`, `bot.combatManager`) are accessed via `(bot as any)` casts where mineflayer's type declarations don't cover them.

### Development Guidelines

- **Runtime**: Node.js (see `package.json` engines).
- **Language**: TypeScript. Source files live under `src/` with a `.ts` extension. Compiled JavaScript output goes to `dist/`. Run `npm run build` to compile.
- **Linting & Formatting**: ESLint (`eslint.config.mjs`) with Prettier (`.prettierrc`). Follow existing formatting guidelines:
  ```bash
  npm run lint   # Run ESLint (includes --fix)
  npm run format # Run Prettier
  ```
- **Style**: Follow existing code patterns (async/await, event-driven, class-based modules). The `tsconfig.json` targets ES2022 with CommonJS module output (`"type": "commonjs"` in package.json).
- **Environment**: Configuration goes into `.env`.
- **Dependencies**: Use `npm install` / `npm ci`; do not add heavy native modules without discussion.
- **File naming**: Use lowercase with hyphens for multi-word module names (e.g., `cli-engine.ts`, `pvp-manager.ts`). Single-word names are acceptable (e.g., `utils.ts`, `config.ts`). Avoid camelCase file names.

### Rules for development/agents

- When implementing new features, prefer enhancing existing modules over creating new top-level files.
- **Documentation**: After making code changes, update `README.md` and `AGENTS.md` to reflect any changes to:
  - Command signatures and behavior
  - File structure and architecture overview
  - Test commands and examples
  - API signatures and type definitions
  - Configuration options and environment variables

### Naming Conventions

#### Variables

- **Constants**: `SCREAMING_SNAKE_CASE` (e.g., `TICK_GRAVITY`, `MOMENTUM_THRESHOLD_1_8`)
- **Private properties**: `_camelCase` with leading underscore (e.g., `_itemCache`, `_edgeSneaking`, `_runRunning`)
- **Local variables**: `camelCase` (e.g., `eyePos`, `targetPos`, `dist2D`, `strafeRange`)
- **Loop counters/indices**: Short names like `i`, `j`, `k` or descriptive short names like `dx`, `dy`, `dz` for deltas

#### Methods

- **Public methods**: `camelCase` (e.g., `getItemCount`, `equipArmor`, `doStrafe`, `setupDecisions`)
- **Private methods**: `_camelCase` with leading underscore (e.g., `_equipItem`, `_computeArmorScore`, `_initializeLiquidCache`)
- **Async methods**: `camelCase` with `async` keyword (e.g., `async equipGapple`, `async restoreInventory`)

#### Classes

- **Classes**: `PascalCase` (e.g., `CombatManager`, `InventoryManager`, `UtilsManager`, `AABB`)

#### Abbreviations

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

#### Method Naming Patterns

- **Getters**: `get<Thing>` (e.g., `getItemCount`, `getTargetFilter`, `getHealthStatus`)
- **Checkers**: `has<Thing>` or `is<Thing>` (e.g., `hasItem`, `hasFood`, `isInLiquid`, `isJumpPathClear`)
- **Actions**: `do<Thing>` or `equip<Thing>` (e.g., `doStrafe`, `doAvoid`, `equipArmor`, `equipWeapon`)
- **Async operations**: Often use `async` with descriptive names (e.g., `async equipGapple`, `async recordInventory`)

## Testing

### Unit Tests (Jest)

Test files live in `tests/` and follow the `*.test.ts` naming convention. Suites:

- `tests/utils.test.ts` — AABB collision detection, fall damage, projectile prediction
- `tests/pvp.test.ts` — CombatDecision, health status, targeting, fall protection
- `tests/e2e.test.ts` — End-to-end debug method tests (requires `E2E_HOST` env var)

Run all tests:

```bash
npm test
```

Or with verbose output:

```bash
npx jest --verbose
```

### Headless Testing

The bot can run in headless mode for automated testing without a TUI. Run from compiled output (via `npm start`):

```bash
# Run headless (requires prior build)
npm start -- --headless --bot1 "dud"

# Chain multiple commands
npm start -- --headless --bot1 "cmd1; cmd2; cmd3;"

# Repeat a command N times with M tick gap
npm start -- --headless --bot1 "run debug_strafe_once 10 1"

# Custom timeout and multiple commands
npm start -- --timeout 30 --headless --bot1 "run debug_strafe_once 10 5"

# Flags can appear in any order
npm start -- --timeout 60 --headless --bot1 "eq 1 boots; v"
```

The headless mode defaults to a 10-second timeout. Use `--timeout <seconds>` to customize. When debugging, use the DebugManager's test commands (`debug_strafe_once`, `debug_strafe_loop`, `debug_pearl_throw`, etc.) via headless mode.

## Project Structure

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
| `dist/`              | Compiled JavaScript output (generated by `npm run build`)                                        |

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

## License

ISC
