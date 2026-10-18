/**
 * @fileoverview Unit tests for InventoryManager window-op serialization.
 *
 * The combat tree fires equipArmor() fire-and-forget every combat tick.
 * Without serialization, overlapping passes interleave mineflayer's window
 * click chains (each equip drives moveSlotItem: a sequence of clicks that
 * must be confirmed per click, all sharing one mouse cursor). The
 * transaction sequence desyncs and the server rejects the clicks —
 * items bounce in and out of the armor slots and nothing settles. This
 * reproduces exactly when a full armor set appears all at once.
 *
 * These tests use a fake bot whose `equip` models the real behavior: an
 * async, non-instant window operation that moves the item from
 * `inventory.items()` into the destination equipment slot when it resolves.
 */

import { InventoryManager } from "../../src/inventory";

// ── Fake bot ────────────────────────────────────────────────────────

const EQUIP_SLOTS: Record<string, number> = {
  head: 5,
  torso: 6,
  legs: 7,
  feet: 8,
  "off-hand": 45,
};

interface FakeItem {
  name: string;
  type: number;
}

function item(name: string): FakeItem {
  return { name, type: 300 + Math.floor(Math.random() * 1000) };
}

/**
 * Build a bot stub: `inventory.items()` returns the not-yet-equipped items;
 * `equip` handles the window op across several macrotasks, then moves the
 * item into the destination slot. Tracks the max observed concurrency of
 * active equips and records `name->slot` movements.
 */
async function makeBot(itemNames: string[]) {
  const items: FakeItem[] = itemNames.map(item);
  const slots: (FakeItem | null)[] = new Array(46).fill(null);
  const moves: string[] = [];
  const starts = Promise.resolve(); // keep the harness simple
  void starts;
  let active = 0;
  let maxConcurrent = 0;
  // One-shot hold for the first equip (tests suspend a pass mid-flight).
  let heldEquip: Promise<void> | null = null;
  let firstEquipPending = false;

  const bot: any = {
    __logger: { debug: () => {}, inventory: () => {}, error: () => {} },
    inventory: {
      items: () => items,
      slots,
      on: () => {}, // windowUpdate/changedSlot cache clear
      findInventoryItem: () => null,
    },
    getEquipmentDestSlot: (dest: string) => EQUIP_SLOTS[dest] ?? 0,
    /** Make the first equip() of the run wait on this promise. */
    holdFirstEquip(promise: Promise<void>): void {
      heldEquip = promise;
      firstEquipPending = true;
    },
    async equip(itemToEquip: FakeItem, destination: string): Promise<void> {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      try {
        if (firstEquipPending) {
          firstEquipPending = false;
          await heldEquip;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        const idx = items.indexOf(itemToEquip);
        if (idx >= 0) items.splice(idx, 1);
        slots[EQUIP_SLOTS[destination]] = itemToEquip;
        moves.push(`${itemToEquip.name}->${destination}`);
      } finally {
        active--;
      }
    },
    waitForTicks: async () => {},
  };

  return {
    inv: new InventoryManager(bot),
    bot,
    moves,
    items,
    slots,
    maxConcurrent: () => maxConcurrent,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const ALL_ARMOR_SLOTS = Object.values(EQUIP_SLOTS);

// ── Tests ───────────────────────────────────────────────────────────

describe("InventoryManager window-op serialization", () => {
  test("overlapping equipArmor passes never run concurrent window tasks", async () => {
    const { inv, moves, maxConcurrent, slots } = await makeBot([
      "leather_helmet",
      "leather_chestplate",
      "leather_leggings",
      "leather_boots",
    ]);

    // The combat tree pattern: five fire-and-forget calls, un-awaited.
    const runs = [0, 0, 0, 0, 0].map(() => inv.equipArmor());
    await Promise.all(runs);

    // Serialized: at most one mineflayer equip was in flight at any time…
    expect(maxConcurrent()).toBe(1);
    // …each piece moved exactly once…
    expect(moves).toEqual([
      "leather_helmet->head",
      "leather_chestplate->torso",
      "leather_leggings->legs",
      "leather_boots->feet",
    ]);
    // …and every equipment slot holds an item.
    for (const slot of ALL_ARMOR_SLOTS.slice(0, 4)) {
      expect(slots[slot]).not.toBeNull();
    }
  });

  test("overlapping calls settle pieces that appear mid-pass", async () => {
    const { inv, bot, moves, items, slots } = await makeBot([
      "leather_helmet",
    ]);
    const hold = deferred();
    bot.holdFirstEquip(hold.promise);

    // One pass starts; more fire-and-forget calls land while it is busy.
    const runs = [0, 0, 0, 0, 0].map(() => inv.equipArmor() as Promise<void>);
    // The remaining set appears while the first window task is still
    // in flight (raw item list mutation, like a full set arriving at once).
    items.push(item("leather_chestplate"));
    items.push(item("leather_leggings"));
    items.push(item("leather_boots"));
    hold.resolve();

    await Promise.all(runs);

    expect(moves).toEqual([
      "leather_helmet->head",
      "leather_chestplate->torso",
      "leather_leggings->legs",
      "leather_boots->feet",
    ]);
    expect(items.length).toBe(0);
    for (const slot of ALL_ARMOR_SLOTS.slice(0, 4)) {
      expect(slots[slot]).not.toBeNull();
    }
  });

  test("window ops from different flows queue instead of clashing", async () => {
    const { inv, moves, maxConcurrent } = await makeBot([
      "leather_helmet",
      "totem_of_undying",
    ]);

    const c1 = inv.equipArmor();
    const c2 = inv._equipItem("totem_of_undying", "off-hand");
    const c3 = inv.equipWeapon(); // no weapon present: no window ops
    const equipped = await Promise.all([c1, c2, c3]);

    expect(maxConcurrent()).toBe(1);
    expect(moves[0]).toBe("leather_helmet->head");
    expect(moves).toContain("totem_of_undying->off-hand");
    expect(equipped[1]).toBe(true);
  });
});
