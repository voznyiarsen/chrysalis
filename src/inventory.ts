import { Logger } from "./logger";
// @ts-ignore - prismarine-nbt may not have complete types
import nbt from "prismarine-nbt";
// @ts-ignore - prismarine-item exports a versioned factory function
import prismarineItem from "prismarine-item";
import { Constants } from "./constants";
import { Bot } from "mineflayer";
import { Vec3 } from "vec3";

// Construct the Item class with a game version
const Item: any = prismarineItem("1.19.3");

/**
 * @fileoverview Manages bot inventory, equipment, and item-related operations.
 */
class InventoryManager {
  bot: Bot;
  logger: Logger;
  _itemCache: Map<string, boolean | number>;
  _lastCacheTick: number;

  /**
   * @param bot - Mineflayer bot instance
   */
  constructor(bot: Bot) {
    this.bot = bot;
    this.logger = bot.__logger;

    this._itemCache = new Map();
    this._lastCacheTick = 0;

    const clearCache = () => this._itemCache.clear();
    this.bot.inventory.on("windowUpdate", clearCache);
    this.bot.inventory.on("changedSlot", clearCache);
  }

  /**
   * Collect all items matching the given criteria from inventory and equipment.
   * This is the single source of truth for item lookups — all other query
   * methods (hasItem, getItemCount) delegate to this.
   *
   * Unlike prismarine-windows' `findInventoryItem`, this method:
   * - Searches equipment slots (off-hand, armor) in addition to inventory
   * - Accepts item names (strings) instead of requiring numeric IDs
   * - Supports optional metadata filtering for 1.12.2 variant matching
   * - Supports `notFull` to skip stacks at max capacity
   *
   * @param itemName - Item name (e.g. "golden_apple", "totem_of_undying")
   * @param metadata - Optional metadata (damage value). When omitted, any
   *   metadata matches. When provided, only items with that exact metadata
   *   are returned (e.g. metadata 1 for enchanted golden apple in 1.12.2).
   * @param notFull - When true, skip items whose count equals their stackSize
   * @returns Array of matching Item objects (empty if none found)
   */
  findItem(itemName: string, metadata?: number, notFull?: boolean): any[] {
    const matchName = (item: any): boolean => item.name === itemName;
    const matchFull = (item: any): boolean =>
      item.name === itemName && item.metadata === metadata;
    const matches = metadata !== undefined ? matchFull : matchName;

    // bot.inventory.items() returns slots inventoryStart..inventoryEnd,
    // which excludes armor (slots 5-8). bot.entity.equipment covers
    // hand, off-hand, and armor — but hand/off-hand overlap with items().
    // To avoid double-counting, search items() for the main inventory
    // and only add equipment entries that aren't already covered
    // (armor slots: equipment indices 2-4 = helmet, chestplate, leggings, boots).
    const results: any[] = [];

    for (const item of this.bot.inventory.items()) {
      if (matches(item) && (!notFull || item.count < item.stackSize)) {
        results.push(item);
      }
    }

    // entity.equipment: [0]=hand, [1]=off-hand, [2]=feet, [3]=legs, [4]=chest, [5]=head (varies by version)
    // Indices 0 and 1 overlap with inventory items(), so skip them.
    // Armor entries (2+) are NOT in items() and must be checked separately.
    const equipment = this.bot.entity.equipment;
    if (equipment) {
      for (let i = 2; i < equipment.length; i++) {
        const item = equipment[i];
        if (item && matches(item) && (!notFull || item.count < item.stackSize)) {
          results.push(item);
        }
      }
    }

    return results;
  }

  /**
   * Get total count of a specific item in inventory and equipment.
   * @param itemName - Item name
   * @returns Total count of the item
   */
  getItemCount(itemName: string): number {
    const currentTick = this.bot.time.age;
    const cacheKey = `count:${itemName}`;

    if (this._lastCacheTick === currentTick && this._itemCache.has(cacheKey)) {
      return this._itemCache.get(cacheKey) as number;
    }

    const count = this.findItem(itemName).reduce(
      (acc: number, item) => acc + item.count,
      0,
    );

    this._updateCache(cacheKey, count, currentTick);
    return count;
  }

