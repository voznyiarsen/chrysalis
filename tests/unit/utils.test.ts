/**
 * @fileoverview Unit tests for pupa/src/utils.ts.
 * Tests AABB collision detection, projectile trajectory prediction, and fall damage calculations.
 */

import { AABB, UtilsManager } from "../../src/utils";
import { Vec3 } from "vec3";

describe("AABB - Collision Detection", () => {
  describe("constructor and basic properties", () => {
    test("creates an AABB with correct bounds", () => {
      const box = new AABB(0, 0, 0, 1, 2, 1);
      expect(box.minX).toBe(0);
      expect(box.minY).toBe(0);
      expect(box.minZ).toBe(0);
      expect(box.maxX).toBe(1);
      expect(box.maxY).toBe(2);
      expect(box.maxZ).toBe(1);
    });
  });

  describe("offset", () => {
    test("translates the AABB by given deltas", () => {
      const box = new AABB(0, 0, 0, 1, 1, 1);
      const moved = box.offset(2, 3, 4);
      expect(moved.minX).toBe(2);
      expect(moved.minY).toBe(3);
      expect(moved.minZ).toBe(4);
      expect(moved.maxX).toBe(3);
      expect(moved.maxY).toBe(4);
      expect(moved.maxZ).toBe(5);
    });

    test("does not mutate original AABB", () => {
      const box = new AABB(0, 0, 0, 1, 1, 1);
      box.offset(5, 5, 5);
      expect(box.minX).toBe(0);
    });
  });

  describe("extend", () => {
    test("extends AABB in positive direction", () => {
      const box = new AABB(0, 0, 0, 1, 1, 1);
      const ext = box.extend(2, 0, 0);
      expect(ext.minX).toBe(0);
      expect(ext.maxX).toBe(3);
    });

    test("extends AABB in negative direction", () => {
      const box = new AABB(0, 0, 0, 1, 1, 1);
      const ext = box.extend(-2, 0, 0);
      expect(ext.minX).toBe(-2);
      expect(ext.maxX).toBe(1);
    });

    test("extends in all directions", () => {
      const box = new AABB(0, 0, 0, 1, 1, 1);
      const ext = box.extend(-1, 1, -1);
      expect(ext.minX).toBe(-1);
      expect(ext.maxX).toBe(1);
      expect(ext.minY).toBe(0);
      expect(ext.maxY).toBe(2);
      expect(ext.minZ).toBe(-1);
      expect(ext.maxZ).toBe(1);
    });
  });

  describe("expand", () => {
    test("expands uniformly on all sides", () => {
      const box = new AABB(1, 1, 1, 3, 3, 3);
      const expanded = box.expand(0.5);
      expect(expanded.minX).toBe(0.5);
      expect(expanded.minY).toBe(0.5);
      expect(expanded.minZ).toBe(0.5);
      expect(expanded.maxX).toBe(3.5);
      expect(expanded.maxY).toBe(3.5);
      expect(expanded.maxZ).toBe(3.5);
    });
  });

  describe("intersects", () => {
    test("two overlapping AABBs intersect", () => {
      const a = new AABB(0, 0, 0, 2, 2, 2);
      const b = new AABB(1, 1, 1, 3, 3, 3);
      expect(a.intersects(b)).toBe(true);
    });

    test("two non-overlapping AABBs do not intersect", () => {
      const a = new AABB(0, 0, 0, 1, 1, 1);
      const b = new AABB(2, 2, 2, 3, 3, 3);
      expect(a.intersects(b)).toBe(false);
    });

    test("adjacent AABBs with exact boundary do not intersect (EPS threshold)", () => {
      const a = new AABB(0, 0, 0, 1, 1, 1);
      const b = new AABB(1, 0, 0, 2, 1, 1);
      expect(a.intersects(b)).toBe(false);
    });

    test("identical AABBs intersect", () => {
      const a = new AABB(0, 0, 0, 1, 1, 1);
      const b = new AABB(0, 0, 0, 1, 1, 1);
      expect(a.intersects(b)).toBe(true);
    });

    test("one AABB fully inside another intersects", () => {
      const outer = new AABB(0, 0, 0, 5, 5, 5);
      const inner = new AABB(1, 1, 1, 2, 2, 2);
      expect(outer.intersects(inner)).toBe(true);
    });
  });

  describe("calculateXOffset", () => {
    test("returns dx unchanged when no Y overlap", () => {
      const player = new AABB(0, 0, 0, 0.6, 1.8, 0.6);
      const block = new AABB(0, 2, 0, 1, 3, 1);
      expect(player.calculateXOffset(block, 0.5)).toBe(0.5);
    });

    test("returns dx unchanged when no Z overlap", () => {
      const player = new AABB(0, 0, 0, 0.6, 1.8, 0.6);
      const block = new AABB(0.6, 0, 2, 1.6, 1, 3);
      expect(player.calculateXOffset(block, 0.5)).toBe(0.5);
    });

    test("stops at block edge when moving right into block", () => {
      const player = new AABB(0, 0, 0, 0.6, 1.8, 0.6);
      const block = new AABB(0.6, 0, 0, 1.6, 1, 1);
      const dx = player.calculateXOffset(block, 0.5);
      expect(dx).toBeCloseTo(0);
    });

    test("stops at block edge when moving left into block", () => {
      const player = new AABB(1, 0, 0, 1.6, 1.8, 0.6);
      const block = new AABB(0, 0, 0, 1, 1, 1);
      const dx = player.calculateXOffset(block, -0.5);
      expect(dx).toBeCloseTo(0);
    });

    test("returns full dx when no collision", () => {
      const player = new AABB(0, 0, 0, 0.6, 1.8, 0.6);
      const block = new AABB(3, 0, 0, 4, 1, 1);
      expect(player.calculateXOffset(block, 0.5)).toBe(0.5);
    });

    test("respects margin parameter", () => {
      const player = new AABB(0, 0, 0, 0.6, 1.8, 0.6);
      const block = new AABB(0.6, 0.1, 0, 1.6, 1, 1);
      const dx = player.calculateXOffset(block, 0.5, 0);
      expect(dx).toBeCloseTo(0);
    });
  });

  describe("calculateYOffset", () => {
    test("returns dy unchanged when no X overlap", () => {
      const player = new AABB(0, 0, 0, 0.6, 1.8, 0.6);
      const block = new AABB(3, 0, 0, 4, 1, 1);
      expect(player.calculateYOffset(block, -0.5)).toBe(-0.5);
    });

    test("returns dy unchanged when no Z overlap", () => {
      const player = new AABB(0, 0, 0, 0.6, 1.8, 0.6);
      const block = new AABB(0, 0, 3, 1, 1, 4);
      expect(player.calculateYOffset(block, -0.5)).toBe(-0.5);
    });

    test("stops at block floor when falling onto block", () => {
      const player = new AABB(0, 1, 0, 0.6, 2.8, 0.6);
      const block = new AABB(0, 0, 0, 1, 1, 1);
      const dy = player.calculateYOffset(block, -0.5);
      expect(dy).toBeCloseTo(0);
    });

    test("stops at block ceiling when jumping into block", () => {
      const player = new AABB(0, 0, 0, 0.6, 1.8, 0.6);
      const block = new AABB(0, 1.8, 0, 1, 2.8, 1);
      const dy = player.calculateYOffset(block, 0.5);
      expect(dy).toBeCloseTo(0);
    });
  });

  describe("calculateZOffset", () => {
    test("returns dz unchanged when no X overlap", () => {
      const player = new AABB(0, 0, 0, 0.6, 1.8, 0.6);
      const block = new AABB(3, 0, 0, 4, 1, 1);
      expect(player.calculateZOffset(block, 0.5)).toBe(0.5);
    });

    test("returns dz unchanged when no Y overlap", () => {
      const player = new AABB(0, 0, 0, 0.6, 1.8, 0.6);
      const block = new AABB(0, 3, 0, 1, 4, 1);
      expect(player.calculateZOffset(block, 0.5)).toBe(0.5);
    });

    test("stops at block edge when moving positive Z into block", () => {
      const player = new AABB(0, 0, 0, 0.6, 1.8, 0.6);
      const block = new AABB(0, 0, 0.6, 1, 1, 1.6);
      const dz = player.calculateZOffset(block, 0.5);
      expect(dz).toBeCloseTo(0);
    });

    test("stops at block edge when moving negative Z into block", () => {
      const player = new AABB(0, 0, 1, 0.6, 1.8, 1.6);
      const block = new AABB(0, 0, 0, 1, 1, 1);
      const dz = player.calculateZOffset(block, -0.5);
      expect(dz).toBeCloseTo(0);
    });
  });
});

