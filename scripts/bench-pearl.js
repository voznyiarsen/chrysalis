/**
 * Benchmark: the cost of the pearl simulation on the main thread.
 * Usage: node --no-deprecation -r dotenv/config scripts/bench-pearl.js
 */
const mineflayer = require("mineflayer");
const { pathfinder } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");

(async () => {
  const bot = mineflayer.createBot({
    host: process.env.E2E_HOST || "nibble.internal",
    port: parseInt(process.env.E2E_PORT || "25565", 10),
    username: "bench_" + Date.now().toString(36).slice(-6),
    version: "1.12.2",
  });
  await new Promise((res, rej) => {
    bot.once("spawn", res);
    bot.once("error", rej);
    bot.once("end", () => rej(new Error("ended")));
  });
  bot.loadPlugin(pathfinder);
  const { PVPManager, attachCombat } = require("../dist/src/pvp.js");
  const { attachUtils } = require("../dist/src/utils.js");
  const { attachInventory } = require("../dist/src/inventory.js");
  bot.pvp = new PVPManager(bot);
  bot.runtimeConfig = { get: () => undefined, has: () => false };
  attachInventory(bot);
  attachCombat(bot);
  attachUtils(bot);
  await bot.waitForTicks(10);

  const cm = bot.combatManager;
  const pos = bot.entity.position;
  // A 3x3 platform three blocks up, like the enemy-above scenario.
  const bx = Math.floor(pos.x);
  const bz = Math.floor(pos.z);
  const by = Math.floor(pos.y);
  const { rconCommands } = require("../scripts/rcon");
  await rconCommands(
    "nibble.internal",
    25575,
    process.env.RCON_PASS || "b01ee0ba3413d257cdbc05e7",
    [
      `fill ${bx - 1} ${by + 2} ${bz - 1} ${bx + 1} ${by + 2} ${bz + 1} stone`,
    ],
  );
  await bot.waitForTicks(10);
  const aim = new Vec3(bx + 0.5, by + 3, bz + 0.5); // the platform top

  const time = (label, fn) => {
    const t0 = process.hrtime.bigint();
    const value = fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`${label}: ${ms.toFixed(2)}ms`);
    return value;
  };

  // 1. The direct solve (one candidate, a few pitch refinements).
  time("direct solve (overhead target)", () =>
    cm._solvePearlTopLanding(pos.offset(0, 1.52, 0), aim),
  );
  time("direct solve (30 blocks away)", () =>
    cm._solvePearlTopLanding(pos.offset(0, 1.52, 0), pos.offset(30, 0, 0)),
  );

  // 2. The launch point search: now a worker request.
  const candidates = cm._launchPointCandidates(aim);
  console.log(`candidates: ${candidates.length}`);
  time("launch point candidates", () => cm._launchPointCandidates(aim));

  const solver = cm._pearlSolver;
  if (solver) {
    const t0 = process.hrtime.bigint();
    solver.request(aim, candidates);
    const requestMs = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`worker request (snapshot + post): ${requestMs.toFixed(2)}ms`);
    // Wait for the answer.
    const t1 = process.hrtime.bigint();
    let answered = false;
    let solution = null;
    const orig = solver.onSolution;
    solver.onSolution = (s) => {
      answered = true;
      solution = s;
      orig?.(s);
    };
    for (let i = 0; i < 200 && !answered; i++) {
      await bot.waitForTicks(1);
    }
    const answerMs = Number(process.hrtime.bigint() - t1) / 1e6;
    console.log(
      `worker round trip: ${answerMs.toFixed(2)}ms (solution=${!!solution})`,
    );
  }

  // 3. The synchronous search (the fallback path) for the same aim.
  time("synchronous launch point search", () =>
    cm._findPearlLaunchPoint(aim),
  );

  // 4. The full mitigation, as the combat tree calls it.
  time("getPearlMitigation", () =>
    cm.getPearlMitigation({ ignoreCooldown: true }),
  );

  bot.quit();
  bot.end();
  process.exit(0);
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