  /**
   * Check if bot has a specific item in inventory or equipment.
   * When metadata is provided, only items matching both name and metadata
   * are considered (e.g. golden_apple metadata 0 vs 1 in 1.12.2).
   * @param itemName - Item name
   * @param metadata - Optional item metadata (damage value) for variant matching
   * @returns Whether bot has the item
   */
  hasItem(itemName: string, metadata?: number): boolean {
    const currentTick = this.bot.time.age;
    const cacheKey =
      metadata !== undefined
        ? `has:${itemName}:${metadata}`
        : `has:${itemName}`;

    if (this._lastCacheTick === currentTick && this._itemCache.has(cacheKey)) {
      return this._itemCache.get(cacheKey) as boolean;
    }

    const has = this.findItem(itemName, metadata).length > 0;

    this._updateCache(cacheKey, has, currentTick);
    return has;
  }

  /**
   * Check if bot has any food item
   * @returns Whether bot has food
   */
  hasFood(): boolean {
    // mineflayer plugin property access
    const currentTick = (this.bot as any).time.age;
    const cacheKey = "has:food";

    if (this._lastCacheTick === currentTick && this._itemCache.has(cacheKey)) {
      return this._itemCache.get(cacheKey) as boolean;
    }

    const foodsByName = (this.bot as any).registry?.foodsByName ?? {};
    const has = this.bot.inventory
      .items()
      .some(
        (item: any) =>
          (foodsByName as Record<string, unknown>)[item.name] !== undefined,
      );

    this._updateCache(cacheKey, has, currentTick);
    return has;
  }

  /**
   * Update the item cache for the current tick.
   * @private
   */
  _updateCache(key: string, value: boolean | number, tick: number): void {
    if (this._lastCacheTick !== tick) {
      this._itemCache.clear();
      this._lastCacheTick = tick;
    }
    this._itemCache.set(key, value);
  }

  /**
   * Forcefully invalidate the entire item cache.
   * Called automatically on window/slot changes.
   */
  invalidateCache(): void {
    this._itemCache.clear();
    this._lastCacheTick = 0;
  }

  /**
   * Equip an item to a specific slot with safety checks.
   * @param itemName - Item name to equip
   * @param targetSlot - Destination slot name
   * @returns Whether equipping succeeded
   * @private
   */
  async _equipItem(
    itemName: string,
    targetSlot: string = "hand",
  ): Promise<boolean> {
    try {
      const destSlot = this.bot.getEquipmentDestSlot(targetSlot);
      const currentItem = this.bot.inventory.slots[destSlot];

      if (currentItem && currentItem.name === itemName) {
        return true;
      }

      const item = this.bot.inventory
        .items()
        .find((i: any) => i.name === itemName);

      if (!item) {
        this.logger.debug(
          `Equip: ${itemName} not found in inventory`,
          "Inventory",
        );
        return false;
      }

      this.logger.inventory(
        `Equipping ${item.displayName} to ${targetSlot}...`,
      );
      await this.bot.equip!(item, targetSlot as any);
      await this.bot.waitForTicks!(Constants.TIMING.EQUIP_TICKS);
      return true;
    } catch (error: unknown) {
      const err = error as Error;
      if (!err.message.includes("not found")) {
        err.message = `Failed to equip ${itemName} to ${targetSlot}: ${err.message}`;
      }
      this.logger.error(err, "Inventory");
      return false;
    }
  }

  /** Map gamemode numbers to their string names as stored in bot.game.gameMode */
  private static readonly GAMEMODE_NAMES = [
    "survival",
    "creative",
    "adventure",
    "spectator",
  ];

  /**
   * Clear the entire inventory via creative mode.
   * @throws Will throw an error if not in creative mode
   */
  async clearInventory(): Promise<void> {
    const creativeName = InventoryManager.GAMEMODE_NAMES[1];
    if ((this.bot.game as any).gameMode !== creativeName) {
      throw new Error(
        `clearInventory requires creative mode, current gamemode is ${(this.bot.game as any).gameMode}`,
      );
    }
    try {
      await this.bot.waitForTicks(3);
      await this.bot.creative.clearInventory();
      this.logger.inventory("Inventory cleared");
    } catch (error: unknown) {
      const err = error as Error;
      err.message = `Failed to clear inventory: ${err.message}`;
      this.logger.error(err, "Inventory");
    }
  }

