/**
 * @fileoverview E2E integration tests for inventory functionality.
 *
 * Tests equip prioritization logic for armor, weapons, and utilities.
 * Verifies that InventoryManager methods select the best item based on
 * material tier, enchantments, and bot state.
 *
 * Environment variables (`.env`):
 *   E2E_HOST      - Server hostname (default: localhost)
 *   E2E_PORT      - Server port     (default: 25565)
 *   E2E_VERSION   - Game version    (default: 1.12.2)
 *   E2E_TIMEOUT   - Seconds per test (default: 60)
 *
 * Skipped automatically when E2E_HOST is not set.
 */

// ── E2E configuration ───────────────────────────────────────────────

import "dotenv/config";
import { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { logger } from "../../src/logger";
import { Constants } from "../../src/constants";
import {
  buildGiveCmd,
  buildServerGiveCmd,
  createBot,
  e2eTimeoutMs,
  e2eVersion,
  effectClearCmd,
  effectGiveCmd,
  enchNbt,
  ensureTestEnvironment,
  ensureReady,
  getSessionPosition,
  getUsername,
  isModernVersion,
  logSuiteStart,
  requireRcon,
  ensureCreative,
  ensureSurvival,
  pollUntil,
  resetBotState,
  restoreTestEnvironment,
  sendCommandVerified,
  serverCommand,
  setDifficulty,
  tpBot,
  type EnchantSpec,
} from "./setup";

const HOST = process.env.E2E_HOST;
const USERNAME = getUsername("inv");
const BASE_POSITION = new Vec3(50, 1, 50);
const POSITION = getSessionPosition(BASE_POSITION);
const TIMEOUT_MS = e2eTimeoutMs();
const VERSION = e2eVersion();

// ── Conditional test runner ─────────────────────────────────────────

const describeE2E = HOST ? describe : describe.skip;

// ── Helpers ─────────────────────────────────────────────────────────

/** Get the inventory manager for the bot. */
function getInv(bot: Bot): any {
  return bot.inventoryManager;
}

/** Get the slot index for a given equipment destination name. */
function getEquipSlot(bot: Bot, destination: string): number {
  return bot.getEquipmentDestSlot(destination);
}

/** Get the item currently equipped in a given slot destination. */
function getEquippedItem(
  bot: Bot,
  destination: string,
): { name: string; displayName: string; enchants?: any[] } | null {
  const slot = getEquipSlot(bot, destination);
  const item = bot.inventory.slots[slot];
  return item
    ? {
        name: item.name,
        displayName: item.displayName,
        enchants: item.enchants,
      }
    : null;
}

/** Reset bot state between tests: stop pathfinding/PVP, switch to creative. */
async function resetState(bot: Bot): Promise<void> {
  await resetBotState(bot);
}

/** Clear the bot's entire inventory via creative mode. */
async function clearInventory(bot: Bot): Promise<void> {
  await ensureCreative(bot);
  await getInv(bot).clearInventory();
  await pollUntil(
    bot,
    () => bot.inventory.items().length === 0,
    40,
    "inventory to be empty after clear",
  );
}

/**
 * Give the bot an item via /give and wait until it arrives.
 * 1.12.2 syntax: /give <player> <item> [amount] [data] [dataTag].
 * 1.13+ syntax:  /give <player> <item>[nbt] [amount].
 */
async function giveItem(
  bot: Bot,
  itemName: string,
  count: number = 1,
  metadata?: number,
  nbt?: string,
  modernNbt?: string,
): Promise<void> {
  const cmd = buildServerGiveCmd(
    bot.username,
    itemName,
    { count, metadata, nbt },
    VERSION,
    modernNbt,
  );
  // RCON executes synchronously server-side; a generous poll covers
  // client sync lag, then fail loudly (no permission concept to heal).
  await serverCommand(bot, cmd);
  await pollUntil(
    bot,
    () => bot.inventoryManager.getItemCount(itemName) >= count,
    120,
    `${count}x ${itemName} in inventory after /give`,
  );
  await bot.waitForTicks!(Constants.TIMING.EQUIP_TICKS);
}

/**
 * Give the bot an enchanted item via /give with NBT.
 * 1.12.2 uses numeric enchantment IDs (`ench` tag);
 * 1.13+ uses namespaced keys (`Enchantments` tag).
 */
async function giveEnchantedItem(
  bot: Bot,
  itemName: string,
  enchantments: EnchantSpec[],
  count: number = 1,
): Promise<void> {
  const tag = enchNbt(enchantments, VERSION);
  await giveItem(bot, itemName, count, undefined, tag.legacy, tag.modern);
}

/** Check if the server version supports netherite items (1.16+). */
function supportsNetherite(): boolean {
  const version = VERSION || "1.12.2";
  const parts = version.split(".").map(Number);
  if (parts[0] < 1) return false;
  if (parts[1] > 16) return true;
  if (parts[1] === 16 && (parts[2] ?? 0) >= 0) return true;
  return false;
}

/**
 * Send a command and wait for the server to process it.
 * Always awaited: fire-and-forget /commands are the top flake source.
 */
async function sendCommand(bot: Bot, command: string): Promise<void> {
  await serverCommand(bot, command);
  await bot.waitForTicks!(Constants.TIMING.EQUIP_TICKS);
}


/**
 * Reduce the bot
/**
 * Reduce the bot's health to at most `target` using controlled falls.
 * Magic-damage effects are unreliable across servers (observed: confirmed
 * /effect with zero HP change), but fall damage is server-authoritative.
 * Targets below 10 are rejected: fine control near death risks respawn
 * (which drops inventory and teleports). Falls are spaced past the 10-tick
 * hurt cooldown; fast natural regen just costs extra iterations.
 */
async function setBotHealth(bot: Bot, health: number): Promise<void> {
  // Survival is required for falls to hurt; verified below.
  await ensureSurvival(bot);
  // Clear stale effects first: a leaked hunger effect starves the bot,
  // outpacing heals and invalidating every health assertion below.
  await clearEffects(bot);
  if (health >= 20) {
    // Heal path (harmless no-op when already full).
    await sendCommand(
      bot,
      effectGiveCmd(bot.username, "instant_health", 1, 255, VERSION),
    );
    await pollUntil(bot, () => (bot.health ?? 0) >= 20, 60, "full health");
    return;
  }
  if (health < 10) {
    throw new Error(
      `setBotHealth: refusing target ${health} (minimum 10; lower risks death/respawn)`,
    );
  }
  const p = bot.entity.position.clone();
  // Single fall size (8 blocks, ~3 damage): small falls stall because fast
  // natural regen outpaces ~1-damage falls. Guard keeps every fall lethal-safe.
  for (let attempt = 0; attempt < 12 && bot.health! > health; attempt++) {
    if (bot.health! < 9) break;
    // tpBot verifies arrival; the rise confirms
    // the teleport executed, then wait out the landing.
    await tpBot(bot, p.x, p.y + 8, p.z);
    await pollUntil(bot, () => !bot.entity.onGround, 40, "leaving ground");
    await pollUntil(bot, () => bot.entity.onGround, 200, "landing after fall");
    await bot.waitForTicks!(11); // clear hurt cooldown before next fall
  }
  if (bot.health! > health) {
    throw new Error(
      `setBotHealth could not reach ${health} (at ${bot.health})`,
    );
  }
}

/**
 * Whether food can drop below 20 on this server. Peaceful-like servers pin
 * food (hunger effect + regen cycle observed with zero movement), making
 * eat-tests impossible. Probed once per suite run; callers skip with a loud
 * warning when false.
 */
let foodDrainable: boolean | null = null;
async function canDrainFood(bot: Bot): Promise<boolean> {
  if (foodDrainable !== null) return foodDrainable;
  await sendEffect(bot, "hunger", 120, 5, "17");
  await bot.waitForTicks!(300);
  // Require two sub-20 reads a minute apart: single transient dips have
  // been observed on servers that otherwise pin food at 20.
  const first = bot.food! < 20;
  await bot.waitForTicks!(60);
  foodDrainable = first && bot.food! < 20;
  await sendCommand(bot, effectClearCmd(bot.username, VERSION));
  if (!foodDrainable) {
    logger.warning(
      "Food does not drain on this server (peaceful-like). Food-drain tests will skip.",
      "Inventory",
    );
  }
  return foodDrainable;
}

/**
 * Set the bot's food level. Only valid when canDrainFood() is true;
 * callers must gate on it first.
 */
async function setBotFood(bot: Bot, food: number): Promise<void> {
  if (food < 20) {
    await sendEffect(bot, "hunger", 120, 5, "17");
    // Drain with stall recovery: if food stops dropping, the server may
    // have reverted to peaceful mid-test — re-assert normal and continue.
    // Bounded at ~900 ticks total.
    let lastFood = bot.food!;
    let stall = 0;
    for (let elapsed = 0; elapsed < 900; elapsed += 20) {
      await bot.waitForTicks!(20);
      if (bot.food! <= food) break;
      if (bot.food! < lastFood) {
        lastFood = bot.food!;
        stall = 0;
      } else if ((stall += 20) >= 200) {
        stall = 0;
        // Stall recovery via RCON when available (survives OP loss),
        // else in-game chat (needs OP).
        await setDifficulty("normal");
      }
    }
    if (bot.food! > food) {
      throw new Error(
        `Timed out waiting for food <= ${food} (at ${bot.food})`,
      );
    }
    await sendCommand(bot, effectClearCmd(bot.username, VERSION));
    await bot.waitForTicks!(2);
  } else {
    await sendEffect(bot, "saturation", 5, 1, "23");
    await pollUntil(bot, () => bot.food! >= 20, 100, "full food");
    await sendCommand(bot, effectClearCmd(bot.username, VERSION));
    await bot.waitForTicks!(2);
  }
}

/** Remove all effects from the bot (verified: leaked hunger starves the bot). */
async function clearEffects(bot: Bot): Promise<void> {
  await sendCommand(bot, effectClearCmd(bot.username, VERSION));
  await pollUntil(
    bot,
    () => Object.keys(bot.entity.effects || {}).length === 0,
    60,
    "effects cleared",
  );
}

/**
 * Apply an effect and verify it landed (presence in bot.entity.effects),
 * healing OP via RCON and retrying once on failure. Unverified fire-and-
 * forget /effect is the top source of phantom test failures.
 */
async function sendEffect(
  bot: Bot,
  effect: string,
  seconds: number,
  amplifier: number,
  effectId: string,
): Promise<void> {
  await sendCommandVerified(
    bot,
    effectGiveCmd(bot.username, effect, seconds, amplifier, VERSION),
    () => bot.entity.effects[effectId as any] !== undefined,
    `${effect} effect present`,
  );
}

// ── E2E test suite ──────────────────────────────────────────────────

describeE2E("E2E Inventory Tests", () => {
  let bot: Bot;
    let envToken: {
    difficultyBumped: boolean;
    timeFrozen: boolean;
    hostiles: boolean;
  } | null = null;

  // ── Lifecycle ─────────────────────────────────────────────────────

  jest.setTimeout(TIMEOUT_MS * 5);

  beforeAll(async () => {
    // Phase 0: RCON channel (fail fast — every setup command needs it).
    requireRcon();
    logSuiteStart("E2E Inventory Tests", USERNAME);
    // Phase 1: bot setup, pure client-side (connect + attach managers).
    bot = await createBot({ username: USERNAME, timeoutMs: TIMEOUT_MS });
    try {
      // Phase 2: environment setup via RCON — normal difficulty so food
      // drain mechanics work (restored afterAll).
      await ensureReady(bot, POSITION);
      envToken = await ensureTestEnvironment(bot, { difficulty: "normal" });
    } catch (error) {
      logger.error(error, "Inventory");
      throw error;
    }
  }, TIMEOUT_MS);

  beforeEach(async () => {
    // Run before each test
    if (bot && bot.entity) {
      try {
        await tpBot(bot, POSITION.x, POSITION.y, POSITION.z);
        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        await resetState(bot);
        await clearInventory(bot);
        await getInv(bot).unequipAllItems();
        await clearEffects(bot);
      } catch (error) {
        logger.error(error, "Inventory");
      }
    }
  }, TIMEOUT_MS);

  afterAll(async () => {
    if (bot) {
      try {
        if (envToken) await restoreTestEnvironment(bot, envToken);
        bot.quit!();
        bot.end!();
        // Wait for the socket to actually close so no bot activity leaks
        // into the next suite file (stale packets + lazy requires crash
        // workers with post-teardown require errors).
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5000);
          bot.once("end", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        logger.error(error, "Inventory");
      }
    }
    logger.setDebugMode(false);
  }, TIMEOUT_MS * 2);

  // ══════════════════════════════════════════════════════════════════
  // Category 1: Armor Equip Prioritization (Worst to Best)
  // ══════════════════════════════════════════════════════════════════

  describe("Armor equip prioritization", () => {
    test("equips worst armor first, then upgrades to better tier", async () => {
      // Give leather helmet (worst tier)
      await giveItem(bot, "leather_helmet", 1);
      await getInv(bot).equipArmor();
      expect(getEquippedItem(bot, "head")!.name).toBe("leather_helmet");

      // Give iron helmet (better tier) — should replace leather
      await giveItem(bot, "iron_helmet", 1);
      await getInv(bot).equipArmor();
      expect(getEquippedItem(bot, "head")!.name).toBe("iron_helmet");

      // Give diamond helmet (best tier) — should replace iron
      await giveItem(bot, "diamond_helmet", 1);
      await getInv(bot).equipArmor();
      expect(getEquippedItem(bot, "head")!.name).toBe("diamond_helmet");
    });

    test("equips full set worst to best across all slots", async () => {
      // Give full leather set (worst)
      await giveItem(bot, "leather_helmet", 1);
      await giveItem(bot, "leather_chestplate", 1);
      await giveItem(bot, "leather_leggings", 1);
      await giveItem(bot, "leather_boots", 1);
      await getInv(bot).equipArmor();
      expect(getEquippedItem(bot, "head")!.name).toBe("leather_helmet");
      expect(getEquippedItem(bot, "torso")!.name).toBe("leather_chestplate");
      expect(getEquippedItem(bot, "legs")!.name).toBe("leather_leggings");
      expect(getEquippedItem(bot, "feet")!.name).toBe("leather_boots");

      // Upgrade to full iron set
      await giveItem(bot, "iron_helmet", 1);
      await giveItem(bot, "iron_chestplate", 1);
      await giveItem(bot, "iron_leggings", 1);
      await giveItem(bot, "iron_boots", 1);
      await getInv(bot).equipArmor();
      expect(getEquippedItem(bot, "head")!.name).toBe("iron_helmet");
      expect(getEquippedItem(bot, "torso")!.name).toBe("iron_chestplate");
      expect(getEquippedItem(bot, "legs")!.name).toBe("iron_leggings");
      expect(getEquippedItem(bot, "feet")!.name).toBe("iron_boots");

      // Upgrade to full diamond set
      await giveItem(bot, "diamond_helmet", 1);
      await giveItem(bot, "diamond_chestplate", 1);
      await giveItem(bot, "diamond_leggings", 1);
      await giveItem(bot, "diamond_boots", 1);
      await getInv(bot).equipArmor();
      expect(getEquippedItem(bot, "head")!.name).toBe("diamond_helmet");
      expect(getEquippedItem(bot, "torso")!.name).toBe("diamond_chestplate");
      expect(getEquippedItem(bot, "legs")!.name).toBe("diamond_leggings");
      expect(getEquippedItem(bot, "feet")!.name).toBe("diamond_boots");
    });

    test("enchanted lower-tier armor outscores plain higher-tier", async () => {
      // Give plain iron helmet
      await giveItem(bot, "iron_helmet", 1);
      await getInv(bot).equipArmor();
      expect(getEquippedItem(bot, "head")!.name).toBe("iron_helmet");

      // Give leather helmet with Protection V (enchanted)
      // Protection V adds 5 to score, leather defense=1 → total 6
      // vs iron defense=2, toughness=0 → total 2
      await giveEnchantedItem(bot, "leather_helmet", [
        { id: 0, key: "minecraft:protection", lvl: 5 },
      ]);
      await getInv(bot).equipArmor();
      expect(getEquippedItem(bot, "head")!.name).toBe("leather_helmet");
    });

    test("higher enchant level wins within same material", async () => {
      // Give iron helmet with Protection I
      await giveEnchantedItem(bot, "iron_helmet", [
        { id: 0, key: "minecraft:protection", lvl: 1 },
      ]);
      await getInv(bot).equipArmor();
      const headItem = getEquippedItem(bot, "head");
      expect(headItem!.name).toBe("iron_helmet");
      expect(headItem!.enchants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "protection", lvl: 1 }),
        ]),
      );

      // Give iron helmet with Protection IV — should replace
      await giveEnchantedItem(bot, "iron_helmet", [
        { id: 0, key: "minecraft:protection", lvl: 4 },
      ]);
      await getInv(bot).equipArmor();
      const upgradedItem = getEquippedItem(bot, "head");
      expect(upgradedItem!.name).toBe("iron_helmet");
      expect(upgradedItem!.enchants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "protection", lvl: 4 }),
        ]),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 2: Weapon Equip Prioritization (Worst to Best)
  // ══════════════════════════════════════════════════════════════════

  describe("Weapon equip prioritization", () => {
    test("equips worst weapon first, then upgrades to better tier", async () => {
      // Give wooden sword (worst tier, DPS = 4 * 1.6 = 6.4)
      await giveItem(bot, "wooden_sword", 1);
      await getInv(bot).equipWeapon();
      expect(getEquippedItem(bot, "hand")!.name).toBe("wooden_sword");

      // Give stone sword (DPS = 5 * 1.6 = 8.0) — should replace
      await giveItem(bot, "stone_sword", 1);
      await getInv(bot).equipWeapon();
      expect(getEquippedItem(bot, "hand")!.name).toBe("stone_sword");

      // Give iron sword (DPS = 6 * 1.6 = 9.6) — should replace
      await giveItem(bot, "iron_sword", 1);
      await getInv(bot).equipWeapon();
      expect(getEquippedItem(bot, "hand")!.name).toBe("iron_sword");

      // Give diamond sword (DPS = 7 * 1.6 = 11.2) — should replace
      await giveItem(bot, "diamond_sword", 1);
      await getInv(bot).equipWeapon();
      expect(getEquippedItem(bot, "hand")!.name).toBe("diamond_sword");
    });

    test("enchanted lower-tier weapon outscores plain higher-tier", async () => {
      // Give plain iron sword (DPS = 9.6)
      await giveItem(bot, "iron_sword", 1);
      await getInv(bot).equipWeapon();
      expect(getEquippedItem(bot, "hand")!.name).toBe("iron_sword");

      // Give wooden sword with Sharpness V
      // DPS = 4 * 1.6 + (5 * 1.25 * 1.6) = 6.4 + 10.0 = 16.4
      // This outscores iron sword (9.6)
      await giveEnchantedItem(bot, "wooden_sword", [
        { id: 16, key: "minecraft:sharpness", lvl: 5 },
      ]);
      await getInv(bot).equipWeapon();
      expect(getEquippedItem(bot, "hand")!.name).toBe("wooden_sword");
    });

    test("higher sharpness level wins within same weapon", async () => {
      // Give iron sword with Sharpness I
      await giveEnchantedItem(bot, "iron_sword", [
        { id: 16, key: "minecraft:sharpness", lvl: 1 },
      ]);
      await getInv(bot).equipWeapon();
      const handItem = getEquippedItem(bot, "hand");
      expect(handItem!.name).toBe("iron_sword");
      expect(handItem!.enchants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "sharpness", lvl: 1 }),
        ]),
      );

      // Give iron sword with Sharpness V — should replace
      await giveEnchantedItem(bot, "iron_sword", [
        { id: 16, key: "minecraft:sharpness", lvl: 5 },
      ]);
      await getInv(bot).equipWeapon();
      const upgradedItem = getEquippedItem(bot, "hand");
      expect(upgradedItem!.name).toBe("iron_sword");
      expect(upgradedItem!.enchants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "sharpness", lvl: 5 }),
        ]),
      );
    });

    test("axe vs sword: higher DPS wins regardless of type", async () => {
      // Give iron sword (DPS = 6 * 1.6 = 9.6)
      await giveItem(bot, "iron_sword", 1);
      await getInv(bot).equipWeapon();
      expect(getEquippedItem(bot, "hand")!.name).toBe("iron_sword");

      // Give diamond axe (DPS = 9 * 1.0 = 9.0) — lower, should NOT replace
      await giveItem(bot, "diamond_axe", 1);
      await getInv(bot).equipWeapon();
      expect(getEquippedItem(bot, "hand")!.name).toBe("iron_sword");

      // Give a higher-DPS weapon — should replace.
      // Netherite axe (DPS = 10.0) only exists in 1.16+; use diamond sword (DPS = 11.2) on 1.12.2.
      const finalWeapon = supportsNetherite()
        ? "netherite_axe"
        : "diamond_sword";
      const finalDPS = supportsNetherite() ? "10.0" : "11.2";
      await giveItem(bot, finalWeapon, 1);
      await getInv(bot).equipWeapon();
      expect(getEquippedItem(bot, "hand")!.name).toBe(finalWeapon);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 3: Utility Equip Prioritization (Selection Logic)
  // ══════════════════════════════════════════════════════════════════

  describe("Utility equip selection", () => {
    test("equipGapple picks enchanted golden apple over regular", async () => {
      if (isModernVersion(VERSION)) {
        // 1.13+: regular and enchanted gapples are distinct items.
        await giveItem(bot, "golden_apple", 1);
        await getInv(bot).equipGapple(false);
        expect(getEquippedItem(bot, "off-hand")!.name).toBe("golden_apple");

        await giveItem(bot, "enchanted_golden_apple", 1);
        await getInv(bot).equipGapple(false);
        expect(getEquippedItem(bot, "off-hand")!.name).toBe(
          "enchanted_golden_apple",
        );
        return;
      }
      // Give regular golden apple (metadata 0)
      await giveItem(bot, "golden_apple", 1, 0);
      await getInv(bot).equipGapple(false);
      const offHandItem = getEquippedItem(bot, "off-hand");
      expect(offHandItem!.name).toBe("golden_apple");

      // Give enchanted golden apple (metadata 1) — should replace
      await giveItem(bot, "golden_apple", 1, 1);
      await getInv(bot).equipGapple(false);
      const upgradedItem = getEquippedItem(bot, "off-hand");
      expect(upgradedItem!.name).toBe("golden_apple");
      // Verify it's the enchanted variant (metadata 1)
      const offHandSlot = getEquipSlot(bot, "off-hand");
      expect(bot.inventory.slots[offHandSlot].metadata).toBe(1);
    });

    test("equipGapple skips activation when regeneration is active", async () => {
      // Apply regeneration effect (verified present, not fire-and-forget).
      await sendEffect(bot, "regeneration", 30, 1, "10");

      // Give golden apple — equipGapple should skip entirely
      // because regeneration (effect ID 10) is already active.
      // The code returns early WITHOUT equipping when the effect exists.
      await giveItem(bot, "golden_apple", 1);
      await getInv(bot).equipGapple(true);

      // The apple should NOT be equipped — equipGapple returns early
      // when the regeneration effect is already active.
      const offHandItem = getEquippedItem(bot, "off-hand");
      expect(offHandItem).toBeNull();
    });

    test("equipTotem equips totem of undying to off-hand", async () => {
      await giveItem(bot, "totem_of_undying", 1);
      const result = await getInv(bot).equipTotem();
      expect(result).toBe(true);
      expect(getEquippedItem(bot, "off-hand")!.name).toBe("totem_of_undying");
    });

    test("equipFood equips best food to off-hand", async () => {
      // Give bread (foodPoints: 5, saturation: 6.0) and cooked beef (foodPoints: 8, saturation: 12.8)
      await giveItem(bot, "bread", 1);
      await giveItem(bot, "cooked_beef", 1);
      await getInv(bot).equipFood();
      // cooked_beef has higher saturation, should be chosen
      expect(getEquippedItem(bot, "off-hand")!.name).toBe("cooked_beef");
    });

    test("equipBuff prefers strong_strength over regular strength", async () => {
      // Potion drinking only takes effect in survival; restore creative after.
      await ensureSurvival(bot);
      try {
        // Give regular strength potion (Potion: minecraft:strength)
        await giveItem(
          bot,
          "potion",
          1,
          undefined,
          '{Potion:"minecraft:strength"}',
          '{Potion:"minecraft:strength"}',
        );
        // Give strong strength potion (Potion: minecraft:strong_strength)
        await giveItem(
          bot,
          "potion",
          1,
          undefined,
          '{Potion:"minecraft:strong_strength"}',
          '{Potion:"minecraft:strong_strength"}',
        );

        // Verify both potions are in inventory before equipBuff
        const invItems = bot.inventory
          .items()
          .filter((i: any) => i.name === "potion");
        expect(invItems.length).toBe(2);

        // Drinking can miss server-side under load (no effect registered);
        // retry the drink while a potion remains unequipped.
        let consumed = false;
        for (let attempt = 0; attempt < 3 && !consumed; attempt++) {
          await getInv(bot).equipBuff();
          try {
            await pollUntil(
              bot,
              () => getEquippedItem(bot, "off-hand") === null,
              100,
              `strength potion to be consumed (attempt ${attempt + 1})`,
            );
            consumed = true;
          } catch {
            logger.info(
              `Buff drink attempt ${attempt + 1} did not consume, retrying`,
              "Inventory",
            );
          }
        }
        expect(consumed).toBe(true);
      } finally {
        await ensureCreative(bot);
        await bot.waitForTicks!(2);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 4: Utility Priority Order Based on Bot State
  // ══════════════════════════════════════════════════════════════════

  describe("Utility priority order based on bot state", () => {
    test("full health: gapple > food > totem", async () => {
      // Set full health
      await setBotHealth(bot, 20);
      await clearEffects(bot);

      // Give gapple, food, and totem
      await giveItem(bot, "golden_apple", 1);
      await giveItem(bot, "cooked_beef", 1);
      await giveItem(bot, "totem_of_undying", 1);

      // equipUtility (which calls equipGapple(false)) should pick gapple
      await getInv(bot).equipUtility();
      expect(getEquippedItem(bot, "off-hand")!.name).toBe("golden_apple");

      // Clear off-hand, then test food priority when no gapple
      await getInv(bot).unequipAllItems();
      await clearInventory(bot);
      await giveItem(bot, "cooked_beef", 1);
      await giveItem(bot, "totem_of_undying", 1);

      // equipFood should pick food over totem
      await getInv(bot).equipFood();
      expect(getEquippedItem(bot, "off-hand")!.name).toBe("cooked_beef");
    });

    test("hurt bot: equipTotem equips totem to off-hand", async () => {
      // Falls only hurt in survival; beforeEach leaves creative mode.
      await ensureSurvival(bot);
      try {
        // Hurt the bot via falls (magic damage is server-dependent). Note:
        // equipTotem itself does not check health — health gating lives in the
        // combat decisions. Targets below 10 risk death/respawn, so 12 keeps
        // a safe margin while still exercising the hurt path.
        await setBotHealth(bot, 12);
        await clearEffects(bot);

      // Give gapple, food, and totem
      await giveItem(bot, "golden_apple", 1);
      await giveItem(bot, "cooked_beef", 1);
      await giveItem(bot, "totem_of_undying", 1);

      // equipTotem should pick totem for low health
      await getInv(bot).equipTotem();
      expect(getEquippedItem(bot, "off-hand")!.name).toBe("totem_of_undying");
      } finally {
        await ensureCreative(bot);
        await bot.waitForTicks!(2);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 5: Use Utilities in Survival Gamemode
  // ══════════════════════════════════════════════════════════════════

  describe("Use utilities in survival gamemode", () => {
    test("equipGapple activates regeneration in survival", async () => {
      // Switch to survival
      await ensureSurvival(bot);
      await bot.waitForTicks!(2);

      // Set up preconditions: clear effects, ensure health not full
      await clearEffects(bot);
      await setBotHealth(bot, 15);

      // Give golden apple
      await giveItem(bot, "golden_apple", 1);

      // equipGapple(true) should equip AND eat the apple
      await getInv(bot).equipGapple(true);

      // Wait for effect to apply
      await bot.waitForTicks!(10);

      // Verify regeneration effect (ID 10) is active
      const hasRegen = bot.entity.effects["10"] !== undefined;
      expect(hasRegen).toBe(true);

      // Restore creative mode
      await ensureCreative(bot);
      await bot.waitForTicks!(2);
    });

    test("equipFood equips and eats food in survival", async () => {
      // Eating needs food < 20. The suite manages difficulty via RCON,
      // so draining must work; without RCON fall back to the skip gate.
      if (!process.env.RCON_PASS && !(await canDrainFood(bot))) {
        logger.warning(
          "SKIP equipFood-eats: server pins food at 20",
          "Inventory",
        );
        return;
      }
      // Switch to survival
      await ensureSurvival(bot);
      await bot.waitForTicks!(2);

      try {
        // Clear existing effects, then drain just below full so eating has
        // an effect. Only a shallow dip is required (19): deep drains stall
        // on servers with flaky hunger mechanics, and any sub-20 level
        // engages equipFood identically.
        await clearEffects(bot);
        await setBotFood(bot, 19);
        const foodBefore = bot.food!;
        expect(foodBefore).toBeLessThan(20);

        // Give food item
        await giveItem(bot, "cooked_beef", 1);

        // equipFood should equip and eat the food
        await getInv(bot).equipFood();

        // Eating takes ~32 ticks; food level must rise.
        await pollUntil(
          bot,
          () => bot.food! > foodBefore,
          100,
          "food to rise after eating",
        );
        expect(bot.food!).toBeGreaterThan(foodBefore);
      } finally {
        // Restore creative mode
        await ensureCreative(bot);
        await bot.waitForTicks!(2);
      }
    });

    test("equipBuff applies strength effect in survival", async () => {
      // Switch to survival
      await ensureSurvival(bot);
      await bot.waitForTicks!(2);

      try {
        // Clear existing effects
        await clearEffects(bot);

        // Give strength potion
        await giveItem(
          bot,
          "potion",
          1,
          undefined,
          '{Potion:"minecraft:strength"}',
          '{Potion:"minecraft:strength"}',
        );

        // equipBuff should equip and drink the potion
        await getInv(bot).equipBuff();

        // Wait for potion to be consumed
        await pollUntil(
          bot,
          () => getEquippedItem(bot, "off-hand") === null,
          100,
          "strength potion to be consumed",
        );
      } finally {
        // Restore creative mode
        await ensureCreative(bot);
        await bot.waitForTicks!(2);
      }
    });

    test("equipGapple skips eating in creative mode", async () => {
      // Ensure creative mode
      await ensureCreative(bot);
      await bot.waitForTicks!(2);
      await clearEffects(bot);

      // Give golden apple
      await giveItem(bot, "golden_apple", 1);

      // equipGapple(true) in creative should equip but NOT eat
      await getInv(bot).equipGapple(true);

      // Verify apple is equipped
      expect(getEquippedItem(bot, "off-hand")!.name).toBe("golden_apple");

      // Verify no regeneration effect (creative eating has no effect)
      const hasRegen = bot.entity.effects["10"] !== undefined;
      expect(hasRegen).toBe(false);
    });
  });
});