describe("Fall Damage Calculations", () => {
  let utilsManager: any;

  beforeAll(() => {
    const mockBot: any = {
      version: "1.12.2",
      registry: { blocksByName: {} },
      entity: { effects: {} },
      blockAt: () => null,
    };
    utilsManager = new UtilsManager(mockBot);
  });

  test("falls of 3 blocks or less deal 0 damage", () => {
    expect(utilsManager.getFallDamage(0)).toBe(0);
    expect(utilsManager.getFallDamage(1)).toBe(0);
    expect(utilsManager.getFallDamage(2)).toBe(0);
    expect(utilsManager.getFallDamage(3)).toBe(0);
  });

  test("falls of 4 blocks deal 1 damage", () => {
    expect(utilsManager.getFallDamage(4)).toBe(1);
  });

  test("falls of 10 blocks deal 7 damage", () => {
    expect(utilsManager.getFallDamage(10)).toBe(7);
  });

  test("falls of 23 blocks deal 20 damage (typically fatal)", () => {
    expect(utilsManager.getFallDamage(23)).toBe(20);
  });

  test("falls of 100 blocks deal 97 damage", () => {
    expect(utilsManager.getFallDamage(100)).toBe(97);
  });

  test("falls at exactly safe distance (3.0) deal 0 damage", () => {
    expect(utilsManager.getFallDamage(3.0)).toBe(0);
  });

  test("falls slightly above safe distance (3.1) deal 0 damage due to floor", () => {
    expect(utilsManager.getFallDamage(3.1)).toBe(0);
  });

  test("falls at 4.0 deal exactly 1 damage", () => {
    expect(utilsManager.getFallDamage(4.0)).toBe(1);
  });

  test("negative fall distance returns 0 damage", () => {
    expect(utilsManager.getFallDamage(-1)).toBe(0);
    expect(utilsManager.getFallDamage(-100)).toBe(0);
  });
});

