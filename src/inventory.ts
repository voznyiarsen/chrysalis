import { Logger } from "./logger";
// @ts-ignore - prismarine-nbt may not have complete types
import nbt from "prismarine-nbt";
// @ts-ignore - prismarine-item exports a versioned factory function
import prismarineItem from "prismarine-item";
import { Constants } from "./constants";
import { Bot } from "mineflayer";

// Construct the Item class with a game version
const Item: any = prismarineItem("1.19.3");

/**
 * Manages bot inventory, equipment, and item-related operations
 */
class InventoryManager {
  public bot: Bot;
  public logger: Logger;
  public _itemCache: Map<string, boolean | number>;
  public _lastCacheTick: number;

  /**
   * @param bot - Mineflayer bot instance
   */
  constructor(bot: Bot) {
    this.bot = bot;
    this.logger = (bot as any).__logger;

    // Cache for hasItem and getItemCount results (cleared every tick or on change)
    this._itemCache = new Map();
    this._lastCacheTick = 0;

    // Invalidate cache on inventory changes
    const clearCache = () => this._itemCache.clear();
    (this.bot as any).inventory.on("windowUpdate", clearCache);
    (this.bot as any).inventory.on("changedSlot", clearCache);
  }

  /**
   * Get total count of a specific item in inventory and equipment
   * @param itemName - Item name
   * @returns Total count of the item
   */
  getItemCount(itemName: string): number {
    const currentTick = (this.bot as any).time.age;
    const cacheKey = `count:${itemName}`;

    if (this._lastCacheTick === currentTick && this._itemCache.has(cacheKey)) {
      return this._itemCache.get(cacheKey) as number;
    }

    const itemInfo = (this.bot as any).registry.itemsByName[itemName];
    if (!itemInfo) return 0;

    const itemType = itemInfo.id;
    const allItems: any[] = [
      ...(this.bot as any).inventory.items(),
      ...Object.values((this.bot as any).entity.equipment),
    ];

    const count = allItems
      .filter((item) => item?.type === itemType)
      .reduce((acc: number, item) => acc + item.count, 0);

    this._updateCache(cacheKey, count, currentTick);
    return count;
  }

  /**
   * Check if bot has a specific item in inventory or equipment
   * @param itemName - Item name
   * @returns Whether bot has the item
   */
  hasItem(itemName: string): boolean {
    const currentTick = (this.bot as any).time.age;
    const cacheKey = `has:${itemName}`;

    if (this._lastCacheTick === currentTick && this._itemCache.has(cacheKey)) {
      return this._itemCache.get(cacheKey) as boolean;
    }

    const names = [itemName];

    const has =
      (this.bot as any).inventory
        .items()
        .some((item: any) => names.includes(item.name)) ||
      Object.values((this.bot as any).entity.equipment).some((item: any) =>
        item ? names.includes(item.name) : false,
      );

    this._updateCache(cacheKey, has, currentTick);
    return has;
  }

  /**
   * Check if bot has a specific item with metadata
   * @param itemName - Item name
   * @param metadata - Item metadata
   * @returns Whether bot has the item
   */
  hasItemWithMetadata(itemName: string, metadata: number): boolean {
    const currentTick = (this.bot as any).time.age;
    const cacheKey = `has:${itemName}:${metadata}`;

    if (this._lastCacheTick === currentTick && this._itemCache.has(cacheKey)) {
      return this._itemCache.get(cacheKey) as boolean;
    }

    const has =
      (this.bot as any).inventory
        .items()
        .some(
          (item: any) => item.name === itemName && item.metadata === metadata,
        ) ||
      Object.values((this.bot as any).entity.equipment).some((item: any) =>
        item ? item.name === itemName && item.metadata === metadata : false,
      );

    this._updateCache(cacheKey, has, currentTick);
    return has;
  }

  /**
   * Check if bot has any food item
   * @returns Whether bot has food
   */
  hasFood(): boolean {
    const currentTick = (this.bot as any).time.age;
    const cacheKey = "has:food";

    if (this._lastCacheTick === currentTick && this._itemCache.has(cacheKey)) {
      return this._itemCache.get(cacheKey) as boolean;
    }

    const foodStats = Constants.MATERIALS.FOOD;
    const has = (this.bot as any).inventory
      .items()
      .some(
        (item: any) =>
          foodStats[item.name as keyof typeof foodStats] !== undefined,
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
      const destSlot = (this.bot as any).getEquipmentDestSlot(targetSlot);
      const currentItem = (this.bot as any).inventory.slots[destSlot];

      if (currentItem && currentItem.name === itemName) return true;

      const item = (this.bot as any).inventory
        .items()
        .find((i: any) => i.name === itemName);

      if (!item) {
        //  throw new Error(`Item ${itemName} not found in inventory`);
        return false;
      }

      this.logger.inventory(
        `Equipping ${item.displayName} to ${targetSlot}...`,
      );
      await this.bot.equip!(item, targetSlot as any);
      await this.bot.waitForTicks!(Constants.TIMING.EQUIP_WAIT_TICKS);
      return true;
    } catch (error: unknown) {
      const err = error as Error;
      if (!err.message.includes("not found")) {
        err.message = `Failed to equip ${itemName}: ${err.message}`;
      }
      this.logger.error(err);
      return false;
    }
  }

