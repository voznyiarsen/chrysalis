## 1. Goals

- Focus of this phase: complete the Ink TUI — per-bot screen navigation, shared command input, log/metrics display.
- Support N bots via `BotRegistry` with broadcast commands.
- Provide TUI and CLI interfaces.
- Accept typed commands and narrow autonomous behaviors: auto-eat and auto-equip (running every tick while combat is enabled).
- Strafe around enemies and across terrain of any shape.
- Prioritize targets automatically within the active combat mode.
- Use equipment intelligently:
  - Throw ender pearls around or beside walls.
  - Auto-equip the best armor based on material and enchantments, plus the best other items by scoring (weapon, offhand, golden apple).

---

## 2. Architecture Layers

| Layer | Responsibility | Actual Modules |
|---|---|---|
| Core | Registry, config, logging | `bot-registry.ts` (BotRegistry), `config.ts` (RuntimeConfig), `logger.ts` (Logger) |
| Perception | Inventory tracking, block caching | `inventory.ts` (InventoryManager with per-tick caching), `utils.ts` (block caches) |
| Decision | Behavior tree, combat modes, target filtering | `behavior-tree.ts`, `pvp.ts` (CombatManager modes 0–3) |
| Action | Movement physics, strafe arcs, pearl trajectories, equipment | `movement.ts`, `strafe.ts` (StrafeController), `projectile.ts`, `inventory.ts` (equip methods) |
| Interface | Ink TUI, CLI, logging | `tui.tsx`, `cli-engine.ts`, `commands.ts`, `logger.ts` |

---

## 3. Core Components

**BotRegistry** (`bot-registry.ts`)
- Creates, tracks, and removes bot instances via `--bot` flags (e.g., `bot1,2 cmd`).
- Broadcasts commands to one or many bots; per-bot prefixed input supported.
- Spawns N bot instances; each bot loads its own `pathfinder` plugin and `Movements`.
- Supports multi-bot logging with bot identifier prefixes `[botN]` integrated into tags.

**RuntimeConfig** (`config.ts`)
- Per-key overrides via a `Map<string, unknown>` keyed `"CATEGORY.KEY"`.
- Wraps `Constants` object from `constants.ts`; falls back to `Constants[category][key]`.
- Consumed by `cfg` command and pvp range settings.
- Per-bot instance created at bot construction; note: currently overwritten at login (known issue).

**Bot lifecycle** (in `bot-registry.ts`, `index.ts`)
- Wraps mineflayer clients; holds position, health, food, inventory, equipment.
- Connects, disconnects, ticks via `physicsTick` events.
- Plugin-added properties (`bot.inventoryManager`, `bot.combatManager`) declared via module augmentation in `src/types/mineflayer.d.ts`.

**Command routing** (`commands.ts`, `index.ts`)
- Parses input from TUI and CLI.
- Dispatches to `CommandManager` handlers or fans out to selected bots.
- No dedicated `CommandRouter` or `EventBus` class; routing is inline in `index.ts` loop.

**Ink TUI** (`tui.tsx`)
- Migrated from blessed (deleted) to Ink v8 with dynamic import.
- Single-screen layout: log pane + input line + suggestion popup.
- Keybinds: Enter submit/accept, Up/Down history/navigation, Tab completion, Esc clear, Ctrl+C exit.
- Logs show `[botN]` tags from Logger; levels DEBUG/INFO/WARN/ERROR color-coded.
- Headless mode: `createHeadlessUI()` triggered by `--headless`, non-TTY, or Ink load failure.
- Tab completion wired via `tokenize`, `resolve`, `getSuggestions`, `expandAbbreviation` from `cli-engine.ts`.
- **No multi-screen routing yet** — top-level bot list, per-bot screens, shared metrics screen are future work.
- Current build error at line 346 (`debugMode` undefined — mid-refactor).