describe("Projectile Trajectory Prediction", () => {
  let utilsManager: any;

  beforeAll(() => {
    const mockBot: any = {
      version: "1.12.2",
      registry: { blocksByName: {} },
      entity: { effects: {} },
      blockAt: () => null,
    };
    utilsManager = new UtilsManager(mockBot);
  });

  test("return empty array for unreachable target (too far/steep)", () => {
    const source = { x: 0, y: 0, z: 0 };
    const target = { x: 100, y: 50, z: 0 };
    const pitches = utilsManager.getProjectilePitch(source, target, 1.5, 0.03);
    expect(pitches).toEqual([]);
  });

  test("returns two pitches for reachable target with ender pearl params", () => {
    const source = { x: 0, y: 0, z: 0 };
    const target = { x: 10, y: 0, z: 0 };
    const pitches = utilsManager.getProjectilePitch(
      source,
      target,
      1.5,
      0.03,
      0.99,
    );
    expect(pitches.length).toBe(2);
    expect(pitches[0]).toBeLessThan(pitches[1]);
  });

  test("returns two distinct arcs for reachable target", () => {
    const source = { x: 0, y: 0, z: 0 };
    const target = { x: 10, y: 0, z: 0 };
    const pitches = utilsManager.getProjectilePitch(
      source,
      target,
      1.5,
      0.03,
      0.99,
    );
    expect(pitches.length).toBe(2);
    expect(pitches[0]).not.toBe(pitches[1]);
  });

  test("handles vertical target (dx = 0) correctly", () => {
    const source = { x: 0, y: 0, z: 0 };
    const target = { x: 0, y: 5, z: 0 };
    const pitches = utilsManager.getProjectilePitch(source, target, 5, 0.03);
    expect(Array.isArray(pitches)).toBe(true);
  });

  test("drag parameter affects refined pitch values", () => {
    const source = { x: 0, y: 0, z: 0 };
    const target = { x: 10, y: 0, z: 0 };

    const pitchesNoDrag = utilsManager.getProjectilePitch(
      source,
      target,
      1.5,
      0.03,
      1.0,
    );
    const pitchesWithDrag = utilsManager.getProjectilePitch(
      source,
      target,
      1.5,
      0.03,
      0.99,
    );

    if (pitchesNoDrag.length > 0 && pitchesWithDrag.length > 0) {
      expect(pitchesNoDrag[0]).not.toBeCloseTo(pitchesWithDrag[0], 1);
    }
  });
});

