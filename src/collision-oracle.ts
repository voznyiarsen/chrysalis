/**
 * @fileoverview CollisionOracle — obstacle-agnostic collision queries.
 *
 * Wraps the project's AABB-based collision detection behind a simple
 * interface so callers (pearl solver, strafe controller, jump path)
 * don't depend on block-query plumbing.
 */

import { Vec3 } from "vec3";
import { AABB } from "./utils";

/**
 * Tests whether a swept sphere (or point with radius) travelling from
 * `from` to `to` is free of collisions.
 *
 * Thin wrapper over sweepAABB with the player radius as half-width.
 * For ballistic-arc queries use isJumpPathClear from movement.ts.
 *
 * @param from - Start position (feet-level)
 * @param to - End position (feet-level)
 * @param blockAt - Block lookup callback (bot.blockAt bound)
 * @param radius - Player half-width (default 0.3)
 * @returns true if the path is clear
 */
export function isPathClear(
  from: Vec3,
  to: Vec3,
  blockAt: (pos: Vec3) => any,
  radius: number = 0.3,
): boolean {
  return sweepAABB(from, to, blockAt, radius);
}

/**
 * Bounding-box sweep test — checks whether a player-sized AABB can
 * travel in a straight line from `from` to `to` without intersecting
 * any solid block.
 *
 * More conservative than isPathClear (no ballistic arc); used by the
 * strafe controller where exact obstacle avoidance matters.
 *
 * @param from - Start position (feet-level)
 * @param to - End position (feet-level)
 * @param blockAt - Block lookup callback
 * @param halfWidth - Player half-width (default 0.3)
 * @param height - Player height (default 1.8)
 * @returns true if the swept AABB hits no solid blocks
 */
export function sweepAABB(
  from: Vec3,
  to: Vec3,
  blockAt: (pos: Vec3) => any,
  halfWidth: number = 0.3,
  height: number = 1.8,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return true;

  const steps = Math.ceil(dist / 0.1);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + dx * t;
    const y = from.y + dy * t;
    const z = from.z + dz * t;

    const minX = Math.floor(x - halfWidth);
    const maxX = Math.floor(x + halfWidth);
    const minY = Math.floor(y);
    const maxY = Math.floor(y + height);
    const minZ = Math.floor(z - halfWidth);
    const maxZ = Math.floor(z + halfWidth);

    for (let bx = minX; bx <= maxX; bx++) {
      for (let by = minY; by <= maxY; by++) {
        for (let bz = minZ; bz <= maxZ; bz++) {
          const block = blockAt(new Vec3(bx, by, bz));
          if (!block || block.boundingBox === "empty") continue;
          if (block.shapes && block.shapes.length > 0) {
            for (const s of block.shapes) {
              if (
                x + halfWidth > bx + s[0] &&
                x - halfWidth < bx + s[3] &&
                y + height > by + s[1] &&
                y < by + s[4] &&
                z + halfWidth > bz + s[2] &&
                z - halfWidth < bz + s[5]
              ) {
                return false;
              }
            }
          } else {
            return false;
          }
        }
      }
    }
  }
  return true;
}

/**
 * Build an AABB for a player standing at the given feet position.
 */
export function playerAABB(pos: Vec3, halfWidth = 0.3, height = 1.8): AABB {
  return new AABB(
    pos.x - halfWidth,
    pos.y,
    pos.z - halfWidth,
    pos.x + halfWidth,
    pos.y + height,
    pos.z + halfWidth,
  );
}

export { AABB };
