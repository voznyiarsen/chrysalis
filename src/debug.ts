/**
 * @fileoverview Debug module for Pupa bot.
 * Contains test commands and debugging utilities.
 */

import { logger, Logger } from './logger';
import { Constants } from './constants';
import { Vec3 } from 'vec3';
import { Bot } from 'mineflayer';

interface Args {
  [index: number]: string;
}

/**
 * Attaches debug commands to a bot instance
 */
class DebugManager {
  bot: Bot;
  logger: Logger;
  strafeLooping: boolean = false;

  /**
   * @param bot - Mineflayer bot instance
   */
  constructor(bot: Bot) {
    this.bot = bot;
    this.logger = bot.__logger;
    logger.setDebugMode(true);
  }

  /**
   * Initialize debug commands. Should be called after CommandManager is loaded.
   */
  public initialize(): void {
    this.setupDebugCommands();
  }

  /**
   * Register debug commands with the command registry
   */
  setupDebugCommands(): void {
    if (!this.bot.commandManager) {
      this.logger.error(new Error('Command registry not initialized'));
      return;
    }

    const cm = this.bot.commandManager;

    cm.registerCommand('debug_strafe_once', {
      description: 'Single strafe test at (+3, 0, 0)',
      handler: async (_args: string[]) => {
        await this.debugStrafeOnce();
      },
    });

    cm.registerCommand('debug_strafe_loop', {
      description: 'Loop the strafe test (call again to stop)',
      handler: async (_args: string[]) => {
        await this.debugStrafeLoop();
      },
    });

    cm.registerCommand('debug_pearl_offsets', {
      description: 'Show calculated offsets for different distances and arcs',
      handler: async (args: string[]) => {
        await this.debugPearlOffsets(args);
      }
    })

    cm.registerCommand('debug_pearl_throw', {
      description: 'Throw a pearl at bot position + offset with arc mode',
      handler: async (args: string[]) => {
        await this.debugPearlThrow(args);
      },
    });

    cm.registerCommand('debug_jump_path', {
      description:
        'Test isJumpPathClear against offset (+3, 0, 0) from bot position',
      handler: async () => {
        await this.debugJumpPath();
      },
    });

    cm.registerCommand('debug_collision_stress', {
      description: 'Batch test isJumpPathClear with 9 scenarios',
      handler: async () => {
        await this.debugCollisionStress();
      },
    });

    cm.registerCommand('debug_jump_test', {
      description: 'Test jump towards a relative point (+3, 0, 0)',
      handler: async () => {
        await this.debugJumpTest();
      },
    });

    this.logger.debug('Debug commands registered', 'Debug');
  }

  /**
   * Test strafe movement once around a relative point (+3, 0, 0).
   * @returns The final distance to the target point after strafing
   */
  async debugStrafeOnce(): Promise<number> {
    this.strafeLooping = false;

    // Wait for the bot to land and settle before strafing
    while (
      !this.bot.entity.onGround ||
      this.bot.entity.velocity.x !== 0 ||
      this.bot.entity.velocity.z !== 0
    ) {
      await this.bot.waitForTicks!(1);
    }

    const targetPos = this.bot.entity!.position.offset(3, 0, 0);

    this.bot.combatManager.doStrafe(targetPos);

    await this.bot.waitForTicks!(1);

    while (
      !this.bot.entity.onGround ||
      this.bot.entity.velocity.x !== 0 ||
      this.bot.entity.velocity.z !== 0
    ) {
      await this.bot.waitForTicks!(1);
    }

    const finalPos = this.bot.entity!.position;
    const strafePoint = this.bot.combatManager.strafePoint;

    if (strafePoint) {
      return Math.hypot(strafePoint.x - finalPos.x, strafePoint.z - finalPos.z);
    } else {
      return Math.hypot(targetPos.x - finalPos.x, targetPos.z - finalPos.z);
    }
  }

