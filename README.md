# Pupa

A terminal-based Minecraft bot with combat, inventory management, physics simulation, and a Cisco IOS-style CLI.

## Features

- **Terminal UI**: blessed-based TUI with color-coded log levels; headless mode for automation
- **Combat**: PVPManager (attack timing) + CombatManager (decisions, pearls, fall protection)
- **CLI**: hierarchical command tree with `?` help, Tab completion, `${variable}` substitution
- **Runtime config**: adjust constants via `cfg` without restarting
- **Inventory**: smart equip (armor scoring, weapon DPS, gapple priority), record/restore
- **Physics**: AABB collision, jump trajectory, projectile prediction

## Install & Run

```bash
npm install
cp .env.example .env  # edit as needed
npm run build
npm start
```

## Commands

| Command | Description |
|---------|-------------|
| `com` | Toggle combat |
| `cm [0-3]` | Combat mode (0=Mobs, 1=Players Survival, 2=Players All, 3=All) |
| `s` | Pacify (stop combat) |
| `q` | Quit |
| `ts <item>` | Toss item |
| `eq <item> <slot>` | Equip item |
| `uneq <slot>` | Unequip slot |
| `rec [slot]` | Record inventory |
| `res [slot]` | Restore inventory |
| `clear` | Clear inventory (creative) |
| `pause <ticks>` | Pause N ticks |
| `run <cmd> <N> <M>` | Run command N times, M ticks apart |
| `cfg [KEY] [val]` | View/set runtime config |
| `pos` | Show position |
| `v` | Show version |

Type `?` at any prompt for context-sensitive help. Tab auto-completes.

## Testing

```bash
npm test                    # all tests
npm test -- tests/unit      # unit only
npx jest tests/e2e --runInBand  # E2E (needs E2E_HOST + RCON_PASS)
```

- Unit tests use mocked bots — no server needed.
- E2E tests need a real server and RCON access. They skip without `E2E_HOST`.

## Headless

```bash
npm start -- --headless --bot "MyBot" "com; v"
npm start -- --headless --bot "cmd1; cmd2; cmd3"
```

Defaults to 10-second timeout. Use `--timeout <seconds>` to customize.

## License

ISC
