/**
 * @fileoverview Main-thread side of the ender pearl launch point solver.
 *
 * The launch point search simulates a trajectory for every candidate spot
 * around the bot. That is far too slow to run on the main thread (it
 * stalls the client's tick loop), so it runs in a worker thread
 * ({@link module:pearl-solver-worker}).
 *
 * The worker needs the blocks of the region it flies over. Taking that
 * snapshot is the only part that has to happen on the main thread, and it
 * is a single pass over the region instead of the tens of thousands of
 * lookups the simulation would do on its own.
 */

import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { Constants } from "./constants";
import type { PearlTopLanding } from "./projectile";
import type {
  LaunchCandidate,
  LaunchPointRequest,
  LaunchPointResult,
} from "./pearl-solver-worker";

/** Floats per block in the snapshot: the position, the AABB and the flags. */
const BLOCK_STRIDE = 10;
/**
 * How many blocks the snapshot may hold. The extraction is the only part
 * of the solve that runs on the main thread, so it has to stay small.
 */
const MAX_SNAPSHOT_BLOCKS = 12000;
const FLAG_WATER = 1;

/** A launch point with the throw that works from it. */
export interface LaunchPointSolution {
  launchPos: Vec3;
  landing: PearlTopLanding;
}

/**
 * Runs the launch point search in a worker thread.
 *
 * The solver is asynchronous: a request is posted to the worker and the
 * answer arrives later. The caller keeps using the last known solution
 * (a launch point is a spot on the ground, so it stays valid) and asks
 * again when the target moves.
 */
export class PearlSolver {
  private readonly bot: Bot;
  /** Called with the solution of a finished search. */
  onSolution: ((solution: LaunchPointSolution | null) => void) | null = null;
  /**
   * Whether the worker is usable. False when the worker could not be
   * started (the compiled worker file is missing) or crashed — the caller
   * then falls back to the synchronous search.
   */
  available = true;
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, LaunchPointSolution | null>();
  /** Whether a search is still running. */
  private inFlight = false;
  /** When the running search was started (for the timing log). */
  private startedAt = 0;

  constructor(bot: Bot) {
    this.bot = bot;
  }

  /**
   * The solution of the last finished search, if any.
   *
   * The launch point is a spot on the ground: it stays valid as long as
   * the target stays put, so the result can be used for several throws.
   */
  get solution(): LaunchPointSolution | null {
    // The newest result wins: a search that finished after a newer one
    // was requested is stale.
    let newest: { id: number; value: LaunchPointSolution | null } | null = null;
    for (const [id, value] of this.pending) {
      if (!newest || id > newest.id) newest = { id, value };
    }
    return newest?.value ?? null;
  }

  /**
   * Ask the worker for a launch point.
   *
   * The request is dropped when one is already running: the search is
   * expensive and the answer is only useful for a target that stays put.
   *
   * @param aim - The point the pearl has to land on
   * @param candidates - The launch points to test, closest first
   */
  request(aim: Vec3, candidates: LaunchCandidate[]): void {
    if (this.inFlight || candidates.length === 0) return;
    const worker = this._ensureWorker();
    if (!worker) return;

    const id = this.nextId++;
    this.inFlight = true;
    this.startedAt = Date.now();
    this.bot.__logger?.debug?.(
      `Pearl solver: searching ${candidates.length} launch points for the aim ${aim.x.toFixed(1)},${aim.y.toFixed(1)},${aim.z.toFixed(1)}`,
      "Combat",
    );
    const request: LaunchPointRequest = {
      id,
      aim: { x: aim.x, y: aim.y, z: aim.z },
      velocity: Constants.COMBAT.ENDER_PEARL.VELOCITY,
      gravity: Constants.COMBAT.ENDER_PEARL.GRAVITY,
      drag: Constants.COMBAT.ENDER_PEARL.DRAG,
      candidates,
      blocks: this._snapshot(candidates, aim),
      entities: this._nearbyEntities(aim),
    };
    worker.postMessage(request);
  }