describe("getBestPearlTrajectory", () => {
  let utilsManager: any;
  let mockBot: any;

  beforeAll(() => {
    mockBot = {
      version: "1.12.2",
      registry: { blocksByName: {} },
      entity: { effects: {} },
      blockAt: () => null,
      entities: {},
    };
    utilsManager = new UtilsManager(mockBot);
  });

  test("returns a result for a reachable target with clear path", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(10, 0, 0);
    const result = utilsManager.getBestPearlTrajectory(
      source,
      target,
      1.5, // velocity
      0.03, // gravity
      0.99, // drag
      1.5, // tolerance radius
      1.0, // step
    );
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("pitch");
    expect(result).toHaveProperty("arc");
    expect(result).toHaveProperty("flightTime");
    expect(result).toHaveProperty("landingPoint");
    expect(result).toHaveProperty("landingDist");
    // The landing point should be within 2.5 blocks of the target
    // (tolerance radius 1.5 + end-trigger radius 1.0)
    expect(result!.landingDist).toBeLessThanOrEqual(2.6);
  });

  test("returns null for unreachable target (too far/too steep)", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(100, 50, 0);
    const result = utilsManager.getBestPearlTrajectory(
      source,
      target,
      1.5,
      0.03,
      0.99,
      1.5,
      1.0,
    );
    expect(result).toBeNull();
  });

  test("tolerance sphere allows hitting near the target when direct path is blocked", () => {
    // Create a mock where blockAt returns blocks near the direct target
    // but clear for offset targets within tolerance
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(10, 0, 0);

    const originalBlockAt = mockBot.blockAt;
    const blockPos = new Vec3(10, 0, 0);
    const solidBlock = {
      boundingBox: "block",
      shapes: [[0, 0, 0, 1, 1, 1]],
      position: blockPos,
    };

    mockBot.blockAt = (pos: any) => {
      // Block positions near the direct target
      const dist = Math.sqrt(
        (pos.x - 10) ** 2 + (pos.y - 0) ** 2 + (pos.z - 0) ** 2,
      );
      if (dist < 2.0) return solidBlock;
      return null;
    };

    const result = utilsManager.getBestPearlTrajectory(
      source,
      target,
      1.5,
      0.03,
      0.99,
      1.5,
      1.0,
    );

    mockBot.blockAt = originalBlockAt;

    // Should find an alternative path via tolerance sampling
    expect(result).not.toBeNull();
    if (result) {
      expect(result.landingDist).toBeLessThanOrEqual(2.6);
    }
  });

  test("returns null when all paths (including tolerance samples) are blocked", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(10, 0, 0);

    // Mock bot.blockAt to return a solid block everywhere.
    // The block has a huge shape so isPointInBlock always returns true.
    const mockBlock = {
      boundingBox: "block",
      shapes: [[-1000, -1000, -1000, 1000, 1000, 1000]],
      position: new Vec3(0, 0, 0),
    };
    const originalBlockAt = mockBot.blockAt;
    mockBot.blockAt = () => mockBlock;

    const result = utilsManager.getBestPearlTrajectory(
      source,
      target,
      1.5,
      0.03,
      0.99,
      1.5,
      1.0,
    );

    mockBot.blockAt = originalBlockAt;

    expect(result).toBeNull();
  });

  test("selects low arc over high arc when both are clear (low arc is faster)", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(15, 0, 0);

    const result = utilsManager.getBestPearlTrajectory(
      source,
      target,
      1.5,
      0.03,
      0.99,
      1.5,
      1.0,
    );

    expect(result).not.toBeNull();
    // Low arc is the default fastest choice when unobstructed
    expect(result!.arc).toBe("low");
  });
});