  /**
   * Get an item using the /give command.
   * Works in any gamemode but typically used in creative mode.
   * @param itemName - Name of the item (e.g., "ender_pearl")
   * @param count - Stack size
   * @param targetSlot - Destination slot name (default: "hand")
   */
  async getItemViaCommand(
    itemName: string,
    count: number = 1,
    targetSlot: string = "hand",
  ): Promise<void> {
    await this.clearInventory();
    await this.bot.utilsManager.assertCommandSuccess("give", `@p ${itemName} ${count}`);
    await this.bot.waitForTicks!(Constants.TIMING.EQUIP_TICKS);

    for (let attempt = 0; attempt < 10; attempt++) {
      const destSlot = this.bot.getEquipmentDestSlot(targetSlot);
      const slotItem: any = this.bot.inventory.slots[destSlot];
      if (slotItem && slotItem.name === itemName) {
        return;
      }
      await this.bot.waitForTicks!(1);
    }

    const equipped = await this._equipItem(itemName, targetSlot);
    if (!equipped) {
      throw new Error(
        `Failed to obtain ${itemName}: not found in inventory after /give`,
      );
    }
  }

  /**
   * Give an item to the bot via the /give command and wait for it to arrive.
   *
   * Java Edition syntax: `/give <target> <item> [amount] [dataTag]`
   * The optional `dataTag` accepts SNBT for enchantments, lore, custom names, etc.
   * See https://minecraft.fandom.com/wiki/Commands/give
   *
   * @param itemName - Item name (e.g. "ender_pearl")
   * @param count - Stack size (default: 1)
   * @param metadata - Item metadata / data value (e.g. 1 for enchanted golden apple).
   *   Appended as the fourth /give argument (Java Edition data value).
   * @param nbt - Optional NBT object (SNBT string) for enchantments, lore, etc.
   *   Appended as `{...}` after the item id in the /give command.
   * @param target - Target selector (default: "@p")
   * @param timeoutMs - Max time to wait for the item to appear (default: TIMEOUT_MS)
   */
  async giveItem(
    itemName: string,
    count: number = 1,
    metadata?: number,
    nbt?: string,
    target: string = "@p",
    timeoutMs: number = 10000,
  ): Promise<void> {
    let args = `${target} ${itemName}`;
    if (count !== 1) args += ` ${count}`;
    if (metadata !== undefined) args += ` ${metadata}`;
    if (nbt) args += ` ${nbt}`;

    await this.bot.utilsManager.assertCommandSuccess("give", args);

    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const items = this.bot.inventory.items();
      const item = items.find(
        (i: any) =>
          i.name === itemName &&
          (metadata === undefined || i.metadata === metadata),
      );
      if (item && item.count >= count) return;
      await this.bot.waitForTicks!(2);
    }
    throw new Error(
      `Timed out waiting for /give ${target} ${itemName} ${count}`,
    );
  }

  /**
   * Give multiple items to the bot in sequence via /give.
   *
   * @param items - Array of item descriptors. Each entry may specify:
   *   - name: Item name
   *   - count: Stack size (default: 1)
   *   - metadata: Item data value (e.g. 1 for enchanted golden apple)
   *   - nbt: Optional SNBT string for enchantments, lore, etc.
   *   - target: Target selector (default: "@p")
   *   - timeoutMs: Max wait per item (default: 10000)
   */
  async giveItems(
    items: Array<{
      name: string;
      count?: number;
      metadata?: number;
      nbt?: string;
      target?: string;
      timeoutMs?: number;
    }>,
  ): Promise<void> {
    for (const item of items) {
      await this.giveItem(
        item.name,
        item.count ?? 1,
        item.metadata,
        item.nbt,
        item.target,
        item.timeoutMs,
      );
    }
  }

  /**
   * Get an item using creative mode inventory manipulation.
   * Uses bot.creative.setInventorySlot() to directly set items in creative mode.
   * @param item - Item instance to set in the slot
   * @param slot - Target slot index (default: 36, first quickbar slot)
   * @throws Will throw an error if gamemode is not 1 (creative)
   */
  async getItemViaCreative(
    item: any, // Item instance
    slot: number = 36, // Default to first quickbar slot
  ): Promise<void> {
    const creativeName = InventoryManager.GAMEMODE_NAMES[1];
    if ((this.bot.game as any).gameMode !== creativeName) {
      throw new Error(
        `getItemViaCreative requires creative mode (gamemode 1), current gamemode is ${(this.bot.game as any).gameMode}`,
      );
    }

    try {
      await this.bot.creative.setInventorySlot(slot, item);
      this.logger.debug(
        `Set item ${item.name} in slot ${slot} using creative API`,
        "Inventory",
      );
    } catch (error: unknown) {
      const err = error as Error;
      err.message = `Failed to set item ${item.name} in creative mode: ${err.message}`;
      this.logger.error(err, "Inventory");
      throw err;
    }
  }

  /**
   * Helper method to create an item instance for use with getItemViaCreative.
   * @param itemName - Name of the item (e.g., "ender_pearl")
   * @param count - Stack size (default: 1)
   * @returns Item instance suitable for creative.setInventorySlot()
   */
  createItemInstance(itemName: string, count: number = 1): any {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Item = require("prismarine-item")(this.bot.version);
      const itemInfo = this.bot.registry.itemsByName[itemName];
      if (!itemInfo) {
        throw new Error(`Unknown item: ${itemName}`);
      }
      return new Item(itemInfo.id, count);
    } catch (error: unknown) {
      const err = error as Error;
      err.message = `Failed to create item instance for ${itemName}: ${err.message}`;
      this.logger.error(err, "Inventory");
      throw err;
    }
  }

  /**
   * Record current inventory to a JSON file.
   * @param slot - Recording slot index for the filename
   */
  async recordInventory(slot: number | string = 0): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs");
    const array = this.bot.inventory.slots.filter((item: any) => item?.type);
    const data = array.map(
      ({ type, count, metadata, nbt, name, displayName, slot }: any) => ({
        type,
        count,
        metadata,
        nbt,
        name,
        displayName,
        slot,
      }),
    );

    const filename = `./recording-${slot}.json`;
    fs.writeFile(
      filename,
      JSON.stringify(data, null, 2),
      (error: Error | null) => {
        if (error) {
          error.message = `Failed to record inventory: ${error.message}`;
          this.logger.error(error, "Inventory");
        } else {
          this.logger.inventory(
            `${data.length} items recorded into slot ${slot}`,
          );
        }
      },
    );
  }

  /**
   * Restore inventory from a recorded JSON file.
   * @param slot - Recording slot index matching the filename
   */
  async restoreInventory(slot: number | string = 0): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs");
    const raw = fs.readFileSync(`./recording-${slot}.json`, "utf8");
    const data = JSON.parse(raw);
    await this.setGamemode(1);

    let restored = 0;
    for (const item of data) {
      try {
        const newItem = new Item(
          item.type,
          item.count,
          item.metadata,
          item.nbt,
        );
        await this.bot.creative.setInventorySlot(item.slot, newItem);
        await this.bot.waitForTicks!(Constants.TIMING.EQUIP_TICKS);
        restored++;
      } catch (error: unknown) {
        const err = error as Error;
        err.message = `Failed to set slot ${item.slot}: ${err.message}`;
        this.logger.error(err, "Inventory");
      }
    }

    this.logger.inventory(`Restored ${restored}/${data.length} items from slot ${slot}`);
    await this.setGamemode(0);
  }

  /**
   * Set the bot's gamemode via /gamemode command.
   * @param mode - Gamemode ID (0=survival, 1=creative, etc.)
   * @param timeout - Max time in ms to wait
   */
  async setGamemode(
    mode: number,
    timeout: number = Constants.TIMING.DEFAULT_TIMEOUT,
  ): Promise<void> {
    const modeName = InventoryManager.GAMEMODE_NAMES[mode] || String(mode);
    const t0 = Date.now();
    if ((this.bot.game as any).gameMode !== modeName) {
      this.logger.status(
        `Setting gamemode from ${(this.bot.game as any).gameMode} to ${modeName}`,
      );
      await this.bot.utilsManager.assertCommandSuccess("gamemode", String(mode));
      while ((this.bot.game as any).gameMode !== modeName) {
        if (Date.now() - t0 > timeout) {
          this.logger.warning(
            `Timeout while setting gamemode to ${modeName} (current: ${(this.bot.game as any).gameMode}). Proceeding anyway`,
          );
          return;
        }
        await this.bot.waitForTicks!(2);
      }
    }
  }

  /**
   * Unequip all armor slots.
   */
  async unequipAllItems(): Promise<void> {
    const destinations = ["head", "torso", "legs", "feet", "off-hand"];
    for (const destination of destinations) {
      const slot = this.bot.getEquipmentDestSlot(destination);
      if (this.bot.inventory.slots[slot] !== null) {
        await this.bot.waitForTicks!(Constants.TIMING.EQUIP_TICKS);
        await this.bot.unequip!(destination as any);
      }
    }
  }

  /**
   * Toss every item from the inventory.
   */
  async tossAllItems(): Promise<void> {
    const items = this.bot.inventory.items();
    for (const item of items) {
      await this.bot.waitForTicks!(Constants.TIMING.EQUIP_TICKS);
      await this.bot.toss!(item.type, item.metadata, item.count);
    }
  }

  /**
   * Equip the best armor items for each slot based on material and enchantment scores.
   */
  async equipArmor(): Promise<void> {
    const materialStats = Constants.MATERIALS.ARMOR;
    const slotMap = Constants.MATERIALS.SLOT_MAP;

    const allArmorItems = this.bot.inventory
      .items()
      .filter(
        (item: any) =>
          item.name.endsWith("_helmet") ||
          item.name.endsWith("_chestplate") ||
          item.name.endsWith("_leggings") ||
          item.name.endsWith("_boots"),
      );

    const armorBySlot: Record<string, any[]> = {
      head: [],
      torso: [],
      legs: [],
      feet: [],
    };
    for (const item of allArmorItems) {
      const slot = Object.keys(slotMap).find((key) =>
        item.name.endsWith(`_${(slotMap as Record<string, string>)[key]}`),
      );
      if (slot) armorBySlot[slot].push(item);
    }

    for (const [slot, items] of Object.entries(armorBySlot)) {
      if (items.length === 0) continue;

      const bestItem = items.reduce((best: any, item: any) => {
        const bestScore = this._computeArmorScore(
          best,
          materialStats,
          (slotMap as Record<string, string>)[slot],
        );
        const itemScore = this._computeArmorScore(
          item,
          materialStats,
          (slotMap as Record<string, string>)[slot],
        );
        return itemScore > bestScore ? item : best;
      });

      const equipSlot = this.bot.getEquipmentDestSlot(slot);
      const currentArmor = this.bot.inventory.slots[equipSlot];

      const bestScore = this._computeArmorScore(
        bestItem,
        materialStats,
        (slotMap as Record<string, string>)[slot],
      );
      const currentScore = currentArmor
        ? this._computeArmorScore(
            currentArmor,
            materialStats,
            (slotMap as Record<string, string>)[slot],
          )
        : -1;

      if (bestScore > currentScore) {
        this.logger.debug(
          `Armor: ${bestItem.displayName} outscores current ${currentArmor?.displayName ?? "empty"} for ${slot}. New score: ${bestScore.toFixed(1)}, current score: ${currentScore.toFixed(1)}`,
          "Inventory",
        );
        this.logger.inventory(
          `Equipping ${bestItem.displayName} to ${slot} (score: ${bestScore})...`,
        );
        await this.bot.equip!(bestItem, slot as any);
        await this.bot.waitForTicks!(Constants.TIMING.EQUIP_TICKS);
      }
    }
  }

  /**
   * Compute a composite armor score from material stats and enchantments.
   * @param item - Item object with .enchants array
   * @param materialStats - Armor material stats from constants
   * @param slotName - Armor slot name (helmet/chestplate/leggings/boots)
   * @returns Score value for comparison
   * @private
   */
  _computeArmorScore(item: any, materialStats: any, slotName: string): number {
    if (!item?.name) return -1;
    const material = item.name.replace(
      /_(helmet|chestplate|leggings|boots)$/,
      "",
    );
    const stats = materialStats[material]?.[slotName];
    if (!stats) return 0;

    let protectionLVL = 0;
    let otherEnchantWeight = 0;

    if (item.enchants && Array.isArray(item.enchants)) {
      const protection = item.enchants.find(
        (e: any) => e.name === "protection",
      );
      protectionLVL = protection ? protection.lvl || 0 : 0;

      const nonProtection = item.enchants.filter(
        (e: any) => e.name !== "protection",
      );
      const bindingCurse = nonProtection.some(
        (e: any) => e.name === "binding_curse",
      );
      otherEnchantWeight =
        nonProtection.filter((e: any) => e.name !== "binding_curse").length *
        0.1;
      if (bindingCurse) otherEnchantWeight -= 1;
    }
    return (
      (stats as any).defense +
      (stats as any).toughness +
      protectionLVL +
      otherEnchantWeight
    );
  }

  /**
   * Equip the best golden apple (enchanted > regular) to off-hand.
   * Optionally activates it (eats it) to trigger the regeneration effect.
   * @param activate - Whether to eat the apple after equipping (default: true)
   */
  async equipGapple(activate: boolean = true): Promise<void> {
    const items = this.bot.inventory
      .items()
      .filter((i: any) => i.name === "golden_apple");
    if (items.length === 0) {
      this.logger.debug(`Gapple: no golden apples in inventory`, "Inventory");
      return;
    }

    if (activate && this.bot.entity.effects["10"]) {
      this.logger.debug(
        `Gapple: already has regeneration, skipping`,
        "Inventory",
      );
      return;
    }

    const bestGapple = items.sort(
      (a: any, b: any) => (b.metadata || 0) - (a.metadata || 0),
    )[0];

    const destSlot = this.bot.getEquipmentDestSlot("off-hand");
    const currentItem = this.bot.inventory.slots[destSlot];

    if (
      !currentItem ||
      currentItem.name !== bestGapple.name ||
      currentItem.metadata !== bestGapple.metadata
    ) {
      this.logger.inventory(
        `Equipping ${bestGapple.displayName} to off-hand...`,
      );
      await this.bot.equip!(bestGapple, "off-hand" as any);
      await this.bot.waitForTicks!(Constants.TIMING.EQUIP_TICKS);
    }

    if (!activate) {
      this.logger.debug(
        `Gapple: equipped ${bestGapple.displayName} (activate=false, not eating)`,
        "Inventory",
      );
      return;
    }

    // In creative mode, eating doesn't grant effects — skip activation
    if ((this.bot.game as any).gameMode === "creative") {
      this.logger.inventory(
        `Skipping ${bestGapple.displayName} use in creative mode (no effect)`,
      );
      return;
    }

    await this._useItemUntilEffect("10", bestGapple.displayName);
  }

  /**
   * Equip the best golden apple to off-hand without activating it.
   * Used as a utility fallback (e.g. combat decision "utility").
   */
  async equipUtility(): Promise<void> {
    await this.equipGapple(false);
  }

  /**
   * Equip and eat the best available food.
   * Skips if food or health is full, or if regeneration is active.
   */
  async equipFood(): Promise<void> {
    if (this.bot.entity.effects["10"]) return;

    const inventory: any[] = [
      ...this.bot.inventory.items(),
      ...Object.values(this.bot.entity.equipment).filter((i: any) => i != null),
    ];

    const foodsByName = (this.bot as any).registry?.foodsByName ?? {};
    const items = inventory.filter(
      (item: any) =>
        (foodsByName as Record<string, unknown>)[item.name] !== undefined,
    );
    if (items.length === 0) {
      this.logger.debug(`Food: no food items in inventory`, "Inventory");
      return;
    }

    const food = items.reduce((best: any, current: any) => {
      const bStats = foodsByName[best.name];
      const cStats = foodsByName[current.name];
      if (cStats.saturation > bStats.saturation) return current;
      if (
        cStats.saturation === bStats.saturation &&
        cStats.foodPoints > bStats.foodPoints
      )
        return current;
      return best;
    });

    // Always equip the best food to off-hand, even if food is full
    if (!(await this._equipItem(food.name, "off-hand"))) return;

    // Skip eating if food is already full or in creative mode
    if (
      this.bot.food! >= 20 ||
      (this.bot.game as any).gameMode === "creative"
    ) {
      this.logger.inventory(
        `Skipping ${food.displayName} use \u2014 food full or creative mode`,
      );
      return;
    }

    // Food is not full — eat it
    const expectedHunger = this.bot.food! + foodsByName[food.name].foodPoints;
    this.logger.inventory(`Using ${food.displayName}...`);
    try {
      this.bot.activateItem(true);
      const t0 = Date.now();
      while (this.bot.food! < expectedHunger && this.bot.food! < 20) {
        if (Date.now() - t0 > Constants.TIMING.DEFAULT_TIMEOUT) {
          throw new Error(`Timeout reached while eating ${food.displayName}`);
        }
        await this.bot.waitForTicks!(2);
      }
      this.logger.inventory(`Used ${food.displayName} successfully`);
    } catch (error: unknown) {
      const err = error as Error;
      err.message = `Failed to eat ${food.displayName}: ${err.message}`;
      this.logger.error(err, "Inventory");
    } finally {
      this.bot.deactivateItem();
    }
  }

  /**
   * Equip and drink a strength potion from off-hand.
   * Prefers strong_strength over regular strength.
   */
  async equipBuff(): Promise<void> {
    const inventory: any[] = [
      ...this.bot.inventory.items(),
      ...Object.values(this.bot.entity.equipment).filter((i: any) => i != null),
    ];
    const potions = inventory.filter((item: any) => item.name === "potion");
    const potion =
      potions.find(
        (i: any) =>
          (nbt as any).simplify(i.nbt).Potion === "minecraft:strong_strength",
      ) ||
      potions.find(
        (i: any) =>
          (nbt as any).simplify(i.nbt).Potion === "minecraft:strength",
      );

    if (!potion) {
      this.logger.debug(`Buff: no strength potion in inventory`, "Inventory");
      return;
    }

    // Resolve the effect ID dynamically from registry using the potion NBT
    const potionId = (nbt as any).simplify(potion.nbt).Potion as string;
    const effectName = potionId.replace(/^minecraft:/, "");
    const effectsByName = (this.bot as any).registry?.effectsByName ?? {};
    const effect = effectsByName[effectName];
    if (!effect) {
      this.logger.debug(`Buff: unknown effect ${effectName}, skipping`, "Inventory");
      return;
    }
    const effectId = String(effect.id);

    if (this.bot.entity.effects[effectId as any]) {
      this.logger.debug(
        `Buff: already has ${effectName} effect, skipping`,
        "Inventory",
      );
      return;
    }

    await this._useItem(potion.name, "off-hand", () => {
      this.bot.activateItem(true);
    }, () => {
      return !this.bot.entity.effects[effectId as any];
    }, () => {
      this.bot.deactivateItem();
    });
  }

  /**
   * Equip a totem of undying to the off-hand.
   * @returns Whether equipping succeeded
   */
  async equipTotem(): Promise<boolean> {
    return this._equipItem("totem_of_undying", "off-hand");
  }

  /**
   * Equip and throw a projectile (e.g. ender pearl) using offset-based aiming.
   * Uses a vertical offset relative to the source position for intuitive aiming.
   *
   * @param targetPos - Target position to throw at
   * @param offset - Vertical offset in blocks (positive = aim above target, negative = aim below)
   * @param itemType - Item name for the projectile (default: "ender_pearl")
   * @param sourcePos - Optional source position (defaults to bot eye level)
   */
  async equipPearl(
    targetPos: Vec3,
    offset: number,
    itemType: string = "ender_pearl",
    sourcePos?: Vec3,
  ): Promise<void> {
    const equipped = await this._equipItem(itemType, "hand");
    if (!equipped) {
      throw new Error(`Cannot throw ${itemType}: not found in inventory`);
    }

    this.bot.clearControlStates();
    await this.bot.pathfinder.stop();
    await this.bot.waitForTicks!(1);

    // The offset is relative to the source Y level (where the projectile
    // is launched from). Use sourcePos if provided, otherwise fall back
    // to the bot's eye position.
    const srcY = sourcePos
      ? sourcePos.y
      : this.bot.entity!.position.y + this.bot.entity!.height!;
    const aimPoint = targetPos.clone();
    aimPoint.y = srcY + offset;

    // Use lookAt which handles the pitch/yaw calculation internally
    await this.bot.lookAt!(aimPoint, true);
    await this.bot.waitForTicks!(1);

    this.bot.activateItem(false); // Right click once
    await this.bot.waitForTicks!(1);
    this.logger.inventory(
      `Tossed ${itemType} with offset ${offset.toFixed(2)} successfully`,
    );
  }

  /**
   * Equip a consumable item, use it, and wait for the expected effect.
   * General-purpose method for food, potions, and other usable items.
   *
   * @param itemName - Item name to equip and use
   * @param targetSlot - Destination slot (default: "off-hand")
   * @param activate - Callback to activate the item (e.g. bot.activateItem(true))
   * @param condition - Callback returning true while the effect hasn't applied
   * @param cleanup - Callback to deactivate/cleanup after use
   * @param display - Display name for logging (defaults to itemName)
   */
  private async _useItem(
    itemName: string,
    targetSlot: string,
    activate: () => void,
    condition: () => boolean,
    cleanup: () => void,
    display?: string,
  ): Promise<void> {
    const label = display ?? itemName;
    if (!(await this._equipItem(itemName, targetSlot))) {
      this.logger.warn(`Use: ${label} not found in inventory`, "Inventory");
      return;
    }
    this.logger.inventory(`Using ${label}...`);
    try {
      activate();
      const t0 = Date.now();
      while (condition()) {
        if (Date.now() - t0 > Constants.TIMING.DEFAULT_TIMEOUT) {
          throw new Error(`Timeout reached while using ${label}`);
        }
        await this.bot.waitForTicks!(2);
      }
      this.logger.inventory(`Used ${label} successfully`);
    } catch (error: unknown) {
      const err = error as Error;
      err.message = `Failed to use ${label}: ${err.message}`;
      this.logger.error(err, "Inventory");
    } finally {
      cleanup();
    }
  }

  /**
   * Equip and use an item until a specific Minecraft status effect is active.
   * @param effectId - Minecraft effect ID string (e.g. "5" for strength, "10" for regeneration)
   * @param display - Display name for logging
   */
  private async _useItemUntilEffect(
    effectId: string,
    display: string,
  ): Promise<void> {
    this.logger.inventory(`Using ${display}...`);
    try {
      this.bot.activateItem(true);
      const t0 = Date.now();
      while (!this.bot.entity.effects[effectId as any]) {
        if (Date.now() - t0 > Constants.TIMING.DEFAULT_TIMEOUT) {
          throw new Error(`Timeout reached while using ${display}`);
        }
        await this.bot.waitForTicks!(2);
      }
      this.logger.inventory(`Used ${display} successfully`);
    } catch (error: unknown) {
      const err = error as Error;
      err.message = `Failed to use ${display}: ${err.message}`;
      this.logger.error(err, "Inventory");
    } finally {
      this.bot.deactivateItem();
    }
  }

  /**
   * Equip the best weapon (sword/axe/pickaxe/shovel/hoe) based on DPS score.
   */
  async equipWeapon(): Promise<void> {
    const materialStats = Constants.MATERIALS.WEAPONS;
    const weapons = this.bot.inventory
      .items()
      .filter(
        (item: any) =>
          item.name.endsWith("_sword") ||
          item.name.endsWith("_axe") ||
          item.name.endsWith("_pickaxe") ||
          item.name.endsWith("_shovel") ||
          item.name.endsWith("_hoe"),
      );
    if (weapons.length === 0) {
      this.logger.debug(`Weapon: no weapons in inventory`, "Inventory");
      return;
    }

    const weapon = weapons.reduce((best: any | null, item: any) => {
      const score = this._computeWeaponScore(item, materialStats);
      return !best || score > this._computeWeaponScore(best, materialStats)
        ? item
        : best;
    }, null);

    const held = this.bot.heldItem;
    const currentScore = held
      ? this._computeWeaponScore(held, materialStats)
      : -1;
    const bestScore = this._computeWeaponScore(weapon, materialStats);

    if (bestScore > currentScore) {
      this.logger.debug(
        `Weapon: ${weapon.displayName} outscores current ${held?.displayName ?? "empty"}. New DPS: ${bestScore.toFixed(2)}, current DPS: ${currentScore.toFixed(2)}`,
        "Inventory",
      );
      this.logger.inventory(
        `Equipping ${weapon.displayName} (#${weapon.type}) (DPS: ${bestScore.toFixed(2)}) to hand...`,
      );
      await this.bot.equip!(weapon, "hand" as any);
      await this.bot.waitForTicks!(Constants.TIMING.EQUIP_TICKS);
    }
  }

  /**
   * Compute a weapon score from base DPS and sharpness enchantment.
   * @param item - Item object with .enchants array
   * @param materialStats - Weapon stats from constants
   * @returns Score value for comparison
   * @private
   */
  _computeWeaponScore(item: any, materialStats: any): number {
    if (!item?.name) return -1;
    const stats = materialStats[item.name];
    if (!stats) return 0;
    const baseDPS = (stats as any).damage * (stats as any).speed;
    let sharpnessBonus = 0;
    if (item.enchants && Array.isArray(item.enchants)) {
      const sharpness = item.enchants.find((e: any) => e.name === "sharpness");
      if (sharpness)
        sharpnessBonus = (sharpness.lvl || 0) * 1.25 * (stats as any).speed;
    }
    return baseDPS + sharpnessBonus;
  }
}

/**
 * Attach the InventoryManager to a bot instance.
 * @param bot - Mineflayer bot instance
 * @returns The same bot instance with inventoryManager attached
 */
export function attachInventory(bot: Bot): Bot {
  bot.inventoryManager = new InventoryManager(bot);
  return bot;
}

export { InventoryManager };
