import { Logger } from "./logger";
// @ts-ignore - prismarine-nbt may not have complete types
import nbt from "prismarine-nbt";
// @ts-ignore - prismarine-item exports a versioned factory function
import prismarineItem from "prismarine-item";
import { Constants } from "./constants";
import { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import * as fs from "node:fs";
import { promisify } from "node:util";

const writeFileAsync = promisify(fs.writeFile);

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

  // ── Window-op serialization ────────────────────────────────────────
  // bot.equip / toss / unequip drive mineflayer moveSlotItem chains: a
  // sequence of clickWindow calls where every click must be confirmed by
  // the server before the next fires, all sharing one mouse cursor. Two
  // overlapping chains interleave their clicks, the transaction sequence
  // desyncs and the server starts rejecting clicks ("Server rejected
  // transaction") — items bounce in and out of slots and nothing settles
  // until the bot reconnects. This happens exactly when an armor set
  // appears all at once: the combat tree fires equipArmor() fire-and-
  // forget every tick, and each tick re-reads the still-shift/shifting
  // inventory. Every window operation in this manager therefore queues
  // behind the same promise chain.
  /** Tail of the serialized window-operation chain. */
  private _windowChain: Promise<unknown> = Promise.resolve();

  // ── Use-flow (eat/drink) non-reentrancy ─────────────────────────────
  // The heal/food/buff decisions dispatch fire-and-forget EVERY tick while
  // their condition holds. A consume takes 32 ticks (~1600ms) of holding
  // "use"; an overlapping second activation re-sends the use packet and
  // restarts the server-side consume bar, so the item never finishes and
  // every flow ends in "timeout reached" (the gapple-eat choke). While a
  // use is active, later dispatches must defer to the running flow
  // instead of starting their own.
  /** True while an eat/drink flow holds an item in a "using" state. */
  private _itemUseActive = false;

  /**
   * Run `fn` as an exclusive window operation: nothing else in this
   * manager touches the inventory window until it settles.
   */
  private _withWindow<T>(fn: () => Promise<T>): Promise<T> {
    // Run regardless of the previous op's outcome.
    const prev = this._windowChain as Promise<void>;
    const run = prev.then(() => fn(), () => fn());
    // The stored chain must never reject — a rejection would poison every
    // later op. Errors stay visible through the returned promise.
    this._windowChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Everything the bot carries in the player window: items() covers the
   * main inventory (9-35) plus the quick bar (36-44); the armor slots (5-8)
   * and the off-hand slot (45) are NOT part of that range and are read
   * from their window slots directly. While a click transaction is mid-
   * flight (e.g. an equip), the stack being moved sits on the mouse cursor
   * and is in no slot at all — include it too, or a scan in that instant
   * reports a false "not in inventory". The main hand is skipped — it
   * always points into the quick bar and would double-count.
   * @private
   */
  private _carriedItems(): any[] {
    const results: any[] = [...this.bot.inventory.items()];
    for (const destination of ["head", "torso", "legs", "feet", "off-hand"]) {
      const slot = this.bot.getEquipmentDestSlot(destination);
      const item = this.bot.inventory.slots[slot];
      if (item) results.push(item);
    }
    // Window updates apply server state, so the cursor stack is not also in
    // a slot; the identity check keeps that guarantee under any harness.
    const cursor = (this.bot.inventory as any).selectedItem;
    if (cursor && !results.includes(cursor)) results.push(cursor);
    return results;
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

    const results: any[] = [];
    for (const item of this._carriedItems()) {
      if (matches(item) && (!notFull || item.count < item.stackSize)) {
        results.push(item);
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
    const currentTick = this.bot.time.age;
    const cacheKey = "has:food";

    if (this._lastCacheTick === currentTick && this._itemCache.has(cacheKey)) {
      return this._itemCache.get(cacheKey) as boolean;
    }

    const foodsByName = this.bot.registry?.foodsByName ?? {};
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
      await this._withWindow(async () => {
        await this.bot.equip!(item, targetSlot as any);
        await this.bot.waitForTicks!(Constants.TIMING.EQUIP_TICKS);
      });
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
    if (this.bot.game.gameMode !== creativeName) {
      throw new Error(
        `clearInventory requires creative mode, current gamemode is ${this.bot.game.gameMode}`,
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
    this.bot.chat!(`/give @p ${itemName} ${count}`);
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

    this.bot.chat!(`/give ${args}`);

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
    if (this.bot.game.gameMode !== creativeName) {
      throw new Error(
        `getItemViaCreative requires creative mode (gamemode 1), current gamemode is ${this.bot.game.gameMode}`,
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
    try {
      await writeFileAsync(filename, JSON.stringify(data, null, 2));
      this.logger.inventory(`${data.length} items recorded into slot ${slot}`);
    } catch (error: unknown) {
      const err = error as Error;
      err.message = `Failed to record inventory: ${err.message}`;
      this.logger.error(err, "Inventory");
    }
  }

  /**
   * Restore inventory from a recorded JSON file.
   * @param slot - Recording slot index matching the filename
   */
  async restoreInventory(slot: number | string = 0): Promise<void> {
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

    this.logger.inventory(
      `Restored ${restored}/${data.length} items from slot ${slot}`,
    );
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
    if (this.bot.game.gameMode !== modeName) {
      this.logger.status(
        `Setting gamemode from ${this.bot.game.gameMode} to ${modeName}`,
      );
      this.bot.chat!(`/gamemode ${mode}`);
      await this.bot.waitForTicks!(2);
      while (this.bot.game.gameMode !== modeName) {
        if (Date.now() - t0 > timeout) {
          this.logger.warning(
            `Timeout while setting gamemode to ${modeName} (current: ${this.bot.game.gameMode}). Proceeding anyway`,
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
    await this._withWindow(async () => {
      const destinations = ["head", "torso", "legs", "feet", "off-hand"];
      for (const destination of destinations) {
        const slot = this.bot.getEquipmentDestSlot(destination);
        if (this.bot.inventory.slots[slot] !== null) {
          await this.bot.waitForTicks!(Constants.TIMING.EQUIP_TICKS);
          await this.bot.unequip!(destination as any);
        }
      }
    });
  }

  /**
   * Toss every item from the inventory.
   */
  async tossAllItems(): Promise<void> {
    await this._withWindow(async () => {
      const items = this.bot.inventory.items();
      for (const item of items) {
        await this.bot.waitForTicks!(Constants.TIMING.EQUIP_TICKS);
        await this.bot.toss!(item.type, item.metadata, item.count);
      }
    });
  }

  /**
   * Equip the best armor items for each slot based on material and
   * enchantment scores.
   *
   * The combat tree fires this fire-and-forget every combat tick, so the
   * runs serialize here instead of at the window: while a pass is in
   * flight, later calls collapse into a single follow-up pass that
   * re-reads the inventory fresh. Without the guard, overlapping passes
   * interleave mineflayer's click chains and the server rejects the
   * window transactions (the bot stalls — see {@link _withWindow}).
   */
  async equipArmor(): Promise<void> {
    if (this._equipArmorBusy) {
      this._equipArmorQueued = true;
      return;
    }
    this._equipArmorBusy = true;
    try {
      do {
        this._equipArmorQueued = false;
        await this._withWindow(() => this._equipArmorPass());
      } while (this._equipArmorQueued);
    } finally {
      this._equipArmorBusy = false;
    }
  }

  /** While an armor pass runs, collapse overlapping calls into one more. */
  private _equipArmorBusy = false;
  private _equipArmorQueued = false;

  /**
   * One armor pass: read the inventory once, equip at most one item per
   * slot. Runs exclusively ({@link _withWindow}).
   */
  private async _equipArmorPass(): Promise<void> {
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
    return stats.defense + stats.toughness + protectionLVL + otherEnchantWeight;
  }

  /**
   * Equip the best golden apple (enchanted > regular) to off-hand.
   * Optionally activates it (eats it) to trigger the regeneration effect.
   * @param activate - Whether to eat the apple after equipping (default: true)
   */
  async equipGapple(activate: boolean = true): Promise<void> {
    // findItem covers the off-hand slot too: once a gapple stack is equipped
    // there, a plain items() scan no longer sees it and later re-eats would
    // report "no golden apples in inventory" while holding one.
    const items = this.findItem("golden_apple");
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
      await this._withWindow(async () => {
        await this.bot.equip!(bestGapple, "off-hand" as any);
      });
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
    if (this.bot.game.gameMode === "creative") {
      this.logger.inventory(
        `Skipping ${bestGapple.displayName} use in creative mode (no effect)`,
      );
      return;
    }

    await this._useItemUntilEffect(
      "10",
      bestGapple.displayName,
      // Abort the wait early if something (e.g. a crisis totem equip) swaps
      // the apple out of the off-hand mid-eat — a stale wait would otherwise
      // spin to the timeout while blocking the next heal dispatch.
      () => {
        const held = this.bot.inventory.slots[destSlot];
        return (
          !!held &&
          held.name === bestGapple.name &&
          held.metadata === bestGapple.metadata
        );
      },
    );
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
    // Another flow is consuming an item (e.g. the heal gapple eat); swapping
    // the off-hand food in mid-eat would break that consume.
    if (this._itemUseActive) {
      this.logger.debug(
        `Food: another item use is active, deferring eat`,
        "Inventory",
      );
      return;
    }

    if (this.bot.entity.effects["10"]) return;

    // Carried items only — a bare items() scan misses the off-hand and the
    // armor slots (see _carriedItems).
    const inventory: any[] = this._carriedItems();

    const foodsByName = this.bot.registry?.foodsByName ?? {};
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
    if (this.bot.food! >= 20 || this.bot.game.gameMode === "creative") {
      this.logger.inventory(
        `Skipping ${food.displayName} use \u2014 food full or creative mode`,
      );
      return;
    }

    // Food is not full — eat it
    const expectedHunger = this.bot.food! + foodsByName[food.name].foodPoints;
    this.logger.inventory(`Using ${food.displayName}...`);
    this._itemUseActive = true;
    try {
      this.bot.activateItem(true);
      const t0 = Date.now();
      while (this.bot.food! < expectedHunger && this.bot.food! < 20) {
        if (Date.now() - t0 > Constants.TIMING.USE_ITEM_TIMEOUT) {
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
      this._itemUseActive = false;
    }
  }

  /**
   * Equip and drink a strength potion from off-hand.
   * Prefers strong_strength over regular strength.
   */
  async equipBuff(): Promise<void> {
    // Carried items only — a bare items() scan misses the off-hand and the
    // armor slots (see _carriedItems).
    const inventory: any[] = this._carriedItems();
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
    const effectsByName = this.bot.registry?.effectsByName ?? {};
    const effect = effectsByName[effectName];
    if (!effect) {
      this.logger.debug(
        `Buff: unknown effect ${effectName}, skipping`,
        "Inventory",
      );
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

    await this._useItem(
      potion.name,
      "off-hand",
      () => {
        this.bot.activateItem(true);
      },
      () => {
        return !this.bot.entity.effects[effectId as any];
      },
      () => {
        this.bot.deactivateItem();
      },
    );
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

    // Verify the server agrees the item is held before activating: rapid
    // give/equip/clear sequences can leave the client's hand ahead of the
    // server's, and activating an (server-side) empty hand silently throws
    // nothing. Poll briefly for the held item to settle.
    const countBefore = this.getItemCount(itemType);
    for (let i = 0; i < 10; i++) {
      if (this.bot.heldItem?.name === itemType) break;
      await this.bot.waitForTicks!(1);
    }
    if (this.bot.heldItem?.name !== itemType) {
      throw new Error(
        `Cannot throw ${itemType}: not held after equip (holding ${this.bot.heldItem?.name ?? "nothing"})`,
      );
    }

    // Use lookAt which handles the pitch/yaw calculation internally
    await this.bot.lookAt!(aimPoint, true);
    await this.bot.waitForTicks!(1);

    // Activate, then verify consumption. If the use packet raced still-
    // in-flight window confirms, the server ignores it; re-aim and retry
    // once while the item is verifiably still held.
    let consumed = this.getItemCount(itemType) < countBefore;
    for (let attempt = 0; attempt < 2 && !consumed; attempt++) {
      this.bot.activateItem(false); // Right click once
      const t0 = Date.now();
      while (Date.now() - t0 < Constants.TIMING.DEFAULT_TIMEOUT) {
        await this.bot.waitForTicks!(2);
        if (this.getItemCount(itemType) < countBefore) break;
      }
      consumed = this.getItemCount(itemType) < countBefore;
      if (!consumed && this.bot.heldItem?.name === itemType) {
        this.logger.debug(
          `Pearl: throw attempt ${attempt + 1} not consumed, retrying`,
          "Inventory",
        );
        await this.bot.lookAt!(aimPoint, true);
        await this.bot.waitForTicks!(1);
      }
    }
    if (!consumed && this.bot.heldItem?.name === itemType) {
      throw new Error(
        `Failed to throw ${itemType}: still held with unchanged count after retries`,
      );
    }
    if (consumed) {
      this.logger.inventory(
        `Tossed ${itemType} with offset ${offset.toFixed(2)} successfully`,
      );
    } else {
      // Left the hand without a count change (client/server inventory
      // desync); the throw may still have fired. Callers verify by polling.
      this.logger.debug(
        `Pearl: ${itemType} left hand with unchanged count — possible desync`,
        "Inventory",
      );
    }
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
    // Guard covers the whole flow (equip + use): equipping the potion into
    // the off-hand mid-consume would break an active eat.
    if (this._itemUseActive) {
      this.logger.debug(
        `Use: another item use is active, skipping ${display ?? itemName}`,
        "Inventory",
      );
      return;
    }
    this._itemUseActive = true;
    try {
      const label = display ?? itemName;
      if (!(await this._equipItem(itemName, targetSlot))) {
        this.logger.warn(`Use: ${label} not found in inventory`, "Inventory");
        return;
      }
      this.logger.inventory(`Using ${label}...`);
      activate();
      const t0 = Date.now();
      while (condition()) {
        if (Date.now() - t0 > Constants.TIMING.USE_ITEM_TIMEOUT) {
          throw new Error(`Timeout reached while using ${label}`);
        }
        await this.bot.waitForTicks!(2);
      }
      this.logger.inventory(`Used ${label} successfully`);
    } catch (error: unknown) {
      const err = error as Error;
      err.message = `Failed to use ${display ?? itemName}: ${err.message}`;
      this.logger.error(err, "Inventory");
    } finally {
      cleanup();
      this._itemUseActive = false;
    }
  }

  /**
   * Equip and use an item until a specific Minecraft status effect is active.
   * Non-reentrant: while a use flow is active, later dispatches (the heal
   * decision fires every tick) defer to the running flow instead of
   * re-activating the item and restarting the ~32-tick consume bar.
   * @param effectId - Minecraft effect ID string (e.g. "5" for strength, "10" for regeneration)
   * @param display - Display name for logging
   * @param stillHeld - Optional check that the used item is still in its slot;
   *   if it stops holding (swapped out mid-eat), the wait aborts early instead
   *   of spinning to the timeout.
   */
  private async _useItemUntilEffect(
    effectId: string,
    display: string,
    stillHeld?: () => boolean,
  ): Promise<void> {
    if (this._itemUseActive) {
      this.logger.debug(
        `Use: another item use is active, skipping ${display}`,
        "Inventory",
      );
      return;
    }
    this._itemUseActive = true;
    try {
      this.logger.inventory(`Using ${display}...`);
      this.bot.activateItem(true);
      const t0 = Date.now();
      while (!this.bot.entity.effects[effectId as any]) {
        if (stillHeld && !stillHeld()) {
          this.logger.debug(
            `Use: ${display} no longer in its slot — abandoning use wait`,
            "Inventory",
          );
          return;
        }
        if (Date.now() - t0 > Constants.TIMING.USE_ITEM_TIMEOUT) {
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
      this._itemUseActive = false;
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
      await this._withWindow(async () => {
        await this.bot.equip!(weapon, "hand" as any);
        await this.bot.waitForTicks!(Constants.TIMING.EQUIP_TICKS);
      });
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
    const baseDPS = stats.damage * stats.speed;
    let sharpnessBonus = 0;
    if (item.enchants && Array.isArray(item.enchants)) {
      const sharpness = item.enchants.find((e: any) => e.name === "sharpness");
      if (sharpness) sharpnessBonus = (sharpness.lvl || 0) * 1.25 * stats.speed;
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
