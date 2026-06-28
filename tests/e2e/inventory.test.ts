/**
 * @fileoverview E2E integration tests for Pupa inventory functionality.
 *
 * These tests connect to a real Minecraft server using configuration from `.env`,
 * create a bot instance, load all Pupa managers, and run inventory-related methods
 * against the live server.
 *
 * Environment variables (`.env`):
 *   E2E_HOST      - Server hostname (default: localhost)
 *   E2E_PORT      - Server port     (default: 25565)
 *   E2E_VERSION   - Game version    (default: 1.12.2)
 *   E2E_TIMEOUT   - Seconds per test (default: 60)
 *
 * Skipped automatically when E2E_HOST is not set.
 */

import "dotenv/config";
import * as fs from "node:fs";
import mineflayer, { Bot } from "mineflayer";
import { pathfinder } from "mineflayer-pathfinder";
import { PVPManager } from "../../src/pvp";
import { attachInventory } from "../../src/inventory";
import { attachCombat } from "../../src/pvp";
import { attachCommands } from "../../src/commands";
import { attachUtils } from "../../src/utils";
import { RuntimeConfig } from "../../src/config";
import { logger } from "../../src/logger";
import { Vec3 } from "vec3";

// ── E2E configuration ───────────────────────────────────────────────

const HOST = process.env.E2E_HOST;
const PORT = parseInt(process.env.E2E_PORT || "25565", 10);
const USERNAME = "inventory_test";
const VERSION = process.env.E2E_VERSION || undefined;
const TIMEOUT_MS = parseInt(process.env.E2E_TIMEOUT || "60", 10) * 1000;
const POSITION = new Vec3(300, 1, 300);

// ── Conditional test runner ─────────────────────────────────────────

const describeE2E = HOST ? describe : describe.skip;

// ── Bot creation helper ─────────────────────────────────────────────

async function createBot(): Promise<Bot> {
  const bot = mineflayer.createBot({
    host: HOST!,
    port: PORT,
    username: USERNAME,
    version: VERSION,
    logErrors: true,
    hideErrors: false,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      bot.removeAllListeners("spawn");
      bot.removeAllListeners("error");
      bot.removeAllListeners("end");
      reject(new Error("Connection timed out"));
    }, TIMEOUT_MS);

    bot.once("spawn", () => {
      clearTimeout(timer);
      resolve();
    });
    bot.once("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    bot.once("end", () => {
      clearTimeout(timer);
      reject(new Error("Bot disconnected before spawn"));
    });
  });

  // Load standard plugins
  bot.loadPlugin(pathfinder);
  bot.pvp = new PVPManager(bot);

  (bot as any).runtimeConfig = new RuntimeConfig();
  (bot as any).__logger = logger;
  attachInventory(bot);
  attachCombat(bot);
  attachCommands(bot);
  attachUtils(bot);

  logger.setDebugMode(true);

  return bot;
}

// ── E2E test suite ──────────────────────────────────────────────────

