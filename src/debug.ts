/**
 * Debug module for Pupa bot
 * Contains test commands and debugging utilities
 */

import util from "node:util";
import { logger, Logger } from "./logger";
import { Constants } from "./constants";
import { Vec3 } from "vec3";
import { Bot } from "mineflayer";

interface Args {
  [index: number]: string;
}

/**
 * Attaches debug commands to a bot instance
 */
class DebugManager {
  public bot: Bot;
  public logger: Logger;
  public strafeLooping: boolean = false;

  /**
   * @param bot - Mineflayer bot instance
   */
  constructor(bot: Bot) {
    this.bot = bot;
    this.logger = (bot as any).__logger;
    logger.setDebugMode(true);
    this.setupDebugCommands();
  }

  /**
   * Register debug commands with the command registry
   */
  setupDebugCommands(): void {
    if (!(this.bot as any).commandManager) {
      this.logger.error(new Error(`Command registry not initialized`));
      return;
    }

    const cm = (this.bot as any).commandManager;

    cm.registerCommand("debug_strafe_once", {
      description: "Single strafe test at (+3, 0, 0)",
      handler: async (_args: string[]) => {
        await this.debugStrafeOnce();
      },
    });

    cm.registerCommand("debug_strafe_loop", {
      description: "Loop the strafe test (call again to stop)",
      handler: async (_args: string[]) => {
        await this.debugStrafeLoop();
      },
    });

    cm.registerCommand("debug_pearl_throw", {
      description: "Throw a pearl at nearest player with offset and arc mode",
      handler: async (args: string[]) => {
        await this.debugPearlThrow(args);
      },
    });

    cm.registerCommand("debug_jump_path", {
      description:
        "Test isJumpPathClear against nearest player's current position",
      handler: async () => {
        await this.debugJumpPath();
      },
    });

    cm.registerCommand("debug_collision_stress", {
      description: "Batch test isJumpPathClear with 9 scenarios",
      handler: async () => {
        await this.debugCollisionStress();
      },
    });

    cm.registerCommand("debug_jump_test", {
      description: "Test jump towards a relative point (+3, 0, 0)",
      handler: async () => {
        await this.debugJumpTest();
      },
    });

    cm.registerCommand("debug_e2e_attack", {
      description: "E2E: Basic attack flow",
      handler: async () => {
        await this.debugE2eAttack();
      },
    });

    cm.registerCommand("debug_e2e_goal", {
      description: "E2E: Goal-directed movement while in combat",
      handler: async () => {
        await this.debugE2eGoal();
      },
    });

    cm.registerCommand("debug_e2e_strafe_goal", {
      description: "E2E: Strafing while moving toward a goal",
      handler: async () => {
        await this.debugE2eStrafeGoal();
      },
    });

    this.logger.debug(`Debug commands registered`);
  }

  /**
   * Test strafe movement once around a relative point (+3, 0, 0).
   */
  async debugStrafeOnce(): Promise<void> {
    this.strafeLooping = false;
    const center = new Vec3(
      Math.floor(this.bot.entity!.position.x) + 0.5,
      this.bot.entity!.position.y,
      Math.floor(this.bot.entity!.position.z) + 0.5,
    );
    await (this.bot as any).combatManager.nudgeToCenter(center);
    const fixedPoint = this.bot.entity!.position.offset(3, 0, 0);
    (this.bot as any).combatManager.doStrafe(fixedPoint);
    this.logger.debug(
      `Executed single strafe test around ${fixedPoint.toString()}`,
    );
  }