  /**
   * Clear the entire inventory via creative mode.
   */
  async clearInventory(): Promise<void> {
    await this.setGamemode(1);
    try {
      await (this.bot as any).creative.clearInventory();
      this.logger.inventory(`Inventory cleared`);
    } catch (error: unknown) {
      const err = error as Error;
      err.message = `Failed to clear inventory: ${err.message}`;
      this.logger.error(err);
    }
    await this.setGamemode(0);
  }

  /**
   * Record current inventory to a JSON file.
   * @param slot - Recording slot index for the filename
   */
  async recordInventory(slot: number | string = 0): Promise<void> {
    const fs = require("node:fs");
    const array = (this.bot as any).inventory.slots.filter(
      (item: any) => item?.type,
    );
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
          this.logger.error(error);
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
    const fs = require("node:fs");
    const raw = fs.readFileSync(`./recording-${slot}.json`, "utf8");
    const data = JSON.parse(raw);
    await this.setGamemode(1);

    for (const item of data) {
      try {
        const newItem = new Item(
          item.type,
          item.count,
          item.metadata,
          item.nbt,
        );
        await (this.bot as any).creative.setInventorySlot(item.slot, newItem);
        await this.bot.waitForTicks!(Constants.TIMING.EQUIP_WAIT_TICKS);
        this.logger.inventory(`Slot ${item.slot} (item: ${item.displayName})`);
      } catch (error: unknown) {
        const err = error as Error;
        err.message = `Failed to set slot ${item.slot}: ${err.message}`;
        this.logger.error(err);
      }
    }

    this.logger.inventory(`Processed ${data.length} items (slot ${slot})`);
    await this.setGamemode(0);
  }

  /**
   * Set the player's gamemode, retrying until it takes effect.
   * @param mode - Gamemode ID (0=survival, 1=creative, etc.)
   * @param timeout - Max time in ms to wait
   */
  async setGamemode(
    mode: number,
    timeout: number = Constants.TIMING.DEFAULT_TIMEOUT,
  ): Promise<void> {
    const t0 = Date.now();
    while ((this.bot as any).player.gamemode !== mode) {
      if (Date.now() - t0 > timeout) {
        this.logger.error(
          new Error(`Timeout reached while setting gamemode to ${mode}`),
        );
        return;
      }
      this.logger.status(
        `Current gamemode: ${(this.bot as any).player.gamemode}, setting to ${mode}`,
      );
      await this.bot.chat!(`/gamemode ${mode}`);
      await this.bot.waitForTicks!(2);
    }
  }

  /**
   * Unequip all armor slots.
   */
  async unequipAllItems(): Promise<void> {
    const destinations = ["head", "torso", "legs", "feet", "off-hand"];
    for (const destination of destinations) {
      const slot = (this.bot as any).getEquipmentDestSlot(destination);
      if ((this.bot as any).inventory.slots[slot] !== null) {
        await this.bot.waitForTicks!(Constants.TIMING.EQUIP_WAIT_TICKS);
        await this.bot.unequip!(destination as any);
      }
    }
  }

  /**
   * Toss every item from the inventory.
   */
  async tossAllItems(): Promise<void> {
    const items = (this.bot as any).inventory.items();
    for (const item of items) {
      await this.bot.waitForTicks!(Constants.TIMING.EQUIP_WAIT_TICKS);
      await this.bot.toss!(item.type, item.metadata, item.count);
    }
  }