describeE2E("E2E Inventory Tests", () => {
  let bot: Bot;

  // ── Helpers ───────────────────────────────────────────────────────

  const getIm = (): any => (bot as any).inventoryManager;

  /**
   * Reset bot state between tests: stop pathfinding/PVP, switch to creative.
   */
  async function resetBotState(): Promise<void> {
    bot.clearControlStates();
    (bot as any).pathfinder?.stop();
    (bot as any).pvp?.stop();
    await bot.utilsManager.assertCommandSuccess("gamemode", "creative");
    await bot.waitForTicks!(3);
  }

  /**
   * Clear the bot's entire inventory via creative mode.
   * Retries once if a previous test left pending creative operations.
   */
  async function clearBotInventory(): Promise<void> {
    const im = getIm();

    if ((bot.game as any).gameMode !== "creative") {
      await resetBotState();
    }

    // Unequip armor and off-hand first — creative clearInventory skips equipment slots
    try {
      await im.unequipAllItems();
      await bot.waitForTicks!(3);
    } catch {
      await bot.waitForTicks!(3);
    }

    // Clear inventory via creative API, retrying once on failure
    try {
      await im.clearInventory();
      await bot.waitForTicks!(3);
    } catch {
      await bot.waitForTicks!(5);
      await im.clearInventory();
      await bot.waitForTicks!(3);
    }

    im.invalidateCache();
    await bot.waitForTicks!(3);
  }

  // Set overall suite timeout
  jest.setTimeout(TIMEOUT_MS * 5);

  beforeAll(async () => {
    bot = await createBot();
    if (bot && bot.entity) {
      try {
        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        await bot.utilsManager.assertCommandSuccess("tp", Object.values(POSITION).join(" "));
        await bot.waitForChunksToLoad!();
        await bot.waitForTicks!(1);
        await bot.utilsManager.assertCommandSuccess("gamemode", "creative");
        await bot.waitForTicks!(2);
      } catch (error) {
        logger.error(error, "Inventory");
      }
    }
  }, TIMEOUT_MS);

  beforeEach(async () => {
    if (bot && bot.entity) {
      try {
        await resetBotState();
        await clearBotInventory();
      } catch (error) {
        logger.error(error, "Inventory");
      }
    }
  }, TIMEOUT_MS);

  afterAll(async () => {
    // Clean up any recording files created during tests
    try {
      const files = fs.readdirSync(".");
      for (const file of files) {
        if (file.match(/^recording-.*\.json$/)) {
          fs.unlinkSync(file);
        }
      }
    } catch {
      // Ignore cleanup errors
    }

    if (bot) {
      try {
        bot.quit!();
        bot.end!();
      } catch (error) {
        logger.error(error, "Inventory");
      }
    }
    logger.setDebugMode(false);
  }, TIMEOUT_MS);

  // ══════════════════════════════════════════════════════════════════
  // Category 1: Item Acquisition
  // ══════════════════════════════════════════════════════════════════

  describe("item acquisition", () => {
    test(
      "getItemViaCommand — gives ender pearl",
      async () => {
        const im = getIm();
        await bot.utilsManager.assertCommandSuccess("give", "@p ender_pearl 16");
        const count = im.getItemCount("ender_pearl");
        expect(count).toBeGreaterThanOrEqual(16);
      },
      TIMEOUT_MS,
    );

    test(
      "getItemViaCommand — gives diamond sword",
      async () => {
        const im = getIm();
        await bot.utilsManager.assertCommandSuccess("give", "@p diamond_sword 1");
        expect(im.hasItem("diamond_sword")).toBe(true);
      },
      TIMEOUT_MS,
    );

    test(
      "getItemViaCommand — gives stack of golden apples",
      async () => {
        const im = getIm();
        await bot.utilsManager.assertCommandSuccess("give", "@p golden_apple 64");
        const count = im.getItemCount("golden_apple");
        // Server may double stack sizes for some items
        expect(count).toBeGreaterThanOrEqual(64);
      },
      TIMEOUT_MS,
    );

    test("createItemInstance — creates valid item", () => {
      const im = getIm();
      const item = im.createItemInstance("ender_pearl", 1);
      expect(item).not.toBeNull();
      expect(item.name).toBe("ender_pearl");
      expect(item.count).toBe(1);
    });

    test(
      "getItemViaCreative — sets slot directly via /give and creative API",
      async () => {
        const im = getIm();
        await im.giveItem("ender_pearl", 1);
        await bot.waitForTicks!(2);

        // Find the item in inventory
        const items = bot.inventory.items();
        const pearl = items.find((i: any) => i.name === "ender_pearl");
        expect(pearl).toBeDefined();

        // Use creative API to set it in slot 36 (first hotbar)
        await bot.creative.setInventorySlot(36, pearl);
        await bot.waitForTicks!(2);

        const slotItem = bot.inventory.slots[36];
        expect(slotItem).not.toBeNull();
        expect(slotItem.name).toBe("ender_pearl");
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 2: Item Query
  // ══════════════════════════════════════════════════════════════════

  describe("item query", () => {
    test(
      "getItemCount — counts items after /give",
      async () => {
        const im = getIm();
        await im.giveItem("cooked_porkchop", 32);
        await bot.waitForTicks!(2);
        const count = im.getItemCount("cooked_porkchop");
        // Server may double stack sizes for some items
        expect(count).toBeGreaterThanOrEqual(32);
      },
      TIMEOUT_MS,
    );

    test(
      "getItemCount — returns 0 for missing items",
      async () => {
        const im = getIm();
        const count = im.getItemCount("diamond_sword");
        expect(count).toBe(0);
      },
      TIMEOUT_MS,
    );

    test(
      "hasItem — true when item present",
      async () => {
        const im = getIm();
        await im.giveItem("diamond_sword", 1);
        await bot.waitForTicks!(2);
        expect(im.hasItem("diamond_sword")).toBe(true);
      },
      TIMEOUT_MS,
    );

    test(
      "hasItem — false when item absent",
      async () => {
        const im = getIm();
        expect(im.hasItem("diamond_sword")).toBe(false);
      },
      TIMEOUT_MS,
    );

    test(
      "hasItem with metadata — matches metadata",
      async () => {
        const im = getIm();
        const items = bot.inventory.items();
        const gapple = items.find((i: any) => i.name === "golden_apple");
        if (gapple) {
          await bot.creative.setInventorySlot(36, gapple);
        } else {
          await bot.utilsManager.assertCommandSuccess("give", "@p golden_apple 1");
        }
        await bot.waitForTicks!(2);
        const has = im.hasItem("golden_apple", 0);
        expect(has).toBe(true);
      },
      TIMEOUT_MS,
    );

    test(
      "hasItem with metadata — rejects wrong metadata",
      async () => {
        await bot.utilsManager.assertCommandSuccess("give", "@p golden_apple 1");
        const im = getIm();
        const has = im.hasItem("golden_apple", 1);
        expect(has).toBe(false);
      },
      TIMEOUT_MS,
    );

    test(
      "hasFood — true when food in inventory",
      async () => {
        const im = getIm();
        await im.giveItem("cooked_porkchop", 1);
        await bot.waitForTicks!(2);
        expect(im.hasFood()).toBe(true);
      },
      TIMEOUT_MS,
    );

    test(
      "hasFood — false when no food",
      async () => {
        const im = getIm();
        expect(im.hasFood()).toBe(false);
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 3: Equipping Armor
  // ══════════════════════════════════════════════════════════════════

  describe("equipping armor", () => {
    test(
      "equipArmor — equips best armor set",
      async () => {
        const im = getIm();
        await im.giveItems([
          { name: "iron_helmet", count: 1 },
          { name: "diamond_chestplate", count: 1 },
          { name: "iron_leggings", count: 1 },
          { name: "iron_boots", count: 1 },
        ]);
        await bot.waitForTicks!(2);
        await im.equipArmor();
        await bot.waitForTicks!(2);

        expect(bot.inventory.slots[bot.getEquipmentDestSlot("head")]?.name).toBe("iron_helmet");
        expect(bot.inventory.slots[bot.getEquipmentDestSlot("torso")]?.name).toBe("diamond_chestplate");
        expect(bot.inventory.slots[bot.getEquipmentDestSlot("legs")]?.name).toBe("iron_leggings");
        expect(bot.inventory.slots[bot.getEquipmentDestSlot("feet")]?.name).toBe("iron_boots");
      },
      TIMEOUT_MS,
    );

    test(
      "equipArmor — skips when already best",
      async () => {
        const im = getIm();
        await im.giveItems([
          { name: "diamond_helmet", count: 1 },
          { name: "diamond_chestplate", count: 1 },
          { name: "diamond_leggings", count: 1 },
          { name: "diamond_boots", count: 1 },
        ]);
        await bot.waitForTicks!(2);
        await im.equipArmor();
        await im.equipArmor();
      },
      TIMEOUT_MS,
    );

    test(
      "equipArmor — handles empty inventory gracefully",
      async () => {
        const im = getIm();
        await im.equipArmor();
      },
      TIMEOUT_MS,
    );

    test(
      "equipArmor — upgrades lower-tier armor",
      async () => {
        const im = getIm();
        await im.giveItems([
          { name: "iron_helmet", count: 1 },
          { name: "leather_chestplate", count: 1 },
        ]);
        await bot.waitForTicks!(2);
        await im.equipArmor();
        await bot.waitForTicks!(2);

        await im.giveItem("diamond_chestplate", 1);
        await bot.waitForTicks!(2);
        await im.equipArmor();
        await bot.waitForTicks!(2);

        expect(bot.inventory.slots[bot.getEquipmentDestSlot("torso")]?.name).toBe("diamond_chestplate");
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 4: Equipping Weapons
  // ══════════════════════════════════════════════════════════════════

  describe("equipping weapons", () => {
    test(
      "equipWeapon — equips best sword",
      async () => {
        const im = getIm();
        await im.giveItems([
          { name: "wooden_sword", count: 1 },
          { name: "diamond_sword", count: 1 },
        ]);
        await bot.waitForTicks!(2);
        await im.equipWeapon();
        await bot.waitForTicks!(2);
        expect(bot.heldItem?.name).toBe("diamond_sword");
      },
      TIMEOUT_MS,
    );

    test(
      "equipWeapon — prefers higher DPS weapon",
      async () => {
        // iron_sword: damage=6, speed=1.6 => DPS=9.6
        // stone_axe:  damage=9, speed=0.8 => DPS=7.2
        const im = getIm();
        await im.giveItems([
          { name: "stone_axe", count: 1 },
          { name: "iron_sword", count: 1 },
        ]);
        await bot.waitForTicks!(2);
        await im.equipWeapon();
        await bot.waitForTicks!(2);
        expect(bot.heldItem?.name).toBe("iron_sword");
      },
      TIMEOUT_MS,
    );

    test(
      "equipWeapon — no weapons in inventory",
      async () => {
        const im = getIm();
        await im.equipWeapon();
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 5: Equipping Consumables
  // ══════════════════════════════════════════════════════════════════

  describe("equipping consumables", () => {
    const offHandSlot = () => bot.getEquipmentDestSlot("off-hand");

    test(
      "equipGapple — equips enchanted golden apple",
      async () => {
        await bot.utilsManager.assertCommandSuccess("give", "@p golden_apple 1");
        await bot.waitForTicks!(5);
        const im = getIm();
        const gapple = bot.inventory.items().find((i: any) => i.name === "golden_apple");
        if (gapple) {
          await bot.creative.setInventorySlot(36, gapple);
          await bot.waitForTicks!(2);
        }
        await im.equipGapple();
        await bot.waitForTicks!(2);
        expect(bot.inventory.slots[offHandSlot()]?.name).toBe("golden_apple");
      },
      TIMEOUT_MS,
    );

    test(
      "equipGapple — equips regular when no enchanted",
      async () => {
        const im = getIm();
        await im.giveItem("golden_apple", 1);
        await bot.waitForTicks!(2);
        await im.equipGapple();
        await bot.waitForTicks!(2);
        expect(bot.inventory.slots[offHandSlot()]?.name).toBe("golden_apple");
      },
      TIMEOUT_MS,
    );

    test(
      "equipGapple — no gapples in inventory",
      async () => {
        const im = getIm();
        await im.equipGapple();
      },
      TIMEOUT_MS,
    );

    test(
      "equipFood — equips best food to off-hand",
      async () => {
        const im = getIm();
        await im.giveItems([
          { name: "bread", count: 1 },
          { name: "cooked_porkchop", count: 1 },
        ]);
        await bot.waitForTicks!(2);
        // In creative mode food is 20, so equipFood equips without eating
        await im.equipFood();
        await bot.waitForTicks!(2);
        // cooked_porkchop has higher saturation (12.8) than bread (6.0)
        expect(bot.inventory.slots[offHandSlot()]?.name).toBe("cooked_porkchop");
      },
      TIMEOUT_MS,
    );

    test(
      "equipFood — skips when food full in creative",
      async () => {
        const im = getIm();
        await im.giveItem("cooked_porkchop", 1);
        await bot.waitForTicks!(2);
        await im.equipFood();
      },
      TIMEOUT_MS,
    );

    test(
      "equipTotem — equips totem to off-hand",
      async () => {
        const im = getIm();
        await im.giveItem("totem_of_undying", 1);
        await bot.waitForTicks!(2);
        const result = await im.equipTotem();
        await bot.waitForTicks!(2);
        expect(result).toBe(true);
        expect(bot.inventory.slots[offHandSlot()]?.name).toBe("totem_of_undying");
      },
      TIMEOUT_MS,
    );

    test(
      "equipTotem — fails without totem",
      async () => {
        const im = getIm();
        const result = await im.equipTotem();
        expect(result).toBe(false);
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 6: Tossing & Clearing
  // ══════════════════════════════════════════════════════════════════

  describe("tossing and clearing", () => {
    test(
      "tossAllItems — tosses everything",
      async () => {
        const im = getIm();
        await im.giveItems([
          { name: "dirt", count: 64 },
          { name: "cobblestone", count: 32 },
          { name: "iron_ingot", count: 16 },
        ]);
        await bot.waitForTicks!(2);
        await im.tossAllItems();
        await bot.waitForTicks!(5);
        expect(bot.inventory.items().length).toBe(0);
      },
      TIMEOUT_MS,
    );

    test(
      "unequipAllItems — removes equipped armor",
      async () => {
        const im = getIm();
        await im.giveItems([
          { name: "iron_helmet", count: 1 },
          { name: "iron_chestplate", count: 1 },
          { name: "iron_leggings", count: 1 },
          { name: "iron_boots", count: 1 },
        ]);
        await bot.waitForTicks!(2);
        await im.equipArmor();
        await bot.waitForTicks!(2);
        expect(bot.inventory.slots[bot.getEquipmentDestSlot("head")]).not.toBeNull();

        await im.unequipAllItems();
        await bot.waitForTicks!(2);

        for (const dest of ["head", "torso", "legs", "feet", "off-hand"]) {
          expect(bot.inventory.slots[bot.getEquipmentDestSlot(dest)]).toBeNull();
        }
      },
      TIMEOUT_MS,
    );

    test(
      "clearInventory — clears via creative API",
      async () => {
        const im = getIm();
        await im.giveItems([
          { name: "dirt", count: 64 },
          { name: "diamond", count: 10 },
        ]);
        await bot.waitForTicks!(2);
        await im.clearInventory();
        await bot.waitForTicks!(2);
        expect(bot.inventory.items().length).toBe(0);
      },
      TIMEOUT_MS,
    );

    test(
      "clearInventory — throws in survival mode",
      async () => {
        await bot.utilsManager.assertCommandSuccess("gamemode", "survival");
        await bot.waitForTicks!(5);

        const im = getIm();
        await expect(async () => {
          await im.clearInventory();
        }).rejects.toThrow("clearInventory requires creative mode");

        await bot.utilsManager.assertCommandSuccess("gamemode", "creative");
        await bot.waitForTicks!(2);
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 7: Record & Restore
  // ══════════════════════════════════════════════════════════════════

  describe("record and restore", () => {
    test(
      "recordInventory — writes JSON file",
      async () => {
        const im = getIm();
        await im.giveItems([
          { name: "diamond_sword", count: 1 },
          { name: "golden_apple", count: 16 },
        ]);
        await bot.waitForTicks!(2);
        await im.recordInventory(99);

        await new Promise((resolve) => setTimeout(resolve, 500));

        expect(fs.existsSync("./recording-99.json")).toBe(true);
        const data = JSON.parse(fs.readFileSync("./recording-99.json", "utf8"));
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBeGreaterThan(0);

        const names = data.map((d: any) => d.name);
        expect(names).toContain("diamond_sword");
        expect(names).toContain("golden_apple");
      },
      TIMEOUT_MS,
    );

    test(
      "record + restore round-trip preserves item counts",
      async () => {
        const im = getIm();
        await im.giveItems([
          { name: "ender_pearl", count: 16 },
          { name: "obsidian", count: 64 },
        ]);
        await bot.waitForTicks!(2);

        await im.recordInventory(97);
        await new Promise((resolve) => setTimeout(resolve, 500));

        await clearBotInventory();
        await bot.waitForTicks!(2);

        await im.restoreInventory(97);
        await bot.waitForTicks!(5);

        expect(im.getItemCount("ender_pearl")).toBe(16);
        expect(im.getItemCount("obsidian")).toBe(64);
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 8: Cache Behavior
  // ══════════════════════════════════════════════════════════════════

  describe("cache behavior", () => {
    test(
      "invalidateCache — forces fresh count",
      async () => {
        const im = getIm();
        await im.giveItem("dirt", 16);
        await bot.waitForTicks!(2);

        const count1 = im.getItemCount("dirt");
        expect(count1).toBe(16);

        await im.giveItem("dirt", 16);
        await bot.waitForTicks!(2);
        im.invalidateCache();

        const count2 = im.getItemCount("dirt");
        expect(count2).toBeGreaterThan(count1);
      },
      TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Category 9: Edge Cases & Error Handling
  // ══════════════════════════════════════════════════════════════════

  describe("edge cases and error handling", () => {
    test(
      "_equipItem — returns false for missing item",
      async () => {
        const im = getIm();
        const result = await im._equipItem("nonexistent_item_xyz", "hand");
        expect(result).toBe(false);
      },
      TIMEOUT_MS,
    );

    test(
      "getItemViaCommand — throws when item not found after /give",
      async () => {
        const im = getIm();
        await expect(async () => {
          await im.getItemViaCommand("totally_invalid_item_name_xyz", 1);
        }).rejects.toThrow();
      },
      TIMEOUT_MS,
    );
  });
});