  /**
   * Loop the strafe movement test around a relative point (+3, 0, 0).
   * Stops if test0 is called or another command sets strafeLooping to false.
   */
  async debugStrafeLoop(): Promise<void> {
    if (this.strafeLooping) {
      this.strafeLooping = false;
      this.logger.debug("Stopped strafe loop test");
      return;
    }

    this.strafeLooping = true;
    const center = new Vec3(
      Math.floor(this.bot.entity!.position.x) + 0.5,
      this.bot.entity!.position.y,
      Math.floor(this.bot.entity!.position.z) + 0.5,
    );
    await (this.bot as any).combatManager.nudgeToCenter(center);
    const fixedPoint = this.bot.entity!.position.offset(3, 0, 0);
    this.logger.debug(
      `Starting strafe loop test around ${fixedPoint.toString()}`,
    );

    while (this.strafeLooping) {
      (this.bot as any).combatManager.doStrafe(fixedPoint);
      await this.bot.waitForTicks!(2);
    }
  }

  /**
   * Throw a pearl at the nearest player with the given arc mode and relative offset.
   Usage: debug_pearl_throw <mode> <axis-offsets>
   *   mode: low | high | auto
   *   axis-offsets: x+2.5 y-1.0 z+0.75
   */
  async debugPearlThrow(args: Args): Promise<void> {
    const mode = args[1];

    // Parse axis offsets: "x+2.5" -> 2.5, "y-1.0" -> -1.0
    const parseAxis = (s: string) => parseFloat(s.slice(1));
    const offset = new Vec3(
      parseAxis(args[2]),
      parseAxis(args[3]),
      parseAxis(args[4]),
    );

    // Compute target position: nearest player offset by the given vector
    const filter = (e: any) =>
      e.type === "player" && e.username !== this.bot.username;
    const target = this.bot.nearestEntity!(filter);
    if (!target) {
      this.logger.error(
        new Error(
          `No player found for test2 (mode=${mode}, offset=${offset.toString()})`,
        ),
      );
      return;
    }

    const targetPos = target
      .position!.offset(0, target.height! / 2, 0)
      .plus(offset);
    this.logger.debug(
      `Throwing ${mode} arc pearl at ${target.username} offset by ${offset.toString()}`,
    );

    await this.debugPearlArc(mode as "low" | "high" | "auto", targetPos);
  }

  /**
   * Test isJumpPathClear against the nearest player's current position.
   * Logs whether the jump arc is clear or blocked.
   */
  async debugJumpPath(): Promise<void> {
    const filter = (e: any) =>
      e.type === "player" && e.username !== this.bot.username;
    const target = this.bot.nearestEntity!(filter);
    if (!target) {
      this.logger.error(new Error("No player found for test5"));
      return;
    }

    const source = this.bot.entity!.position;
    const strafePoint = target.position!;

    this.logger.debug(
      `Testing jump path to ${target.username} at ${strafePoint.x.toFixed(1)}, ${strafePoint.y.toFixed(1)}, ${strafePoint.z.toFixed(1)} from ${this.bot.entity!.position.x.toFixed(1)}, ${this.bot.entity!.position.y.toFixed(1)}, ${this.bot.entity!.position.z.toFixed(1)}`,
    );

    const isClear = (this.bot as any).utilsManager.isJumpPathClear(
      source,
      strafePoint,
    );

    if (isClear) {
      this.logger.debug(`Jump path to ${target.username} is CLEAR`);
    } else {
      this.logger.debug(`Jump path to ${target.username} is BLOCKED`);
    }
  }