**CLI** (`cli-engine.ts` + `commands.ts`)
- Cisco IOS-style hierarchical command tree.
- `resolve(tree, tokens)` walks tree, returns deepest match.
- `registerCommand(name, node)` plugin API.
- `evaluatePlaceholders()` resolves `${x}`, `${y}`, `${z}`, plus `health`, `food`, `yaw`, `pitch`, `version`, `target`, and user variables.
- Tab completion via `getSuggestions`; help via `getHelp`.
- **No `?` help alias** — only `help` command.
- `func [args...]` provides access to internal functions.
- Commands: `as`, `ts`, `eq`, `uneq`, `rec`, `res`, `v`, `pos`, `com`, `cm`, `s`, `cfg`, `run`, `debug`, `msglog`, `vel`, `pause`, `jump`, `func`, `help`, etc.

---

## 4. Perception

- **InventoryManager** (`inventory.ts`): per-tick item caching keyed to `bot.time.age`, event-driven invalidation via `windowUpdate`/`changedSlot`.
- **Block caches**: `UtilsManager._solidCache` (16-entry LRU, 500ms TTL) in `utils.ts`; `movement.ts getSolidBlocks` LRU; `ObstacleCache` in `strafe.ts` (rebuilds on >0.5b move, radius 3).
- **No unified WorldModel, EntityTracker, or InventoryTracker class** — closest logic exists in the modules above.
- Entity tracking: only `CombatManager.updateTarget` stickiness in `pvp.ts`.

---

## 5. Decision

**Behavior Tree** (`behavior-tree.ts`)
- Replaces `CombatDecision[]` array in runtime path.
- Uses `behaviortree` npm library; `Selector` root, `Sequence` composites, custom `condition()`/`action()`/`alwaysTrue()` leaf factories.
- **No decorators** (no cooldown, inverter, retry, parallel).
- **8 branches** (combat/inventory only): `fallProtection`, `criticalTotem`, `heal`, `armor`, `weapon`, `pearl`, `buff`, `food`.
- **No Idle/Passive/Follow/roam branches** — tree only decides inventory actions when combat is enabled.
- Wired: built in `CombatManager.setupDecisions` (`pvp.ts:383`), executed on `physicsTick` via `executeDecisions()` (`pvp.ts:690-693`).
- Registered only when `com` command toggles combat on; not auto-registered at startup.
- Legacy `_legacySetupDecisions` exists but is never called.
- No tests for the tree.

**Combat Modes** (`pvp.ts`)
- Mode 0–3: `setMode(mode?)` cycles mod 4; `getTargetFilter()` returns cached filter function per mode.
- Mode 0 = Hostile mobs (`e.type === "mob"`, `e.kind === "Hostile mobs"`).
- Mode 1 = Players in survival gamemode (`e.type === "player"`, `gamemode === 0`, excludes allies).
- Mode 2 = All players regardless of gamemode (excludes allies).
- Mode 3 = All entities (players + mobs, excludes allies).
- Pacify: `setMode(4)` → filter returns `()=>false`.
- Allies tracked via `alliesSet`; `addAlly(username)` invalidates filter cache.
- Filter cached with `lastMode` check for invalidation.

**Target Selection**
- `CombatManager.updateTarget()` (`pvp.ts:1025-1049`): sticky target selection with mode filter.
- No standalone `TargetPrioritizer` class; scoring/ranking not implemented.
- No `TaskPlanner` or `CombatModes` module — logic inline in `CombatManager`.

**Autonomous Behaviors** (all in behavior tree, run while combat enabled)
- **Auto-eat**: `heal` branch (gapple when health<20, no regen, safe vs lastDamage), `food` branch (food<18 or healing need, safety gate). Calls `InventoryManager.equipFood`/`equipGapple`.
- **Damage-taken heuristic**: `getLastDamage()` (`pvp.ts:796-802`) fed by `entityHurt` listener in `bot-registry.ts:556-562`.
- **Auto-equip every tick**: `armor` and `weapon` branches are `alwaysTrue()` sequences run on every `executeDecisions()` (every `physicsTick` after `com` enabled).
- **Fall protection**: `getFallProtectionStatus()` (`pvp.ts:822-886`) predicts damage, ticks to impact, chooses gapple/egapple/totem.
- **Edge protection**: `doEdgeProtection()` (`pvp.ts:955-991`) sneaks + nudges toward block center.
- No auto-defend/auto-follow/auto-mine — those were cut from scope.

