/**
 * @fileoverview Terrain helper utilities for E2E tests.
 *
 * Uses vanilla /fill and /setblock commands to place and clear terrain
 * relative to an anchor position. All coordinates in fixtures are
 * offsets from the bot's position.
 */

import { Bot } from "mineflayer";
import { Vec3 } from "vec3";

// ── Types ────────────────────────────────────────────────────────────

export interface BlockSpec {
  pos: [number, number, number];
  type: string;
}

export interface TerrainFixture {
  name: string;
  description: string;
  blocks: BlockSpec[];
}

// ── Vanilla terrain commands ─────────────────────────────────────────

/**
 * Place all blocks from a fixture using individual /setblock commands.
 * Blocks are placed sequentially, then the server is given 2 ticks
 * to process physics.
 */
export async function placeTerrain(
  bot: Bot,
  anchor: Vec3,
  fixture: TerrainFixture,
): Promise<void> {
  const { blocks } = fixture;
  if (blocks.length === 0) return;

  for (const b of blocks) {
    const [dx, dy, dz] = b.pos;
    const x = Math.floor(anchor.x + dx);
    const y = Math.floor(anchor.y + dy);
    const z = Math.floor(anchor.z + dz);
    await bot.utilsManager.assertCommandSuccess(
      "setblock",
      `${x} ${y} ${z} stone`,
    );
    await bot.waitForTicks!(1);
  }
  await bot.waitForTicks!(2);
}

/**
 * Clear all blocks from a fixture by setting them to air.
 */
export async function clearTerrain(
  bot: Bot,
  anchor: Vec3,
  fixture: TerrainFixture,
): Promise<void> {
  const { blocks } = fixture;
  if (blocks.length === 0) return;

  for (const b of blocks) {
    const [dx, dy, dz] = b.pos;
    const x = Math.floor(anchor.x + dx);
    const y = Math.floor(anchor.y + dy);
    const z = Math.floor(anchor.z + dz);
    await bot.utilsManager.assertCommandSuccess(
      "setblock",
      `${x} ${y} ${z} air`,
    );
  }
  await bot.waitForTicks!(2);
}

/**
 * Place terrain, run a callback, then clean up.
 */
export async function withTerrain<T>(
  bot: Bot,
  anchor: Vec3,
  fixture: TerrainFixture,
  fn: () => Promise<T>,
): Promise<T> {
  await placeTerrain(bot, anchor, fixture);
  try {
    return await fn();
  } finally {
    await clearTerrain(bot, anchor, fixture);
  }
}

// ── Fixtures from ASCII scenarios (top-down view) ──────────────────
//
// Grid is 5x5. B = bot at (0,0). Row 0 = north (-Z), col 0 = west (-X).
// Each 'P' = 1x2x1 stone pillar (y=0 and y=1).

const BOT_COL = 2;
const BOT_ROW = 2;

function pillar(x: number, z: number): BlockSpec[] {
  return [
    { pos: [x, 0, z], type: "stone" },
    { pos: [x, 1, z], type: "stone" },
  ];
}

function p(col: number, row: number): BlockSpec[] {
  return pillar(col - BOT_COL, row - BOT_ROW);
}

// ── Convenience namespace ────────────────────────────────────────────

export const terrain = {
  place: placeTerrain,
  clear: clearTerrain,
  with: withTerrain,
};
