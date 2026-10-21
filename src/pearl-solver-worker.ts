/**
 * @fileoverview Worker thread for the ender pearl launch point search.
 *
 * The search is the expensive part of the pearl solver: it simulates a
 * trajectory for every candidate launch point around the bot, and each
 * simulation walks the flight tick by tick. On the main thread that
 * blocked the client's tick loop for the better part of a second, which
 * stalls the physics, the pathfinder and the network.
 *
 * The worker receives the blocks of the region it needs (a snapshot taken
 * on the main thread) and runs the pure trajectory math from
 * {@link module:projectile}. The result comes back as a message.
 */

import { parentPort } from "node:worker_threads";
import { Vec3 } from "vec3";
import { findPearlTopLanding, type PearlTopLanding } from "./projectile";

/** A living entity that would absorb a pearl that lands on it. */
interface EntityPoint {
  x: number;
  y: number;
  z: number;
}

/** A launch point candidate: the spot the pearl would leave from. */
export interface LaunchCandidate {
  x: number;
  y: number;
  z: number;
}

/** The request the main thread sends to the worker. */
export interface LaunchPointRequest {
  id: number;
  /** The aim point: the top surface the pearl has to land on. */
  aim: { x: number; y: number; z: number };
  /** The projectile parameters. */
  velocity: number;
  gravity: number;
  drag: number;
  /** The launch points to test, closest first. */
  candidates: LaunchCandidate[];
  /**
   * The blocks of the region, 10 floats per block:
   * x, y, z, the block's origin, the block's local shape (minX..maxZ) and
   * the flags. A flag of 1 marks water, which a pearl flies through.
   */
  blocks: Float32Array;
  /** The entities near the aim point. */
  entities: EntityPoint[];
}

/** The result the worker sends back. */
export interface LaunchPointResult {
  id: number;
  /** The launch point that works, or null when none does. */
  launchPos: LaunchCandidate | null;
  /** The landing of the throw from that launch point. */
  landing: PearlTopLanding | null;
}

const FLAG_WATER = 1;

/** Block lookup backed by the snapshot the main thread sent. */
function makeBlockLookup(blocks: Float32Array): (pos: {
  x: number;
  y: number;
  z: number;
}) => any {
  const stride = 10;
  const count = Math.floor(blocks.length / stride);
  // The blocks are stored in a flat array; a map keyed by the packed
  // coordinates keeps the lookup O(1) without a per-block object.
  const index = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    index.set(pack(blocks[o], blocks[o + 1], blocks[o + 2]), i);
  }
  return (pos) => {
    const i = index.get(pack(pos.x, pos.y, pos.z));
    if (i === undefined) return null;
    const o = i * stride;
    return {
      position: { x: blocks[o], y: blocks[o + 1], z: blocks[o + 2] },
      shapes: [
        [
          blocks[o + 3],
          blocks[o + 4],
          blocks[o + 5],
          blocks[o + 6],
          blocks[o + 7],
          blocks[o + 8],
        ],
      ],
      boundingBox: "block",
      name: (blocks[o + 9] & FLAG_WATER) ? "water" : "stone",
    };
  };
}

/** Pack a block coordinate into a single number key. */
function pack(x: number, y: number, z: number): number {
  // The region is at most a few hundred blocks wide, so 10 bits per axis
  // are enough (and the sign is handled by the offset).
  return (
    ((x + 512) & 0x3ff) |
    (((y + 512) & 0x3ff) << 10) |
    (((z + 512) & 0x3ff) << 20)
  );
}

if (parentPort) {
  parentPort.on("message", (req: LaunchPointRequest) => {
    const blockAt = makeBlockLookup(req.blocks);
    const entities = req.entities.map(
      (e) => ({ position: new Vec3(e.x, e.y, e.z) }),
    );
    const aim = new Vec3(req.aim.x, req.aim.y, req.aim.z);
    // The candidates are ordered closest first, so the first one that
    // works is the best one: the search stops there.
    for (const candidate of req.candidates) {
      // The pearl leaves the hand at the eye height minus 0.1, the same
      // origin the main thread uses.
      const source = new Vec3(candidate.x, candidate.y + 1.52, candidate.z);
      const landing = findPearlTopLanding(
        source,
        aim,
        req.velocity,
        req.gravity,
        req.drag,
        blockAt as any,
        entities as any,
      );
      if (landing) {
        const result: LaunchPointResult = {
          id: req.id,
          launchPos: candidate,
          landing,
        };
        parentPort?.postMessage(result);
        return;
      }
    }
    const result: LaunchPointResult = {
      id: req.id,
      launchPos: null,
      landing: null,
    };
    parentPort?.postMessage(result);
  });
}
