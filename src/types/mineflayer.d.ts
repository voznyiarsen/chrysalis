/**
 * @fileoverview Type augmentations for mineflayer and related packages.
 * Declares plugin-attached properties on the Bot interface so they can
 * be accessed without `(bot as any)` casts.
 */

import "mineflayer";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { goals, Movements } from "mineflayer-pathfinder";
import type { Vec3 } from "vec3";
import type { Logger } from "../logger";
import type { AABB } from "../utils";
import type { RuntimeConfig } from "../config";
import type { ListenerManager } from "../listener-manager";
import type { CombatDecision } from "../pvp";
import type { PearlTrajectoryResult } from "../projectile";

// Forward-declare manager classes to avoid circular imports
declare class PVPManager {
  bot: Bot;
  target: Entity | undefined;
  timeToNextAttack: number;
  wasInRange: boolean;
  blockingExplosion: boolean;
  attackRange: number;
  followRange: number;
  viewDistance: number;
  movements: Movements;
  goal: Vec3 | null;
  attack(target: Entity): Promise<void>;
  stop(): Promise<void>;
  forceStop(): void;
  setGoal(pos: Vec3 | null): void;
  clearGoal(): void;
}

declare class InventoryManager {
  findItem(itemName: string, metadata?: number, notFull?: boolean): any[];
  getItemCount(itemName: string): number;
  hasItem(itemName: string, metadata?: number): boolean;
  hasFood(): boolean;
  clearInventory(): Promise<void>;
  setGamemode(mode: number, timeout?: number): Promise<void>;
  recordInventory(slot: number | string): Promise<void>;
  restoreInventory(slot: number | string): Promise<void>;
  tossAllItems(): Promise<void>;
  equipArmor(): Promise<void>;
  equipGapple(): Promise<void>;
  equipFood(): Promise<void>;
  equipBuff(): Promise<void>;
  equipTotem(): Promise<boolean>;
  equipPearl(
    targetPos: Vec3,
    offset: number,
    itemType?: string,
    sourcePos?: Vec3,
  ): Promise<void>;
  equipWeapon(): Promise<void>;
  /**
   * Equip golden apple to off-hand without activating it. */
  equipUtility(): Promise<void>;
  unequipAllItems(): Promise<void>;
  getItemViaCommand(
    itemName: string,
    count: number,
    targetSlot?: string,
  ): Promise<void>;
}

declare class CombatManager {
  bot: Bot;
  logger: Logger;
  alliesSet: Set<string>;
  debounce: boolean;
  lastDamage: number;
  lastHealth: number;
  lastDist: number | null;
  mode: number;
  decisions: CombatDecision[];
  setupDecisions(): void;
  getBestPearlPitch(
    source: Vec3,
    target: Vec3,
  ): { pitch: number; arc: "low" | "high" } | null;
  getBestPearlOffset(
    source: Vec3,
    target: Vec3,
    arcType?: "low" | "high",
  ): { offset: number; arc: "low" | "high" } | null;
  executeDecisions(): Promise<void>;
  setMode(mode?: number): void;
  getTargetFilter(): (e: any) => boolean;
  addAlly(username: string): void;
  removeAlly(username: string): void;
  getLastDamage(): void;
  getHealthStatus(): {
    totalHealth: number;
    healthPoints: number;
    absorbPoints: number;
  };
  getFallProtectionStatus(): {
    isDangerous: boolean;
    predictedDamage?: number;
    ticksToImpact?: number;
    hasTimeToEat?: boolean;
    canEatGapple?: boolean;
    canEatEGapple?: boolean;
    needsTotem?: boolean;
  };
  doDecide(): Promise<void>;
  decideIfToss(): Promise<void>;
  doAvoid(): void;
  doEdgeProtection(): void;
  nudgeToCenter(target: Vec3): Promise<void>;
  updateTarget(): void;
  throwPearlAt(
    targetPos: Vec3,
    arcType?: "low" | "high" | "auto",
  ): Promise<void>;
  _waitUntilSettled(): Promise<void>;
  lastPearlTime: number;
}

declare class CommandManager {
  bot: Bot;
  logger: Logger;
  autosend: boolean;
  tree: Record<string, unknown>;
  variables: Record<string, unknown>;
  setupCommandTree(): void;
  handleInput(data: string): Promise<void>;
  evaluatePlaceholders(str: string): string;
  query(data: string): Promise<void>;
  registerCommand(name: string, node: unknown): void;
  toggleAutosend(): void;
  tossSingle(args: string[]): Promise<void>;
  tossAll(): Promise<void>;
  equip(args: string[]): Promise<void>;
  unequip(args: string[]): Promise<void>;
  unequipAll(): Promise<void>;
  showVersion(): void;
  showPosition(): void;
  restore(args: string[]): Promise<void>;
  record(args: string[]): Promise<void>;
  toggleCombat(): void;
  changeMode(args: string[]): void;
  pacify(): void;
  queryPlayerDB(args: string[]): void;
  querySlotDB(args: string[]): void;
  quit(): void;
  configCommand(args: string[]): void;
  pause(args: string[]): Promise<void>;
  run(args: string[]): Promise<void>;
  listFunctions(): Promise<void>;
  callFunction(args: string[]): Promise<void>;
}

