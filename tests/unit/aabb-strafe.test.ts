/**
 * @fileoverview Unit tests for AABB-aware strafing functions.
 * Tests isPositionClear, findWalkableSurface, and getStrafePoint
 * with respect to the bot's 0.6x1.8x0.6 bounding box.
 */

import { Vec3 } from "vec3";
import {
  isPositionClear,
  getStrafePoint,
  findWalkableSurface,
} from "../../src/movement";
import { Constants } from "../../src/constants";

// ── Helpers ──────────────────────────────────────────────────────────────

interface MockBlock {
  name: string;
  boundingBox: string;
  shapes: number[][];
}

function solid(shapes = [[0, 0, 0, 1, 1, 1]]): MockBlock {
  return { name: "stone", boundingBox: "block", shapes };
}

function empty(): MockBlock {
  return { name: "air", boundingBox: "empty", shapes: [] };
}

/**
 * Create a blockAt function from a 3D grid map.
 * grid[y][z][x] - array of layers, each layer is rows, each row is cells.
 * Returns solid/empty blocks for the grid, air for everything else.
 */
function makeBlockAt(
  grid: MockBlock[][][],
  originX = 0,
  originY = 0,
  originZ = 0,
) {
  return (pos: Vec3) => {
    const x = Math.floor(pos.x) - originX;
    const y = Math.floor(pos.y) - originY;
    const z = Math.floor(pos.z) - originZ;
    if (y < 0 || y >= grid.length) return empty();
    if (z < 0 || z >= grid[y].length) return empty();
    if (x < 0 || x >= grid[y][z].length) return empty();
    return grid[y][z][x] || empty();
  };
}

// ── isPositionClear ─────────────────────────────────────────────────────

describe("isPositionClear", () => {
  test("returns true on flat ground with no adjacent blocks", () => {
    const blockAt = makeBlockAt([[[solid()]], [[empty()]]]);
    const pos = new Vec3(0.5, 1, 0.5);
    expect(isPositionClear(pos, blockAt)).toBe(true);
  });

  test("returns false when body overlaps a wall to the side", () => {
    const blockAt = makeBlockAt([[[solid(), solid()]], [[empty(), solid()]]]);
    // Position at x=0.85 - body extends to x=1.15, overlapping the wall at x=1
    const pos = new Vec3(0.85, 1, 0.5);
    expect(isPositionClear(pos, blockAt)).toBe(false);
  });

  test("returns true when touching but not overlapping (strict inequality)", () => {
    const blockAt = makeBlockAt([[[solid(), solid()]], [[empty(), empty()]]]);
    // Position at x=0.7 - body extends to x=1.0, exactly touching the wall
    const pos = new Vec3(0.7, 1, 0.5);
    expect(isPositionClear(pos, blockAt)).toBe(true);
  });

  test("returns false when head overlaps a block above", () => {
    const blockAt = makeBlockAt([[[solid()]], [[solid()]]]);
    // Position feet at y=1 - body extends to y=2.8, overlapping block at y=1
    const pos = new Vec3(0.5, 1, 0.5);
    expect(isPositionClear(pos, blockAt)).toBe(false);
  });

  test("returns true with clearance above head", () => {
    const blockAt = makeBlockAt([[[solid()]], [[empty()]], [[empty()]]]);
    // Position feet at y=1 - body extends to y=2.8, clear of any blocks
    const pos = new Vec3(0.5, 1, 0.5);
    expect(isPositionClear(pos, blockAt)).toBe(true);
  });

  test("returns false when body overlaps diagonal block", () => {
    const blockAt = makeBlockAt([
      [
        [solid(), empty()],
        [empty(), empty()],
      ],
      [
        [empty(), empty()],
        [empty(), solid()],
      ],
    ]);
    // Position at x=0.8, z=0.8 - body extends to x=1.1, z=1.1, overlapping diagonal
    const pos = new Vec3(0.8, 1, 0.8);
    expect(isPositionClear(pos, blockAt)).toBe(false);
  });

  test("returns true when body is fully in empty space", () => {
    const blockAt = makeBlockAt([[[empty()]], [[empty()]], [[empty()]]]);
    const pos = new Vec3(0.5, 1, 0.5);
    expect(isPositionClear(pos, blockAt)).toBe(true);
  });
});

// ── findWalkableSurface ──────────────────────────────────────────────────

