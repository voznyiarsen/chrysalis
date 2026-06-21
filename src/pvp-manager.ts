/**
 * @fileoverview In-house PVP Manager — replaces mineflayer-pvp plugin.
 *
 * Manages target tracking, tick-based attack cooldown, shield blocking for
 * creeper explosions, and serves a `bot.pvp` interface that integrates with
 * the existing CombatManager strafing and decision systems.
 *
 * Architecture notes:
 * - Attack timing uses weapon-specific cooldowns from constants.
 * - Target following is *not* done via pathfinder here — CombatManager.doStrafe()
 *   handles physics-based approach/strafing once the target is set.
 * - Events (`startedAttacking`, `stoppedAttacking`, `attackedTarget`) are
 *   emitted for parity with the original plugin.
 */

import { Bot } from 'mineflayer';
import { Entity } from 'prismarine-entity';
import { goals, Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { Constants } from './constants';

/** Registered item substrings that are considered PVP weapons. */
const WEAPON_NAMES = [
  'sword',
  'trident',
  'axe',
  'pickaxe',
  'shovel',
  'hoe',
] as const;

/**
 * Return the base attack speed for a held item.
 * Falls back to 4.0 (fist / non-weapon).
 */
export function getAttackSpeed(itemName?: string | null): number {
  if (!itemName) return Constants.WEAPON_ATTACK_SPEEDS.OTHER;
  for (const prefix of WEAPON_NAMES) {
    if (itemName.includes(prefix)) {
      const key = itemName.replace(/^minecraft:/, '');
      const speed = (Constants.WEAPON_ATTACK_SPEEDS as Record<string, number>)[key];
      if (speed !== undefined) return speed;
      const speeds: Record<string, number> = {
        sword: 1.6,
        trident: 1.1,
        axe: 1.0,
        pickaxe: 1.2,
        shovel: 1.0,
        hoe: 1.0,
      };
      return speeds[prefix] ?? Constants.WEAPON_ATTACK_SPEEDS.OTHER;
    }
  }
  return Constants.WEAPON_ATTACK_SPEEDS.OTHER;
}

/**
 * Cooldown (in ticks) before the next attack is allowed.
 *   1 / speed * 20 ticks
 */
export function getCooldown(itemName?: string | null): number {
  const speed = getAttackSpeed(itemName);
  return Math.floor((1 / speed) * 20);
}

/**
 * Damage multiplier based on attack speed timing.
 * Vanilla: 0.2 + ((t + 0.5) / cooldown)² × 0.8, clamped [0.2, 1.0].
 */
export function getDamageMultiplier(itemName?: string | null): number {
  const speed = getAttackSpeed(itemName);
  const cooldown = getCooldown(itemName);
  const damageMul = 0.2 + Math.pow((speed + 0.5) / cooldown, 2) * 0.8;
  return Math.max(0.2, Math.min(1.0, damageMul));
}

export class PVPManager {
  bot: Bot;

  /** Current attack target (undefined = not attacking). */
  target: Entity | undefined;

  /** Ticks remaining until the next attack is permitted. */
  timeToNextAttack: number = 0;

  /** Whether the target was within attack range on the previous tick. */
  wasInRange: boolean = false;

  /** True while the bot is blocking a creeper explosion. */
  blockingExplosion: boolean = false;

  /** Timeout handle for the explosion blocking reset. */
  private _explosionTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Distance at which the bot begins attacking. */
  attackRange: number = Constants.COMBAT.ATTACK_RANGE;

  /** How close to the target the bot should try to get. */
  followRange: number = Constants.COMBAT.FOLLOW_RANGE;

  /** Max distance before the target is considered lost. */
  viewDistance: number = Constants.COMBAT.VIEW_DISTANCE;

  /** Movements config for pathfinder (kept for external access). */
  movements: Movements;

  /** Optional goal position for combat-aware movement. */
  goal: Vec3 | null = null;

  constructor(bot: Bot) {
    this.bot = bot;
    this.movements = new Movements(bot);
    // mineflayer event typing doesn't cover physicsTick
    this.bot.on('physicsTick' as any, () => this.update());
    this.bot.on('entityGone', (e: { position: Vec3 }) => {
      if (e === this.target) this.stop();
    });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Begin attacking a target entity.
   * @returns Promise that resolves when attack setup is complete.
   */
  async attack(target: Entity): Promise<void> {
    if (target === this.target) return;
    await this.stop();
    this.target = target;
    this.timeToNextAttack = 0;
    if (!this.target) return;

    const pf = this.bot.pathfinder;
    if (pf) {
      pf.setMovements(this.movements);
      pf.setGoal(new goals.GoalFollow(this.target, this.followRange), true);
    }

    // mineflayer event typing doesn't cover startedAttacking
    this.bot.emit('startedAttacking' as any);
  }

  /**
   * Stop attacking. Cancels the pathfinder goal if we set one.
   * @returns Promise that resolves when cleanup is complete.
   */
  async stop(): Promise<void> {
    if (this.target == null) return;
    this.target = undefined;
    this.goal = null;
    this._clearExplosionTimeout();

    const pathfinder = this.bot.pathfinder;
    if (pathfinder) {
      pathfinder.stop();
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
          this.bot.once('path_stop' as any, () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } catch {
        this.bot.removeAllListeners('path_stop' as any);
        pathfinder.setGoal(null);
      }
    }

    // mineflayer event typing doesn't cover stoppedAttacking
    this.bot.emit('stoppedAttacking' as any);
  }

  /**
   * Forced stop — does not wait for pathfinder to settle.
   */
  forceStop(): void {
    if (this.target == null) return;
    this.target = undefined;
    this.goal = null;
    this._clearExplosionTimeout();
    const pathfinder = this.bot.pathfinder;
    if (pathfinder) pathfinder.setGoal(null);
    // mineflayer event typing doesn't cover stoppedAttacking
    this.bot.emit('stoppedAttacking' as any);
  }

  /**
   * Set a combat-aware movement goal. The bot will navigate toward this
   * position using pathfinder while continuing to attack any active target.
   * Once in attack range, strafing takes over. If the goal is far, pathfinder
   * is used for the approach.
   *
   * Pass `null` to clear the goal and revert to pure strafing.
   */
  setGoal(pos: Vec3 | null): void {
    this.goal = pos;
  }

  /**
   * Clear the combat goal.
   */
  clearGoal(): void {
    this.goal = null;
    const pf = this.bot.pathfinder;
    if (pf) pf.setGoal(null);
  }

  // -----------------------------------------------------------------------
  // Tick handler
  // -----------------------------------------------------------------------

  /** Called every physics tick. */
  update(): void {
    this.checkExplosion();
    this.checkRange();
    if (!this.target || this.blockingExplosion) return;

    this.timeToNextAttack--;
    if (this.timeToNextAttack <= 0) {
      this.attemptAttack();
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Check target range and view distance. Updates `wasInRange`.
   * Also handles goal-based movement integration.
   */
  private checkRange(): void {
    if (!this.target) return;
    if (this.timeToNextAttack < 0) return;

    const dist = this.target.position.distanceTo(this.bot.entity.position);

    // Lost target beyond view distance
    if (dist > this.viewDistance) {
      this.stop();
      return;
    }

    const inRange = dist <= this.attackRange;

    if (!this.wasInRange && inRange) {
      this.timeToNextAttack = 0;
    }
    this.wasInRange = inRange;

    if (this.goal) {
      const distToGoal = this.bot.entity.position.distanceTo(this.goal);
      const pf = this.bot.pathfinder;

      if (distToGoal > this.attackRange + 1) {
        if (pf) {
          pf.setMovements(this.movements);
          pf.setGoal(new goals.GoalNearXZ(this.goal.x, this.goal.z, 1));
        }
      } else if (inRange) {
        // In attack range AND close to goal — clear pathfinder so strafing
        // (triggered by CombatManager) takes over
        if (pf) pf.setGoal(null);
      }
    }
  }

  /**
   * Block creeper explosions with a shield, if equipped.
   */
  private checkExplosion(): void {
    if (!this.target || !this.hasShield()) return;
    if (this.target.name === 'creeper' && (this.target.metadata as Record<number, unknown>)[16] === 1) {
      this.blockingExplosion = true;
      const pf = this.bot.pathfinder;
      if (pf) pf.stop();
      this.bot.lookAt(this.target.position.offset(0, 1, 0), true);
      this.bot.activateItem(true);
      this._clearExplosionTimeout();
      this._explosionTimeout = setTimeout(() => {
        this.blockingExplosion = false;
        this._explosionTimeout = null;
      }, 2000);
    }
  }

  /**
   * Clear the explosion blocking timeout if one is pending.
   */
  private _clearExplosionTimeout(): void {
    if (this._explosionTimeout !== null) {
      clearTimeout(this._explosionTimeout);
      this._explosionTimeout = null;
    }
  }

  /**
   * Execute an attack on the current target (cooldown already verified).
   */
  private attemptAttack(): void {
    if (!this.target) return;
    if (!this.wasInRange) {
      this.timeToNextAttack = this.getWeaponCooldown();
      return;
    }

    // Deactivate shield before attacking (if active)
    if (this.hasShield()) {
      this.bot.deactivateItem();
    }

    this.bot.lookAt(
      this.target.position.offset(0, this.target.height ?? 1.8, 0),
      true,
    );

    this.bot.attack(this.target);
    // mineflayer event typing doesn't cover attackedTarget
    this.bot.emit('attackedTarget' as any);
    this.timeToNextAttack = this.getWeaponCooldown();

    // Re-activate shield after a brief delay
    if (this.hasShield()) {
      setTimeout(() => {
        if (this.target && this.hasShield()) {
          this.bot.activateItem(true);
        }
      }, 150);
    }
  }

  /**
   * Compute the weapon cooldown from the held item.
   */
  private getWeaponCooldown(): number {
    const slot =
      this.bot.inventory.slots[this.bot.getEquipmentDestSlot('hand')];
    return getCooldown(slot?.name);
  }

  /**
   * Whether the bot currently has a shield in the off-hand.
   */
  private hasShield(): boolean {
    if (this.bot.supportFeature?.('doesntHaveOffHandSlot')) return false;
    const slot =
      this.bot.inventory.slots[this.bot.getEquipmentDestSlot('off-hand')];
    if (!slot) return false;
    return slot.name.includes('shield');
  }
}

export function plugin(bot: Bot): void {
  bot.pvp = new PVPManager(bot);
}
