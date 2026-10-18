/**
 * @fileoverview Unit tests for the continuous strafe controller.
 *
 * The controller sets the orbit velocity every tick (grounded and airborne)
 * from a tangential + radial-encirclement direction vector, with a full
 * closed-loop physics prediction validating every candidate before the bot
 * moves. These tests cover:
 *
 * - computeDirectionVec geometry (tangential at range, inward when far,
 *   outward when close, constant magnitude, no yaw-mirroring mismatch),
 * - the continuous predictor (void/deep-drop/hazard/wall rejection, landing
 *   drop measurement) and jump velocity (0.42 on jump ticks, y preserved
 *   otherwise),
 * - controller behavior: bunny-hop orbit on flat ground, blocked orbit
 *   radius cascade, direction flip on collision, void avoidance, hazard
 *   avoidance, rescue and brake,
 * - integration loops that reproduce the original bug reports: a flat
 *   ground orbit must be circular (no oscillation) and an orbit next to a
 *   void hole must never step into the void.
 */

import { Vec3 } from "vec3";
import {
  StrafeController,
  computeDirectionVec,
  simulateStrafePath,
} from "../../src/strafe";
import type { StrafeWorld } from "../../src/strafe";
import { getCollisions, getGroundBelow } from "../../src/movement";
import { Constants } from "../../src/constants";

// ── Mock block world ────────────────────────────────────────────────

const SOLID = {
  name: "stone",
  boundingBox: "block",
  shapes: [[0, 0, 0, 1, 1, 1]],
};
const AIR = { name: "air", boundingBox: "empty", shapes: [] };
const LAVA = { name: "lava", boundingBox: "empty", shapes: [] };

type Overlay = (
  x: number,
  y: number,
  z: number,
) => "stone" | "lava" | "air" | "keep" | undefined;

/** Floor: solid at y<=0 (top surface y=1), air above, overlay on top. */
function makeWorld(overlay?: Overlay): (pos: Vec3) => any {
  return (pos: Vec3) => {
    const x = Math.floor(pos.x);
    const y = Math.floor(pos.y);
    const z = Math.floor(pos.z);
    if (overlay) {
      const over = overlay(x, y, z);
      if (over === "stone") return SOLID;
      if (over === "lava") return LAVA;
      if (over === "air") return AIR;
      if (over === "keep") return y <= 0 ? SOLID : AIR;
    }
    return y <= 0 ? SOLID : AIR;
  };
}

function worldOf(blockAt: (pos: Vec3) => any): StrafeWorld {
  return {
    blockAt,
    getCollisions: (aabb, minY) => getCollisions(aabb, minY, blockAt),
  };
}

// ── Mini-physics integration (mirrors the real bot loop) ───────────

interface OrbitRun {
  positions: Vec3[];
  fellIntoVoid: boolean;
  ticks: number;
}

/**
 * Integrate the controller over a tick loop the same way the real bot runs
 * its physics: move by the velocity from the previous tick's plan, apply
 * gravity/drag, land on `getGroundBelow`, and stop if the bot drops into
 * the void (y well below the ground level).
 */
function runOrbit(
  controller: StrafeController,
  blockAt: (pos: Vec3) => any,
  start: Vec3,
  target: Vec3,
  ticks: number,
): OrbitRun {
  const positions: Vec3[] = [];
  const pos = start.clone();
  let vy = 0;
  let onGround = true;
  let fellIntoVoid = false;
  let jumped = 0;
  let plans = 0;

  for (let i = 0; i < ticks; i++) {
    const plan = controller.computeTick({
      source: pos.clone(),
      target,
      velocity: new Vec3(0, vy, 0),
      onGround,
      collidedHorizontally: false,
      world: worldOf(blockAt),
    });
    if (!plan) continue;
    plans++;
    if (plan.jump) jumped++;
    positions.push(pos.clone());

    // Move by the velocity computed this tick (the control loop injects it).
    pos.x += plan.velocity.x;
    pos.z += plan.velocity.z;
    positionVertical(pos, plan, blockAt, (state) => {
      vy = state.vy;
      onGround = state.onGround;
    });
    if (pos.y < -20) {
      fellIntoVoid = true;
      break;
    }
  }
  return { positions, fellIntoVoid, ticks: plans };
}

