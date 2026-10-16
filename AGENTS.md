# AGENTS.md

## Project: Pupa

Pupa is a Node.js Minecraft bot written in TypeScript.

---

## TypeScript Infrastructure

- **`tsconfig.json`**: targets ES2022, module `Node16` (CommonJS output), strict mode off,
  `isolatedModules: true`, source maps + declarations enabled.
- **`jest.config.js`**: uses `ts-jest` transformer with `.js` extension mapping for imports.
- **Build**: `npm run build` runs `tsc`; output lands in `dist/`.
- **Run**: `node dist/src/index.js` (after build).
- **Type augmentations**: Plugin-added properties (e.g., `bot.inventoryManager`, `bot.combatManager`) are
  declared via module augmentation in `src/types/mineflayer.d.ts`, extending the
  `Bot` interface so they can be accessed directly without `(bot as any)` casts.
- **API docs**: See `documentation/` for Mineflayer/Minecraft protocol docs; `documentation/minecraft/` for gameplay; `documentation/parkour/` for movement physics.

---

## Development Guidelines

- **Runtime**: Node.js. **Language**: TypeScript (`src/` → `dist/`).
- **Linting**: ESLint (`eslint.config.mjs`) with Prettier (`.prettierrc`).
- **Environment**: Configuration goes into `.env` via `dotenv`.
- **Dependencies**: Use `npm install` / `npm ci`; do not add heavy native modules without discussion.
- **File naming**: Use lowercase with hyphens for multi-word module names (e.g., `cli-engine.ts`, `bot-registry.ts`).
  Single-word names are acceptable (e.g., `utils.ts`, `config.ts`). Avoid camelCase file names.

---

## Naming Conventions

- **Private properties/methods**: Use `_camelCase` prefix (e.g., `_itemCache`, `_equipItem`).
- **Constants**: `SCREAMING_SNAKE_CASE` (e.g., `TICK_GRAVITY`).
- **Classes/interfaces/types/enums**: `PascalCase`.
- **Imports**: Module namespace imports are `lowerCamelCase`, files are `kebab-case`: `import * as fooBar from "./foo_bar"`.

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

### Canonical Tags

| Tag           | Domain                                      | Default Level |
| ------------- | ------------------------------------------- | ------------- |
| `Client`      | Bot lifecycle (login, kick, end, reconnect) | INFO          |
| `Combat`      | Decisions, modes, pearls                    | INFO/DEBUG    |
| `Inventory`   | Equip, toss, record, restore, consume       | INFO          |
| `Command`     | User commands, run loops, pause             | INFO          |
| `Status`      | Health, food, position, version             | INFO          |
| `Config`      | Runtime config get/set/list                 | INFO          |
| `Chat`        | Incoming chat messages                      | INFO          |
| `Error`       | Recoverable failures                        | ERROR         |
| `Exception`   | Uncaught exceptions, unhandled rejections   | ERROR         |
| `Warning`     | Node warnings                               | WARN          |
| `Debug`       | Verbose debug output                        | DEBUG         |
| `Movement`    | Movement logic, path execution, navigation  | INFO/DEBUG    |
| `Pathfinding` | Path computation, goal setting, A\* search  | INFO/DEBUG    |
| `Entity`      | Entity tracking, targeting, interaction     | INFO/DEBUG    |
| `Packet`      | Packet handling, protocol events            | DEBUG         |

DEBUG-level logs are suppressed by default. Toggle at runtime via the `debug` command or `logger.setDebugMode(true/false)`.

---

## Command & Interaction Model

- **Server-only commands**: Start with `/`. In production code and tests, execute via `bot.chat()` directly followed by a short `waitForTicks` settle (e.g., `bot.chat('/give @p stone 1); await bot.waitForTicks(2)`). Do not wait on server success messages.
- **Client-only commands**: Do not have a prefix. They are executed using internal bot logic and must **never** be sent via `bot.chat()`. They are registered by modules such as `src/commands.ts`.
- **Runtime config**: Combat and movement constants can be adjusted at runtime via the `cfg` command (e.g., `cfg COMBAT.ATTACK_RANGE 4.0`), routed through `src/config.ts` (`RuntimeConfig` class), which wraps `src/constants.ts` and allows per-key overrides via a `Map`.

---

## Testing