  /**
   * Loop the strafe movement test around a relative point (+3, 0, 0).
   * Centers once before starting, then strafes 3 times.
   * @returns Array of distances to target after each strafe
   */
  async debugStrafeLoop(): Promise<number[]> {
    if (this.strafeLooping) {
      this.strafeLooping = false;
      return [];
    }

    const targetPos = this.bot.entity!.position.offset(3, 0, 0);
    const distances: number[] = [];

    for (let i = 0; i < 3; i++) {
      this.bot.combatManager.doStrafe(targetPos);

      await this.bot.waitForTicks!(1);

      while (
        !this.bot.entity.onGround ||
        this.bot.entity.velocity.x !== 0 ||
        this.bot.entity.velocity.z !== 0
      ) {
        await this.bot.waitForTicks!(1);
      }

      const finalPos = this.bot.entity!.position;
      const strafePoint = this.bot.combatManager.strafePoint;

      if (strafePoint) {
        distances.push(Math.hypot(strafePoint.x - finalPos.x, strafePoint.z - finalPos.z));
      } else {
        distances.push(Math.hypot(targetPos.x - finalPos.x, targetPos.z - finalPos.z));
      }
    }

    this.strafeLooping = false;
    return distances;
  }

  /**
   * Throw a pearl at bot position + offset with arc mode.
   * @param args - Array where args[1] is the arc mode and args[2-4] are axis offsets
   *   axis-offsets: x+2.5 y-1.0 z+0.75
   * @param mode - Arc mode ("low", "high", or "auto")
   * @param offset - Offset as Vec3 object (alternative signature)
   */
  async debugPearlThrow(args: Args): Promise<void>;
  async debugPearlThrow(mode: 'low' | 'high' | 'auto', offset: Vec3): Promise<void>;

  async debugPearlThrow(arg1: Args | 'low' | 'high' | 'auto', arg2?: Vec3): Promise<void> {
    const startTime = Date.now();
    let mode: 'low' | 'high' | 'auto';
    let offset: Vec3;

    if (Array.isArray(arg1)) {
      mode = arg1[0] as 'low' | 'high' | 'auto';

      const parseAxis = (s: string) => parseFloat(s.slice(1));
      offset = new Vec3(
        parseAxis(arg1[1]),
        parseAxis(arg1[2]),
        parseAxis(arg1[3]),
      );
    } else {
      mode = arg1 as 'low' | 'high' | 'auto';
      offset = arg2!;
    }

    const targetPos = this.bot.entity!.position.plus(offset);
    await this.debugPearlArc(mode, targetPos);
  }