---

## 6. Action

**Movement physics** (`movement.ts`)
- Jump trajectory simulation: `isJumpPathClear()` (tick-simulated LCE trajectory + sweptTOI).
- Jump velocity: `getJumpVelocity()` closed-form with friction geometry + `JUMP_CORRECTION 0.825`.
- Collision detection: `getCollisions()`, `isPositionClear()`, `AABB.sweptTOI` from `utils.ts`.
- Fall damage: `getFallDamage()`.
- Solid block LRU: `getSolidBlocks()` (16 entries, 500ms TTL).
- Ground detection: `getGroundBelow()` (block-column scan, no slope raycast).
- **No `mineflayer-pathfinder` usage in movement.ts** — pathfinding loads in `bot-registry.ts:126`, goal issuance in `pvp.ts:110-236`.
- **No `bot.setControlState` here** — only in `pvp.ts` edge-protection sneak.

**StrafeController** (`strafe.ts`) — **dead code, not imported anywhere**
- `StrafeController` class with `computeStrafe()`, `steerAir()`, `reset()`.
- **Not named `doStrafe`/`doAvoid`** — those don't exist here (`doAvoid` is in `pvp.ts:932` hazard function).
- Single candidate per direction; `candidates[]` array vestigial.
- Hazard block avoidance: **absent** — lives in `UtilsManager.isInUnwanted` (`utils.ts:807-835`) against `["water","lava","web","cactus"]`, **no soulsand**.
- `ObstacleCache`: full rebuild when bot moves >0.5b, radius 3, no entry cap/LRU.
- Bounding-box sweep: uses `collision-oracle` `isPathClear`/`sweepAABB`.
- Jump-velocity constraints: constants only (`STRAFE_JUMP_DISTANCE: 4.0`), `getJumpVelocity` not used.
- **No pathfinder fallback**.
- Constants (`constants.ts:133-144`): `STRAFE_RADIUS: 3.0`, `STRAFE_MIN_SPACING: 2.5`, `STRAFE_GRID_RESOLUTION: 0.3`, `MAX_AXIS_SPEED: 0.35635`.
- **Currently unreferenced** — no imports outside `strafe.ts` itself; no tests.

**PVP / Combat** (`pvp.ts`)
- **PVPManager** (`pvp.ts:68-295`): attack/stop/forceStop, cooldown update on `physicsTick`, creeper-shield block, `GoalFollow`/`GoalNearXZ` issue-once-per-goal logic.
- **CombatManager** (`pvp.ts:330-1095`): main loop `doDecide` → `updateTarget()` → `doAvoid()` → `doEdgeProtection()` → `await executeDecisions()`.
- Modes, fall protection, edge protection, `getLastDamage` as above.
- **CombatDecision class** (`pvp.ts:296-325`): exported but only used in `tests/unit/pvp.test.ts`; dead in runtime path.
- Registered on `physicsTick` only when `com` command toggles combat on.
- Known bug: `doAvoid` passes boolean as `Vec3` to `getFlatVelocity` → NaN components.

**Equipment** (`inventory.ts`)
- **InventoryManager** class (no `EquipmentController`/`ArmorManager` classes).
- `equipArmor()` (`inventory.ts:557-629`), `_computeArmorScore()` (`inventory.ts:639-669`): defense + toughness + protection level + 0.1/other enchant, binding curse −1.
- `equipWeapon()` (`inventory.ts:1044-1085`), `_computeWeaponScore()` (`inventory.ts:1094-1105`): `damage*speed` base + `sharpness.lvl*1.25*speed`.
- Attack speed/cooldown multipliers also in `pvp.ts:31-62`.
- `equipGapple()` (`inventory.ts:676-729`): always equips to off-hand, prefers enchanted, skips if regen active or creative.
- `equipFood()` (`inventory.ts:743-804`): best saturation→foodPoints, eats via `activateItem`.
- `equipTotem()`, `equipBuff()`, `equipUtility()`.
- Creative record/restore: `recordInventory()` (JSON file), `restoreInventory()` (switches to creative via `setGamemode(1)`, `creative.setInventorySlot`, back to survival).
- Scoring runs every tick while combat enabled (via behavior tree).
- Golden apple always held in offhand when no other offhand action executing.

