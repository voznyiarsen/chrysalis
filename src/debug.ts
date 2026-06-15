/**
 * Debug module for Pupa bot
 * Contains test commands and debugging utilities
 */

import util from "node:util";
import { logger } from "./logger";
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
  public strafeLooping: boolean = false;

  /**
   * @param bot - Mineflayer bot instance
   */
  constructor(bot: Bot) {
    this.bot = bot;
    logger.setDebugMode(true);
    this.setupDebugCommands();
  }

  /**
   * Register debug commands with the command registry
   */
  setupDebugCommands(): void {
    if (!(this.bot as any).commandManager) {
      logger.error(new Error(`Command registry not initialized`));
      return;
    }

    const cm = (this.bot as any).commandManager;

    cm.registerCommand("t0", {
      description: "Single strafe test at (+3, 0, 0)",
      handler: async (_args: string[]) => {
        await this.test0();
      },
    });

    cm.registerCommand("t1", {
      description: "Loop strafe test (call again to stop)",
      handler: async (_args: string[]) => {
        await this.test1();
      },
    });

    cm.registerCommand("t2", {
      description: "Throw pearl at nearest player with offset",
      subcommands: {
        "<mode>": {
          description: "Arc mode: low | high | auto",
          positional: true,
          subcommands: {
            "<x>": {
              description: "X offset (e.g., x+2.5)",
              positional: true,
              subcommands: {
                "<y>": {
                  description: "Y offset (e.g., y-1.0)",
                  positional: true,
                  subcommands: {
                    "<z>": {
                      description: "Z offset (e.g., z+0.75)",
                      positional: true,
                      handler: async (args: string[]) => {
                        await this.test2(args);
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    cm.registerCommand("t5", {
      description: "Test jump path to nearest player",
      handler: async (_args: string[]) => {
        await this.test5();
      },
    });

    cm.registerCommand("t6", {
      description: "Run 9 jump-path obstacle scenarios",
      handler: async (_args: string[]) => {
        await this.test6();
      },
    });

    cm.registerCommand("t7", {
      description: "Jump test to (+3, 0, 0)",
      handler: async (_args: string[]) => {
        await this.test7();
      },
    });

    cm.registerCommand("pdb", {
      description: "Debug info for a player",
      subcommands: {
        "<username>": {
          description: "Player username",
          positional: true,
          handler: (args: string[]) => this.playerDebug(args),
        },
      },
    });

    cm.registerCommand("sdb", {
      description: "Debug info for an inventory slot",
      subcommands: {
        "<slot>": {
          description: "Slot number",
          positional: true,
          handler: (args: string[]) => this.slotDebug(args),
        },
      },
    });

    logger.debug(`Debug commands registered`);
  }

  /**
   * Test strafe movement once around a relative point (+3, 0, 0).
   */
  async test0(): Promise<void> {
    this.strafeLooping = false;
    const center = new Vec3(
      Math.floor(this.bot.entity!.position.x) + 0.5,
      this.bot.entity!.position.y,
      Math.floor(this.bot.entity!.position.z) + 0.5,
    );
    await (this.bot as any).combatManager.nudgeToCenter(center);
    const fixedPoint = this.bot.entity!.position.offset(3, 0, 0);
    (this.bot as any).combatManager.doStrafe(fixedPoint);
    logger.debug(
      `Executed single strafe test around ${fixedPoint.toString()}`,
    );
  }

  /**
   * Loop the strafe movement test around a relative point (+3, 0, 0).
   * Stops if test0 is called or another command sets strafeLooping to false.
   */
  async test1(): Promise<void> {
    if (this.strafeLooping) {
      this.strafeLooping = false;
      logger.debug("Stopped strafe loop test");
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
    logger.debug(
      `Starting strafe loop test around ${fixedPoint.toString()}`,
    );

    while (this.strafeLooping) {
      (this.bot as any).combatManager.doStrafe(fixedPoint);
      await this.bot.waitForTicks!(2);
    }
  }

  /**
   * Throw a pearl at the nearest player with the given arc mode and relative offset.
   * Usage: t2 <mode> <axis-offsets>
   *   mode: low | high | auto
   *   axis-offsets: x+2.5 y-1.0 z+0.75
   */
  async test2(args: Args): Promise<void> {
    const mode = args[1];

    // Parse axis offsets: "x+2.5" -> 2.5, "y-1.0" -> -1.0
    const parseAxis = (s: string) => parseFloat(s.slice(1));
    const offset = new Vec3(parseAxis(args[2]), parseAxis(args[3]), parseAxis(args[4]));

    // Compute target position: nearest player offset by the given vector
    const filter = (e: any) =>
      e.type === "player" && e.username !== this.bot.username;
    const target = this.bot.nearestEntity!(filter);
    if (!target) {
      logger.error(new Error(`No player found for test2 (mode=${mode}, offset=${offset.toString()})`));
      return;
    }

    const targetPos = target.position!.offset(0, target.height! / 2, 0).plus(offset);
    logger.debug(
      `Throwing ${mode} arc pearl at ${target.username} offset by ${offset.toString()}`,
    );

    await this.testPearlArc(mode as "low" | "high" | "auto", targetPos);
  }

  /**
   * Test isJumpPathClear against the nearest player's current position.
   * Logs whether the jump arc is clear or blocked.
   */
  async test5(): Promise<void> {
    const filter = (e: any) =>
      e.type === "player" && e.username !== this.bot.username;
    const target = this.bot.nearestEntity!(filter);
    if (!target) {
      logger.error(new Error("No player found for test5"));
      return;
    }

    const source = this.bot.entity!.position;
    const strafePoint = target.position!;

    logger.debug(
      `Testing jump path to ${target.username} at ${strafePoint.x.toFixed(1)}, ${strafePoint.y.toFixed(1)}, ${strafePoint.z.toFixed(1)} from ${this.bot.entity!.position.x.toFixed(1)}, ${this.bot.entity!.position.y.toFixed(1)}, ${this.bot.entity!.position.z.toFixed(1)}`,
    );

    const isClear = (this.bot as any).utilsManager.isJumpPathClear(source, strafePoint);

    if (isClear) {
      logger.debug(`Jump path to ${target.username} is CLEAR`);
    } else {
      logger.debug(`Jump path to ${target.username} is BLOCKED`);
    }
  }

  /**
   * Test the isJumpPathClear method with 9 scenarios.
   * Player at X=0, Z=0 (Y=0 and Y=1), Bot at X=3, Z=0 (Y=0 and Y=1).
   * Obstacle positions defined in 4-width by 3-height grid.
   */
  async test6(): Promise<void> {
    // Define test scenarios: obstacle positions (x, y, z), null means no obstacle
    const scenarios: { name: string; obstacle: { x: number; y: number; z: number } | null }[] = [
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
      logger.debug(
        `${botSource.toString()}, ${playerPos.toString()}, ${scenario.obstacle ? scenario.obstacle.x + ", " + scenario.obstacle.y + ", " + scenario.obstacle.z : "none"}`,
      );

      // Test isJumpPathClear
      const isClear = (this.bot as any).utilsManager.isJumpPathClear(
        botSource,
        playerPos,
      );

      logger.debug(`${scenario.name}: ${isClear ? "CLEAR" : "BLOCKED"}`);

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
  async test7(): Promise<void> {
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
    logger.debug(
      `Pre-jump state: bot=${jumpSource.toString().slice(0, 30)} target=${target.toString().slice(0, 30)} dist=${preDist.toFixed(3)}`,
    );

    const impulse = (this.bot as any).utilsManager.getJumpVelocity(
      jumpSource,
      target,
    );

    if (impulse) {
      logger.debug(`Jumping to ${target.toString()}`);

      const utils = (this.bot as any).utilsManager;
      const originalApplyImpulse = utils.applyImpulse.bind(utils);
      const startTick = this.bot.time!.age;

      // Override applyImpulse to log every call for the next 40 ticks
      utils.applyImpulse = (imp: Vec3, mode: string = "add", force: boolean = false) => {
        logger.debug(
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

      await this.bot.waitForTicks!(1);
      // Wait a few ticks for the jump to resolve, then log post-jump state
      while (!this.bot.entity.onGround) {
        await this.bot.waitForTicks!(1);
      }

      const postPos = this.bot.entity!.position;
      const postDist = Math.hypot(
        target.x - postPos.x,
        target.z - postPos.z,
      );
      const withinTolerance = postDist <= 0.3;

      // Calculate overshoot/undershoot along jump direction
      const jumpDir = new Vec3(target.x - jumpSource.x, 0, target.z - jumpSource.z).normalize();
      const toTarget = new Vec3(target.x - postPos.x, 0, target.z - postPos.z);
      const alongJump = toTarget.dot(jumpDir); // negative = overshoot, positive = undershoot
      const overshoot = alongJump < 0 ? "overshoot" : "undershoot";
      const overshootAmount = Math.abs(alongJump);

      logger.debug(
        `Post-jump state:  bot=${postPos.toString().slice(0, 30)} target=${target.toString().slice(0, 30)} dist=${postDist.toFixed(3)} ${withinTolerance ? "✓" : "✗"}`,
      );

      if (withinTolerance) {
        logger.debug(
          `Jump landed within tolerance (${postDist.toFixed(3)} <= 0.3)`,
        );
      } else {
        logger.debug(
          `Jump ${overshoot} by ${overshootAmount.toFixed(3)} blocks (dist=${postDist.toFixed(3)} > 0.3)`,
        );
      }
    } else {
      logger.error(new Error("Cannot calculate jump velocity for test7"));
    }
  }

  /**
   * Helper to test pearl throws with a specific arc preference.
   * @param arcType - Which arc to attempt, or "auto" to pick the best
   * @param overrideTargetPos - Optional target position (otherwise uses nearest player)
   */
  async testPearlArc(arcType: "low" | "high" | "auto", overrideTargetPos?: Vec3): Promise<void> {
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
        logger.error(new Error(`No player found for ${arcType} arc test`));
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
        logger.error(new Error("Cannot reach target with pearl"));
        return;
      }
      const { pitch, arc } = result;
      const yaw = Math.atan2(eyePos.x - targetPos.x, eyePos.z - targetPos.z);

      logger.debug(`Throwing ${arc} arc pearl at ${target.username}`);
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
      logger.error(
        new Error(`Cannot reach target with pearl (${arcType} arc)`),
      );
      return;
    }

    // pitches[0] is low arc, pitches[1] is high arc
    const pitch = arcType === "low" ? pitches[0] : pitches[1] || pitches[0];
    const yaw = Math.atan2(eyePos.x - targetPos.x, eyePos.z - targetPos.z);

    logger.debug(`Throwing ${arcType} arc pearl at ${target.username}`);
    await (this.bot as any).inventoryManager.equipPearl(yaw, pitch);
    (this.bot as any).combatManager.lastPearlTime = Date.now();
  }

  /**
   * Logs detailed info about a player by username.
   * @param args - Command arguments, args[1] is the username
   */
  playerDebug(args: Args): void {
    const username = args[1];
    const player = (this.bot as any).players[username];
    if (!player) {
      logger.error(new Error(`Player '${username}' not found`));
      return;
    }
    logger.debug(`Player Debug: '${player.username}'`);
    logger.debug(util.inspect(player, { depth: 1, colors: true }));
  }

  /**
   * Logs detailed info about an inventory slot by index.
   * @param args - Command arguments, args[1] is the slot number
   */
  slotDebug(args: Args): void {
    const slotNumber = parseInt(args[1], 10);
    const item = this.bot.inventory!.slots![slotNumber];
    if (!item) {
      logger.error(new Error(`Item in slot ${slotNumber} not found`));
      return;
    }
    logger.debug(`Slot Debug: '${(item as any).displayName}' (slot ${slotNumber})`);
    logger.debug(util.inspect(item, { depth: 1, colors: true }));
  }
}

/**
 * Attach the DebugManager to a bot instance.
 * @param bot - Mineflayer bot instance
 * @returns The same bot instance with debugManager attached
 */
export default function attach(bot: Bot): Bot {
  (bot as any).debugManager = new DebugManager(bot);
  return bot;
}

export { DebugManager };