  /**
   * Equip the best armor items for each slot based on material and enchantment scores.
   */
  async equipArmor(): Promise<void> {
    const materialStats = Constants.MATERIALS.ARMOR;
    const slotMap = Constants.MATERIALS.SLOT_MAP;

    const allArmorItems = (this.bot as any).inventory
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

      const equipSlot = (this.bot as any).getEquipmentDestSlot(slot);
      const currentArmor = (this.bot as any).inventory.slots[equipSlot];

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
        this.logger.inventory(
          `Equipping ${bestItem.displayName} to ${slot} (score: ${bestScore})...`,
        );
        await this.bot.equip!(bestItem, slot as any);
        await this.bot.waitForTicks!(Constants.TIMING.EQUIP_WAIT_TICKS);
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
   * Activates and waits for the regeneration effect.
   */
  async equipGapple(): Promise<void> {
    const items = (this.bot as any).inventory
      .items()
      .filter((i: any) => i.name === "golden_apple");
    if (items.length === 0) return;

    // Don't use if already having regeneration
    if ((this.bot as any).entity.effects["10"]) return;

    // Prioritize enchanted (metadata 1)
    const bestGapple = items.sort(
      (a: any, b: any) => (b.metadata || 0) - (a.metadata || 0),
    )[0];

    const destSlot = (this.bot as any).getEquipmentDestSlot("off-hand");
    const currentItem = (this.bot as any).inventory.slots[destSlot];

    if (
      !currentItem ||
      currentItem.name !== bestGapple.name ||
      currentItem.metadata !== bestGapple.metadata
    ) {
      this.logger.inventory(
        `Equipping ${bestGapple.displayName} to off-hand...`,
      );
      await this.bot.equip!(bestGapple, "off-hand" as any);
      await this.bot.waitForTicks!(Constants.TIMING.EQUIP_WAIT_TICKS);
    }

    this.logger.inventory(`Using ${bestGapple.displayName}...`);
    try {
      (this.bot as any).activateItem(true);
      const t0 = Date.now();
      while (!(this.bot as any).entity.effects["10"]) {
        if (Date.now() - t0 > Constants.TIMING.DEFAULT_TIMEOUT) {
          throw new Error("Timeout reached while using item");
        }
        await this.bot.waitForTicks!(2);
      }
      this.logger.inventory(`Used ${bestGapple.displayName} successfully`);
    } catch (error: unknown) {
      const err = error as Error;
      err.message = `Failed to use ${bestGapple.displayName}: ${err.message}`;
      this.logger.error(err);
    } finally {
      (this.bot as any).deactivateItem();
    }
  }

  /**
   * Equip and eat the best available food.
   * Skips if food or health is full, or if regeneration is active.
   */
  async equipFood(): Promise<void> {
    // Skip if full or regeneration active (prevents waste during combat)
    if (this.bot.food! >= 20 || (this.bot as any).entity.effects["10"]) return;

    const inventory: any[] = [
      ...(this.bot as any).inventory.items(),
      ...Object.values((this.bot as any).entity.equipment).filter(
        (i: any) => i != null,
      ),
    ];

    const foodStats = Constants.MATERIALS.FOOD;
    const items = inventory.filter(
      (item: any) =>
        (foodStats as Record<string, unknown>)[item.name] !== undefined,
    );
    if (items.length === 0) return;

    // Best food: prioritize saturation then hunger
    const food = items.reduce((best: any, current: any) => {
      const bStats = (
        foodStats as Record<string, { saturation: number; hunger: number }>
      )[best.name];
      const cStats = (
        foodStats as Record<string, { saturation: number; hunger: number }>
      )[current.name];
      if (cStats.saturation > bStats.saturation) return current;
      if (
        cStats.saturation === bStats.saturation &&
        cStats.hunger > bStats.hunger
      )
        return current;
      return best;
    });

    if (await this._equipItem(food.name, "off-hand")) {
      const stats = (
        foodStats as Record<string, { saturation: number; hunger: number }>
      )[food.name];
      const expectedHunger = this.bot.food! + stats.hunger;
      this.logger.inventory(`Using ${food.displayName}...`);
      try {
        (this.bot as any).activateItem(true);
        const t0 = Date.now();
        while (this.bot.food! < expectedHunger && this.bot.food! < 20) {
          if (Date.now() - t0 > Constants.TIMING.DEFAULT_TIMEOUT) {
            throw new Error("Timeout reached while eating");
          }
          await this.bot.waitForTicks!(2);
        }
        this.logger.inventory(`Used ${food.displayName} successfully`);
      } catch (error: unknown) {
        const err = error as Error;
        err.message = `Failed to eat ${food.displayName}: ${err.message}`;
        this.logger.error(err);
      } finally {
        (this.bot as any).deactivateItem();
      }
    }
  }

  /**
   * Equip and drink a strength potion from off-hand.
   * Prefers strong_strength over regular strength.
   */
  async equipBuff(): Promise<void> {
    // Skip if strength already active
    if ((this.bot as any).entity.effects["5"]) return;

    const inventory: any[] = [
      ...(this.bot as any).inventory.items(),
      ...Object.values((this.bot as any).entity.equipment).filter(
        (i: any) => i != null,
      ),
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

    if (potion && (await this._equipItem(potion.name, "off-hand"))) {
      this.logger.inventory(`Using ${potion.displayName}...`);
      try {
        (this.bot as any).activateItem(true);
        const t0 = Date.now();
        while (!(this.bot as any).entity.effects["5"]) {
          if (Date.now() - t0 > Constants.TIMING.DEFAULT_TIMEOUT) {
            throw new Error("Timeout reached while using potion");
          }
          await this.bot.waitForTicks!(2);
        }
        this.logger.inventory(`Used ${potion.displayName} successfully`);
      } catch (error: unknown) {
        const err = error as Error;
        err.message = `Failed to use ${potion.displayName}: ${err.message}`;
        this.logger.error(err);
      } finally {
        (this.bot as any).deactivateItem();
      }
    }
  }

  /**
   * Equip a totem of undying to the off-hand.
   * @returns Whether equipping succeeded
   */
  async equipTotem(): Promise<boolean> {
    return this._equipItem("totem_of_undying", "off-hand");
  }

  /**
   * Equip and throw an ender pearl (or other projectile) toward a target.
   * Adjusts pitch for the projectile's offset and looks before throwing.
   * @param yaw - Yaw in radians, or null to keep current
   * @param pitch - Pitch in radians, or null to keep current
   * @param itemType - Item name for the projectile
   */
  async equipPearl(
    yaw: number | null = null,
    pitch: number | null = null,
    itemType: string = "ender_pearl",
  ): Promise<void> {
    if (await this._equipItem(itemType, "hand")) {
      // Ensure the bot stops moving before the throw
      (this.bot as any).clearControlStates();
      await (this.bot as any).pathfinder.stop();
      await this.bot.waitForTicks!(1);

      if (yaw !== null && pitch !== null) {
        // Apply pitch offset from documentation
        const projData = Constants.COMBAT.PROJECTILES[
          itemType as keyof typeof Constants.COMBAT.PROJECTILES
        ] || {
          PITCH_OFFSET: 0,
        };
        // Minecraft pitch: positive is down. PITCH_OFFSET (positive) makes it point lower.
        // T = P + O => P = T - O
        // All our internal pitches are in Radians, but constants might be in Degrees
        const offsetRad = ((projData as any).PITCH_OFFSET * Math.PI) / 180;
        const adjustedPitch = pitch - offsetRad;

        // Mineflayer uses positive pitch for looking UP
        await this.bot.look!(yaw, adjustedPitch, true);
        await this.bot.waitForTicks!(1);
      }
      (this.bot as any).activateItem(false); // Right click once
      await this.bot.waitForTicks!(1);
      this.logger.inventory(`Tossed ${itemType} successfully`);
    }
  }

  /**
   * Equip the best weapon (sword/axe/pickaxe/shovel/hoe) based on DPS score.
   */
  async equipWeapon(): Promise<void> {
    const materialStats = Constants.MATERIALS.WEAPONS;
    const weapons = (this.bot as any).inventory
      .items()
      .filter(
        (item: any) =>
          item.name.endsWith("_sword") ||
          item.name.endsWith("_axe") ||
          item.name.endsWith("_pickaxe") ||
          item.name.endsWith("_shovel") ||
          item.name.endsWith("_hoe"),
      );
    if (weapons.length === 0) return;

    const weapon = weapons.reduce((best: any | null, item: any) => {
      const score = this._computeWeaponScore(item, materialStats);
      return !best || score > this._computeWeaponScore(best, materialStats)
        ? item
        : best;
    }, null);

    const held = (this.bot as any).heldItem;
    const currentScore = held
      ? this._computeWeaponScore(held, materialStats)
      : -1;
    const bestScore = this._computeWeaponScore(weapon, materialStats);

    if (bestScore > currentScore) {
      this.logger.inventory(
        `Equipping ${weapon.displayName} (#${weapon.type}) (DPS: ${bestScore.toFixed(2)}) to hand...`,
      );
      await this.bot.equip!(weapon, "hand" as any);
      await this.bot.waitForTicks!(Constants.TIMING.EQUIP_WAIT_TICKS);
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

  /**
   * Equip the best golden apple to off-hand (does not activate it).
   * Used as a utility fallback.
   */
  async equipUtility(): Promise<void> {
    const items = (this.bot as any).inventory
      .items()
      .filter((i: any) => i.name === "golden_apple");
    if (items.length === 0) return;

    // Prioritize enchanted (metadata 1)
    const bestGapple = items.sort(
      (a: any, b: any) => (b.metadata || 0) - (a.metadata || 0),
    )[0];

    await this.bot.equip!(bestGapple, "off-hand" as any);
    await this.bot.waitForTicks!(Constants.TIMING.EQUIP_WAIT_TICKS);
  }
}

/**
 * Attach the InventoryManager to a bot instance.
 * @param bot - Mineflayer bot instance
 * @returns The same bot instance with inventoryManager attached
 */
export default function attach(bot: Bot): Bot {
  (bot as any).inventoryManager = new InventoryManager(bot);
  return bot;
}

export { InventoryManager };
