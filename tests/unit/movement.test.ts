/**
 * @fileoverview Unit tests for accurate jump physics.
 *
 * Tests the getJumpVelocity function which uses accurate LCE physics:
 * ground friction (St * 0.91) on the takeoff tick, then air friction (0.91)
 * on each subsequent airborne tick. No calibration factor needed.
 */

import { Vec3 } from "vec3";
import { getJumpVelocity } from "../../src/movement";
import { Constants } from "../../src/constants";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getJumpVelocity", () => {
  const defaultSlipperiness = Constants.PHYSICS.SLIPPERINESS.DEFAULT; // 0.6
  const getMocker = (slipperiness = defaultSlipperiness) => ({
    getSlipperiness: () => slipperiness,
    getHorizontalSpeed: () => 0,
  });

  test("returns upward velocity for zero horizontal distance", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(0, 0, 0);
    const { getSlipperiness, getHorizontalSpeed } = getMocker();

    const vel = getJumpVelocity(source, target, 0, getSlipperiness, getHorizontalSpeed);

    expect(vel.x).toBe(0);
    expect(vel.y).toBe(Constants.PHYSICS.JUMP_VELOCITY); // 0.42
    expect(vel.z).toBe(0);
  });

  test("produces velocity in the correct direction (east)", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(3, 0, 0);
    const { getSlipperiness, getHorizontalSpeed } = getMocker();

    const vel = getJumpVelocity(source, target, 0, getSlipperiness, getHorizontalSpeed);

    expect(vel.x).toBeGreaterThan(0);
    expect(vel.z).toBe(0);
    expect(vel.y).toBe(Constants.PHYSICS.JUMP_VELOCITY);
  });

  test("produces velocity in the correct direction (south)", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(0, 0, 3);
    const { getSlipperiness, getHorizontalSpeed } = getMocker();

    const vel = getJumpVelocity(source, target, 0, getSlipperiness, getHorizontalSpeed);

    expect(vel.x).toBe(0);
    expect(vel.z).toBeGreaterThan(0);
    expect(vel.y).toBe(Constants.PHYSICS.JUMP_VELOCITY);
  });

  test("longer distance produces higher horizontal velocity", () => {
    const source = new Vec3(0, 0, 0);
    const { getSlipperiness, getHorizontalSpeed } = getMocker();

    const vel3 = getJumpVelocity(source, new Vec3(0, 0, 3), 0, getSlipperiness, getHorizontalSpeed);
    const vel5 = getJumpVelocity(source, new Vec3(0, 0, 5), 0, getSlipperiness, getHorizontalSpeed);

    expect(vel5.z).toBeGreaterThan(vel3.z);
  });

  test("angle rotation works correctly (90 degrees)", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(3, 0, 0); // Target is east
    const { getSlipperiness, getHorizontalSpeed } = getMocker();

    // With 90 degree angle, the bot should move in +Z direction (south)
    const vel = getJumpVelocity(source, target, 90, getSlipperiness, getHorizontalSpeed);

    expect(Math.abs(vel.x)).toBeLessThan(0.001);
    expect(vel.z).toBeGreaterThan(0);
  });

  test("vertical velocity is always JUMP_VELOCITY (0.42)", () => {
    const source = new Vec3(0, 0, 0);
    const { getSlipperiness, getHorizontalSpeed } = getMocker();

    for (const dist of [1, 2, 3, 4, 5]) {
      const vel = getJumpVelocity(source, new Vec3(dist, 0, 0), 0, getSlipperiness, getHorizontalSpeed);
      expect(vel.y).toBeCloseTo(Constants.PHYSICS.JUMP_VELOCITY, 10);
    }
  });

  test("higher slipperiness (ice) produces different velocity than default", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(3, 0, 0);

    const velDefault = getJumpVelocity(
      source, target, 0,
      () => Constants.PHYSICS.SLIPPERINESS.DEFAULT,
      () => 0,
    );
    const velIce = getJumpVelocity(
      source, target, 0,
      () => Constants.PHYSICS.SLIPPERINESS.ICE,
      () => 0,
    );

    // Ice has higher slipperiness (0.98) so ground friction is higher (0.98*0.91=0.8918)
    // vs default (0.6*0.91=0.546). Higher friction means more deceleration on takeoff,
    // so the computed initial velocity should be higher to compensate.
    expect(velIce.x).not.toBeCloseTo(velDefault.x, 3);
  });

  test("air acceleration increases jump distance", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(4, 0, 0);
    const { getSlipperiness, getHorizontalSpeed } = getMocker();

    const velNoAccel = getJumpVelocity(source, target, 0, getSlipperiness, getHorizontalSpeed, 0);
    const velWithAccel = getJumpVelocity(source, target, 0, getSlipperiness, getHorizontalSpeed, 0.02);

    // With air acceleration, less initial velocity is needed
    expect(velWithAccel.x).toBeLessThan(velNoAccel.x);
  });

  test("correction factor is applied for server physics differences", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(1, 0, 0);
    const { getSlipperiness, getHorizontalSpeed } = getMocker();

    const vel = getJumpVelocity(source, target, 0, getSlipperiness, getHorizontalSpeed);

    // With accurate physics and correction factor, the velocity for a 1-block
    // jump should be reasonable (between 0.1 and 0.3 blocks/tick).
    expect(vel.x).toBeGreaterThan(0.1);
    expect(vel.x).toBeLessThan(0.3);
  });
});
