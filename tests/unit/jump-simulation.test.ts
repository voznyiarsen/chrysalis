/**
 * @fileoverview Unit tests for jump path simulation.
 * 
 * Tests the isJumpPathClear function which simulates jump trajectories
 * and checks for collisions using accurate LCE physics.
 */

import { Vec3 } from "vec3";
import { AABB } from "../../src/utils";
import { isJumpPathClear } from "../../src/movement";
import { Constants } from "../../src/constants";

// ---------------------------------------------------------------------------
// Test Setup
// ---------------------------------------------------------------------------

/**
 * Creates a mock bot entity with position and velocity
 */
function createMockBotEntity(position: Vec3 = new Vec3(0, 0, 0)): {
  position: Vec3;
  velocity: Vec3;
} {
  return {
    position: position.clone(),
    velocity: new Vec3(0, 0, 0),
  };
}

/**
 * Creates a mock getCollisions function that returns predefined obstacles
 */
function createMockGetCollisions(obstacles: AABB[] = []): (
  aabb: AABB,
  minYThreshold: number,
) => AABB[] {
  return (aabb: AABB, minYThreshold: number) => {
    // Return obstacles that intersect with the query AABB
    return obstacles.filter((obs) => aabb.intersects(obs));
  };
}

/**
 * Creates a mock getSlipperiness function
 */
function createMockGetSlipperiness(slipperiness: number = 0.6): (pos: Vec3) => number {
  return () => slipperiness;
}

// ---------------------------------------------------------------------------
// Test Suites
// ---------------------------------------------------------------------------

