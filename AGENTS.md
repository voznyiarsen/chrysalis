# AGENTS.md

Pupa is a Node.js Minecraft bot written in TypeScript.

---

## Build & Run

- `npm run build` — compiles `src/` to `dist/`
- `npm start` — runs the bot (after build)
- `npm start -- --headless --bot "command"` — headless mode
- `npm test` — all tests; `npm test -- tests/unit` — unit only

## Architecture

- **Entry**: `src/index.ts` — multi-bot registry, CLI parsing
- **Combat**: `src/pvp.ts` — CombatManager, PVPManager, CombatDecision
- **Inventory**: `src/inventory.ts` — equip, toss, consume, record/restore
- **Movement**: `src/movement.ts` — jump physics, collision, void safety
- **Projectiles**: `src/projectile.ts` — pearl trajectory, swept raycast
- **Utils**: `src/utils.ts` — AABB, physics, block cache
- **Types**: `src/types/mineflayer.d.ts` — Bot interface augmentation
- **Config**: `src/config.ts` (runtime overrides), `src/constants.ts` (defaults)

File naming: kebab-case (`cli-engine.ts`). No camelCase file names.

## Conventions

- Private: `_camelCase`. Constants: `SCREAMING_SNAKE_CASE`. Classes: `PascalCase`.
- Logger: use `logger` facade from `src/logger.ts`. Never `console.log`/`ui.log` outside `tui.ts`/`logger.ts`.
- Server commands: `bot.chat("/cmd"); await bot.waitForTicks(n)` — never wait on success messages.
- Client commands: never send via `bot.chat()`.
- Types: use declaration merging for plugin properties, not `(bot as any)`.

## Testing

- Unit: `tests/unit/` — mocked bot, no server needed
- E2E: `tests/e2e/` — requires `E2E_HOST` + `RCON_PASS` in `.env`; skipped without them
- E2E suites: jump, pearl, inventory, pvp (run with `--runInBand`)
- E2E helpers: `tests/e2e/setup.ts` — RCON, summon, pin, kill, teleport, difficulty

### E2E pitfalls

- Natural spawns: flat world + `DIFFICULTY: normal` spawns animals. Tests must tolerate this.
- Summon filtering: `summonNear` matches by name, not just proximity.
- Teleporting: use `tpBot` (moves bot, physics freeze). Entity `/tp` via RCON is unreliable in 1.12.2 (no UUID selectors).
- Effect/food drain: some servers can't clear effects or drain food. Tests skip when preconditions can't be met.
- Flakes: transient stalls happen. A test failing twice with assertion mismatches is a real bug.

## Environment

See `.env.example` for all variables. Key ones: `PUPA_HOST`, `PUPA_PORT`, `E2E_HOST`, `RCON_PASS`.

## Rules

1. Ask before ambiguous changes (which files, expected behavior, scope).
2. Build + test after every change. `npm run build && npm test`.
3. Never modify `.expect()` to force a pass — fix the underlying issue.
4. Don't add top-level files when existing modules can be extended.
5. Don't assume the server is at fault — check the codebase first.