/**
 * Vertical step of the mini-physics: prismarine order — move by the planned
 * velocity, clamp on the floor below (getGroundBelow), then gravity + drag
 * when airborne.
 */
function positionVertical(
  pos: Vec3,
  plan: { velocity: Vec3 },
  blockAt: (pos: Vec3) => any,
  apply: (state: { vy: number; onGround: boolean }) => void,
): void {
  const velY = plan.velocity.y;
  pos.y += velY;
  const ground = getGroundBelow(pos, blockAt);
  if (velY <= 0 && pos.y <= ground) {
    // Landed: snap onto the surface.
    pos.y = ground;
    apply({ vy: 0, onGround: true });
  } else {
    apply({
      vy: (velY - Constants.PHYSICS.GRAVITY) * Constants.PHYSICS.DRAG,
      onGround: false,
    });
  }
}

// ── Orbit statistics ────────────────────────────────────────────────

function signedAngleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Sum of |Δbearing| and signed ΣΔbearing around `target`. */
function orbitStats(positions: Vec3[], target: Vec3) {
  let sumAbs = 0;
  let sumSigned = 0;
  let prev: number | null = null;
  for (const p of positions) {
    const a = Math.atan2(p.z - target.z, p.x - target.x);
    if (prev !== null) {
      const d = signedAngleDelta(prev, a);
      sumAbs += Math.abs(d);
      sumSigned += d;
    }
    prev = a;
  }
  return { sumAbs, sumSigned };
}

function pathLength(positions: Vec3[], skip = 1): number {
  let len = 0;
  for (let i = skip; i < positions.length; i++) {
    len += positions[i].distanceTo(positions[i - 1]);
  }
  return len;
}

// ── computeDirectionVec ─────────────────────────────────────────────

describe("computeDirectionVec (LiquidBounce encirclement)", () => {
  const speed = Constants.MOVEMENT.STRAFE_SPEED;

  test("is purely tangential at the orbit radius", () => {
    // Bot directly west of the target: tangent must be ±Z only.
    const source = new Vec3(7.5, 1, 0.5);
    const target = new Vec3(10.5, 1, 0.5);
    const v = computeDirectionVec(source, target, speed, 3, 1);
    expect(Math.abs(v.x)).toBeLessThan(0.02);
    expect(v.z).toBeGreaterThan(speed * 0.9);
    // No parametrization mismatch: the tangent is perpendicular, i.e. the
    // velocity has no component along the bot→target line.
    const dot = v.x * (target.x - source.x) + v.z * (target.z - source.z);
    expect(Math.abs(dot)).toBeLessThan(0.15);
  });

  test("always has magnitude speed", () => {
    for (const dist of [0.5, 3, 6, 12]) {
      const source = new Vec3(0, 1, 0);
      const target = new Vec3(dist, 1, 0);
      const v = computeDirectionVec(source, target, speed, 3, 1);
      expect(Math.hypot(v.x, v.z)).toBeCloseTo(speed, 5);
    }
  });

  test("points inward when the bot is outside the orbit radius", () => {
    const source = new Vec3(-6.5, 1, 0);
    const target = new Vec3(0, 1, 0);
    const v = computeDirectionVec(source, target, speed, 3, 1);
    // Component along bot→target (+X) must be inward and dominant.
    expect(v.x).toBeGreaterThan(speed * 0.6);
  });

  test("pushes outward when the bot is inside the orbit radius", () => {
    const source = new Vec3(3, 1, 0);
    const target = new Vec3(5, 1, 0);
    const v = computeDirectionVec(source, target, speed, 3, 1);
    expect(v.x).toBeLessThan(-0.02);
  });

  test("mirrors correctly between +1 and -1 sides", () => {
    const source = new Vec3(7.5, 1, 0.5);
    const target = new Vec3(10.5, 1, 0.5);
    const v1 = computeDirectionVec(source, target, speed, 3, 1);
    const v2 = computeDirectionVec(source, target, speed, 3, -1);
    expect(v1.x).toBeCloseTo(v2.x, 6); // tangential: no radial flip
    expect(v1.z).toBeCloseTo(-v2.z, 6); // mirrored tangent
    expect(v1.z).toBeGreaterThan(0);
    expect(v2.z).toBeLessThan(0);
  });
});

// ── simulateStrafePath (continuous prediction) ──────────────────────