- **Unit tests**: `tests/unit/` — use mocked bot instances, no server required.
- **E2E tests**: `tests/e2e/` — connect to a real Minecraft server; automatically skipped when `E2E_HOST` is not set. Require `RCON_PASS` (server console access; fail-fast in `beforeAll` without it). Environment setup goes exclusively through RCON with explicit players/coordinates — bots never need OP, so there is no OP failure mode. Suites run in three separated phases (see `tests/e2e/setup.ts`): (1) environment setup via RCON (difficulty, time, terrain, mobs, items), (2) bot setup, pure client-side (connect, attach managers), (3) test execution, which only plays the game. Shared lifecycle lives in `tests/e2e/setup.ts` (session usernames via `E2E_SUFFIX`, version branching for 1.12.2 vs 1.13+ command syntax, per-suite difficulty management: suites needing hostiles/food-drain set `/difficulty normal` in `beforeAll` and restore peaceful in `afterAll`). Every server interaction is verified by polling (timeouts report ticks + wall ms to distinguish server stalls from false conditions).
- **Run**: `npm test` (all), `npm test -- tests/unit` (unit only), `npm run test:e2e` (e2e only, serialized with `--runInBand` since difficulty is server-global). For unit-only locally despite `.env`: `E2E_HOST= npm test -- tests/unit`.
- **Concurrent sessions**: set a distinct `E2E_SUFFIX` per run (usernames become `inv|jmp|prl|pvp_<suffix>`, positions offset per session).
- **Flake protocol**: the live server + LAN path produce transient infra flakes (DNS blips, stalls). Every server interaction is verified by polling (generous budgets, no blind retries); if a run still shows 1–2 rotating failures, check the log for `RCON failed` / wall-clock-heavy poll timeouts (infra) vs assertion mismatches (real bugs), then re-run failures only: `npx jest tests/e2e --onlyFailures`. A test failing twice in a row with assertion mismatches is a real bug — investigate, don't re-run a third time.
- **Headless mode**: `npm start -- --headless --bot "command"` for automated testing without a TUI.

---

## Environment Variables

Configuration is loaded from `.env` via `dotenv`. See `.env.example` for the full template.

| Variable       | Default     | Description                |
| -------------- | ----------- | -------------------------- |
| `PUPA_HOST`    | `localhost` | Minecraft server hostname  |
| `PUPA_PORT`    | `25565`     | Minecraft server port      |
| `PUPA_NAME`    | `Pupa`      | Bot player name            |
| `PUPA_VERSION` | `1.12.2`    | Minecraft protocol version |

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
| `src/movement.ts`           | Movement mechanics (jump, collision physics)            |
| `src/projectile.ts`         | Projectile trajectory calculation (pearl arcs)          |
| `src/pvp.ts`                | PvP combat logic (CombatManager, PVPManager)            |
| `src/tui.ts`                | Terminal UI (blessed-based)                             |
| `src/types/mineflayer.d.ts` | Type augmentations for mineflayer Bot/Entity interfaces |
| `src/utils.ts`              | Utility functions (AABB, math, block cache)             |

---

## Common Pitfalls

- **Don't call `ui.log()` or `console.log/error` directly** from any module other than `src/tui.ts` or `src/logger.ts`. Use the `logger` facade.
- **Don't send client-only commands via `bot.chat()`**. Client-only commands (no `/` prefix) are handled by internal bot logic and will fail or cause errors if sent as chat.
- **Don't wait on server success messages** for server commands in production code or tests. Use `bot.chat()` + `waitForTicks` settle instead.
- **Don't add new top-level files** when an existing module can be extended. Prefer enhancing existing modules.
- **Don't modify `.expect()` values in tests** to force a pass. Always fix the underlying issue.
- **Don't assume the server is at fault.** If issues arise, the cause is in the codebase.

---

## Rules for Agents

1. **Ask Clarifying Questions**: Before making code changes, ask the user to confirm intent if any of the following is ambiguous:
   - Which file(s) or module(s) to modify
   - The expected behavior or outcome of the change
   - Which tests to add or update
   - Configuration values, thresholds, or constants to use
   - Scope of the change (e.g., refactor vs. targeted fix)

   If the task description already provides all the necessary details, proceed without asking.

2. **Divide-Verify-Refine**: For complex tasks, break them down into smaller sub-tasks. After each, verify the result through builds, tests, or manual inspection. Refine if issues are found.
3. When implementing new features, prefer enhancing existing modules over creating new top-level files.
4. **Formatting**: Run `npm run lint` and `npm run format` to auto-fix formatting issues instead of manual fixes.
5. **Build & Verify**: After making code changes, run `npm run build` to compile TypeScript and `npm test` to verify nothing is broken. E2E tests are skipped when `E2E_HOST` is not set.
6. **Documentation**: After making code changes, update `README.md` and `AGENTS.md` to reflect any changes to command signatures, file structure, test commands, API signatures, or configuration options.
7. **Jest Tests**: Always resolve the underlying issue causing a test failure. **NEVER** bypass failures by modifying `.expect()` values to force a pass. Modifying an expectation is only acceptable if you have verified that the test expectation itself is incorrect.
8. **Troubleshooting**: If issues arise during development or testing, assume they are caused by the codebase. The server is never at fault.
9. **Terminal Tool Usage**: When using the `terminal` tool, both `command` and `cd` parameters are **required**. Never embed `cd` inside the command string. Do not include shell substitutions like `$VAR`, `$(...)`, or backticks — resolve values beforehand.
10. **Use MCP Web Search Tools**: When you need to look up information outside the codebase (library docs, API references, Minecraft protocol details, changelogs), prefer the MCP web search tools over guessing or relying on stale local knowledge.
