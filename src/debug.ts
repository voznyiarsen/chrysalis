/**
 * Debug module for Pupa bot
 * Contains test commands and debugging utilities
 */

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
      description: "Throw a pearl at bot position + offset with arc mode",
      handler: async (args: string[]) => {
        await this.debugPearlThrow(args);
      },
    });

    cm.registerCommand("debug_jump_path", {
      description:
        "Test isJumpPathClear against offset (+3, 0, 0) from bot position",
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

    this.logger.debug("commands registered", "Debug");
  }

  /**
   * Test strafe movement once around a relative point (+3, 0, 0).
   * @returns The final distance to the target point after strafing
   */
  async debugStrafeOnce(): Promise<number> {
    this.strafeLooping = false;
    const center = new Vec3(
      Math.floor(this.bot.entity!.position.x) + 0.5,
      this.bot.entity!.position.y,
      Math.floor(this.bot.entity!.position.z) + 0.5,
    );
    await (this.bot as any).combatManager.nudgeToCenter(center);
    const targetPos = this.bot.entity!.position.offset(3, 0, 0);

    // Log initial position
    const initialPos = this.bot.entity!.position.clone();
    this.logger.debug(
      `Strafe test: initial position ${initialPos.toString()}`,
      "Debug",
    );
    this.logger.debug(
      `Strafe test: target position ${targetPos.toString()}`,
      "Debug",
    );

    (this.bot as any).combatManager.doStrafe(targetPos);

    // Wait a tick for velocity to apply
    await this.bot.waitForTicks!(1);

    // Wait for the entity to land after applying impulse
    while (
      !this.bot.entity.onGround ||
      this.bot.entity.velocity.x !== 0 ||
      this.bot.entity.velocity.z !== 0
    ) {
      await this.bot.waitForTicks!(1);
    }

    // Log final position and distance check
    const finalPos = this.bot.entity!.position;
    const dist = Math.hypot(targetPos.x - finalPos.x, targetPos.z - finalPos.z);
    const withinTolerance = dist <= 0.3;

    this.logger.debug(
      `Strafe test: final position ${finalPos.toString()}`,
      "Debug",
    );
    this.logger.debug(
      `Strafe test: distance to target ${dist.toFixed(3)} ${withinTolerance ? "✓ within 0.3 tolerance" : "✗ outside 0.3 tolerance"}`,
      "Debug",
    );
    return dist;
  }

  /**
   * Loop the strafe movement test around a relative point (+3, 0, 0).
   * Centers once before starting, then strafes 3 times.
   * @returns Array of distances to target after each strafe
   */
  async debugStrafeLoop(): Promise<number[]> {
    if (this.strafeLooping) {
      this.strafeLooping = false;
      this.logger.debug("Strafe loop test: stopped", "Debug");
      return [];
    }

    // Center once before starting strafing chain
    const center = new Vec3(
      Math.floor(this.bot.entity!.position.x) + 0.5,
      this.bot.entity!.position.y,
      Math.floor(this.bot.entity!.position.z) + 0.5,
    );
    await (this.bot as any).combatManager.nudgeToCenter(center);

    const targetPos = this.bot.entity!.position.offset(3, 0, 0);

    // Log initial position
    const initialPos = this.bot.entity!.position.clone();
    this.logger.debug(
      `Strafe loop test: initial position ${initialPos.toString()}`,
      "Debug",
    );
    this.logger.debug(
      `Strafe loop test: target position ${targetPos.toString()}`,
      "Debug",
    );

    const distances: number[] = [];

    // Strafe 3 times
    for (let i = 0; i < 3; i++) {
      (this.bot as any).combatManager.doStrafe(targetPos);

      // Wait a tick for velocity to apply
      await this.bot.waitForTicks!(1);

      // Wait for the entity to land after applying impulse
      while (
        !this.bot.entity.onGround ||
        this.bot.entity.velocity.x !== 0 ||
        this.bot.entity.velocity.z !== 0
      ) {
        await this.bot.waitForTicks!(1);
      }

      // Log position after each strafe
      const finalPos = this.bot.entity!.position;
      const dist = Math.hypot(
        targetPos.x - finalPos.x,
        targetPos.z - finalPos.z,
      );
      this.logger.debug(
        `Strafe loop test: after strafe ${i + 1} position ${finalPos.toString()}`,
        "Debug",
      );
      this.logger.debug(
        `Strafe loop test: after strafe ${i + 1} distance ${dist.toFixed(3)} ${dist <= 0.3 ? "✓ within 0.3 tolerance" : "✗ outside 0.3 tolerance"}`,
        "Debug",
      );
      distances.push(dist);
    }

    this.strafeLooping = false;
    this.logger.debug("Strafe loop test completed (3 iterations)", "Debug");
    return distances;
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

    // Compute target position: bot position + offset
    const targetPos = this.bot.entity!.position.plus(offset);
    this.logger.debug(
      `Pearl throw: ${mode} arc at bot position + ${offset.toString()}`,
      "Debug",
    );

    await this.debugPearlArc(mode as "low" | "high" | "auto", targetPos);
  }

  /**
   * Test isJumpPathClear against offset (+3, 0, 0) from bot position.
   * Logs whether the jump arc is clear or blocked.
   */
  async debugJumpPath(): Promise<void> {
    const source = this.bot.entity!.position;
    const targetPos = source.offset(3, 0, 0);

    this.logger.debug(
      `Jump path: target (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)}) from (${this.bot.entity!.position.x.toFixed(1)}, ${this.bot.entity!.position.y.toFixed(1)}, ${this.bot.entity!.position.z.toFixed(1)})`,
      "Debug",
    );

    const isClear = (this.bot as any).utilsManager.isJumpPathClear(
      source,
      targetPos,
    );

    if (isClear) {
      this.logger.debug(`Jump path: CLEAR`, "Debug");
    } else {
      this.logger.debug(`Jump path: BLOCKED`, "Debug");
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

    const source = new Vec3(3.5, 1, 0.5);
    const targetPos = new Vec3(0.5, 1, 0.5);

    for (const scenario of scenarios) {
      // Position bot using /tp command
      this.bot.chat!(`/tp ${this.bot.username} 3 1 0`);
      await this.bot.waitForTicks!(3);

      // Place obstacle using setblock command (skip if no obstacle)
      if (scenario.obstacle) {
        const obsPos = scenario.obstacle;
        this.bot.chat!(`/setblock ${obsPos.x} ${obsPos.y} ${obsPos.z} dirt`);
        await this.bot.waitForTicks!(3);
      }

      // Output positions in requested format
      this.logger.debug(
        `Collision stress: ${source.toString()}, ${targetPos.toString()}, ${scenario.obstacle ? scenario.obstacle.x + ", " + scenario.obstacle.y + ", " + scenario.obstacle.z : "none"}`,
        "Debug",
      );

      // Test isJumpPathClear
      const isClear = (this.bot as any).utilsManager.isJumpPathClear(
        source,
        targetPos,
      );

      this.logger.debug(
        `Collision stress: ${scenario.name}: ${isClear ? "CLEAR" : "BLOCKED"}`,
        "Debug",
      );

      // Remove obstacle for next test (skip if no obstacle)
      if (scenario.obstacle) {
        const obsPos = scenario.obstacle;
        this.bot.chat!(`/setblock ${obsPos.x} ${obsPos.y} ${obsPos.z} air`);
        await this.bot.waitForTicks!(3);
      }
    }
  }

  /**
   * Test a jump towards a relative point (+3, 0, 0).
   * Centers the bot before jumping.
   * @param offset - Optional relative Vec3 offset from current position
   * @returns The final distance to the target point after jumping
   */
  async debugJumpTest(offset?: Vec3): Promise<number> {
    const center = new Vec3(
      Math.floor(this.bot.entity!.position.x) + 0.5,
      this.bot.entity!.position.y,
      Math.floor(this.bot.entity!.position.z) + 0.5,
    );
    await (this.bot as any).combatManager.nudgeToCenter(center);

    const targetPos = offset
      ? this.bot.entity!.position.plus(offset)
      : this.bot.entity!.position.offset(3, 0, 0);

    // Log initial position before jumping
    const initialPos = this.bot.entity!.position.clone();
    this.logger.debug(
      `Jump test: initial position ${initialPos.toString()}`,
      "Debug",
    );
    this.logger.debug(
      `Jump test: target position ${targetPos.toString()}`,
      "Debug",
    );

    const jumpSource = initialPos.clone();

    // Log state before the jump
    const preDist = Math.hypot(
      targetPos.x - jumpSource.x,
      targetPos.z - jumpSource.z,
    );
    this.logger.debug(
      `Jump test: pre-jump distance ${preDist.toFixed(3)}`,
      "Debug",
    );

    const impulse = (this.bot as any).utilsManager.getJumpVelocity(
      jumpSource,
      targetPos,
    );

    if (impulse) {
      this.logger.debug(
        `Jump test: jumping to ${targetPos.toString()}`,
        "Debug",
      );

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
          `Jump test: ApplyImpulse (${imp.x.toFixed(4)}, ${imp.y.toFixed(4)}, ${imp.z.toFixed(4)}) [${mode}]`,
          "Debug",
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
      while (
        !this.bot.entity.onGround ||
        this.bot.entity.velocity.x !== 0 ||
        this.bot.entity.velocity.z !== 0
      ) {
        await this.bot.waitForTicks!(1);
      }

      const finalPos = this.bot.entity!.position;
      const dist = Math.hypot(
        targetPos.x - finalPos.x,
        targetPos.z - finalPos.z,
      );
      const withinTolerance = dist <= 0.3;

      // Log position after jumping
      this.logger.debug(
        `Jump test: after jump position ${finalPos.toString()}`,
        "Debug",
      );
      this.logger.debug(
        `Jump test: distance to target ${dist.toFixed(3)} ${withinTolerance ? "✓ within 0.3 tolerance" : "✗ outside 0.3 tolerance"}`,
        "Debug",
      );

      // Calculate overshoot/undershoot along jump direction
      const jumpDir = new Vec3(
        targetPos.x - jumpSource.x,
        0,
        targetPos.z - jumpSource.z,
      ).normalize();
      const toTarget = new Vec3(
        targetPos.x - finalPos.x,
        0,
        targetPos.z - finalPos.z,
      );
      const alongJump = toTarget.dot(jumpDir); // negative = overshoot, positive = undershoot
      const overshoot = alongJump < 0 ? "overshoot" : "undershoot";
      const overshootAmount = Math.abs(alongJump);

      if (withinTolerance) {
        this.logger.debug(
          `Jump test: landed within tolerance (${dist.toFixed(3)} <= 0.3)`,
          "Debug",
        );
      } else {
        this.logger.debug(
          `Jump test: ${overshoot} by ${overshootAmount.toFixed(3)} blocks (dist=${dist.toFixed(3)} > 0.3)`,
          "Debug",
        );
      }
      return dist;
    } else {
      this.logger.error(new Error("Cannot calculate jump velocity"));
      return -1;
    }
  }

  /**
   * Helper to test pearl throws with a specific arc preference.
   * @param arcType - Which arc to attempt, or "auto" to pick the best
   * @param targetPos - Target position
   */
  async debugPearlArc(
    arcType: "low" | "high" | "auto",
    targetPos: Vec3,
  ): Promise<void> {
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

      this.logger.debug(`Pearl arc: ${arc} arc`, "Debug");
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

    this.logger.debug(`Pearl arc: ${arcType} arc`, "Debug");
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