  /**
   * Test the isJumpPathClear method with 9 scenarios.
   * Player at X=0, Z=0 (Y=0 and Y=1), Bot at X=3, Z=0 (Y=0 and Y=1).
   * Obstacle positions defined in 4-width by 3-height grid.
   */
  async debugCollisionStress(): Promise<void> {
    // Define test scenarios: obstacle positions (x, y, z), null means no obstacle
    const scenarios: {
      name: string;
      obstacle: { x: number; y: number; z: number } | null;
    }[] = [
      { name: "Test 0", obstacle: null },
      { name: "Test 1", obstacle: { x: 1, y: 1, z: 0 } },
      { name: "Test 2", obstacle: { x: 2, y: 1, z: 0 } },
      { name: "Test 3", obstacle: { x: 1, y: 2, z: 0 } },
      { name: "Test 4", obstacle: { x: 2, y: 2, z: 0 } },
      { name: "Test 5", obstacle: { x: 0, y: 3, z: 0 } },
      { name: "Test 6", obstacle: { x: 1, y: 3, z: 0 } },
      { name: "Test 7", obstacle: { x: 2, y: 3, z: 0 } },
      { name: "Test 8", obstacle: { x: 3, y: 3, z: 0 } },
    ];

    const botSource = new Vec3(3.5, 1, 0.5);
    const playerPos = new Vec3(0.5, 1, 0.5);

    for (const scenario of scenarios) {
      // Position bot using /tp command
      this.bot.chat!(`/tp ${this.bot.username} 3 1 0`);
      await this.bot.waitForTicks!(3);

      // Place obstacle using setblock command (skip if no obstacle)
      if (scenario.obstacle) {
        const obs = scenario.obstacle;
        this.bot.chat!(`/setblock ${obs.x} ${obs.y} ${obs.z} dirt`);
        await this.bot.waitForTicks!(3);
      }

      // Output positions in requested format
      this.logger.debug(
        `${botSource.toString()}, ${playerPos.toString()}, ${scenario.obstacle ? scenario.obstacle.x + ", " + scenario.obstacle.y + ", " + scenario.obstacle.z : "none"}`,
      );

      // Test isJumpPathClear
      const isClear = (this.bot as any).utilsManager.isJumpPathClear(
        botSource,
        playerPos,
      );

      this.logger.debug(`${scenario.name}: ${isClear ? "CLEAR" : "BLOCKED"}`);

      // Remove obstacle for next test (skip if no obstacle)
      if (scenario.obstacle) {
        const obs = scenario.obstacle;
        this.bot.chat!(`/setblock ${obs.x} ${obs.y} ${obs.z} air`);
        await this.bot.waitForTicks!(3);
      }
    }
  }

  /**
   * Test a jump towards a relative point (+3, 0, 0).
   * Centers the bot before jumping.
   */
  async debugJumpTest(): Promise<void> {
    const center = new Vec3(
      Math.floor(this.bot.entity!.position.x) + 0.5,
      this.bot.entity!.position.y,
      Math.floor(this.bot.entity!.position.z) + 0.5,
    );
    await (this.bot as any).combatManager.nudgeToCenter(center);

    const target = this.bot.entity!.position.offset(3, 0, 0);
    const jumpSource = this.bot.entity!.position.clone();

    // Log state before the jump
    const preDist = Math.hypot(
      target.x - jumpSource.x,
      target.z - jumpSource.z,
    );
    this.logger.debug(
      `Pre-jump state: bot=${jumpSource.toString().slice(0, 30)} target=${target.toString().slice(0, 30)} dist=${preDist.toFixed(3)}`,
    );

    const impulse = (this.bot as any).utilsManager.getJumpVelocity(
      jumpSource,
      target,
    );

    if (impulse) {
      this.logger.debug(`Jumping to ${target.toString()}`);

      const utils = (this.bot as any).utilsManager;
      const originalApplyImpulse = utils.applyImpulse.bind(utils);
      const startTick = this.bot.time!.age;

      // Override applyImpulse to log every call for the next 40 ticks
      utils.applyImpulse = (
        imp: Vec3,
        mode: string = "add",
        force: boolean = false,
      ) => {
        this.logger.debug(
          `ApplyImpulse: (${imp.x.toFixed(4)}, ${imp.y.toFixed(4)}, ${imp.z.toFixed(4)}) [${mode}]`,
        );
        const result = originalApplyImpulse(imp, mode, force);

        // Self-restore after 40 ticks
        if (this.bot.time!.age - startTick >= 40) {
          utils.applyImpulse = originalApplyImpulse;
        }
        return result;
      };

      utils.applyImpulse(impulse, "set", true);

      // Wait a tick for velocity to apply
      await this.bot.waitForTicks!(1);

      // Wait for the entity to land after applying impulse
      while (!this.bot.entity.onGround) {
        await this.bot.waitForTicks!(1);
      }

      const postPos = this.bot.entity!.position;
      const postDist = Math.hypot(target.x - postPos.x, target.z - postPos.z);
      const withinTolerance = postDist <= 0.3;

      // Calculate overshoot/undershoot along jump direction
      const jumpDir = new Vec3(
        target.x - jumpSource.x,
        0,
        target.z - jumpSource.z,
      ).normalize();
      const toTarget = new Vec3(target.x - postPos.x, 0, target.z - postPos.z);
      const alongJump = toTarget.dot(jumpDir); // negative = overshoot, positive = undershoot
      const overshoot = alongJump < 0 ? "overshoot" : "undershoot";
      const overshootAmount = Math.abs(alongJump);

      this.logger.debug(
        `Post-jump state:  bot=${postPos.toString().slice(0, 30)} target=${target.toString().slice(0, 30)} dist=${postDist.toFixed(3)} ${withinTolerance ? "✓" : "✗"}`,
      );

      if (withinTolerance) {
        this.logger.debug(
          `Jump landed within tolerance (${postDist.toFixed(3)} <= 0.3)`,
        );
      } else {
        this.logger.debug(
          `Jump ${overshoot} by ${overshootAmount.toFixed(3)} blocks (dist=${postDist.toFixed(3)} > 0.3)`,
        );
      }
    } else {
      this.logger.error(new Error("Cannot calculate jump velocity for test7"));
    }
  }