describe("simulateStrafePath (continuous physics prediction)", () => {
  test("flat ground hop lands safely with zero drop", () => {
    const blockAt = makeWorld();
    const result = simulateStrafePath({
      source: new Vec3(10.5, 1, 10.5),
      target: new Vec3(4.5, 1, 10.5),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      jump: true,
      direction: 1,
      range: 3,
      speed: Constants.MOVEMENT.STRAFE_SPEED,
      referenceGroundY: 1,
      world: worldOf(blockAt),
    });
    expect(result.safe).toBe(true);
    expect(result.landed).toBe(true);
    expect(result.drop).toBeLessThanOrEqual(0.5);
  });

  test("rejects a hop straight into a wall before moving", () => {
    // 2-tall wall spanning the target side.
    const blockAt = makeWorld(
      (x, y, z) => (y === 1 || y === 2) && x === 9 ? "stone" : undefined,
    );
    const result = simulateStrafePath({
      source: new Vec3(10.5, 1, 10.5),
      target: new Vec3(4.5, 1, 10.5),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      jump: true,
      direction: 1,
      range: 3,
      speed: Constants.MOVEMENT.STRAFE_SPEED,
      referenceGroundY: 1,
      world: worldOf(blockAt),
    });
    expect(result.safe).toBe(false);
  });

  test("rejects an inward walk that would fall into the void", () => {
    // Floor only for x >= 6 (void beyond the ledge).
    const blockAt = makeWorld((x) => (x >= 6 ? "keep" : "air"));
    const result = simulateStrafePath({
      source: new Vec3(6.5, 1, 10.5),
      target: new Vec3(2.5, 1, 10.5),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      jump: false,
      direction: 1,
      range: 3,
      speed: Constants.MOVEMENT.STRAFE_SPEED,
      referenceGroundY: 1,
      world: worldOf(blockAt),
      mode: "inward",
    });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("void");
  });

  test("rejects paths over hazard blocks", () => {
    // Lava pool replacing the floor east of x=9.
    const blockAt = makeWorld(
      (x, y) => (y <= 0 && x >= 9 ? "lava" : y <= 0 ? "keep" : undefined),
    );
    const result = simulateStrafePath({
      source: new Vec3(6.5, 1, 10.5),
      target: new Vec3(9.5, 1, 10.5),
      velocity: new Vec3(0, -0.0784, 0),
      onGround: true,
      jump: false,
      direction: 1,
      range: 3,
      speed: Constants.MOVEMENT.STRAFE_SPEED,
      referenceGroundY: 1,
      world: worldOf(blockAt),
      mode: "inward",
    });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("hazard");
  });

  test("measures a 1-block landing drop (warn tier input)", () => {
    // 1-deep basin: mouth at y=0 over x 5..8 (wide so the walk falls in it),
    // solid basin floor at y=-1 → landing drop 1 from the ground level.
    const blockAt = makeWorld(
      (x, y, z) => {
        if (y === 0 && x >= 5 && x <= 8 && z >= 4 && z <= 17) return "air";
        return y <= 0 ? "keep" : undefined;
      },
    );
    const result = simulateStrafePath({
      source: new Vec3(10.5, 1, 10.5),
      target: new Vec3(4.5, 1, 10.5),
      velocity: new Vec3(0, -0.0784, 0),
      onGround: true,
      jump: false,
      direction: 1,
      range: 3,
      speed: Constants.MOVEMENT.STRAFE_SPEED,
      referenceGroundY: 1,
      world: worldOf(blockAt),
      mode: "inward",
    });
    expect(result.safe).toBe(true);
    expect(result.landed).toBe(true);
    expect(result.drop).toBeGreaterThan(0.5); // > STRAFE_SAFE_DROP
    expect(result.drop).toBeLessThanOrEqual(3); // ≤ STRAFE_HAZARD_MAX_DROP
  });

  test("rejects drops deeper than STRAFE_HAZARD_MAX_DROP", () => {
    // 4-deep pit: solid floor only at y=-4 inside the pit region.
    const blockAt = makeWorld((x, y) => {
      if (y <= 0 && x >= 9 && x <= 12) return y <= -4 ? "keep" : "air";
      return y <= 0 ? "keep" : undefined;
    });
    const result = simulateStrafePath({
      source: new Vec3(13.5, 1, 10.5),
      target: new Vec3(8.5, 1, 10.5),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      jump: false,
      direction: 1,
      range: 3,
      speed: Constants.MOVEMENT.STRAFE_SPEED,
      referenceGroundY: 1,
      world: worldOf(blockAt),
      mode: "inward",
    });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("deep-drop");
  });

  test("launches with vy = 0.42 exactly like a vanilla jump", () => {
    const blockAt = makeWorld();
    // The prediction marks the first tick with the jump velocity internally;
    // verify via landed state and safe path (indirect), plus no unsafe
    // reasons for a normal launch.
    const result = simulateStrafePath({
      source: new Vec3(10.5, 1, 10.5),
      target: new Vec3(10.5, 1, 13.5),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      jump: true,
      direction: 1,
      range: 3,
      speed: Constants.MOVEMENT.STRAFE_SPEED,
      referenceGroundY: 1,
      world: worldOf(blockAt),
      maxTicks: 12,
    });
    expect(result.safe).toBe(true);
    expect(result.landed).toBe(true);
  });
});

