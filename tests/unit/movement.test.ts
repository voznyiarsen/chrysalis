/**
 * @fileoverview Unit tests for accurate jump physics.
 *
 * Tests the getJumpVelocity function which uses accurate LCE physics:
 * ground friction (St * 0.91) on the takeoff tick, then air friction (0.91)
 * on each subsequent airborne tick. No calibration factor needed.
 */

import { Vec3 } from "vec3";
import { getJumpVelocity, renderTopDownView } from "../../src/movement";
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

    const vel = getJumpVelocity(
      source,
      target,
      0,
      getSlipperiness,
      getHorizontalSpeed,
    );

    expect(vel.x).toBe(0);
    expect(vel.y).toBe(Constants.PHYSICS.JUMP_VELOCITY); // 0.42
    expect(vel.z).toBe(0);
  });

  test("produces velocity in the correct direction (east)", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(3, 0, 0);
    const { getSlipperiness, getHorizontalSpeed } = getMocker();

    const vel = getJumpVelocity(
      source,
      target,
      0,
      getSlipperiness,
      getHorizontalSpeed,
    );

    expect(vel.x).toBeGreaterThan(0);
    expect(vel.z).toBe(0);
    expect(vel.y).toBe(Constants.PHYSICS.JUMP_VELOCITY);
  });

  test("produces velocity in the correct direction (south)", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(0, 0, 3);
    const { getSlipperiness, getHorizontalSpeed } = getMocker();

    const vel = getJumpVelocity(
      source,
      target,
      0,
      getSlipperiness,
      getHorizontalSpeed,
    );

    expect(vel.x).toBe(0);
    expect(vel.z).toBeGreaterThan(0);
    expect(vel.y).toBe(Constants.PHYSICS.JUMP_VELOCITY);
  });

  test("longer distance produces higher horizontal velocity", () => {
    const source = new Vec3(0, 0, 0);
    const { getSlipperiness, getHorizontalSpeed } = getMocker();

    const vel3 = getJumpVelocity(
      source,
      new Vec3(0, 0, 3),
      0,
      getSlipperiness,
      getHorizontalSpeed,
    );
    const vel5 = getJumpVelocity(
      source,
      new Vec3(0, 0, 5),
      0,
      getSlipperiness,
      getHorizontalSpeed,
    );

    expect(vel5.z).toBeGreaterThan(vel3.z);
  });

  test("angle rotation works correctly (90 degrees)", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(3, 0, 0); // Target is east
    const { getSlipperiness, getHorizontalSpeed } = getMocker();

    // With 90 degree angle, the bot should move in +Z direction (south)
    const vel = getJumpVelocity(
      source,
      target,
      90,
      getSlipperiness,
      getHorizontalSpeed,
    );

    expect(Math.abs(vel.x)).toBeLessThan(0.001);
    expect(vel.z).toBeGreaterThan(0);
  });

  test("vertical velocity is always JUMP_VELOCITY (0.42)", () => {
    const source = new Vec3(0, 0, 0);
    const { getSlipperiness, getHorizontalSpeed } = getMocker();

    for (const dist of [1, 2, 3, 4, 5]) {
      const vel = getJumpVelocity(
        source,
        new Vec3(dist, 0, 0),
        0,
        getSlipperiness,
        getHorizontalSpeed,
      );
      expect(vel.y).toBeCloseTo(Constants.PHYSICS.JUMP_VELOCITY, 10);
    }
  });

  test("higher slipperiness (ice) produces different velocity than default", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(3, 0, 0);

    const velDefault = getJumpVelocity(
      source,
      target,
      0,
      () => Constants.PHYSICS.SLIPPERINESS.DEFAULT,
      () => 0,
    );
    const velIce = getJumpVelocity(
      source,
      target,
      0,
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

    const velNoAccel = getJumpVelocity(
      source,
      target,
      0,
      getSlipperiness,
      getHorizontalSpeed,
      0,
    );
    const velWithAccel = getJumpVelocity(
      source,
      target,
      0,
      getSlipperiness,
      getHorizontalSpeed,
      0.02,
    );

    // With air acceleration, less initial velocity is needed
    expect(velWithAccel.x).toBeLessThan(velNoAccel.x);
  });

  test("correction factor is applied for server physics differences", () => {
    const source = new Vec3(0, 0, 0);
    const target = new Vec3(1, 0, 0);
    const { getSlipperiness, getHorizontalSpeed } = getMocker();

    const vel = getJumpVelocity(
      source,
      target,
      0,
      getSlipperiness,
      getHorizontalSpeed,
    );

    // With accurate physics and correction factor, the velocity for a 1-block
    // jump should be reasonable (between 0.1 and 0.3 blocks/tick).
    expect(vel.x).toBeGreaterThan(0.1);
    expect(vel.x).toBeLessThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// renderTopDownView
// ---------------------------------------------------------------------------

describe("renderTopDownView", () => {
  /** Simple world: solid floor at y<=0 ("bedrock"), air above. */
  const floorWorld = (pos: Vec3): any => {
    const y = Math.floor(pos.y);
    return y <= 0 ? { name: "bedrock", boundingBox: "block" } : null;
  };

  test("renders a 5x5 grid of the level under the feet with the bot marked", () => {
    const lines = renderTopDownView(new Vec3(10.5, 1, 20.5), floorWorld);

    expect(lines).toHaveLength(7); // header + column labels + 5 rows
    // Bot at feet y=1 stands on the block level y=0.
    expect(lines[0]).toContain("y=0");
    expect(lines[0]).toContain("bot block (10, 20)");

    // 5 columns labeled with x coordinates.
    expect(lines[1]).toContain("x8");
    expect(lines[1]).toContain("x12");

    // Rows run north (-Z) to south (+Z) from the bot's row.
    expect(lines[2]).toContain("z18");
    expect(lines[4]).toContain("z20");
    expect(lines[6]).toContain("z22");

    // Every floor cell is bedrock; the bot's own cell carries the marker.
    expect(lines[4]).toContain("*bed ");
    expect(lines[4]).toContain("bed  ");
    const markedCount = lines
      .slice(2)
      .filter((l) => l.includes("*"))
      .length;
    expect(markedCount).toBe(1);
  });

  test("shows void gaps as air and unloaded chunks as dots", () => {
    // Floor only in a 3-wide strip (x 9..11); unloaded west beyond x <= 8
    // and air east of x >= 12 — both reachable inside the 5x5 window.
    const world = (pos: Vec3): any => {
      const x = Math.floor(pos.x);
      const y = Math.floor(pos.y);
      if (y > 0) return null;
      if (x < 9) return null; // unloaded
      if (x > 11) return { name: "air", boundingBox: "empty" };
      return { name: "stone", boundingBox: "block" };
    };
    const lines = renderTopDownView(new Vec3(10.5, 1, 3.5), world);
    expect(lines[0]).toContain("y=0");
    // West columns ... unloaded; east columns air; middle stone.
    expect(lines[3]).toContain("... ");
    expect(lines[3]).toContain("air ");
    expect(lines[3]).toContain("sto ");
  });

  test("falls back to the level below the feet when hovering over the void", () => {
    // Nothing but air everywhere.
    const airWorld = () => ({ name: "air", boundingBox: "empty" });
    const lines = renderTopDownView(new Vec3(0.5, 1, 0.5), airWorld);
    // No support found: level = floor(1) - 1 = 0.
    expect(lines[0]).toContain("y=0");
    expect(lines[5]).toContain("air ");
  });
});