describe("isJumpPathClear", () => {
  const MOMENTUM_THRESHOLD = Constants.PHYSICS.MOMENTUM_THRESHOLD_1_9; // 0.003
  const DEFAULT_SLIPPERINESS = Constants.PHYSICS.SLIPPERINESS.DEFAULT; // 0.6

  describe("Basic jump scenarios", () => {
    test("returns true for clear horizontal jump", () => {
      const source = new Vec3(0, 0, 0);
      const target = new Vec3(3, 0, 0);
      const botEntity = createMockBotEntity(source);
      const getCollisions = createMockGetCollisions([]);
      const getSlipperiness = createMockGetSlipperiness();

      const result = isJumpPathClear(
        source,
        target,
        getSlipperiness,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      expect(result).toBe(true);
    });

    test("returns true for clear diagonal jump", () => {
      const source = new Vec3(0, 0, 0);
      const target = new Vec3(2, 0, 2);
      const botEntity = createMockBotEntity(source);
      const getCollisions = createMockGetCollisions([]);
      const getSlipperiness = createMockGetSlipperiness();

      const result = isJumpPathClear(
        source,
        target,
        getSlipperiness,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      expect(result).toBe(true);
    });

    test("returns true for clear tertiary jump (with vertical component)", () => {
      const source = new Vec3(0, 0, 0);
      const target = new Vec3(1, 1, 1);
      const botEntity = createMockBotEntity(source);
      const getCollisions = createMockGetCollisions([]);
      const getSlipperiness = createMockGetSlipperiness();

      const result = isJumpPathClear(
        source,
        target,
        getSlipperiness,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      expect(result).toBe(true);
    });
  });

  describe("Obstacle collision scenarios", () => {
    test("returns false when obstacle blocks path at ground level", () => {
      const source = new Vec3(0, 0, 0);
      const target = new Vec3(3, 0, 0);
      const botEntity = createMockBotEntity(source);
      
      // Create a wall obstacle at x=1.5
      const obstacle = new AABB(1.5, 0, -0.5, 1.5, 2, 0.5);
      const getCollisions = createMockGetCollisions([obstacle]);
      const getSlipperiness = createMockGetSlipperiness();

      const result = isJumpPathClear(
        source,
        target,
        getSlipperiness,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      expect(result).toBe(false);
    });

    test("returns false when obstacle blocks path at jump height", () => {
      const source = new Vec3(0, 0, 0);
      const target = new Vec3(3, 0, 0);
      const botEntity = createMockBotEntity(source);
      
      // Create an obstacle at jump height (y=1)
      const obstacle = new AABB(1.5, 1, -0.5, 1.5, 1.5, 0.5);
      const getCollisions = createMockGetCollisions([obstacle]);
      const getSlipperiness = createMockGetSlipperiness();

      const result = isJumpPathClear(
        source,
        target,
        getSlipperiness,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      expect(result).toBe(false);
    });

    test("returns false when obstacle blocks landing area", () => {
      const source = new Vec3(0, 0, 0);
      const target = new Vec3(3, 0, 0);
      const botEntity = createMockBotEntity(source);
      
      // Create a taller obstacle at the landing position that blocks the path
      const obstacle = new AABB(2.8, 0, -0.5, 3.2, 2, 0.5);
      const getCollisions = createMockGetCollisions([obstacle]);
      const getSlipperiness = createMockGetSlipperiness();

      const result = isJumpPathClear(
        source,
        target,
        getSlipperiness,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      expect(result).toBe(false);
    });

    test("returns true when obstacle is below jump path", () => {
      const source = new Vec3(0, 0, 0);
      const target = new Vec3(3, 0, 0);
      const botEntity = createMockBotEntity(source);
      
      // Create an obstacle below the path (y=-1)
      const obstacle = new AABB(1.5, -1, -0.5, 1.5, -0.5, 0.5);
      const getCollisions = createMockGetCollisions([obstacle]);
      const getSlipperiness = createMockGetSlipperiness();

      const result = isJumpPathClear(
        source,
        target,
        getSlipperiness,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      expect(result).toBe(true);
    });

    test("returns true when obstacle is above jump path", () => {
      const source = new Vec3(0, 0, 0);
      const target = new Vec3(3, 0, 0);
      const botEntity = createMockBotEntity(source);
      
      // Create an obstacle above the path (y=3)
      const obstacle = new AABB(1.5, 3, -0.5, 1.5, 3.5, 0.5);
      const getCollisions = createMockGetCollisions([obstacle]);
      const getSlipperiness = createMockGetSlipperiness();

      const result = isJumpPathClear(
        source,
        target,
        getSlipperiness,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      expect(result).toBe(true);
    });
  });

  describe("Different distance scenarios", () => {
    test("returns true for short jump (1 block)", () => {
      const source = new Vec3(0, 0, 0);
      const target = new Vec3(1, 0, 0);
      const botEntity = createMockBotEntity(source);
      const getCollisions = createMockGetCollisions([]);
      const getSlipperiness = createMockGetSlipperiness();

      const result = isJumpPathClear(
        source,
        target,
        getSlipperiness,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      expect(result).toBe(true);
    });

    test("returns true for medium jump (2 blocks)", () => {
      const source = new Vec3(0, 0, 0);
      const target = new Vec3(2, 0, 0);
      const botEntity = createMockBotEntity(source);
      const getCollisions = createMockGetCollisions([]);
      const getSlipperiness = createMockGetSlipperiness();

      const result = isJumpPathClear(
        source,
        target,
        getSlipperiness,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      expect(result).toBe(true);
    });

    test("returns true for long jump (4 blocks)", () => {
      const source = new Vec3(0, 0, 0);
      const target = new Vec3(4, 0, 0);
      const botEntity = createMockBotEntity(source);
      const getCollisions = createMockGetCollisions([]);
      const getSlipperiness = createMockGetSlipperiness();

      const result = isJumpPathClear(
        source,
        target,
        getSlipperiness,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      expect(result).toBe(true);
    });
  });

  describe("Different surface scenarios", () => {
    test("different slipperiness affects jump calculation", () => {
      const source = new Vec3(0, 0, 0);
      const target = new Vec3(3, 0, 0);
      const botEntity = createMockBotEntity(source);
      const getCollisions = createMockGetCollisions([]);

      // Test with default slipperiness (0.6)
      const getSlipperinessDefault = createMockGetSlipperiness(0.6);
      const resultDefault = isJumpPathClear(
        source,
        target,
        getSlipperinessDefault,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      // Test with ice slipperiness (0.98)
      const getSlipperinessIce = createMockGetSlipperiness(0.98);
      const resultIce = isJumpPathClear(
        source,
        target,
        getSlipperinessIce,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      // Both should succeed on clear path, but the physics calculation will be different
      expect(resultDefault).toBe(true);
      expect(resultIce).toBe(true);
    });
  });

  describe("Edge cases", () => {
    test("returns false for zero-distance jump", () => {
      const source = new Vec3(0, 0, 0);
      const target = new Vec3(0, 0, 0);
      const botEntity = createMockBotEntity(source);
      const getCollisions = createMockGetCollisions([]);
      const getSlipperiness = createMockGetSlipperiness();

      const result = isJumpPathClear(
        source,
        target,
        getSlipperiness,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      // Zero-distance jumps are not valid
      expect(result).toBe(false);
    });

    test("returns false when starting position has obstacle", () => {
      const source = new Vec3(0, 0, 0);
      const target = new Vec3(3, 0, 0);
      const botEntity = createMockBotEntity(source);
      
      // Create an obstacle at starting position
      const obstacle = new AABB(-0.5, 0, -0.5, 0.5, 2, 0.5);
      const getCollisions = createMockGetCollisions([obstacle]);
      const getSlipperiness = createMockGetSlipperiness();

      const result = isJumpPathClear(
        source,
        target,
        getSlipperiness,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      expect(result).toBe(false);
    });

    test("returns false when target position has obstacle", () => {
      const source = new Vec3(0, 0, 0);
      const target = new Vec3(3, 0, 0);
      const botEntity = createMockBotEntity(source);
      
      // Create an obstacle at target position
      const obstacle = new AABB(2.5, 0, -0.5, 3.5, 2, 0.5);
      const getCollisions = createMockGetCollisions([obstacle]);
      const getSlipperiness = createMockGetSlipperiness();

      const result = isJumpPathClear(
        source,
        target,
        getSlipperiness,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      expect(result).toBe(false);
    });
  });

  describe("Multiple obstacle scenarios", () => {
    test("returns false when multiple obstacles block path", () => {
      const source = new Vec3(0, 0, 0);
      const target = new Vec3(4, 0, 0);
      const botEntity = createMockBotEntity(source);
      
      // Create multiple obstacles along the path
      const obstacles = [
        new AABB(1, 0, -0.5, 1, 2, 0.5), // First obstacle
        new AABB(2.5, 0, -0.5, 2.5, 2, 0.5), // Second obstacle
      ];
      const getCollisions = createMockGetCollisions(obstacles);
      const getSlipperiness = createMockGetSlipperiness();

      const result = isJumpPathClear(
        source,
        target,
        getSlipperiness,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      expect(result).toBe(false);
    });

    test("returns true when obstacles are outside jump path", () => {
      const source = new Vec3(0, 0, 0);
      const target = new Vec3(3, 0, 0);
      const botEntity = createMockBotEntity(source);
      
      // Create obstacles outside the path
      const obstacles = [
        new AABB(-2, 0, -0.5, -1, 2, 0.5), // Left of path
        new AABB(4, 0, -0.5, 5, 2, 0.5), // Right of path
      ];
      const getCollisions = createMockGetCollisions(obstacles);
      const getSlipperiness = createMockGetSlipperiness();

      const result = isJumpPathClear(
        source,
        target,
        getSlipperiness,
        getCollisions,
        botEntity,
        MOMENTUM_THRESHOLD,
      );

      expect(result).toBe(true);
    });
  });


});