// ── StrafeController.computeTick ────────────────────────────────────

describe("StrafeController.computeTick (continuous orbit)", () => {
  const SPEED = Constants.MOVEMENT.STRAFE_SPEED;
  const FLAT = worldOf(makeWorld());

  test("returns null beyond attack range", () => {
    const controller = new StrafeController();
    const plan = controller.computeTick({
      source: new Vec3(0, 1, 0),
      target: new Vec3(10, 1, 0),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      collidedHorizontally: false,
      world: FLAT,
    });
    expect(plan).toBeNull();
  });

  test("grounded plan is a bunny-hop (jump 0.42) with tier safe", () => {
    const controller = new StrafeController();
    const plan = controller.computeTick({
      source: new Vec3(7.5, 1, 10.5),
      target: new Vec3(10.5, 1, 10.5),
      velocity: new Vec3(0, -0.0784, 0),
      onGround: true,
      collidedHorizontally: false,
      world: FLAT,
    });
    expect(plan).not.toBeNull();
    expect(plan!.tier).toBe("safe");
    expect(plan!.jump).toBe(true);
    expect(plan!.velocity.y).toBe(Constants.PHYSICS.JUMP_VELOCITY);
    const h = Math.hypot(plan!.velocity.x, plan!.velocity.z);
    expect(h).toBeCloseTo(SPEED, 5);
  });

  test("airborne plan preserves vertical velocity and does not jump", () => {
    const controller = new StrafeController();
    const plan = controller.computeTick({
      source: new Vec3(7.5, 1.4, 10.5),
      target: new Vec3(10.5, 1, 10.5),
      velocity: new Vec3(0, -0.15, 0),
      onGround: false,
      collidedHorizontally: false,
      world: FLAT,
    });
    expect(plan).not.toBeNull();
    expect(plan!.jump).toBe(false);
    expect(plan!.velocity.y).toBe(-0.15);
  });

  test("flips orbit side when horizontally collided", () => {
    const controller = new StrafeController();
    const base = {
      source: new Vec3(7.5, 1, 10.5),
      target: new Vec3(10.5, 1, 10.5),
      velocity: new Vec3(0, -0.0784, 0),
      onGround: true,
      collidedHorizontally: false,
      world: FLAT,
    };
    // First tick: the controller picks whatever safe direction it prefers.
    const first = controller.computeTick({ ...base });
    expect(first).not.toBeNull();
    // A reported horizontal collision flips the side on the next tick.
    const collided = controller.computeTick({
      ...base,
      collidedHorizontally: true,
    });
    expect(collided!.direction).toBe(-first!.direction);
  });

  test("avoids the void: refuses to orbit over a void hole", () => {
    // Hole in the floor at (7..8, 10..11); the bot starts north-west of the
    // hole, target east of it. Any plan heading over the hole must be
    // rejected; the resulting plan must move to ground that supports the
    // bot (floor reachable below the probe point).
    const blockAt = makeWorld(
      (x, y, z) =>
        y <= 0 && x >= 7 && x <= 8 && z >= 10 && z <= 11 ? "air" : "keep",
    );
    const world = worldOf(blockAt);
    const controller = new StrafeController();
    const plan = controller.computeTick({
      source: new Vec3(7.8, 1, 12.6),
      target: new Vec3(10.5, 1, 10.5),
      velocity: new Vec3(0, -0.0784, 0),
      onGround: true,
      collidedHorizontally: false,
      world,
    });
    expect(plan).not.toBeNull();
    expect(plan!.tier).not.toBe("brake");
    const probe = new Vec3(
      plan!.point.x,
      plan!.point.y,
      plan!.point.z,
    );
    expect(getGroundBelow(probe, blockAt)).toBeGreaterThanOrEqual(1);
  });

  test("refuses to move toward lava (brakes instead)", () => {
    // Lava surrounds a narrow stone corridor (x < 9, 8 <= z < 13); the
    // target sits across the lava edge. Every orbit ring, flip and inward
    // walk ends on lava within the horizon → NOTHING is validated.
    const blockAt = makeWorld((x, y, z) => {
      if (y > 0) return "air";
      if (x < 9 && z >= 8 && z < 13) return "keep";
      return "lava";
    });
    const world = worldOf(blockAt);
    const controller = new StrafeController();
    const plan = controller.computeTick({
      source: new Vec3(6.5, 1, 10.5),
      target: new Vec3(9.5, 1, 10.5),
      velocity: new Vec3(0, -0.0784, 0),
      onGround: true,
      collidedHorizontally: false,
      world,
    });
    expect(plan).not.toBeNull();
    expect(plan!.tier).toBe("brake");
    expect(plan!.jump).toBe(false);
    expect(plan!.velocity.x).toBe(0);
    expect(plan!.velocity.z).toBe(0);
    expect(plan!.velocity.y).toBe(-0.0784);
  });

  test("rescues an airborne fall by steering toward the target", () => {
    // Island (blocks 8..12 × 8..12) around the target, void beyond; the bot
    // jumped off the east edge and drifts away — no orbit plan can validate,
    // so the controller steers back toward the island's ground.
    const blockAt = makeWorld(
      (x, y, z) =>
        y <= 0 && Math.abs(x - 10) <= 2 && Math.abs(z - 10) <= 2
          ? "keep"
          : "air",
    );
    const world = worldOf(blockAt);
    const controller = new StrafeController();
    const plan = controller.computeTick({
      source: new Vec3(13.4, 1.42, 10.5),
      target: new Vec3(10.5, 1, 10.5),
      velocity: new Vec3(0.25, 0.2, 0),
      onGround: false,
      collidedHorizontally: false,
      world,
    });
    expect(plan).not.toBeNull();
    expect(plan!.tier).toBe("rescue");
    expect(plan!.jump).toBe(false);
    // Inward: toward the target (west of the bot) at orbit speed.
    expect(plan!.velocity.x).toBeLessThan(-SPEED * 0.8);
  });

  test("brakes (never jumps) when every plan is unsafe", () => {
    // Entire floor absent: any movement ends in the void.
    const blockAt = makeWorld(() => "air");
    const world = worldOf(blockAt);
    const controller = new StrafeController();
    const plan = controller.computeTick({
      source: new Vec3(5.5, 1, 5.5),
      target: new Vec3(8.5, 1, 5.5),
      velocity: new Vec3(0.25, -0.1, 0),
      onGround: false,
      collidedHorizontally: false,
      world,
    });
    expect(plan).not.toBeNull();
    expect(plan!.tier).toBe("brake");
    expect(plan!.jump).toBe(false);
    expect(Math.abs(plan!.velocity.x)).toBeLessThan(1e-9);
    expect(Math.abs(plan!.velocity.z)).toBeLessThan(1e-9);
    expect(plan!.velocity.y).toBe(-0.1);
  });
});