declare class UtilsManager {
  bot: Bot;
  isNewSlipperiness: boolean;
  isNewCollision: boolean;
  isNewThreshold: boolean;
  momentumThreshold: number;
  applyEffects: boolean;
  getSlipperiness(pos: Vec3): number;
  getEffectsMultiplier(): number;
  simulateTick(state: unknown, inputs: unknown): unknown;
  applyImpulse(impulse: Vec3, mode?: "add" | "set", force?: boolean): void;
  getProjectilePitch(
    source: Vec3,
    target: Vec3,
    velocity: number,
    gravity: number,
    drag: number,
  ): number[];
  getProjectileOffset(
    source: Vec3,
    target: Vec3,
    velocity: number,
    gravity: number,
    drag: number,
    arcType: "low" | "high",
  ): number;
  isProjectilePathClear(
    source: Vec3,
    target: Vec3,
    v: number,
    g: number,
    p: number,
    drag?: number,
  ): boolean;
  getBestPearlTrajectory(
    source: Vec3,
    target: Vec3,
    velocity?: number,
    gravity?: number,
    drag?: number,
    toleranceRadius?: number,
    sampleStep?: number,
  ): PearlTrajectoryResult | null;
  isPointInBlock(
    point: Vec3,
    block: { position: Vec3; shapes: number[][] },
  ): boolean;
  getEntityHitbox(entity: Entity): {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  };
  isInCylinder(
    point: Vec3,
    center: Vec3,
    radius: number,
    height: number,
  ): boolean;
  isInUnwanted(pos: Vec3, height?: number, offset?: number): boolean;
  isInLiquid(pos: Vec3): boolean;
  getCollisions(aabb: AABB, minYThreshold?: number): AABB[];
  isJumpPathClear(source: Vec3, target: Vec3): boolean;
  getHorizontalSpeed(): number;
  getJumpVelocity(source: Vec3, target: Vec3, angleDeg?: number): Vec3 | null;
  jumpViaOffset(offset?: Vec3): Promise<number>;
  getFlatVelocity(
    source: Vec3,
    target: Vec3,
    yaw: number,
    speed: number,
    yVel: number,
  ): Vec3;
  getGroundBelow(): number;
  getFallDamage(fallDistance: number): number;
  clearSolidCache(): void;
}

declare module "prismarine-windows" {
  interface Window {
    on(event: "windowUpdate", listener: () => void): this;
    on(event: "changedSlot", listener: () => void): this;
  }
}

declare module "mineflayer" {
  interface Bot {
    /** Pupa's PVP manager plugin. */
    pvp: PVPManager;
    /** Pupa's inventory manager plugin. */
    inventoryManager: InventoryManager;
    /** Pupa's combat manager plugin. */
    combatManager: CombatManager;
    /** Pupa's command manager plugin. */
    commandManager: CommandManager;
    /** Pupa's utils manager plugin. */
    utilsManager: UtilsManager;
    /** Pupa's runtime config. */
    runtimeConfig: RuntimeConfig;
    /** Pupa's logger instance. */
    __logger: Logger;
    /** Listener manager for cleanup. */
    listenerManager: ListenerManager;
    /** Bot number (public alias). */
    botNumber: number;
    /** Original chat function, saved before UtilsManager wraps it. */
    _originalChat: (...args: unknown[]) => void;
    /** Currently held item (from inventory). */
    heldItem: {
      type: number;
      name: string;
      metadata: number;
      nbt: unknown;
    } | null;
  }

  interface Entity {
    /** Equipment slots (helmet, chestplate, leggings, boots). */
    equipment: Array<{ name: string; type: number; count: number } | null>;
    /** Active status effects keyed by effect ID (e.g., "10" = regeneration). */
    effects: unknown[];
    /** Per-entity metadata flags. */
    metadata: Record<number, unknown>;
  }

  interface BotEvents {
    /** Fires every physics tick. */
    physicsTick(): void;
    /** Emitted by PVPManager when it begins attacking. */
    startedAttacking(): void;
    /** Emitted by PVPManager when it stops attacking. */
    stoppedAttacking(): void;
    /** Emitted by PVPManager when an attack is performed. */
    attackedTarget(): void;
    /** Emitted by mineflayer-pathfinder when path computation stops. */
    path_stop(): void;
  }

  interface Registry {
    /** Numeric-indexed item registry. */
    items: Record<number, { id: number; name: string }>;
    /** Name-indexed item registry. */
    itemsByName: Record<string, { id: number; name: string }>;
  }

  interface Game {
    /** Current gamemode name (e.g., "survival", "creative"). */
    gameMode: string;
  }

  interface Bot {
    /** mineflayer item/block/effect registry. */
    registry: Registry;
    /** mineflayer game-state info. */
    game: Game;
  }
}