describe("Trajectory Calculation - Sanity Check", () => {
  // Sanity values for v=2.97 m/tick, g=0.03 m/tick², drag=0.99
  // Source and target are at the same Y level (flat ground)
  const sanityData: Array<{
    distance: number;
    lowOffset: number;
    highOffset: number;
  }> = [
    { distance: 5, lowOffset: 0.017, highOffset: 236.584 },
    { distance: 10, lowOffset: 0.123, highOffset: 236.371 },
    { distance: 15, lowOffset: 0.318, highOffset: 236.016 },
    { distance: 20, lowOffset: 0.608, highOffset: 235.517 },
    { distance: 25, lowOffset: 0.996, highOffset: 234.873 },
    { distance: 30, lowOffset: 1.486, highOffset: 234.082 },
    { distance: 35, lowOffset: 2.082, highOffset: 233.142 },
    { distance: 40, lowOffset: 2.79, highOffset: 232.048 },
    { distance: 45, lowOffset: 3.615, highOffset: 230.797 },
    { distance: 50, lowOffset: 4.562, highOffset: 229.385 },
  ];

  const mockBot: any = {
    entity: {
      position: new Vec3(0, 0, 0),
    },
    version: "1.12.2",
    registry: {
      blocksByName: {},
    },
    chat: null,
  };
  const utils = new UtilsManager(mockBot);
  const source = new Vec3(0, 0, 0);
  const v = 2.97;
  const g = 0.03;
  const drag = 0.99;

  for (const {
    distance,
    lowOffset: expectedLow,
    highOffset: expectedHigh,
  } of sanityData) {
    const target = new Vec3(distance, 0, 0);

    test(`low arc offset for ${distance}m flat target`, () => {
      const offset = utils.getProjectileOffset(
        source,
        target,
        v,
        g,
        drag,
        "low",
      );
      expect(offset).toBeCloseTo(expectedLow, 2);
    });

    test(`high arc offset for ${distance}m flat target`, () => {
      const offset = utils.getProjectileOffset(
        source,
        target,
        v,
        g,
        drag,
        "high",
      );
      expect(offset).toBeCloseTo(Math.round(expectedHigh * 1000) / 1000, 2);
    });
  }

  test("low arc offset is always smaller than high arc offset", () => {
    for (const { distance } of sanityData) {
      const target = new Vec3(distance, 0, 0);
      const low = utils.getProjectileOffset(source, target, v, g, drag, "low");
      const high = utils.getProjectileOffset(
        source,
        target,
        v,
        g,
        drag,
        "high",
      );
      expect(low).toBeLessThan(high);
    }
  });

  test("all offsets are positive (aiming above target)", () => {
    for (const { distance } of sanityData) {
      const target = new Vec3(distance, 0, 0);
      const low = utils.getProjectileOffset(source, target, v, g, drag, "low");
      const high = utils.getProjectileOffset(
        source,
        target,
        v,
        g,
        drag,
        "high",
      );
      expect(low).toBeGreaterThan(0);
      expect(high).toBeGreaterThan(0);
    }
  });

  test("getProjectileOffset properly handles unreachable targets and various distances", () => {
    const mockBot: any = {
      entity: {
        position: new Vec3(0, 0, 0),
      },
      version: "1.12.2",
      registry: {
        blocksByName: {},
      },
      chat: null,
    };

    const utils = new UtilsManager(mockBot);

    const source = new Vec3(0, 0, 0);
    const v = 2.97;
    const g = 0.03;

    // Test that unreachable targets throw error
    const unreachableTarget = new Vec3(1000, 0, 0); // Too far
    expect(() => {
      utils.getProjectileOffset(source, unreachableTarget, v, g, 1, "low");
    }).toThrow("Target is unreachable");

    // Test different distances
    const distances = [5, 10, 15, 20];
    for (const distance of distances) {
      const testTarget = new Vec3(distance, 0, 0);

      // Should not throw for reasonable distances
      const lowOffset = utils.getProjectileOffset(
        testTarget,
        source,
        v,
        g,
        1,
        "low",
      );
      expect(typeof lowOffset).toBe("number");
      expect(isFinite(lowOffset)).toBe(true);

      const highOffset = utils.getProjectileOffset(
        testTarget,
        source,
        v,
        g,
        1,
        "high",
      );
      expect(typeof highOffset).toBe("number");
      expect(isFinite(highOffset)).toBe(true);
    }
  });
});