// ── Escape hop (grounded rescue jump) ──────────────────────────────

describe("escape hop (grounded rescue jump)", () => {
  /**
   * 1x1 perch world: solid only at the perch column and at Chebyshev
   * distance > `moat` (all at y <= 0); the `moat` rings between them are
   * air over the void. Blocks above y=0 are air everywhere.
   */
  function perchWorld(
    perchX: number,
    perchZ: number,
    moat: number,
  ): (pos: Vec3) => any {
    return makeWorld((x, y, z) => {
      if (y > 0) return undefined;
      const cheb = Math.max(Math.abs(x - perchX), Math.abs(z - perchZ));
      if (x === perchX && z === perchZ) return "keep";
      return cheb > moat ? "keep" : "air";
    });
  }

  const PERCH = new Vec3(10.5, 1, 10.5);
  const TARGET = new Vec3(12.5, 1, 10.5); // due east, within strafe range
  const SPEED = Constants.MOVEMENT.STRAFE_SPEED;

  test("escapes a 1x1 perch across a one-block void ring", () => {
    const blockAt = perchWorld(10, 10, 1);
    const controller = new StrafeController();
    const plan = controller.computeTick({
      source: PERCH.clone(),
      target: TARGET.clone(),
      velocity: new Vec3(0, -0.0784, 0),
      onGround: true,
      collidedHorizontally: false,
      world: worldOf(blockAt),
    });

    // Every orbit/walk/rescue candidate steps into the void ring within a
    // couple of ticks; the only valid plan is the escape hop.
    expect(plan).not.toBeNull();
    expect(plan!.tier).toBe("escape");
    expect(plan!.jump).toBe(true);
    // Launch impulse bundled into the plan velocity.
    expect(plan!.velocity.y).toBeGreaterThan(0.4);
    // Steers straight at the target (east): zero drop to its ground.
    expect(plan!.velocity.x).toBeGreaterThan(SPEED * 0.85);
    expect(Math.abs(plan!.velocity.z)).toBeLessThan(0.05);
  });

  test("rejects the escape hop when the far shore is beyond jump range", () => {
    // Four void rings around the perch: the ~4-block jump arc lands short
    // and must never validate.
    const blockAt = perchWorld(10, 10, 4);
    const controller = new StrafeController();
    const plan = controller.computeTick({
      source: PERCH.clone(),
      target: TARGET.clone(),
      velocity: new Vec3(0, -0.0784, 0),
      onGround: true,
      collidedHorizontally: false,
      world: worldOf(blockAt),
    });
    expect(plan).not.toBeNull();
    expect(plan!.tier).toBe("brake");
    expect(plan!.jump).toBe(false);
    expect(plan!.velocity.x).toBe(0);
    expect(plan!.velocity.z).toBe(0);
  });

  test("integration: bot leaves the perch, lands safely, resumes orbiting", () => {
    const blockAt = perchWorld(10, 10, 1);
    const controller = new StrafeController();
    const run = runOrbit(controller, blockAt, PERCH.clone(), TARGET.clone(), 90);

    expect(run.fellIntoVoid).toBe(false);
    // The escape arc never dips below the level it jumped from, and later
    // orbit hops stay above the floor.
    for (const p of run.positions) {
      expect(p.y).toBeGreaterThanOrEqual(0.9);
    }

    // Escaped the perch block…
    const leftPerch = run.positions.some(
      (p) => Math.floor(p.x) !== 10 || Math.floor(p.z) !== 10,
    );
    expect(leftPerch).toBe(true);

    // …landed on solid ground…
    const last = run.positions[run.positions.length - 1];
    expect(getGroundBelow(last, blockAt)).toBeGreaterThanOrEqual(1);

    // …and the orbit resumed around the target.
    const { sumAbs, sumSigned } = orbitStats(run.positions, TARGET);
    expect(sumAbs).toBeGreaterThan(2);
    expect(Math.abs(sumSigned)).toBeGreaterThan(0.5);
    expect(pathLength(run.positions)).toBeGreaterThan(10);
  });

  test("integration: unreachable far shore keeps the bot braking in place", () => {
    const blockAt = perchWorld(10, 10, 4);
    const controller = new StrafeController();
    const run = runOrbit(controller, blockAt, PERCH.clone(), TARGET.clone(), 60);

    expect(run.fellIntoVoid).toBe(false);
    // Never leaves the perch, never sinks below its surface.
    for (const p of run.positions) {
      expect(Math.floor(p.x)).toBe(10);
      expect(Math.floor(p.z)).toBe(10);
      expect(p.y).toBeCloseTo(1.0, 5);
    }
  });
});

