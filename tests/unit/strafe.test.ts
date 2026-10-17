/**
 * @fileoverview Unit tests for the strafe controller's combat steering.
 *
 * Covers the continuous circle-strafe used by PVPManager (steerAroundTarget)
 * and the walkable-surface scan it depends on, using a mocked flat world.
 */

import { Vec3 } from "vec3";
import { StrafeController, findWalkableSurface } from "../../src/strafe";
import { Constants } from "../../src/constants";

// ── Mock block world ────────────────────────────────────────────────

const SOLID = {
  name: "stone",
  boundingBox: "block",
  shapes: [[0, 0, 0, 1, 1, 1]],
};
const AIR = { name: "air", boundingBox: "empty", shapes: [] };

/** Flat floor with its walkable surface at y=1; overlay adds walls. */
function flatWorld(overlay?: (pos: Vec3) => unknown): (pos: Vec3) => any {
  return (pos: Vec3) => {
    const over = overlay?.(pos);
    if (over) return over;
    return pos.y < 1 ? SOLID : AIR;
  };
}

const BOT = new Vec3(0.5, 1, 0.5);
const ZERO = new Vec3(0, 0, 0);

describe("findWalkableSurface", () => {
  test("returns the top face of a full block", () => {
    const surface = findWalkableSurface(2.5, 2.5, 1, flatWorld());
    expect(surface).not.toBeNull();
    expect(surface!.y).toBe(1);
  });

  test("returns a slab's half-block surface", () => {
    const world = (pos: Vec3) =>
      pos.x === 2 && pos.y === 0 && pos.z === 2
        ? { name: "slab", boundingBox: "block", shapes: [[0, 0, 0, 1, 0.5, 1]] }
        : pos.y < 1
          ? SOLID
          : AIR;
    const surface = findWalkableSurface(2.5, 2.5, 1, world);
    expect(surface).not.toBeNull();
    expect(surface!.y).toBe(0.5);
  });

  test("returns null over a void column", () => {
    const world = (pos: Vec3) =>
      Math.floor(pos.x) === 2 ? AIR : pos.y < 1 ? SOLID : AIR;
    expect(findWalkableSurface(2.5, 0.5, 1, world)).toBeNull();
    // Control: the neighbouring column still resolves a surface.
    expect(findWalkableSurface(1.5, 0.5, 1, world)).not.toBeNull();
  });
});