describe("AABB.sweptTOI", () => {
  test("returns null when boxes are separated and stationary on an axis", () => {
    const box = new AABB(0, 0, 0, 1, 1, 1);
    const block = new AABB(5, 0, 0, 6, 1, 1);
    expect(box.sweptTOI(new Vec3(0, 0, 0), block)).toBeNull();
  });

  test("returns null when motion is away from block", () => {
    const box = new AABB(0, 0, 0, 1, 1, 1);
    const block = new AABB(3, 0, 0, 4, 1, 1);
    expect(box.sweptTOI(new Vec3(-1, 0, 0), block)).toBeNull();
  });

  test("returns 0 when already overlapping at start", () => {
    const box = new AABB(0, 0, 0, 1, 1, 1);
    const block = new AABB(0.5, 0, 0, 1.5, 1, 1);
    expect(box.sweptTOI(new Vec3(0, 0, 0), block)).toBe(0);
  });

  test("returns correct TOI for head-on X collision", () => {
    // box center at 0.5, block center at 3.5
    // combined half-widths on X: 0.5 + 0.5 = 1.0
    // dx = 0.5 - 3.5 = -3.0
    // entry: t1 = (-1.0 - (-3.0)) / 2.5 = 0.8
    // exit:  t2 = (1.0 - (-3.0)) / 2.5 = 1.6
    // TOI = 0.8
    const box = new AABB(0, 0, 0, 1, 1, 1);
    const block = new AABB(3, 0, 0, 4, 1, 1);
    const toi = box.sweptTOI(new Vec3(2.5, 0, 0), block);
    expect(toi).not.toBeNull();
    expect(toi!).toBeCloseTo(0.8, 5);
  });

  test("returns TOI < 1 for collision mid-tick", () => {
    // box center at 0.5, block center at 2.0
    // combined half-widths on X: 0.5 + 0.5 = 1.0
    // entry distance: 2.0 - 0.5 - 1.0 = 0.5
    // at speed 2.0, TOI = 0.5 / 2.0 = 0.25
    const box = new AABB(0, 0, 0, 1, 1, 1);
    const block = new AABB(1.5, 0, 0, 2.5, 1, 1);
    const toi = box.sweptTOI(new Vec3(2, 0, 0), block);
    expect(toi).not.toBeNull();
    expect(toi!).toBeCloseTo(0.25, 5);
  });

  test("returns null for diagonal miss near corner", () => {
    // box at origin moving diagonally, block is far on both X and Z
    // combined half-extents: 0.5 + 0.5 = 1.0 on each axis
    // box center (0.5, 0.5), block center (3.5, 3.5)
    // dx = 0.5 - 3.5 = -3.0, hx = 1.0
    // On X: t1 = (-1.0 - (-3.0)) / 1 = 2.0, t2 = (1.0 - (-3.0)) / 1 = 4.0
    // On Z: same as X
    // tEntry = max(2.0, 2.0) = 2.0 > 1 → null
    const box = new AABB(0, 0, 0, 1, 1, 1);
    const block = new AABB(3, 0, 3, 4, 1, 4);
    expect(box.sweptTOI(new Vec3(1, 0, 1), block)).toBeNull();
  });

  test("handles zero velocity on all axes (already separated)", () => {
    const box = new AABB(0, 0, 0, 1, 1, 1);
    const block = new AABB(0, 5, 0, 1, 6, 1);
    expect(box.sweptTOI(new Vec3(0, 0, 0), block)).toBeNull();
  });

  test("handles zero velocity on all axes (overlapping)", () => {
    const box = new AABB(0, 0, 0, 1, 1, 1);
    const block = new AABB(0, 0, 0, 1, 1, 1);
    expect(box.sweptTOI(new Vec3(0, 0, 0), block)).toBe(0);
  });

  test("collision on Y axis only (falling onto block)", () => {
    // box center at (0.5, 2.0), block center at (0.5, 0.5)
    // combined half-heights: 0.5 + 0.5 = 1.0
    // dy = 2.0 - 0.5 = 1.5, hy = 1.0
    // falling at speed -2.0:
    //   t1 = (-1.0 - 1.5) / -2 = 1.25
    //   t2 = (1.0 - 1.5) / -2 = 0.25
    //   tEntry = max(0.25, ...) on Y, but X and Z are overlapping (0 vel)
    const box = new AABB(0, 1.5, 0, 1, 2.5, 1);
    const block = new AABB(0, 0, 0, 1, 1, 1);
    const toi = box.sweptTOI(new Vec3(0, -2, 0), block);
    expect(toi).not.toBeNull();
    expect(toi!).toBeCloseTo(0.25, 5);
  });

  test("returns null when collision happens after this tick", () => {
    const box = new AABB(0, 0, 0, 1, 1, 1);
    const block = new AABB(10, 0, 0, 11, 1, 1);
    // speed 1.0, need to travel 8.5 units → TOI = 8.5 > 1
    expect(box.sweptTOI(new Vec3(1, 0, 0), block)).toBeNull();
  });
});
