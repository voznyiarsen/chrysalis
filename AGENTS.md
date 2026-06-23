# AGENTS.md

## Project: Pupa

Pupa is a Node.js Minecraft bot written in TypeScript.

---

## Table of Contents

- [Quick Start](#quick-start)
- [TypeScript Infrastructure](#typescript-infrastructure)
- [Development Guidelines](#development-guidelines)
- [Naming Conventions](#naming-conventions)
- [Logging Conventions](#logging-conventions)
- [Command & Interaction Model](#command--interaction-model)
- [Testing](#testing)
- [Environment Variables](#environment-variables)
- [File Map](#file-map)
- [AABB Math of Blocks](#aabb-math-of-blocks)
- [Common Pitfalls](#common-pitfalls)
- [Session-Specific Notes](#session-specific-notes)
- [Rules for Agents](#rules-for-agents)

---

## Quick Start

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (output -> dist/)
npm test             # Run Jest tests
npm start            # Run the bot (after build)
npm start -- --headless --bot1 "command"   # Headless mode for testing
npm run lint         # ESLint with auto-fix
npm run format       # Prettier
```

Using the `terminal` tool:

```json
{ "command": "npm install", "cd": "/home/tsuchinoko/code-nodejs/pupa" }
{ "command": "npm run build", "cd": "/home/tsuchinoko/code-nodejs/pupa" }
{ "command": "npm test", "cd": "/home/tsuchinoko/code-nodejs/pupa" }
{ "command": "npm start", "cd": "/home/tsuchinoko/code-nodejs/pupa" }
{ "command": "npm run lint", "cd": "/home/tsuchinoko/code-nodejs/pupa" }
{ "command": "npm run format", "cd": "/home/tsuchinoko/code-nodejs/pupa" }
```

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
  declared via module augmentation in `src/types/mineflayer.d.ts`, extending the
  `Bot` interface so they can be accessed directly without `(bot as any)` casts.

**API Documentation**: For Mineflayer library and Minecraft protocol documentation, see the `documentation/` directory.

### Module Documentation Index

The `documentation/` directory contains API documentation for the following modules:

- `flying-squid_api.md`
- `mineflayer-cmd_api.md`
- `mineflayer-collectblock_api.md`
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
- **Style**: Follow the naming and style conventions in the [Naming Conventions](#naming-conventions) section below.
  The `tsconfig.json` targets ES2022 with CommonJS module output (`"type": "commonjs"` in package.json).
- **Environment**: Configuration goes into `.env` (see [Environment Variables](#environment-variables)).
- **Dependencies**: Use `npm install` / `npm ci`; do not add heavy native modules without discussion.
- **File naming**: Use lowercase with hyphens for multi-word module names (e.g., `cli-engine.ts`, `bot-registry.ts`).
  Single-word names are acceptable (e.g., `utils.ts`, `config.ts`). Avoid camelCase file names.

---

## Naming Conventions

### General Rules

- **Identifiers** must use only ASCII letters, digits, underscores (for constants), and (rarely) the `$` sign.
- **Names must be descriptive** and clear to a new reader. Do not use abbreviations that are ambiguous or unfamiliar.
  - **Exception**: Variables in scope for 10 lines or fewer, including non-exported arguments, may use short (e.g. single-letter) names.
- **Do not** use trailing or leading underscores for private properties or methods (except as noted below for private properties).
- **Do not** use the `opt_` prefix for optional parameters.
- **Do not** mark interfaces specially (e.g. `IMyInterface`) unless idiomatic in their environment.
- Treat abbreviations like acronyms as whole words: `loadHttpUrl`, not `loadHTTPURL`, unless required by a platform name.

### Variables

| Style                                   | Category                                                                                                        | Examples                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `SCREAMING_SNAKE_CASE`                  | Constants (module-level, static readonly, enum values)                                                          | `TICK_GRAVITY`, `MOMENTUM_THRESHOLD_1_8`     |
| `_camelCase`                            | Private properties (project convention; note: Google styleguide disallows `_` prefix, but this project uses it) | `_itemCache`, `_edgeSneaking`, `_runRunning` |
| `camelCase`                             | Local variables, parameters                                                                                     | `eyePos`, `targetPos`, `dist2D`              |
| Short (`i`, `j`, `k`, `dx`, `dy`, `dz`) | Loop counters, indices, deltas                                                                                  | `i`, `dx`                                    |

### Methods

| Style                 | Category        | Examples                                      |
| --------------------- | --------------- | --------------------------------------------- |
| `camelCase`           | Public methods  | `getItemCount`, `equipArmor`, `doStrafe`      |
| `_camelCase`          | Private methods | `_equipItem`, `_computeArmorScore`            |
| `camelCase` + `async` | Async methods   | `async equipGapple`, `async restoreInventory` |

#### Method Naming Patterns

| Pattern          | Convention                    | Examples                                              |
| ---------------- | ----------------------------- | ----------------------------------------------------- |
| Getters          | `get<Thing>`                  | `getItemCount`, `getTargetFilter`, `getHealthStatus`  |
| Checkers         | `has<Thing>` or `is<Thing>`   | `hasItem`, `hasFood`, `isInLiquid`, `isJumpPathClear` |
| Actions          | `do<Thing>` or `equip<Thing>` | `doStrafe`, `doAvoid`, `equipArmor`, `equipWeapon`    |
| Async operations | `async` with descriptive name | `async equipGapple`, `async recordInventory`          |

### Classes

| Style        | Category                                                       | Examples                                    |
| ------------ | -------------------------------------------------------------- | ------------------------------------------- |
| `PascalCase` | Classes, interfaces, types, enums, decorators, type parameters | `CombatManager`, `InventoryManager`, `AABB` |

### Type Parameters

Type parameters may use a single uppercase character (`T`) or `UpperCamelCase`.

### Imports

Module namespace imports are `lowerCamelCase` while files are `kebab-case`:

```ts
import * as fooBar from "./foo_bar";
```

### Aliases

When creating a local-scope alias of an existing symbol, match the naming format of the source identifier:

```ts
const { BrewStateEnum } = SomeType;
const CAPACITY = 5;
```

### Abbreviations

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
| `EGAPPLE`                  | Enchanted Golden Apple                  |
| `HP`                       | Health Points                           |
| `AP`                       | Absorption Points                       |

### Units

| Term  | Alias | Definition                                                                                                         |
| ----- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| Tick  | t     | The standard unit of time in Minecraft, equal to 50ms. Minecraft's physics and inputs are updated once every tick. |
| Block | b     | The standard unit of distance in Minecraft, 1b is equal to 1m.                                                     |
| Pixel | px    | A sub-unit of distance. A pixel is 1/16th of a block, which is equal to 0.0625b.                                   |

---

## Logging Conventions

All output flows through the unified Logger facade in `src/logger.ts`. **Do not call
`ui.log()` or `console.log/error` directly** from any module other than `src/tui.ts` or `src/logger.ts`.

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
| ------------- | -------------------------------------------------------------------------------------- | ------------- |
| `Client`      | Bot lifecycle (login, kick, end, reconnect)                                            | INFO          |
| `Combat`      | Decisions, modes, pearls, strafing                                                     | INFO/DEBUG    |
| `Inventory`   | Equip, toss, record, restore, consume                                                  | INFO          |
| `Command`     | User commands, run loops, pause                                                        | INFO          |
| `Status`      | Health, food, position, version                                                        | INFO          |
| `Config`      | Runtime config get/set/list                                                            | INFO          |
| `Chat`        | Incoming chat messages                                                                 | INFO          |
| `Error`       | Recoverable failures                                                                   | ERROR         |
| `Exception`   | Uncaught exceptions, unhandled rejections                                              | ERROR         |
| `Warning`     | Node warnings                                                                          | WARN          |
| `Debug`       | Verbose debug output                                                     | DEBUG         |
| `Movement`    | Movement logic, path execution, navigation                                             | INFO/DEBUG    |
| `Pathfinding` | Path computation, goal setting, A\* search                                             | INFO/DEBUG    |
| `Entity`      | Entity tracking, targeting, interaction                                                | INFO/DEBUG    |
| `Packet`      | Packet handling, protocol events                                                       | DEBUG         |

### Debug Mode

DEBUG-level logs are suppressed by default. To enable/disable manually:

```js
logger.setDebugMode(true); // enable DEBUG output
logger.setDebugMode(false); // suppress DEBUG output
```

---

## Command & Interaction Model

### Command Types

Commands are categorized based on how they are executed and registered:

- **Server-only commands**: Start with `/`. They are executed via `bot.chat()` and are registered by the Minecraft server itself.
- **Client-only commands**: Do not have a prefix. They are executed using internal bot logic and must **never** be sent via `bot.chat()`. They are registered by modules such as `src/commands.ts`.

### Command System Architecture

The command system uses a **hierarchical command tree** instead of flat regex matching
(`src/cli-engine.ts` + `src/commands.ts`).

**Key features for agents:**

- **Tree nodes** have `{ name, description, handler?, subcommands?, positional? }` shape.
- **Positional params** use `<argName>` syntax and are matched by position, not by name.
- **`resolve(tree, tokens)`** walks the tree following tokens, returns deepest match.
- **`registerCommand(name, node)`** is the plugin API used by debug modules to inject debug commands.
- **Variable substitution**: `${variable}` tokens in commands are resolved by `evaluatePlaceholders()`
  against built-in variables (`${x}`, `${y}`, `${z}`, `${health}`, `${food}`, `${yaw}`, `${pitch}`,
  `${version}`, `${target}`) before execution.
- **Tab completion** and **`?` context-sensitive help** are handled by `src/tui.ts` using the CLI engine,
  not by the command tree itself.

Combat and movement constants can be adjusted at runtime via the `cfg` command,
without restarting the bot. Example:

```
cfg COMBAT.ATTACK_RANGE 4.0
cfg COMBAT.STRAFE_RANGE 4.0
cfg                    # list all active overrides
```

Adjustable values are routed through `src/config.ts` (the `RuntimeConfig` class),
which wraps `src/constants.ts` and allows per-key overrides via a `Map`.

---

## Testing

### Unit Tests (Jest)

Unit tests live in `tests/unit/` and follow the `*.test.ts` naming convention. They do not
require a running Minecraft server and use mocked bot instances. Suites:

- `tests/unit/utils.test.ts` — AABB collision detection, fall damage, projectile prediction
- `tests/unit/pvp.test.ts` — CombatDecision, health status, targeting, fall protection
- `tests/unit/config.test.ts` — RuntimeConfig get/set/reset/overrides
- `tests/unit/pvp-manager.test.ts` — Attack speed, cooldown, damage multiplier

### E2E Tests (Jest)

End-to-end tests live in `tests/e2e/` and follow the `*.test.ts` naming convention. They
connect to a real Minecraft server using configuration from `.env` and are
automatically skipped when `E2E_HOST` is not set. Suites:

- `tests/e2e/jump.test.ts` — Jump and collision debug methods
- `tests/e2e/pearl.test.ts` — Ender pearl throw trajectory and accuracy
- `tests/e2e/strafe.test.ts` — Strafe movement and pathfinding
- `tests/e2e/inventory.test.ts` — Inventory management E2E tests
- `tests/e2e/pvp.test.ts` — PvP combat E2E tests

### Running Tests

```bash
npm test                  # Run all tests (unit + e2e)
npm test -- tests/unit       # Run only unit tests
npm test -- tests/e2e       # Run only E2E tests (skipped without E2E_HOST)
```

Using the `terminal` tool:

```json
{ "command": "npm test", "cd": "/home/tsuchinoko/code-nodejs/pupa" }
{ "command": "npm test -- tests/unit", "cd": "/home/tsuchinoko/code-nodejs/pupa" }
{ "command": "npm test -- tests/e2e", "cd": "/home/tsuchinoko/code-nodejs/pupa" }
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
npm start -- --headless --bot1 "run dud 10 1"
```

Using the `terminal` tool:

```json
{ "command": "npm start -- --headless --bot1 \"dud\"", "cd": "/home/tsuchinoko/code-nodejs/pupa" }
{ "command": "npm start -- --headless --bot1 \"cmd1; cmd2; cmd3;\"", "cd": "/home/tsuchinoko/code-nodejs/pupa" }
{ "command": "npm start -- --headless --bot1 \"run dud 10 1\"", "cd": "/home/tsuchinoko/code-nodejs/pupa" }
```

---

## Environment Variables

Configuration is loaded from `.env` via `dotenv`. See `.env.example` for the full template.

### Bot Connection

| Variable         | Default     | Description                                     |
| ---------------- | ----------- | ----------------------------------------------- |
| `PUPA_HOST`      | `localhost` | Minecraft server hostname                       |
| `PUPA_PORT`      | `25565`     | Minecraft server port                           |
| `PUPA_NAME`      | `Pupa`      | Bot player name                                 |
| `PUPA_VERSION`   | `1.12.2`    | Minecraft protocol version                      |
| `DEBUG_COMMANDS` | `0`         | Set to `1` to enable debug command registration |

### E2E Test Configuration

| Variable       | Description                                |
| -------------- | ------------------------------------------ |
| `E2E_HOST`     | Hostname of the E2E test server            |
| `E2E_PORT`     | Port of the E2E test server                |
| `E2E_USERNAME` | Username for the E2E test bot              |
| `E2E_VERSION`  | Minecraft version for E2E tests            |
| `E2E_TIMEOUT`  | Timeout in seconds for E2E test operations |

---

## File Map

| File                        | Purpose                                                 |
| --------------------------- | ------------------------------------------------------- |
| `src/index.ts`              | Entry point; bot initialization and main loop           |
| `src/bot-registry.ts`       | Multi-bot registry (BotRegistry class)                  |
| `src/cli-engine.ts`         | Hierarchical command tree engine                        |
| `src/commands.ts`           | Command registration and handlers                       |
| `src/config.ts`             | Runtime config with per-key overrides                   |
| `src/constants.ts`          | Combat/movement constants                               |
| `src/inventory.ts`          | Inventory management (equip, toss, consume)             |
| `src/listener-manager.ts`   | Event listener lifecycle management                     |
| `src/logger.ts`             | Unified logging facade                                  |
| `src/movement.ts`           | Movement mechanics (jump, strafe, collision physics)    |
| `src/projectile.ts`         | Projectile trajectory calculation (pearl arcs)         |
| `src/pvp.ts`                | PvP combat logic (CombatManager, PVPManager)           |
| `src/tui.ts`                | Terminal UI (blessed-based)                             |
| `src/types/mineflayer.d.ts` | Type augmentations for mineflayer Bot/Entity interfaces |
| `src/utils.ts`              | Utility functions (AABB, math, block cache)              |

---

## AABB Math of Blocks

### 1. The Voxel Coordinate Model

A standard $1 \times 1 \times 1$ solid block located at integer coordinates $(x, y, z)$ is defined in data storage as a strictly **closed 3D interval**:

$$[x, x+1] \times [y, y+1] \times [z, z+1]$$

For a block at the origin $(0,0,0)$, its internal boundaries are exactly $[0, 1] \times [0, 1] \times [0, 1]$. The block "owns" its mathematical edges.

### 2. The Collision Rules (Volume Intersection)

Do not use simple set intersection to calculate physical collisions. Game physics requires **volume interpenetration** (a shared space with a volume greater than zero) to trigger a collision.

When checking if an entity's AABB overlaps with a block's AABB, evaluate using **strict inequalities**:

* `Overlap X = (Entity.MinX < Block.MaxX) AND (Entity.MaxX > Block.MinX)`
* `Overlap Y = (Entity.MinY < Block.MaxY) AND (Entity.MaxY > Block.MinY)`
* `Overlap Z = (Entity.MinZ < Block.MaxZ) AND (Entity.MaxZ > Block.MinZ)`

A physical collision only occurs if all three axes report true. An entity standing perfectly at $y = 1.0$ on top of a block at $(0,0,0)$ shares exactly one mathematical point (set intersection of $\{1\}$), but because $1.0$ is not strictly less than $1.0$, the overlap logic evaluates to false. The entity is supported, not colliding.

### 3. The Raycasting Rules (Surface Interaction)

Unlike movement physics, raycasting (used for mining, shooting, or placing blocks) evaluates the strict mathematical boundaries.

* A ray intersecting the exact coordinate $x=1.0$ or $y=1.0$ of the block $[0, 1]$ registers a successful hit on the outer face.
* Do not treat the block as an open interval $(0, 1)$ for raycasting, or rays striking the exact face will pass through the block.

### 4. Movement Resolution Protocol

When an entity's velocity vector projects its AABB *into* a solid block's AABB (violating the strict inequality rule above):

1. Halt velocity on the colliding axis.
2. Snap the entity's boundary exactly to the block's maximum or minimum boundary.
3. Example: A player falling onto block $(0,0,0)$ has their Y-coordinate snapped exactly to $y = 1.0$.

---

## Common Pitfalls

- **Don't call `ui.log()` or `console.log/error` directly** from any module other than `src/tui.ts` or `src/logger.ts`. Use the `logger` facade.
- **Don't send client-only commands via `bot.chat()`**. Client-only commands (no `/` prefix) are handled by internal bot logic and will fail or cause errors if sent as chat.
- **Don't add new top-level files** when an existing module can be extended. Prefer enhancing existing modules.
- **Don't modify `.expect()` values in tests** to force a pass. Always fix the underlying issue.
- **Don't assume the server is at fault.** If issues arise, the cause is in the codebase.

---

## Session-Specific Notes

- Operating system: Linux.
- Temporary workspace: `temporary` may be used for intermediate artifacts.

---

## Rules for Agents

1. **Divide-Verify-Refine**: For complex tasks, break them down into smaller, manageable sub-tasks (Divide). After each sub-task, verify the result through builds, tests, or manual inspection (Verify). If issues are found, refine the implementation before proceeding to the next sub-task (Refine).
2. When implementing new features, prefer enhancing existing modules over creating new top-level files.
3. **Formatting**: Run linters to auto-fix formatting issues instead of manual fixes:

   ```bash
   npm run lint   # Run ESLint (includes --fix)
   npm run format # Run Prettier
   ```

   Using the `terminal` tool:

   ```json
   { "command": "npm run lint", "cd": "/home/tsuchinoko/code-nodejs/pupa" }
   { "command": "npm run format", "cd": "/home/tsuchinoko/code-nodejs/pupa" }
   ```

4. **Build & Verify**: After making code changes, run `npm run build` to compile TypeScript and `npm start -- --headless --bot1` to verify functionality.

   Using the `terminal` tool:

   ```json
   { "command": "npm run build", "cd": "/home/tsuchinoko/code-nodejs/pupa" }
   { "command": "npm start -- --headless --bot1 \"\"", "cd": "/home/tsuchinoko/code-nodejs/pupa" }
   ```

5. **Documentation**: After making code changes, update `README.md` and `AGENTS.md` to reflect any changes to:
   - Command signatures and behavior
   - File structure and architecture overview
   - Test commands and examples
   - API signatures and type definitions
   - Configuration options and environment variables
6. **Jest Tests**: Always aim to resolve the underlying issue causing a test failure. **NEVER** bypass failures by modifying values inside `.expect()` calls to force a test to pass. Doing so masks real bugs and undermines the reliability of the test suite. Modifying an expectation is only acceptable if you have verified that the test expectation itself is incorrect.
7. **Troubleshooting**: If issues arise during development or testing, assume they are caused by the codebase. The server is never at fault.
8. **Terminal Tool Usage**: When using the `terminal` tool to execute shell commands, both `command` and `cd` parameters are **required**. The `terminal` tool will **NEVER** run if either parameter is missing — the call will fail every time.
   - `cd` (required): An absolute path to a directory within the workspace (e.g., `/home/tsuchinoko/code-nodejs/pupa`). Never embed `cd` inside the command string.
   - `command` (required): The shell one-liner to execute. Do not include shell substitutions like `$VAR`, `$(...)`, or backticks — resolve values beforehand.
   - Always provide both parameters in every `terminal` tool invocation without exception.

---

_End of AGENTS.md_
