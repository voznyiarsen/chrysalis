# Pupa

A terminal-based Minecraft bot with advanced combat, inventory management, physics simulation, and a Cisco IOS-style CLI.

## Features

- **Terminal UI**: Interactive TUI using `blessed` for logs and commands. Supports log levels (DEBUG, INFO, WARN, ERROR) with color-coded output. Headless mode for automated testing.
- **Combat System**: Automated PVP with decision-making, strafing, pearl arc prediction, fall damage mitigation, edge protection, and configurable targeting modes.
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

Or run directly from source (requires `ts-node` or similar):

```bash
node dist/src/index.js
```

## Commands

Commands use a hierarchical Cisco IOS-style CLI. Type `?` (Shift-/) at any prompt to see available commands and subcommands in the current context. Press **Tab** to auto-complete tokens or show completions when ambiguous.

| Command | Description |
|---------|-------------|
| `as` | Toggle autosend (sends unrecognized commands as chat) |
| `v` | Show version and connection info |
| `pos` | Show current position |
| `com` | Toggle combat mode on/off |
| `cm [0-3]` | Change combat mode (0=Mobs, 1=Players Survival, 2=Players All, 3=All Entities) |
| `s` | Pacify bot — stop combat and any active run loop |
| `q` | Quit the bot |
| `ts <item> [count]` | Toss a single item or stack |
| `tsall` | Toss all items from inventory |
| `eq <item> <slot>` | Equip an item to a slot (hand, off-hand, head, torso, legs, feet) |
| `uneq <slot>` | Unequip an item from a slot |
| `uneqall` | Unequip all items |
| `rec [slot]` | Record inventory to a JSON file (default slot 0) |
| `res [slot]` | Restore inventory from a recorded JSON file |
| `clear` | Clear inventory via creative mode |
| `pause <ticks>` | Pause the bot for N ticks |
| `run <cmd> <N> <M>` | Run a command N times with M ticks between each execution |
| `cfg` | List all active runtime configuration overrides |
| `cfg <CATEGORY.KEY>` | View a specific config value (e.g., `cfg COMBAT.STRAFE_RANGE`) |
| `cfg <CATEGORY.KEY> <value>` | Set a runtime override (e.g., `cfg COMBAT.ATTACK_RANGE 4.0`) |

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

### Runtime Configuration

The following constants can be adjusted at runtime via the `cfg` command:

- `COMBAT.ATTACK_RANGE` — Melee attack reach (default: 3.5)
- `COMBAT.FOLLOW_RANGE` — Follow distance for PVP (default: 3.45)
- `COMBAT.VIEW_DISTANCE` — Entity tracking range (default: 128)
- `COMBAT.STRAFE_RANGE` — Strafing activation radius (default: 3.5)

### Debug Commands

| Command | Description |
|---------|-------------|
| `t0` | Single strafe test at (+3, 0, 0) |
| `t1` | Loop strafe test (call again to stop) |
| `t2 <mode> <x> <y> <z>` | Throw pearl at nearest player with arc mode (`low`/`high`/`auto`) and per-axis offset (e.g., `t2 auto x+2.5 y-1.0 z+0.75`) |
| `t5` | Test jump path to nearest player |
| `t6` | Run 9 jump-path obstacle scenarios |
| `t7` | Jump test to (+3, 0, 0) with pre/post state logging and tolerance check |
| `pdb <username>` | Debug info for a player |
| `sdb <slot>` | Debug info for an inventory slot |

## Log Levels

All output flows through the unified Logger facade (`logger.js`). Four levels are supported, automatically color-coded in the TUI:

- `DEBUG` — Detailed diagnostic information (suppressed by default; enabled when the DebugManager loads)
- `INFO` — General operational messages (default)
- `WARN` — Warning conditions
- `ERROR` — Error conditions with automatic stack trace inclusion

In headless mode, ERROR-level messages are routed to stderr with a `HH:MM:SS` timestamp.

### Available API

```js
const logger = require("./logger");

logger.debug(msg, tag?);
logger.info(msg, tag?);
logger.warn(msg, tag?);
logger.error(msg, tag?);

// Semantic helpers (tag is set automatically)
logger.client(msg, level?);
logger.combat(msg, level?);
logger.inventory(msg, level?);
logger.command(msg, level?);
logger.status(msg, level?);
logger.config(msg, level?);
logger.chat(msg);
logger.exception(msg);
logger.warning(msg);
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

- `npm run build`: Compile TypeScript to JavaScript (output in `dist/`).
- `npm run lint`: Run ESLint.
- `npm run format`: Format code with Prettier.
- `npm test`: Run unit tests with Jest.

### Testing

```bash
# Run all tests
npm test

# Run tests with verbose output
npx jest --verbose
```

### Headless Testing

The bot can run in headless mode for automated testing without a TUI:

```bash
# Run from compiled output
node dist/src/index.js --headless "dud"

# Chain multiple commands
node dist/src/index.js --headless "cmd1; cmd2; cmd3;"

# Repeat a command N times with M tick gap
node dist/src/index.js --headless "run t0 10 5" --timeout 30

# Test inventory recording/restoring
node dist/src/index.js --headless "rec 1; clear; res 1" --timeout 30

# Flags can appear in any order
node dist/src/index.js --timeout 60 --headless "eq 1 boots; v"
```

The headless mode defaults to a 10-second timeout. Use `--timeout <seconds>` to customize.

## Project Structure

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, listener management, plugin loading |
| `src/tui.ts` | Terminal UI (blessed) or headless console logger with log levels |
| `src/logger.ts` | Unified logging facade — all modules must use this |
| `src/commands.ts` | Hierarchical command tree with context-sensitive CLI support |
| `src/cli-engine.ts` | CLI engine — tokenization, resolution, suggestions, abbreviation expansion, help generation |
| `src/pvp.ts` | Combat manager, strafing, targeting, decision tree |
| `src/inventory.ts` | Inventory manager, equipment, item caching |
| `src/utils.ts` | Physics (AABB, trajectory, collision), movement utilities, LRU block cache |
| `src/config.ts` | Runtime configuration manager for mutable constants |
| `src/debug.ts` | Debug/test commands for development |
| `src/constants.ts` | Centralized constants (physics, combat, materials, timing) |
| `tests/` | Unit tests for utils and pvp modules |
| `dist/` | Compiled JavaScript output (generated by `npm run build`) |

## License

ISC