  /** Stop the worker (the bot is going away). */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }

  private _ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const workerPath = resolveWorkerPath();
      if (!workerPath) {
        this.available = false;
        return null;
      }
      this.worker = new Worker(workerPath);
      // The worker must not keep the process alive on its own.
      this.worker.unref();
      this.worker.on("message", (result: LaunchPointResult) => {
        this.inFlight = false;
        const solution = this._toSolution(result);
        this.pending.set(result.id, solution);
        this.bot.__logger?.debug?.(
          `Pearl solver: launch point search finished (${solution ? "found" : "no launch point"}) in ${Date.now() - this.startedAt}ms`,
          "Combat",
        );
        this.onSolution?.(solution);
      });
      this.worker.on("error", (error) => {
        this.inFlight = false;
        this.worker = null;
        this.available = false;
        this.bot.__logger?.warn?.(
          `Pearl solver worker failed: ${(error as Error).message}`,
          "Combat",
        );
      });
      return this.worker;
    } catch {
      this.worker = null;
      this.available = false;
      return null;
    }
  }

  private _toSolution(
    result: LaunchPointResult,
  ): LaunchPointSolution | null {
    if (!result.launchPos || !result.landing) return null;
    return {
      launchPos: new Vec3(
        result.launchPos.x,
        result.launchPos.y,
        result.launchPos.z,
      ),
      landing: result.landing,
    };
  }

  /**
   * The blocks the worker needs: the column above every candidate and the
   * corridor the pearl flies through.
   *
   * The corridor is sampled at full resolution — a missing block would
   * make the simulated flight pass through a wall and pick a launch point
   * the pearl cannot reach. The region is capped, and the step grows when
   * the flight is very long.
   */
  private _snapshot(
    candidates: LaunchCandidate[],
    aim: Vec3,
  ): Float32Array {
    const blockAt = (pos: Vec3): any => this.bot.blockAt(pos, true);
    const records: number[] = [];
    const seen = new Set<number>();
    const push = (x: number, y: number, z: number): void => {
      const key = pack(x, y, z);
      if (seen.has(key)) return;
      seen.add(key);
      const block = blockAt(new Vec3(x, y, z));
      if (!block || block.boundingBox === "empty") return;
      const shape = block.shapes?.[0];
      if (!shape) return;
      const isWater = block.name === "water" || block.name === "flowing_water";
      // The block's coordinates and its local shape: the same data the
      // simulation uses on the main thread (the shape is relative to the
      // block's origin).
      records.push(
        x,
        y,
        z,
        shape[0],
        shape[1],
        shape[2],
        shape[3],
        shape[4],
        shape[5],
        isWater ? FLAG_WATER : 0,
      );
    };

    // The blocks around every candidate: the pearl leaves the hand there
    // and has to clear the ground it stands on.
    for (const candidate of candidates) {
      const bx = Math.floor(candidate.x);
      const by = Math.floor(candidate.y);
      const bz = Math.floor(candidate.z);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (let dy = -2; dy <= 3; dy++) {
            push(bx + dx, by + dy, bz + dz);
          }
        }
      }
    }

    // The corridor between the candidates and the aim: the flight passes
    // through it. It is a narrow cone around the straight line, so the
    // step only grows for very long flights.
    const xs = candidates.map((c) => c.x).concat(aim.x);
    const zs = candidates.map((c) => c.z).concat(aim.z);
    const ys = candidates.map((c) => c.y).concat(aim.y);
    const minX = Math.min(...xs) - 1;
    const maxX = Math.max(...xs) + 1;
    const minZ = Math.min(...zs) - 1;
    const maxZ = Math.max(...zs) + 1;
    const minY = Math.min(...ys) - 2;
    // The lob can peak well above the aim, so the corridor has to reach
    // over the top of the flight.
    const maxY = Math.max(...ys) + 24;
    const width = maxX - minX + 1;
    const depth = maxZ - minZ + 1;
    const height = maxY - minY + 1;
    const step = Math.max(
      1,
      Math.ceil((width * depth * height) / MAX_SNAPSHOT_BLOCKS),
    );
    for (let x = Math.floor(minX); x <= Math.ceil(maxX); x += step) {
      for (let z = Math.floor(minZ); z <= Math.ceil(maxZ); z += step) {
        for (let y = Math.floor(minY); y <= Math.ceil(maxY); y += step) {
          push(x, y, z);
        }
      }
    }

    return new Float32Array(records);
  }

  /** The entities near the aim point: a pearl that lands on one is eaten. */
  private _nearbyEntities(aim: Vec3): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    for (const entity of Object.values(this.bot.entities)) {
      const e = entity as any;
      if (!e?.position) continue;
      if (e.position.distanceTo(aim) > 4) continue;
      out.push({
        x: e.position.x,
        y: e.position.y,
        z: e.position.z,
      });
    }
    return out;
  }
}

/** Pack a block coordinate into a single number key. */
function pack(x: number, y: number, z: number): number {
  return (
    ((x + 512) & 0x3ff) |
    (((y + 512) & 0x3ff) << 10) |
    (((z + 512) & 0x3ff) << 20)
  );
}

/**
 * The worker script.
 *
 * It sits next to the compiled module in production. The test setup runs
 * the TypeScript sources directly, so the built copy is used there.
 */
function resolveWorkerPath(): string | null {
  const candidates = [
    path.join(__dirname, "pearl-solver-worker.js"),
    path.join(__dirname, "..", "dist", "src", "pearl-solver-worker.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
