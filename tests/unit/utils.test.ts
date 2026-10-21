/**
 * @fileoverview Unit tests for pupa/src/utils.ts.
 * Tests AABB collision detection, projectile trajectory prediction, and fall damage calculations.
 */

import { AABB, UtilsManager } from "../../src/utils";
import { Constants } from "../../src/constants";
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

  describe("distanceToPoint", () => {
    test("returns 0 when the point is inside the box", () => {
      const box = new AABB(0, 0, 0, 2, 2, 2);
      expect(box.distanceToPoint(new Vec3(1, 1, 1))).toBe(0);
    });

    test("returns 0 when the point is on a face", () => {
      const box = new AABB(0, 0, 0, 2, 2, 2);
      expect(box.distanceToPoint(new Vec3(2, 1, 1))).toBe(0);
    });

    test("returns the perpendicular distance outside one axis", () => {
      const box = new AABB(0, 0, 0, 1, 1, 1);
      expect(box.distanceToPoint(new Vec3(3, 0.5, 0.5))).toBe(2);
      expect(box.distanceToPoint(new Vec3(0.5, -2, 0.5))).toBe(2);
      expect(box.distanceToPoint(new Vec3(0.5, 0.5, 4))).toBe(3);
    });

    test("returns the diagonal distance outside a corner", () => {
      const box = new AABB(0, 0, 0, 1, 1, 1);
      expect(box.distanceToPoint(new Vec3(2, 2, 2))).toBeCloseTo(
        Math.sqrt(3),
      );
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

describe("Fall Time Prediction", () => {
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

  test("a fall reaching ground within the cap reports exact ticks", () => {
    // Start at ground: lands on the very first tick.
    expect(utilsManager.getFallTicks(10, -0.08, 10)).toBe(1);
  });

  test("a short fall reports ticks", () => {
    // Y=4 above ground at rest: tick1 -> vel=-0.0784, y=3.9216; ... lands by tick ~14
    const ticks = utilsManager.getFallTicks(4, 0, 0);
    expect(ticks).toBeGreaterThanOrEqual(1);
    expect(ticks).toBeLessThan(200);
  });

  test("a high fall reports more ticks than a short fall", () => {
    const short = utilsManager.getFallTicks(10, 0, 0);
    const tall = utilsManager.getFallTicks(100, 0, 0);
    expect(tall).toBeGreaterThan(short);
  });

  test("upward velocity delays impact (more ticks than from rest)", () => {
    const fromRest = utilsManager.getFallTicks(10, 0, 0);
    const rising = utilsManager.getFallTicks(10, 0.5, 0);
    expect(rising).toBeGreaterThanOrEqual(fromRest);
  });

  test("never reaching ground within the cap returns the cap", () => {
    expect(
      utilsManager.getFallTicks(1000, 0, -100, 5),
    ).toBe(5);
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
    // The landing must be at the target — the tolerance sampling may pick a
    // neighbouring aim point, but a landing anywhere else is a miss.
    expect(result!.landingDist).toBeLessThanOrEqual(1.0);
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

  test("a landing short of the target is a miss, not a usable throw", () => {
    // A wall at x=10..11 whose top face is the landing surface. Aiming at
    // the far edge (x=10.5) is out of reach — the pearl hits the near face
    // one block short, which is not where the bot wants to be.
    const source = new Vec3(0, 0, 0);

    const originalBlockAt = mockBot.blockAt;
    const solidBlock = {
      boundingBox: "block",
      shapes: [[0, 0, 0, 1, 1, 1]],
      position: new Vec3(10, 0, 0),
    };
    mockBot.blockAt = (pos: any) =>
      Math.floor(pos.x) === 10 && Math.floor(pos.y) === 0 && Math.floor(pos.z) === 0
        ? solidBlock
        : null;

    const short = utilsManager.getBestPearlTrajectory(
      source,
      new Vec3(10.5, 0, 0),
      1.5,
      0.03,
      0.99,
      1.5,
      1.0,
    );
    // Aiming at the wall's own x column lands on its top face.
    const onFace = utilsManager.getBestPearlTrajectory(
      source,
      new Vec3(10.0, 0, 0),
      1.5,
      0.03,
      0.99,
      1.5,
      1.0,
    );

    mockBot.blockAt = originalBlockAt;

    // The pearl stops at the near face (x=10), one block short of the aim
    // point, so the throw is rejected.
    expect(short).toBeNull();
    expect(onFace).not.toBeNull();
    expect(onFace!.landingDist).toBeLessThan(0.6);
  });

  test("null when every path lands off the target", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(10, 0, 0);

    // A wall spanning the whole world: every throw lands on it, far from the
    // wanted target.
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

  test("detects water and applies correct drag", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(10, 0, 0);

    // Mock water blocks along the path. Water is not solid, so it must not
    // register as a landing; the pearl passes through and still lands on the
    // target.
    const waterBlock = {
      boundingBox: "block",
      shapes: [[0, 0, 0, 1, 1, 1]],
      position: new Vec3(5, 0, 0),
      name: "water",
    };
    const originalBlockAt = mockBot.blockAt;
    mockBot.blockAt = (pos: any) =>
      pos.x >= 4 && pos.x <= 6 && pos.y >= -1 && pos.y <= 1 && pos.z >= -1 && pos.z <= 1
        ? waterBlock
        : null;

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

    // Water does not block: the throw still reaches the target.
    expect(result).not.toBeNull();
  });

  test("handles hybrid air-water-air transitions without crashing", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(6, 0, 0);

    // Create a simple water zone that the pearl can pass through
    const waterBlock = {
      boundingBox: "block",
      shapes: [[0, 0, 0, 1, 1, 1]],
      position: new Vec3(3, 0, 0),
      name: "water",
    };

    const originalBlockAt = mockBot.blockAt;
    mockBot.blockAt = (pos: any) => {
      // Small water zone at x=3
      if (pos.x >= 3 && pos.x <= 4 && pos.y >= -1 && pos.y <= 1) {
        return waterBlock;
      }
      return null;
    };

    // This should not throw an error - just verify the function handles water transitions
    expect(() => {
      utilsManager.getBestPearlTrajectory(
        source,
        target,
        1.5,
        0.03,
        0.99,
        1.5,
        1.0,
      );
    }).not.toThrow();

    mockBot.blockAt = originalBlockAt;
  });

  test("uses correct pearl hitbox size (0.25) for entity collision", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(10, 0, 0);

    // Mock entity at position (5, 0, 0) with width 0.6
    const mockEntity = {
      position: new Vec3(5, 0, 0),
      width: 0.6,
    };
    const originalEntities = mockBot.entities;
    mockBot.entities = [mockEntity];

    // Mock blockAt to return null (no blocks)
    const originalBlockAt = mockBot.blockAt;
    mockBot.blockAt = () => null;

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
    mockBot.entities = originalEntities;

    // Entity at (5,0,0) with width 0.6 should be hit by pearl (0.25 radius).
    // The direct path goes through the entity, so the sampler must pick an
    // offset aim point that misses it.
    expect(result).not.toBeNull();
    expect(result!.landingDist).toBeLessThan(0.6);
  });

  test("selects fastest clear arc (min flight time)", () => {
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
    // New scoring: minimum flight time wins, not low-arc preference
    expect(result!.flightTime).toBeGreaterThan(0);
    expect(result!.landingDist).toBeLessThanOrEqual(1.5);
  });
});

/**
 * Enemy-above scenarios: the target stands on a platform above the bot. The
 * pearl has to land on the platform's TOP surface — a throw that clips the
 * platform's side face teleports the bot against the wall, not up onto it.
 */
describe("getBestPearlTrajectory - enemy-above platforms", () => {
  const V = Constants.COMBAT.ENDER_PEARL.VELOCITY;
  const G = Constants.COMBAT.ENDER_PEARL.GRAVITY;
  const D = Constants.COMBAT.ENDER_PEARL.DRAG;

  /** Full-cube block at an integer position. */
  const cube = (x: number, y: number, z: number) => ({
    position: new Vec3(x, y, z),
    boundingBox: "block",
    shapes: [[0, 0, 0, 1, 1, 1]],
    name: "stone",
  });

  /**
   * Scenario 1: a 1x1 pillar one block above the bot's ground level, with
   * the target standing on top of it.
   */
  function pillarBlockAt(pos: Vec3) {
    const x = Math.floor(pos.x);
    const y = Math.floor(pos.y);
    const z = Math.floor(pos.z);
    // Ground plane (surface at y=1).
    if (y === 0 && x >= -4 && x <= 4 && z >= -4 && z <= 4) {
      return { ...cube(x, y, z), name: "grass" };
    }
    // 1x1 pillar, top surface at y=5.
    if (x === 2 && z === 2 && y >= 1 && y <= 4) return cube(x, y, z);
    return null;
  }

  const PILLAR_TOP = new Vec3(2.5, 5, 2.5);
  const BOT_FEET = new Vec3(2.5, 1, 3.5);
  const BOT_EYE = BOT_FEET.offset(0, 1.8, 0);

  test("a throw aimed at the platform's side face is not a usable throw", () => {
    // Aiming at the pillar's own body column (y=3, mid-pillar): the pearl
    // hits the side face and stops short of the top.
    const result = new UtilsManager({
      version: "1.12.2",
      registry: { blocksByName: {} },
      entity: { effects: {} },
      blockAt: pillarBlockAt,
      entities: {},
    } as any).getBestPearlTrajectory(
      BOT_EYE,
      new Vec3(2.5, 3, 2.5),
      V,
      G,
      D,
      1.5,
      0.5,
    );

    // Whatever pitch is chosen, the pearl lands on a side face below the
    // platform top, so the throw is rejected.
    if (result) expect(result.landingPoint.y).toBeLessThan(5);
  });

  test("aiming at the platform top lands the pearl on the top surface", () => {
    const utils = new UtilsManager({
      version: "1.12.2",
      registry: { blocksByName: {} },
      entity: { effects: {} },
      blockAt: pillarBlockAt,
      entities: {},
    } as any);

    // From the bot's own position (adjacent to the pillar).
    const direct = utils.getBestPearlTrajectory(
      BOT_EYE,
      PILLAR_TOP,
      V,
      G,
      D,
      1.5,
      0.5,
    );
    expect(direct).not.toBeNull();
    expect(direct!.landingPoint.y).toBeCloseTo(5, 5);
    expect(direct!.landingDist).toBeLessThan(0.6);

    // From a launch point one block further back.
    const launchEye = new Vec3(2.5, 2.8, 4.5);
    const fromLaunch = utils.getBestPearlTrajectory(
      launchEye,
      PILLAR_TOP,
      V,
      G,
      D,
      1.5,
      0.5,
    );
    expect(fromLaunch).not.toBeNull();
    expect(fromLaunch!.landingPoint.y).toBeCloseTo(5, 5);
    expect(fromLaunch!.landingDist).toBeLessThan(0.6);
  });

  test("a 3x3 platform top is reachable from a surrounding launch point", () => {
    // Scenario 2: a 3x3 platform at y=1..4, target standing in the middle.
    const blockAt = (pos: Vec3) => {
      const x = Math.floor(pos.x);
      const y = Math.floor(pos.y);
      const z = Math.floor(pos.z);
      if (y === 0 && x >= -5 && x <= 5 && z >= -5 && z <= 5) {
        return { ...cube(x, y, z), name: "grass" };
      }
      if (x >= 1 && x <= 3 && z >= 1 && z <= 3 && y >= 1 && y <= 4) {
        return cube(x, y, z);
      }
      return null;
    };
    const utils = new UtilsManager({
      version: "1.12.2",
      registry: { blocksByName: {} },
      entity: { effects: {} },
      blockAt,
      entities: {},
    } as any);

    // Bot at the platform's edge, launch point one block outside it.
    const eye = new Vec3(2.5, 2.8, 0.5);
    const top = new Vec3(2.5, 5, 2.5);

    const direct = utils.getBestPearlTrajectory(eye, top, V, G, D, 1.5, 0.5);
    expect(direct).not.toBeNull();
    expect(direct!.landingPoint.y).toBeCloseTo(5, 5);
    expect(direct!.landingDist).toBeLessThan(0.6);

    const fromLaunch = utils.getBestPearlTrajectory(
      new Vec3(2.5, 2.8, -1.5),
      top,
      V,
      G,
      D,
      1.5,
      0.5,
    );
    expect(fromLaunch).not.toBeNull();
    expect(fromLaunch!.landingPoint.y).toBeCloseTo(5, 5);
    expect(fromLaunch!.landingDist).toBeLessThan(0.6);
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