  /**
   * Test isJumpPathClear against offset (+3, 0, 0) from bot position.
   * Logs whether the jump arc is clear or blocked.
   */
  async debugJumpPath(): Promise<void> {
    const source = this.bot.entity!.position;
    const targetPos = source.offset(3, 0, 0);

    const isClear = (this.bot as any).utilsManager.isJumpPathClear(
      source,
      targetPos,
    );
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
      { name: 'Test 0', obstacle: null },
      { name: 'Test 1', obstacle: { x: 1, y: 1, z: 0 } },
      { name: 'Test 2', obstacle: { x: 2, y: 1, z: 0 } },
      { name: 'Test 3', obstacle: { x: 1, y: 2, z: 0 } },
      { name: 'Test 4', obstacle: { x: 2, y: 2, z: 0 } },
      { name: 'Test 5', obstacle: { x: 0, y: 3, z: 0 } },
      { name: 'Test 6', obstacle: { x: 1, y: 3, z: 0 } },
      { name: 'Test 7', obstacle: { x: 2, y: 3, z: 0 } },
      { name: 'Test 8', obstacle: { x: 3, y: 3, z: 0 } },
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

      const isClear = (this.bot as any).utilsManager.isJumpPathClear(
        source,
        targetPos,
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
   * @param offset - Optional relative Vec3 offset from current position
   * @returns The final distance to the target point after jumping
   */
  async debugJumpTest(offset?: Vec3): Promise<number> {
    const targetPos = offset
      ? this.bot.entity!.position.plus(offset)
      : this.bot.entity!.position.offset(0, 0, 0);

    const jumpSource = this.bot.entity!.position.clone();

    const impulse = (this.bot as any).utilsManager.getJumpVelocity(
      jumpSource,
      targetPos,
    );

    if (impulse) {
      const utils = (this.bot as any).utilsManager;
      const originalApplyImpulse = utils.applyImpulse.bind(utils);
      const startTick = this.bot.time!.age;

      utils.applyImpulse = (
        imp: Vec3,
        mode: string = 'add',
        force: boolean = false,
      ) => {
        const result = originalApplyImpulse(imp, mode, force);
        if (this.bot.time!.age - startTick >= 40) {
          utils.applyImpulse = originalApplyImpulse;
        }
        return result;
      };

      utils.applyImpulse(impulse, 'set', true);

      await this.bot.waitForTicks!(1);

      while (
        !this.bot.entity.onGround ||
        this.bot.entity.velocity.x !== 0 ||
        this.bot.entity.velocity.z !== 0
      ) {
        await this.bot.waitForTicks!(1);
      }

      const finalPos = this.bot.entity!.position;
      return Math.hypot(
        targetPos.x - finalPos.x,
        targetPos.z - finalPos.z,
      );
    } else {
      this.logger.error(new Error('Cannot calculate jump velocity'));
      return -1;
    }
  }

  /**
   * Helper to test pearl throws with a specific arc preference.
   * @param arcType - Which arc to attempt, or "auto" to pick the best
   * @param targetPos - Target position
   */
  async debugPearlArc(
    arcType: 'low' | 'high' | 'auto',
    targetPos: Vec3,
  ): Promise<void> {
    const eyePos = this.bot.entity!.position.offset(
      0,
      this.bot.entity!.height!,
      0,
    );

    if (arcType === 'auto') {
      await this._debugPearlArcAuto(eyePos, targetPos);
    } else if (arcType === 'low') {
      await this._debugPearlArcLow(eyePos, targetPos);
    } else if (arcType === 'high') {
      await this._debugPearlArcHigh(eyePos, targetPos);
    }
  }

  /**
   * Handle auto arc selection by delegating to combat manager
   */
  private async _debugPearlArcAuto(eyePos: Vec3, targetPos: Vec3): Promise<void> {
    const result = (this.bot as any).combatManager.getBestPearlOffset(
      eyePos,
      targetPos,
      'low'
    );
    if (!result) {
      this.logger.error(new Error('Cannot reach target with pearl'));
      return;
    }
    const { offset } = result;
    await (this.bot as any).inventoryManager.equipPearlWithOffset(targetPos, offset);
    (this.bot as any).combatManager.lastPearlTime = Date.now();
  }

  /**
   * Handle low arc pearl throws
   */
  private async _debugPearlArcLow(eyePos: Vec3, targetPos: Vec3): Promise<void> {
    await this._debugPearlArcWithType(eyePos, targetPos, 'low');
  }

  /**
   * Handle high arc pearl throws
   */
  private async _debugPearlArcHigh(eyePos: Vec3, targetPos: Vec3): Promise<void> {
    await this._debugPearlArcWithType(eyePos, targetPos, 'high');
  }

  /**
   * Shared implementation for low/high arc throws
   */
  private async _debugPearlArcWithType(eyePos: Vec3, targetPos: Vec3, arcType: 'low' | 'high'): Promise<void> {
    const { VELOCITY, GRAVITY, DRAG } = Constants.COMBAT.ENDER_PEARL;

    try {
      const offset = (this.bot as any).utilsManager.getProjectileOffset(
        eyePos,
        targetPos,
        VELOCITY,
        GRAVITY,
        DRAG,
        arcType
      );

      await (this.bot as any).inventoryManager.equipPearlWithOffset(targetPos, offset);
      (this.bot as any).combatManager.lastPearlTime = Date.now();
    } catch (error) {
      this.logger.error(new Error(`Cannot reach target with pearl (${arcType} arc): ${error.message}`));
      return;
    }
  }

  /**
   * Jump test in a given direction offset.
   *
   * @param offset - The jump offset as a Vec3 (e.g. new Vec3(dir.x * distance, 0, dir.z * distance))
   * @returns The result of the jump test
   */
  async debugJumpComprehensive(offset: Vec3): Promise<
    { result: number }
  > {
    const result = await this.debugJumpTest(offset);
    return { result };
  }

  /**
   * Comprehensive pearl test covering all 4 cardinal directions at 20 blocks.
   * Tests both low and high arcs using forcedMove event detection.
   */
  private async _testPearlLowArc(directionName: string, targetPos: Vec3): Promise<number> {
    try { await this.bot.waitForChunksToLoad(); } catch (e) {
      this.logger.warn(`Chunk loading failed: ${e.message}`, 'Debug');
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const check = () => {
        if (settled) return;
        if (this.bot.entity!.onGround &&
            Math.abs(this.bot.entity!.velocity.x) < 0.001 &&
            Math.abs(this.bot.entity!.velocity.z) < 0.001) {
          settled = true;
          this.bot.off('physicsTick', check);
          resolve();
        }
      };
      check();
      this.bot.on('physicsTick', check);
      setTimeout(() => { if (!settled) { this.bot.off('physicsTick', check); resolve(); } }, 5000);
    });

    return await this._testPearlWithForcedMove(directionName, targetPos, 'low');
  }

  private async _testPearlHighArc(directionName: string, targetPos: Vec3): Promise<number> {
    try { await this.bot.waitForChunksToLoad(); } catch (e) {
      this.logger.warn(`Chunk loading failed: ${e.message}`, 'Debug');
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const check = () => {
        if (settled) return;
        if (this.bot.entity!.onGround &&
            Math.abs(this.bot.entity!.velocity.x) < 0.001 &&
            Math.abs(this.bot.entity!.velocity.z) < 0.001) {
          settled = true;
          this.bot.off('physicsTick', check);
          resolve();
        }
      };
      check();
      this.bot.on('physicsTick', check);
      setTimeout(() => { if (!settled) { this.bot.off('physicsTick', check); resolve(); } }, 5000);
    });

    return await this._testPearlWithForcedMove(directionName, targetPos, 'high');
  }