**Pearl trajectory** (`projectile.ts`) — **module functions, no `PearlArcSolver` class**
- `getProjectilePitch()` (ballistic quadratic + Newton refine).
- `getProjectileOffset()` (closed-form drag=1 + binary-search root with drag).
- `isProjectilePathClear()` (raycastBlocks swept segment).
- `getBestPearlTrajectory()` → `PearlTrajectoryResult`.
- Lateral sampling: ±step perpendicular to origin→target axis.
- **No backward/forward sampling** (docstring explicitly: lateral only).
- Tolerance: `toleranceRadius = 1.5`, capped at `dist/4`; `sampleStep = 0.5` (or `1.0` via `UtilsManager` wrapper).
- Defaults (`constants.ts:167-172`, `190-196`): velocity 1.5, gravity 0.03, drag 0.99, `ENDER_PEARL.MAX_RANGE: 50`, `COOLDOWN: 10000`ms, max sim 200 ticks.
- **No clearance scoring** (0.6b clearance not implemented; sort has no clearance term).

**CollisionOracle** (`collision-oracle.ts`) — **module functions, not a class, dead code**
- `isPathClear(from, to, blockAt, radius=0.3)` — wrapper over `sweepAABB`.
- `sweepAABB(from, to, blockAt, halfWidth=0.3, height=1.8)` — discrete 0.1-step swept bounding-box sampling (not true swept-sphere).
- `playerAABB(pos, ...)`.
- AABB backend from `utils.ts` class `AABB` with `sweptTOI`, `calculateX/Y/ZOffset`.
- **Only consumer**: `strafe.ts` (which is itself unreferenced).
- No tests.

---

## 7. Pearl Throw Planning Flow

1. Call `getBestPearlTrajectory(origin, target, ...)` with gravity, max speed, projectile radius, tolerance radius, max time.
2. Solve ballistic arcs via `getProjectilePitch`/`getProjectileOffset`.
3. Test each arc via `isProjectilePathClear` (raycast segment).
4. Return fastest clear arc.
5. If exact target blocked, sample lateral points within tolerance (±step perpendicular to axis, cap dist/4).
6. Solve and test arcs for each sampled point.
7. Keep best feasible arc within tolerance (sort by flight time then miss distance).
8. Return `PearlTrajectoryResult` or failure.

**Implementation** (`projectile.ts`)
- Module functions, no standalone class.
- Pure geometry: no combat state, no entity references (except entity hitbox check at 0.25).
- Lateral-only sampling; no forward/backward.
- Defaults in `constants.ts`.
- Used by behavior tree `pearl` branch, `UtilsManager` wrappers, tests.

**Tolerance Sampling**
- Lateral only: perpendicular to origin→target axis.
- Max offset: `min(1.5, dist/4)`.
- Sample step: 0.5 (module) or 1.0 (UtilsManager wrapper).
- No forward/backward sampling.