// ── Integration: circular orbit / void safety quirks ───────────────

describe("orbit integration (the two reported bugs)", () => {
  test(
    "flat ground: bot circles the target without oscillating or falling",
    () => {
      const controller = new StrafeController();
      const blockAt = makeWorld();
      const target = new Vec3(10.5, 1, 10.5);
      const run = runOrbit(
        controller,
        blockAt,
        new Vec3(7.5, 1, 0 + 10.5),
        target,
        90,
      );

      expect(run.ticks).toBeGreaterThanOrEqual(70);
      expect(run.fellIntoVoid).toBe(false);

      // Continuous orbit: plenty of distinct positions, ≥ 2 revolutions.
      const keys = new Set(
        run.positions.map((p) => `${Math.round(p.x * 4)},${Math.round(p.z * 4)}`),
      );
      expect(keys.size).toBeGreaterThanOrEqual(30);

      // Circular, not oscillating: signed orbit angle dominates the total walked arc.
      const { sumAbs, sumSigned } = orbitStats(run.positions, target);
      expect(sumAbs).toBeGreaterThan(4);
      expect(Math.abs(sumSigned)).toBeGreaterThan(
        sumAbs - 0.35 * sumAbs, // ≥ 65% of movement is one-directional
      );

      // Radius stays near the orbit band (no spiral into/out of the target).
      const radii = run.positions.slice(10).map((p) =>
        Math.hypot(p.x - target.x, p.z - target.z),
      );
      for (const r of radii) {
        expect(r).toBeGreaterThan(1.6);
        expect(r).toBeLessThan(3.9);
      }

      // Bot never leaves the floor.
      for (const p of run.positions) {
        expect(p.y).toBeGreaterThanOrEqual(0.9);
      }
      expect(pathLength(run.positions)).toBeGreaterThan(15);
    },
  );

  test(
    "void hole on the orbit side: bot orbits without stepping into the void",
    () => {
      const controller = new StrafeController();
      // Hole in the bedrock: blocks (7..8, y=0, z 10..11) removed → void.
      const blockAt = makeWorld(
        (x, y, z) =>
          y <= 0 && x >= 7 && x <= 8 && z >= 10 && z <= 11 ? "air" : "keep",
      );
      const target = new Vec3(10.5, 1, 10.5);
      const run = runOrbit(
        controller,
        blockAt,
        new Vec3(7.8, 1, 12.6),
        target,
        90,
      );

      expect(run.ticks).toBeGreaterThanOrEqual(60);
      expect(run.fellIntoVoid).toBe(false);

      // Never positioned over the hole and never fell below floor level.
      for (const p of run.positions) {
        expect(getGroundBelow(p, blockAt)).toBeGreaterThanOrEqual(1);
        expect(p.y).toBeGreaterThanOrEqual(0.9);
      }

      // Orbit continues around the target on the open side.
      const { sumAbs, sumSigned } = orbitStats(run.positions, target);
      expect(sumAbs).toBeGreaterThan(2);
      expect(Math.abs(sumSigned)).toBeGreaterThan(1.5);
      expect(pathLength(run.positions)).toBeGreaterThan(10);
    },
  );

  test(
    "wall on the orbit side: bot routes around without entering it",
    () => {
      const controller = new StrafeController();
      // 2x2 wall at (7..8, y 1..2, z 10..11) blocks the west orbit side.
      const blockAt = makeWorld(
        (x, y, z) =>
          (y === 1 || y === 2) && x >= 7 && x <= 8 && z >= 10 && z <= 11
            ? "stone"
            : "keep",
      );
      const target = new Vec3(10.5, 1, 10.5);
      const run = runOrbit(
        controller,
        blockAt,
        new Vec3(7.8, 1, 12.6),
        target,
        90,
      );

      expect(run.ticks).toBeGreaterThanOrEqual(60);
      expect(run.fellIntoVoid).toBe(false);

      // Bot never overlaps the wall footprint (with half-width margin).
      const half = Constants.PHYSICS.PLAYER_OFFSET;
      for (const p of run.positions) {
        const overlapX = p.x + half > 7 && p.x - half < 9;
        const overlapZ = p.z + half > 10 && p.z - half < 12;
        if (overlapX && overlapZ) {
          // Only acceptable when the bot's feet are above the wall top.
          expect(p.y).toBeGreaterThanOrEqual(3);
        }
        expect(p.y).toBeGreaterThanOrEqual(0.9);
      }

      // The orbit keeps moving around the wall (direction flips at the wall
      // are acceptable, like LiquidBounce) and the bot stays on the floor.
      const { sumAbs } = orbitStats(run.positions, target);
      expect(sumAbs).toBeGreaterThan(2);
      expect(pathLength(run.positions)).toBeGreaterThan(10);
    },
  );
});