describe("findWalkableSurface", () => {
  test("returns correct Y for full block", () => {
    const blockAt = makeBlockAt([[[solid()]], [[empty()]]]);
    const surface = findWalkableSurface(0.5, 0.5, 0, blockAt);
    expect(surface).not.toBeNull();
    expect(surface!.y).toBe(1);
  });

  test("returns null when no AABB clearance above surface", () => {
    // Solid blocks from y=-4 to y=4 (no room for 1.8-tall bot anywhere)
    // Use targetY=-4 so scan starts at 0 (targetY + STRAFE_JUMP_DISTANCE = -4+4=0)
    const blockAt = makeBlockAt([
      [[solid()]],
      [[solid()]],
      [[solid()]],
      [[solid()]],
      [[solid()]],
      [[solid()]],
      [[solid()]],
      [[solid()]],
      [[solid()]],
    ]);
    const surface = findWalkableSurface(0.5, 0.5, -4, blockAt);
    expect(surface).toBeNull();
  });

  test("returns surface when adjacent block is below body height", () => {
    const blockAt = makeBlockAt([[[solid(), solid()]], [[empty(), solid()]]]);
    // At x=0.5, z=0.5 - body extends to x=0.8, clear of wall at x=1
    const surface = findWalkableSurface(0.5, 0.5, 0, blockAt);
    expect(surface).not.toBeNull();
    expect(surface!.y).toBe(1);
  });

  test("returns null when adjacent wall clips body", () => {
    const blockAt = makeBlockAt([[[solid(), solid()]], [[empty(), solid()]]]);
    // At x=0.85, z=0.5 - body extends to x=1.15, overlapping wall at x=1
    const surface = findWalkableSurface(0.85, 0.5, 0, blockAt);
    expect(surface).toBeNull();
  });
});

// ── getStrafePoint ──────────────────────────────────────────────────────

describe("getStrafePoint with AABB clearance", () => {
  function mockIsJumpPathClear(_a: Vec3, _b: Vec3): boolean {
    return true;
  }

  test("rejects point where body would overlap adjacent wall", () => {
    // 4x4 floor with wall along x=2 (blocking all candidates near target)
    const blockAt = makeBlockAt([
      [
        [solid(), solid(), solid(), solid()],
        [solid(), solid(), solid(), solid()],
        [solid(), solid(), solid(), solid()],
        [solid(), solid(), solid(), solid()],
      ],
      [
        [empty(), empty(), empty(), empty()],
        [empty(), empty(), empty(), empty()],
        [empty(), empty(), empty(), empty()],
        [empty(), empty(), solid(), solid()],
      ],
    ]);
    const source = new Vec3(1.5, 1, 1.5);
    const target = new Vec3(1.5, 1, 3.0);
    const result = getStrafePoint(
      source,
      new Vec3(1.5, 1, 2.5),
      target,
      blockAt,
      mockIsJumpPathClear,
      [],
      Constants.MOVEMENT.STRAFE_HISTORY_SIZE,
    );
    // All candidates near target at z=3 are blocked by wall at z=3 (x=2,3)
    // Candidates at z=2.5 are clear but may not score well
    // The key is that no candidate should have body overlapping the wall
    if (result) {
      // If a result is found, verify it is AABB-clear
      const halfWidth = Constants.PHYSICS.PLAYER_OFFSET;
      const height = Constants.PHYSICS.PLAYER_HEIGHT;
      const minX = Math.floor(result.x - halfWidth);
      const maxX = Math.floor(result.x + halfWidth);
      const minY = Math.floor(result.y);
      const maxY = Math.floor(result.y + height);
      const minZ = Math.floor(result.z - halfWidth);
      const maxZ = Math.floor(result.z + halfWidth);
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          for (let z = minZ; z <= maxZ; z++) {
            const block = blockAt(new Vec3(x, y, z));
            if (block.boundingBox !== "empty") {
              // Allow the floor block below the bot
              if (y < result.y) continue;
              throw new Error(
                `Result at ${result.x},${result.y},${result.z} overlaps block at ${x},${y},${z}`,
              );
            }
          }
        }
      }
    }
  });

  test("accepts point with full AABB clearance", () => {
    const blockAt = makeBlockAt([
      [
        [solid(), solid(), solid()],
        [solid(), solid(), solid()],
        [solid(), solid(), solid()],
      ],
      [
        [empty(), empty(), empty()],
        [empty(), empty(), empty()],
        [empty(), empty(), empty()],
      ],
    ]);
    const source = new Vec3(1.5, 1, 1.5);
    const target = new Vec3(1.5, 1, 1.5);
    const result = getStrafePoint(
      source,
      new Vec3(0.5, 1, 0.5),
      target,
      blockAt,
      mockIsJumpPathClear,
      [],
      Constants.MOVEMENT.STRAFE_HISTORY_SIZE,
    );
    expect(result).not.toBeNull();
    expect(result!.y).toBe(1);
  });
});