**Scoring** (`getBestPearlTrajectory` sort)
- Fastest flight time wins.
- Tie-break by miss distance (smaller better).
- **No clearance term** in scoring (docstring mentions it but sort doesn't implement it).

---

## 8. Scalability

- `BotRegistry` spawns N bots via `--bot` flags; per-bot pathfinder and Movements instances.
- **No shared cache** — each bot owns `InventoryManager` block caches, `UtilsManager._solidCache`.
- All planning on main thread (Node.js single-threaded).
- Runtime configuration: `RuntimeConfig` in `config.ts` with per-key `Map` overrides wrapping `constants.ts`.
- Graceful reconnect/backoff: **not implemented** (no rate limiting, no backoff logic found).

---

## 9. Key Invariants

- Behavior tree replaces `CombatDecision[]` in runtime path (legacy setup never called).
- Combat modes 0–3 filter target selection; mode changes explicit only via `setMode()`.
- Combat mode transitions: explicit commands only, no auto-switching.
- Auto-equip scoring runs every tick while combat enabled.
- Golden apple always held in offhand when no other offhand action executing.
- Armor scoring: defense + toughness + protection enchant + minor enchants, binding curse penalty.
- Weapon scoring: damage×speed base + sharpness contribution.
- Pearl sampling: lateral only, cap dist/4, no forward/backward.
- Strafe bounds: `STRAFE_RADIUS: 3.0`, `MAX_AXIS_SPEED: 0.35635`, `STRAFE_GRID_RESOLUTION: 0.3`.
- Block caches: 16-entry LRU with 500ms TTL (`utils.ts`, `movement.ts`).
- Fall damage mitigation and edge protection built into `CombatManager`.
- Logger levels DEBUG/INFO/WARN/ERROR with `[botN]` prefixes in tags.

---

## 10. Resolved Decisions

- TUI library: Ink v8 (blessed deleted); single-screen layout currently.
- TUI navigation: single screen with input + log pane; multi-screen routing is future work.
- Decision model: Behavior Tree, replacing `CombatDecision[]` in runtime path.
- Behavior tree branches: 8 combat/inventory branches (fallProtection, criticalTotem, heal, armor, weapon, pearl, buff, food); no Idle/Passive/Follow.
- Combat modes: 0=mobs, 1=players in survival gamemode, 2=all players, 3=all entities; explicit transitions only.
- Target selection: sticky in `CombatManager.updateTarget()`; no standalone prioritizer.
- Pearl trajectory: module functions (`projectile.ts`), lateral-only sampling, cap dist/4, no clearance scoring.
- Execution model: single-threaded, main thread; no worker offloading.
- Strafe: `StrafeController` in `strafe.ts` exists but is dead code (unreferenced).
- Command system: Cisco IOS-style tree with `resolve`, `registerCommand`, `evaluatePlaceholders` (${x}/${y}/${z} + health/food/yaw/pitch/version/target), Tab completion, `help` (no `?` alias).
- Physics: custom AABB collision (`utils.ts` class `AABB`), jump trajectory sim (`movement.ts`), projectile prediction (`projectile.ts`), block caches (16-entry LRU, 500ms).
- Inventory: per-tick caching with event invalidation, armor/weapon scoring, golden apple offhand priority, creative record/restore.
- Runtime configuration: `RuntimeConfig` with per-key `Map` overrides.
- Autonomous behaviors: auto-eat (heal/food branches), auto-equip every tick (armor/weapon branches), fall protection, edge protection; no auto-defend/follow/mine.

---

## Appendix: Current State vs Spec

**Implemented and wired:**
- Behavior tree with 8 branches, wired to `CombatManager.executeDecisions()` on `physicsTick`.
- Combat modes 0–3 with filter cache, allies set.
- `InventoryManager` equip methods with scoring, per-tick caching.
- Pearl trajectory module with lateral sampling.
- Movement jump physics, collision detection.
- CLI engine with `resolve`, `registerCommand`, placeholders, completion.
- Ink TUI single-screen with headless mode.
- Logger with levels and bot prefixes.
- RuntimeConfig with per-key overrides.

**Exists but dead code:**
- `strafe.ts` (StrafeController) — no imports outside module.
- `collision-oracle.ts` — only imported by `strafe.ts`.
- `CombatDecision` class — used only in tests, not runtime path.

**Exists but incomplete/mid-refactor:**
- `tui.tsx` — build error at line 346 (`debugMode` undefined).
- `RuntimeConfig` — instance overwritten at login, losing pre-login overrides.

**Not implemented (cut from scope or future):**
- Multi-screen TUI routing, top-level bot list, shared metrics screen.
- `EventBus`, `CommandRouter`, `PathfinderPool`, `WorldModel`, `EntityTracker`, `InventoryTracker`, `TargetPrioritizer`, `TaskPlanner` classes.
- Task queue, rate limiting, reconnect backoff.
- Strafe `doStrafe`/`doAvoid` named methods, pathfinder fallback, soulsand avoidance, LRU entry cap.
- Clearance-based pearl scoring, backward/forward sampling.
- `?` help alias.
- Auto-defend, auto-follow, auto-mine behaviors.