  private async _debugPearlComprehensiveArc(arcType: 'low' | 'high'): Promise<
    { direction: string; distance: number; arc: string; result: number }[]
  > {
    const startTime = Date.now();
    const testFn = arcType === 'low'
      ? (name: string, pos: Vec3) => this._testPearlLowArc(name, pos)
      : (name: string, pos: Vec3) => this._testPearlHighArc(name, pos);

    const originPos = this.bot.entity!.position.clone();
    const targetPos = originPos.offset(20, 0, 0);
    const result = await testFn('East', targetPos);
    const results = [{ direction: 'East', distance: 20, arc: arcType, result }];

    return results;
  }

  async debugPearlComprehensiveArc(arcType: 'low' | 'high'): Promise<
    { direction: string; distance: number; arc: string; result: number }[]
  > {
    return this._debugPearlComprehensiveArc(arcType);
  }

  private async _testPearlWithForcedMove(
    directionName: string, targetPos: Vec3, arcType: string,
  ): Promise<number> {
    return new Promise((resolve) => {
      const eyePos = this.bot.entity!.position.offset(0, this.bot.entity!.height!, 0);
      const initialDist = Math.sqrt(
        Math.pow(targetPos.x - eyePos.x, 2) +
        Math.pow(targetPos.y - eyePos.y, 2) +
        Math.pow(targetPos.z - eyePos.z, 2),
      );
      const minAcceptable = initialDist * 0.5;
      let recorded = false; // Track if we've already recorded a result

      const listener = () => {
        if (recorded) return; // Ignore subsequent events after first recording

        const newPos = this.bot.entity!.position;
        const moved = Math.sqrt(
          Math.pow(newPos.x - eyePos.x, 2) +
          Math.pow(newPos.y - eyePos.y, 2) +
          Math.pow(newPos.z - eyePos.z, 2),
        );
        const dist = Math.sqrt(
          Math.pow(targetPos.x - newPos.x, 2) +
          Math.pow(targetPos.y - newPos.y, 2) +
          Math.pow(targetPos.z - newPos.z, 2),
        );
        if (moved >= minAcceptable) {
          recorded = true;
          this.bot.off('forcedMove', listener as any);
          resolve(dist);
        }
      };

      this.bot.on('forcedMove', listener as any);
      const timeout = setTimeout(() => {
        this.bot.off('forcedMove', listener as any);
        this.logger.warn(`Pearl timeout for ${directionName} ${arcType}`, 'Debug');
        resolve(-1);
      }, 30000).unref();

      this._executePearlThrow(eyePos, targetPos, arcType as any, 1)
        .catch((err) => {
          clearTimeout(timeout);
          this.bot.off('forcedMove', listener as any);
          this.logger.error(`Pearl failed: ${err.message}`, 'Debug');
          resolve(-1);
        });
    });
  }

