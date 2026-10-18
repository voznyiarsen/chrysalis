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
  metadata?: number;
  count?: number;
  stackSize?: number;
}

function item(name: string): FakeItem {
  return {
    name,
    type: 300 + Math.floor(Math.random() * 1000),
    count: 1,
    stackSize: 64,
  };
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
  const errors: string[] = [];
  let active = 0;
  let maxConcurrent = 0;
  // One-shot hold for the first equip (tests suspend a pass mid-flight).
  let heldEquip: Promise<void> | null = null;
  let firstEquipPending = false;

  const bot: any = {
    __logger: {
      debug: () => {},
      inventory: () => {},
      warn: () => {},
      error: (err: unknown) => {
        errors.push(err instanceof Error ? err.message : String(err));
      },
    },
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
    // Use-flow surface (unused unless a test installs spies).
    entity: {
      effects: {} as Record<string, unknown>,
      equipment: {} as Record<string, unknown>,
    },
    game: { gameMode: "survival" },
    food: 20,
    activateItem: () => {},
    deactivateItem: () => {},
    time: { age: 0 },
  };

  return {
    inv: new InventoryManager(bot),
    bot,
    moves,
    items,
    slots,
    errors,
    maxConcurrent: () => maxConcurrent,
  };
}

/**
 * Fake bot prepared for use-flow (eat/drink) tests: activation spies, a
 * ticking waitForTicks that yields real macrotasks, and manual control
 * over the regeneration effect.
 */
async function makeUseBot(itemNames: string[]) {
  const base = await makeBot(itemNames);
  const { bot } = base;
  let activations = 0;
  let deactivations = 0;
  bot.activateItem = () => {
    activations++;
  };
  bot.deactivateItem = () => {
    deactivations++;
  };
  // Real macrotask gaps so overlapping flows interleave like on a server.
  bot.waitForTicks = async () => {
    await new Promise((resolve) => setTimeout(resolve, 2));
  };
  // Note: no items() override here. findItem/_carriedItems reads the
  // equipment window slots directly, so an override that folded slots into
  // items() would double-count equipped pieces.
  return {
    ...base,
    activations: () => activations,
    deactivations: () => deactivations,
    setRegeneration(active: boolean): void {
      if (active) {
        bot.entity.effects["10"] = { id: 10, amplifier: 2 };
      } else {
        delete bot.entity.effects["10"];
      }
    },
  };
}

async function waitUntil(
  cond: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
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

describe("InventoryManager use-flow non-reentrancy", () => {
  test("findItem sees items resting in armor and off-hand window slots", async () => {
    const { inv, slots } = await makeBot(["empty"]);

    // As equips do: place an apple in the off-hand and a helmet on the head.
    slots[45] = { name: "golden_apple", type: 1, count: 64, metadata: 1 };
    slots[5] = { name: "iron_helmet", type: 2, count: 1 };

    expect(inv.findItem("golden_apple").length).toBe(1);
    expect(inv.findItem("golden_apple", 1).length).toBe(1);
    expect(inv.findItem("golden_apple", 0).length).toBe(0);
    expect(inv.getItemCount("iron_helmet")).toBe(1);
    // The 64-stack in the off-hand must count without double-adding.
    expect(inv.getItemCount("golden_apple")).toBe(64);
  });

  test("findItem sees a stack on the cursor mid-transaction, counted once", async () => {
    const { inv, bot, slots } = await makeBot(["empty"]);

    // Mid-equip: the stack being moved sits on the mouse cursor and in no
    // slot (window state applies with each confirm).
    const apple = {
      name: "golden_apple",
      type: 1,
      count: 64,
      metadata: 1,
    } as FakeItem;
    (bot.inventory as any).selectedItem = apple;

    expect(inv.findItem("golden_apple").length).toBe(1);

    // Paranoid harness state: same item object also visible in a slot.
    // Identity dedupe must keep the count stable.
    slots[45] = apple;
    bot.time.age = 1; // bypass the per-tick cache
    expect(inv.getItemCount("golden_apple")).toBe(64);
  });

  test("overlapping heal dispatches activate the eat exactly once", async () => {
    const { inv, bot, slots, activations, deactivations, errors } =
      await makeUseBot(["golden_apple"]);

    // The heal decision pattern: fire-and-forget equipGapple() every tick.
    const first = inv.equipGapple();
    // Wait until the first flow is actually eating (item equipped, item
    // activated) before the later dispatches land — per-tick spacing.
    await waitUntil(() => activations() >= 1);
    const rest = [0, 0, 0, 0].map(() => inv.equipGapple());

    // The regen effect lands mid-eat; every flow resolves.
    await new Promise((resolve) => setTimeout(resolve, 10));
    bot.entity.effects["10"] = { id: 10, amplifier: 2 };
    await Promise.all([first, ...rest]);

    expect(activations()).toBe(1);
    expect(deactivations()).toBe(1);
    expect(errors).toEqual([]);
    // The apple moved to the off-hand exactly once.
    expect(slots[45]?.name).toBe("golden_apple");
  });

  test("a swapped-out apple aborts the eat wait without a timeout error", async () => {
    const { inv, bot, slots, activations, errors } = await makeUseBot([
      "golden_apple",
    ]);

    const eat = inv.equipGapple();
    await waitUntil(() => activations() >= 1);

    // Crisis: the totem decision swaps the off-hand mid-eat.
    slots[45] = { name: "totem_of_undying", type: 999, metadata: 0 };
    const t0 = Date.now();
    await eat;

    expect(Date.now() - t0).toBeLessThan(1000);
    expect(errors).toEqual([]); // no "Failed to use …: Timeout reached"
  });

  test("guard releases after the effect — a later dispatch can eat again", async () => {
    const { inv, bot, activations, errors } = await makeUseBot([
      "golden_apple",
    ]);

    const first = inv.equipGapple();
    await waitUntil(() => activations() >= 1);
    bot.entity.effects["10"] = { id: 10, amplifier: 2 };
    await first;

    // Later tick: regen expired, health still low → heal dispatches again.
    delete bot.entity.effects["10"];
    const second = inv.equipGapple();
    await waitUntil(() => activations() === 2);
    bot.entity.effects["10"] = { id: 10, amplifier: 2 };
    await second;

    expect(activations()).toBe(2);
    expect(errors).toEqual([]);
  });
});