describe("StrafeController.steerAroundTarget", () => {
  test("returns mostly-lateral velocity around the target", () => {
    const controller = new StrafeController();
    const target = new Vec3(0.5, 1, 3.5); // 3 blocks away, within STRAFE_RADIUS

    const velocity = controller.steerAroundTarget(
      BOT,
      target,
      ZERO,
      flatWorld(),
      false,
    );

    expect(velocity).not.toBeNull();
    const mag = Math.hypot(velocity!.x, velocity!.z);
    expect(mag).toBeGreaterThan(0);

    // Target is due +Z: direction +1 strafes toward -X (left) with only a
    // small inward pullback toward the target.
    const outward = new Vec3(0, 0, -1); // unit vector from target to bot (XZ)
    const dot = (velocity!.x * outward.x + velocity!.z * outward.z) / mag;
    expect(dot).toBeLessThan(0.2); // never drifting outward
    expect(velocity!.x).toBeLessThan(0);
    // Vertical velocity is untouched (no inputs, no fall).
    expect(velocity!.y).toBe(0);
  });

  test("keeps the orbit radius stable while circling", () => {
    const controller = new StrafeController();
    const target = new Vec3(0.5, 1, 0.5);
    let pos = new Vec3(0.5, 1, 3.36); // radius 2.86
    let velocity = new Vec3(0, 0, 0);
    let angle = 0;
    let minRadius = Infinity;
    let maxRadius = 0;
    let previousAngle = Math.atan2(pos.z - target.z, pos.x - target.x);

    for (let i = 0; i < 80; i++) {
      const v = controller.steerAroundTarget(
        pos,
        target,
        velocity,
        flatWorld(),
        false,
      );
      expect(v).not.toBeNull();
      velocity = v!;
      // Physics order: move by the velocity, then apply ground friction.
      pos = pos.offset(velocity.x, 0, velocity.z);
      velocity = new Vec3(velocity.x * 0.546, 0, velocity.z * 0.546);

      const radius = Math.hypot(pos.x - target.x, pos.z - target.z);
      minRadius = Math.min(minRadius, radius);
      maxRadius = Math.max(maxRadius, radius);

      const current = Math.atan2(pos.z - target.z, pos.x - target.x);
      let delta = current - previousAngle;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      angle += Math.abs(delta);
      previousAngle = current;
    }

    // The bot circled a wide sector without drifting out of strafe range.
    expect(minRadius).toBeGreaterThan(2.2);
    expect(maxRadius).toBeLessThan(3.2);
    expect(angle).toBeGreaterThan(Math.PI);
  });

  test("holds when the target is beyond combat reach", () => {
    const controller = new StrafeController();
    const target = new Vec3(
      0.5,
      1,
      0.5 + Constants.COMBAT.ATTACK_RANGE + 0.5,
    );
    expect(
      controller.steerAroundTarget(BOT, target, ZERO, flatWorld(), false),
    ).toBeNull();
  });

  test("steers back toward the orbit radius after drifting out", () => {
    const controller = new StrafeController();
    const target = new Vec3(0.5, 1, 0.5);
    // Outside STRAFE_RADIUS but still inside combat reach: the pullback
    // must aim inward instead of refusing to steer.
    const bot = new Vec3(
      0.5,
      1,
      0.5 + Constants.MOVEMENT.STRAFE_RADIUS + 0.4,
    );

    const velocity = controller.steerAroundTarget(
      bot,
      target,
      ZERO,
      flatWorld(),
      false,
    );

    expect(velocity).not.toBeNull();
    const outward = new Vec3(0, 0, 1); // unit vector target -> bot (XZ)
    const mag = Math.hypot(velocity!.x, velocity!.z);
    const dot = (velocity!.x * outward.x + velocity!.z * outward.z) / mag;
    expect(dot).toBeLessThan(0); // net inward
  });

  test("airborne steering holds the orbit without the ground probe", () => {
    const controller = new StrafeController();
    const target = new Vec3(0.5, 1, 3.5);
    // Direction +1 strafes toward -X; block that side one level up. A
    // committed jump arc must not flip there ...
    const world = flatWorld((pos) =>
      pos.x <= -1 && pos.y === 1 ? SOLID : null,
    );
    const airborne = new Vec3(0.5, 2, 0.5);

    const velocity = controller.steerAroundTarget(
      airborne,
      target,
      ZERO,
      world,
      false,
      false,
    );

    // ... whereas the same world flips a grounded step.
    expect(velocity).not.toBeNull();
    expect(velocity!.x).toBeLessThan(0); // preferred -X side kept
    expect(controller.direction).toBe(1); // no flip mid-hop
    const grounded = controller.steerAroundTarget(
      BOT,
      target,
      ZERO,
      world,
      false,
    );
    expect(grounded).not.toBeNull();
    expect(grounded!.x).toBeGreaterThan(0); // flipped to +X
    expect(controller.direction).toBe(-1);
  });

  test("flips to the free side when the preferred side is blocked", () => {
    const controller = new StrafeController();
    const target = new Vec3(0.5, 1, 3.5);
    // Direction +1 strafes toward -X; block that side one level up.
    const world = flatWorld((pos) =>
      pos.x <= -1 && pos.y === 1 ? SOLID : null,
    );

    const velocity = controller.steerAroundTarget(
      BOT,
      target,
      ZERO,
      world,
      false,
    );

    expect(velocity).not.toBeNull();
    expect(velocity!.x).toBeGreaterThan(0); // pushed to the free +X side
    expect(controller.direction).toBe(-1); // flip remembered
  });

  test("horizontal collisions reverse the orbit direction", () => {
    const controller = new StrafeController();
    const target = new Vec3(0.5, 1, 3.5);
    controller.steerAroundTarget(BOT, target, ZERO, flatWorld(), true);
    expect(controller.direction).toBe(-1);
  });

  test("preserves upward velocity while strafing", () => {
    const controller = new StrafeController();
    const target = new Vec3(0.5, 1, 3.5);
    const airborne = new Vec3(0, 0.42, 0);
    const velocity = controller.steerAroundTarget(
      BOT,
      target,
      airborne,
      flatWorld(),
      false,
    );
    expect(velocity).not.toBeNull();
    expect(velocity!.y).toBeCloseTo(0.42, 6);
  });
});