  /**
   * E2E: Test basic attack flow.
   * Attacks the nearest player, waits 40 ticks, then stops.
   */
  async debugE2eAttack(): Promise<void> {
    const filter = (e: any) =>
      e.type === "player" && e.username !== this.bot.username;
    const target = this.bot.nearestEntity!(filter);
    if (!target) {
      this.logger.error(new Error("No player found for e2e_attack"));
      return;
    }

    this.logger.debug(`e2e_attack: attacking ${target.username}`);
    await (this.bot as any).pvp.attack(target);
    await this.bot.waitForTicks!(40);
    await (this.bot as any).pvp.stop();
    this.logger.debug("e2e_attack: complete");
  }

  /**
   * E2E: Test goal-directed movement while in combat.
   * Attacks nearest player, sets a goal 10 blocks east, waits 100 ticks.
   */
  async debugE2eGoal(): Promise<void> {
    const filter = (e: any) =>
      e.type === "player" && e.username !== this.bot.username;
    const target = this.bot.nearestEntity!(filter);
    if (!target) {
      this.logger.error(new Error("No player found for e2e_goal"));
      return;
    }

    this.logger.debug(`e2e_goal: attacking ${target.username} with goal`);
    await (this.bot as any).pvp.attack(target);

    const goalPos = this.bot.entity!.position.offset(10, 0, 0);
    this.logger.debug(
      `e2e_goal: set goal to ${goalPos.toString().slice(0, 30)}`,
    );
    (this.bot as any).pvp.setGoal(goalPos);

    await this.bot.waitForTicks!(100);
    (this.bot as any).pvp.clearGoal();
    await (this.bot as any).pvp.stop();
    this.logger.debug("e2e_goal: complete");
  }

