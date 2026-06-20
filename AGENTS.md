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

**API Documentation**: For Mineflayer library and Minecraft protocol documentation, see the `module-documentation` directory.

### Module Documentation Index

The `module-documentation` directory contains API documentation for the following modules:

- `flying-squid_api.md`
- `mineflayer-cmd_api.md`
- `mineflayer-collectblock_api.md`
- `mineflayer-pvp_api.md`
- `mineflayer-statemachine_api.md`
- `mineflayer-tool_api.md`
- `mineflayer_api.md`
- `mineflayer_unstable_api.md`
- `node-minecraft-assets_api.md`
- `node-minecraft-data_api.md`
- `node-minecraft-packets_api.md`
- `node-minecraft-protocol_api.md`
- `prismarine-auth_api.md`
- `prismarine-block_api.md`
- `prismarine-realms_api.md`
- `prismarine-windows_api.md`
- `prismarine-world_api.md`

---

## Development Guidelines

- **Runtime**: Node.js (see `package.json` engines).
- **Language**: TypeScript. Source files live under `src/` with a `.ts` extension.
  Compiled JavaScript output goes to `dist/`.
- **Linting**: ESLint (`eslint.config.mjs`) with Prettier (`.prettierrc`).
- **Style**: Follow the TypeScript styleguide in `styleguide.md`.
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
| `pos`                      | Position (Vec3)                         |
| `AABB`                     | Axis-Aligned Bounding Box               |
| `St`                       | Slipperiness factor                     |
| `Mt`                       | Momentum                                |
| `Et`                       | Effective speed multiplier              |
| `dx`, `dy`, `dz`           | Delta/difference in X, Y, Z coordinates |
| `dist`, `dist2D`, `distSq` | Distance, 2D distance, squared distance |
| `GAPPLE`                   | Golden Apple                            |
| `EGAPPLE`                   | Enchanted Golden Apple                  |
| `HP`                       | Health Points                           |
| `AP`                       | Absorption Points                       |

### Units

| Term  | Alias | Definition                                                                                                            |
| ----- | ----- | --------------------------------------------------------------------------------------------------------------------- |
| Tick  | t     | The standard unit of time in Minecraft, equal to 50ms. Minecraft's physics and inputs are updated once every tick. |
| Block | b     | The standard unit of distance in Minecraft, 1b is equal to 1m.                                                        |
| Pixel | px    | A sub-unit of distance. A pixel is 1/16th of a block, which is equal to 0.0625b                                    |

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
logger.debug(msg, tag?, caller?);   // DEBUG level
logger.info(msg, tag?, caller?);    // INFO level
logger.warn(msg, tag?, caller?);    // WARN level
logger.error(msg, tag?, caller?);   // ERROR level

// Semantic helpers (tag is set automatically)
logger.client(msg, level?, caller?);
logger.combat(msg, level?, caller?);
logger.inventory(msg, level?, caller?);
logger.command(msg, level?, caller?);
logger.status(msg, level?, caller?);
logger.config(msg, level?, caller?);
logger.chat(msg, caller?);
logger.exception(msg, caller?);     // always ERROR
logger.warning(msg, caller?);       // always WARN

// Additional semantic helpers
logger.movement(msg, level?, caller?);
logger.pathfinding(msg, level?, caller?);
logger.entity(msg, level?, caller?);
logger.packet(msg, level?, caller?);
```

### Canonical Tags

| Tag           | Domain                                                                                 | Default Level |
| ------------ | -------------------------------------------------------------------------------------- | ------------- |
| `Client`     | Bot lifecycle (login, kick, end, reconnect)                                            | INFO          |
| `Combat`     | Decisions, modes, pearls, strafing                                                     | INFO/DEBUG    |
| `Inventory`  | Equip, toss, record, restore, consume                                                  | INFO          |
| `Command`    | User commands, run loops, pause                                                        | INFO          |
| `Status`     | Health, food, position, version                                                        | INFO          |
| `Config`     | Runtime config get/set/list                                                            | INFO          |
| `Chat`       | Incoming chat messages                                                                 | INFO          |
| `Error`      | Recoverable failures                                                                   | ERROR         |
| `Exception`  | Uncaught exceptions, unhandled rejections                                              | ERROR         |
| `Warning`    | Node warnings                                                                          | WARN          |
| `Debug`      | Verbose debug commands (debug_strafe_once, debug_strafe_loop, debug_pearl_throw, etc.) | DEBUG         |
| `Movement`   | Movement logic, path execution, navigation                                             | INFO/DEBUG    |
| `Pathfinding`| Path computation, goal setting, A* search                                               | INFO/DEBUG    |
| `Entity`     | Entity tracking, targeting, interaction                                                | INFO/DEBUG    |
| `Packet`     | Packet handling, protocol events                                                       | DEBUG         |

### Debug Mode

DEBUG-level logs are suppressed by default. The `DebugManager` (`debug.ts`)
enables debug mode in its constructor. To enable/disable manually:

```js
logger.setDebugMode(true); // enable DEBUG output
logger.setDebugMode(false); // suppress DEBUG output
```

---

## Command & Interaction Model

### Command Types

Commands are categorized based on how they are executed and registered:

- **Server-only commands**: Start with `/`. They are executed via `bot.chat()` and are registered by the Minecraft server itself.
- **Client-only commands**: Do not have a prefix. They are executed using internal bot logic and must **never** be sent via `bot.chat()`. They are registered by modules such as `src/commands.ts` and `src/debug.ts`.

### Command System Architecture

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

---

## Session-Specific Notes

- Operating system: Linux.
- Temporary workspace: `/home/tsuchinoko/.gemini/tmp/pupa` may be used for
  intermediate artifacts but **the canonical project is at
  `/home/tsuchinoko/code-nodejs/pupa`**.
- Ignore the `temporary` directory in the root of the workspace – it is for intermediate artifacts only.

---

## Rules for agents

- **Divide-Verify-Refine**: For complex tasks, break them down into smaller, manageable sub-tasks (Divide). After each sub-task, verify the result through builds, tests, or manual inspection (Verify). If issues are found, refine the implementation before proceeding to the next sub-task (Refine).
- When implementing new features, prefer enhancing existing modules over creating new top-level files.
- **Formatting**: Run linters to auto-fix formatting issues instead of manual fixes:
  ```bash
  npm run lint   # Run ESLint (includes --fix)
  npm run format # Run Prettier
  ```
- **Build & Verify**: After making code changes, run `npm run build` to compile TypeScript and `npm start -- --headless --bot1` to verify functionality.
- **Documentation**: After making code changes, update `README.md` and `AGENTS.md` to reflect any changes to:
  - Command signatures and behavior
  - File structure and architecture overview
  - Test commands and examples
  - API signatures and type definitions
  - Configuration options and environment variables

- **Jest Tests**: Always aim to resolve the underlying issue causing a test failure. Do not bypass failures by modifying values inside `.expect()` calls unless all other options have been exhausted.
- **Troubleshooting**: If issues arise during development or testing, assume they are caused by the codebase. The server is never at fault.

---

_End of AGENTS.md_