  /**
   * Show calculated offsets for different distances and arcs
   */
  private async debugPearlOffsets(args: string[]): Promise<void> {
    const distances = [5, 10, 15, 20, 25, 30];
    const arcTypes: ('low' | 'high')[] = ['low', 'high'];

    const eyePos = this.bot.entity!.position.offset(
      0,
      Constants.PHYSICS.EYE_HEIGHT_OFFSET,
      0,
    );

    for (const distance of distances) {
      for (const arcType of arcTypes) {
        try {
          const targetPos = eyePos.offset(distance, 0, 0);

          const offset = (this.bot as any).utilsManager.getProjectileOffset(
            eyePos,
            targetPos,
            Constants.COMBAT.ENDER_PEARL.VELOCITY,
            Constants.COMBAT.ENDER_PEARL.GRAVITY,
            Constants.COMBAT.ENDER_PEARL.DRAG,
            arcType
          );

          // Also get pitch for comparison
          const pitches = (this.bot as any).utilsManager.getProjectilePitch(
            eyePos,
            targetPos,
            Constants.COMBAT.ENDER_PEARL.VELOCITY,
            Constants.COMBAT.ENDER_PEARL.GRAVITY,
            Constants.COMBAT.ENDER_PEARL.DRAG
          );
          const pitch = arcType === 'low' ? pitches[0] : pitches[1] || pitches[0];

          this.logger.debug(
            `${distance}b ${arcType} arc: offset=${offset.toFixed(2)} (pitch=${pitch.toFixed(2)}°)`,
            'Debug'
          );
        } catch (error) {
          this.logger.debug(
            `${distance}b ${arcType} arc: ${error.message}`,
            'Debug'
          );
        }
      }
    }


  }

  private async _executePearlThrow(
    eyePos: Vec3, targetPos: Vec3,
    arcType: 'auto' | 'low' | 'high',
    throwAmount: number = 1,
  ): Promise<void> {
    await (this.bot as any).inventoryManager.getItemViaCommand('ender_pearl', throwAmount);

    if (arcType === 'auto') {
      const result = (this.bot as any).combatManager.getBestPearlOffset(eyePos, targetPos, 'low');
      if (!result) throw new Error('Cannot reach target with pearl (auto arc)');
      const { offset } = result;
      await (this.bot as any).inventoryManager.equipPearlWithOffset(targetPos, offset, 'ender_pearl', eyePos);
    } else {
      const { VELOCITY, GRAVITY, DRAG } = Constants.COMBAT.ENDER_PEARL;
      let offset;
      try {
        offset = (this.bot as any).utilsManager.getProjectileOffset(
          eyePos,
          targetPos,
          VELOCITY,
          GRAVITY,
          DRAG,
          arcType
        );
      } catch (err) {
        this.logger.error(new Error(`Cannot reach target with pearl (${arcType} arc): ${err.message}`));
        return;
      }
      await (this.bot as any).inventoryManager.equipPearlWithOffset(targetPos, offset, 'ender_pearl', eyePos);
    }

    (this.bot as any).combatManager.lastPearlTime = Date.now();
  }
}

/**
 * Attach the DebugManager to a bot instance.
 * @param bot - Mineflayer bot instance
 * @returns The same bot instance with debugManager attached
 */
export function attachDebug(bot: Bot): Bot {
  bot.debugManager = new DebugManager(bot);
  bot.debugManager.bot = bot;
  return bot;
}

export { DebugManager };