  /**
   * E2E: Test strafing while moving toward a goal.
   * Attacks nearest player, sets a nearby goal, waits 80 ticks.
   */
  async debugE2eStrafeGoal(): Promise<void> {
    const filter = (e: any) =>
      e.type === "player" && e.username !== this.bot.username;
    const target = this.bot.nearestEntity!(filter);
    if (!target) {
      this.logger.error(new Error("No player found for e2e_strafe_goal"));
      return;
    }

    this.logger.debug(
      `e2e_strafe_goal: attacking ${target.username} with nearby goal`,
    );
    await (this.bot as any).pvp.attack(target);

    // Set a goal just a few blocks away to test combined strafe+goal behavior
    const goalPos = this.bot.entity!.position.offset(4, 0, 3);
    this.logger.debug(
      `e2e_strafe_goal: goal=${goalPos.toString().slice(0, 30)}`,
    );
    (this.bot as any).pvp.setGoal(goalPos);

    await this.bot.waitForTicks!(80);
    (this.bot as any).pvp.clearGoal();
    await (this.bot as any).pvp.stop();
    this.logger.debug("e2e_strafe_goal: complete");
  }

  /**
   * Helper to test pearl throws with a specific arc preference.
   * @param arcType - Which arc to attempt, or "auto" to pick the best
   * @param overrideTargetPos - Optional target position (otherwise uses nearest player)
   */
  async debugPearlArc(
    arcType: "low" | "high" | "auto",
    overrideTargetPos?: Vec3,
  ): Promise<void> {
    let target: any;
    let targetPos: Vec3;

    if (overrideTargetPos) {
      targetPos = overrideTargetPos;
      // Find the nearest player for display name only (may be null)
      const filter = (e: any) =>
        e.type === "player" && e.username !== this.bot.username;
      target = this.bot.nearestEntity!(filter);
    } else {
      const filter = (e: any) =>
        e.type === "player" && e.username !== this.bot.username;
      target = this.bot.nearestEntity!(filter);
      if (!target) {
        this.logger.error(new Error(`No player found for ${arcType} arc test`));
        return;
      }
      targetPos = target.position!.offset(0, target.height! / 2, 0);
    }

    const eyePos = this.bot.entity!.position.offset(
      0,
      this.bot.entity!.height!,
      0,
    );

    // Auto mode delegates to the combat manager's pitch selection logic
    if (arcType === "auto") {
      const result = (this.bot as any).combatManager.getBestPearlPitch(
        eyePos,
        targetPos,
      );
      if (!result) {
        this.logger.error(new Error("Cannot reach target with pearl"));
        return;
      }
      const { pitch, arc } = result;
      const yaw = Math.atan2(eyePos.x - targetPos.x, eyePos.z - targetPos.z);

      this.logger.debug(`Throwing ${arc} arc pearl at ${target.username}`);
      await (this.bot as any).inventoryManager.equipPearl(yaw, pitch);
      (this.bot as any).combatManager.lastPearlTime = Date.now();
      return;
    }

    const { VELOCITY, GRAVITY, DRAG } = Constants.COMBAT.ENDER_PEARL;
    const pitches = (this.bot as any).utilsManager.getProjectilePitch(
      eyePos,
      targetPos,
      VELOCITY,
      GRAVITY,
      DRAG,
    );

    if (pitches.length === 0) {
      this.logger.error(
        new Error(`Cannot reach target with pearl (${arcType} arc)`),
      );
      return;
    }

    // pitches[0] is low arc, pitches[1] is high arc
    const pitch = arcType === "low" ? pitches[0] : pitches[1] || pitches[0];
    const yaw = Math.atan2(eyePos.x - targetPos.x, eyePos.z - targetPos.z);

    this.logger.debug(`Throwing ${arcType} arc pearl at ${target.username}`);
    await (this.bot as any).inventoryManager.equipPearl(yaw, pitch);
    (this.bot as any).combatManager.lastPearlTime = Date.now();
  }
}

/**
 * Attach the DebugManager to a bot instance.
 * @param bot - Mineflayer bot instance
 * @returns The same bot instance with debugManager attached
 */
export default function attach(bot: Bot): Bot {
  (bot as any).debugManager = new DebugManager(bot);
  (bot as any).debugManager.bot = bot;
  return bot;
}

export { DebugManager };
