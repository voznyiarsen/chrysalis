/**
 * @fileoverview Centralized constants for Pupa bot.
 * Organized by category: Physics, Geometry, Movement, Block Detection, Timing, Combat, and Materials.
 */

export const Constants = {
  // ============================================================================
  // PHYSICS & GEOMETRY
  // ============================================================================
  PHYSICS: {
    /** Vertical gravity (blocks per tick squared) */
    GRAVITY: 0.08,
    /** Vertical drag multiplier (applied to velocity every tick) */
    DRAG: 0.98,
    /** Terminal velocity for falling (m/t) */
    TERMINAL_VELOCITY: -3.92,
    /** Base momentum conservation factor for airborne and some ground movement */
    MOMENTUM: 0.91,
    /** Slipperiness factors (St) for different blocks affecting friction and acceleration */
    SLIPPERINESS: {
      DEFAULT: 0.6,
      SLIME: 0.8,
      ICE: 0.98,
      BLUE_ICE: 0.989,
      AIRBORNE: 1.0,
    },
    /** Acceleration constants (used in V_H formulas) */
    ACCELERATION: {
      GROUND: 0.1,
      AIR: 0.02,
      SPRINT_MULTIPLIER: 1.3,
      SNEAK_MULTIPLIER: 0.3,
    },
    /** Initial upwards vertical velocity for a jump (V_Y,1) */
    JUMP_VELOCITY: 0.42,
    /** Horizontal velocity boost applied during a sprint-jump takeoff */
    JUMP_BOOST: 0.2,
    /**
     * Correction factor to account for differences between LCE physics model
     * and actual server physics. The server applies ~21% more effective friction
     * than the LCE model predicts, so computed velocities must be scaled down.
     * Determined empirically by measuring jump distance vs target distance.
     */
    JUMP_CORRECTION: 0.825,
    /** Momentum thresholds for stopping movement */
    MOMENTUM_THRESHOLD_1_8: 0.005,
    /** Momentum thresholds for stopping movement (1.9+) */
    MOMENTUM_THRESHOLD_1_9: 0.003,
    /** Standard player height in blocks */
    PLAYER_HEIGHT: 1.8,
    /** Standard player width in blocks (0.6x0.6 footprint) */
    PLAYER_WIDTH: 0.6,
    /** Half-width of the player for offset calculations */
    PLAYER_OFFSET: 0.3,
    /** Vertical offset from position to eye level */
    EYE_HEIGHT: 1.62,
    /** Small offset used to prevent precision-related collision issues (1/16th of a block) */
    COLLISION_OFFSET: 0.0625,
  },

  GEOMETRY: {
    /** Width used for liquid collision checking */
    LIQUID_WIDTH: 0.6,
    /** Height used for liquid collision checking */
    LIQUID_HEIGHT: 1.8,
    /** Vertical levels (indices) used to sample liquid presence */
    LIQUID_LEVELS: [0, 1, 2],
    /** Width used for unwanted block detection (e.g., webs, cactus) */
    UNWANTED_WIDTH: 0.6,
    /** Height used for unwanted block detection */
    UNWANTED_HEIGHT: 1.8,
    /** Horizontal offset for sampling points around the entity position */
    UNWANTED_OFFSET: 0.3,
    /** Number of vertical layers for unwanted block detection */
    UNWANTED_LAYERS: 3,
  },

  // ============================================================================
  // SHAPE INDICES (for block shapes arrays: [minX, minY, minZ, maxX, maxY, maxZ])
  // ============================================================================
  SHAPE: {
    MIN_X: 0,
    MIN_Y: 1,
    MIN_Z: 2,
    MAX_X: 3,
    MAX_Y: 4,
    MAX_Z: 5,
  },

  // ============================================================================
  // MOVEMENT & NAVIGATION
  // ============================================================================
  MOVEMENT: {
    /**
     * Walking input scale — matches Legacy Console Edition (7th Gen)
     * `Mob::walkingSpeed` (Mob.cpp:57).  The LCE ground model normalizes
     * input to this speed via `moveRelative()`; actual asymptotic speed is
     * `walkingSpeed * friction / (1 - friction)` ≈ 0.12 b/tick.
     */
    WALK_SPEED: 0.1,
    /**
     * Sprinting input scale — matches LCE `Player::_init` (Player.cpp:1013-1018)
     * where `walkingSpeed += abilities.getWalkingSpeed() * 0.3f` → 0.1 + 0.03 = 0.13.
     */
    SPRINT_SPEED: 0.13,
    /**
     * Air movement scale — matches LCE `Mob::flyingSpeed` (Mob.cpp:58).
     * In air, `moveRelative()` uses this as the normalized input speed.
     * With sprint: `flyingSpeed += defaultFlySpeed * 0.3` = 0.026 (Player.cpp:1018).
     */
    AIR_SPEED: 0.02,
    /**
     * Sprinting air speed — matches LCE `Player::_init` (Player.cpp:1018).
     */
    SPRINT_AIR_SPEED: 0.026,
    /** Velocity used for fine-tuned horizontal positioning (e.g., micro-adjustments) */
    FLAT_SPEED: 0.05,
    /** Maximum allowed horizontal velocity per axis (X or Z) for movement impulses */
    MAX_AXIS_SPEED: 0.35635,
    /** Radius (in blocks) to search for solid floor blocks */
    SOLID_BLOCK_RADIUS: 3,
    /** Step size for segmenting trajectory paths during collision checks */
    COLLISION_SEGMENT: 0.2,
    /** Vertical offsets used for sampling 1.8m high collision box */
    COLLISION_HEIGHTS: [0, 0.6, 1.2, 1.8],
    /** Horizontal X/Z offsets for sampling the 0.6m wide collision box corners */
    COLLISION_OFFSETS: [
      { x: -0.3, z: -0.3 },
      { x: 0.3, z: -0.3 },
      { x: -0.3, z: 0.3 },
      { x: 0.3, z: 0.3 },
    ],
  },

  // ============================================================================
  // COMBAT SETTINGS
  // ============================================================================
  COMBAT: {
    /** Maximum reach distance for melee attacks */
    ATTACK_RANGE: 3.5,
    /** Preferred distance to maintain behind/around a target while following */
    FOLLOW_RANGE: 2.99,
    /** Maximum distance to track/respond to entities */
    VIEW_DISTANCE: 128,
    /** Multiplier to prioritize actions when health is dangerously low */
    CRITICAL_HP_MULT: 2,
    /** Food level below which sprinting and health regeneration are disabled */
    LOW_FOOD: 18,
    /** Default power for custom projectile calculations */
    PROJECTILE_VELOCITY: 10,
    /** Vertical eye offset for projectile origin */
    PROJECTILE_EYE_HEIGHT: 1.62,
    /** Physics and offset profiles for various throwable items */
    PROJECTILES: {
      ender_pearl: {
        VELOCITY: 1.5,
        GRAVITY: 0.03,
        DRAG: 0.99,
        PITCH_OFFSET: 0,
      },
      snowball: { VELOCITY: 1.5, GRAVITY: 0.03, DRAG: 0.99, PITCH_OFFSET: 0 },
      egg: { VELOCITY: 1.5, GRAVITY: 0.03, DRAG: 0.99, PITCH_OFFSET: 0 },
      potion: { VELOCITY: 0.5, GRAVITY: 0.05, DRAG: 0.99, PITCH_OFFSET: -20 },
      experience_bottle: {
        VELOCITY: 0.7,
        GRAVITY: 0.07,
        DRAG: 0.99,
        PITCH_OFFSET: -20,
      },
      arrow: { VELOCITY: 3.0, GRAVITY: 0.05, DRAG: 0.99, PITCH_OFFSET: 0 },
      trident: { VELOCITY: 2.5, GRAVITY: 0.05, DRAG: 0.99, PITCH_OFFSET: 0 },
      wind_charge: { VELOCITY: 1.0, GRAVITY: 0.0, DRAG: 1.0, PITCH_OFFSET: 0 },
      fireball: { VELOCITY: 1.0, GRAVITY: 0.0, DRAG: 0.95, PITCH_OFFSET: 0 },
    },
    /** Enable offset-based pearl throwing (true) or angle-based (false) */
    OFFSET_PEARLS: true,
    /** Specialized settings for ender pearl usage */
    ENDER_PEARL: {
      VELOCITY: 1.5,
      GRAVITY: 0.03,
      DRAG: 0.99,
      MAX_RANGE: 50,
      COOLDOWN: 10000,
    },
    /** HP and Survival settings */
    SURVIVAL: {
      MAX_HP: 20,
      DANGER_HP: 2,
      GAPPLE_ABSORB: 8,
      EGAPPLE_ABSORB: 32,
      EGAPPLE_RESIST: 0.8,
      EAT_TICKS: 32,
      EAT_BUFFER: 10,
    },
  },

  // ============================================================================
  // WEAPON ATTACK SPEEDS (from mineflayer-pvp AttackSpeeds.json)
  // ============================================================================
  WEAPON_SPEEDS: {
    wooden_sword: 1.6,
    golden_sword: 1.6,
    stone_sword: 1.6,
    iron_sword: 1.6,
    diamond_sword: 1.6,
    netherite_sword: 1.6,
    trident: 1.1,
    wooden_shovel: 1.0,
    golden_shovel: 1.0,
    stone_shovel: 1.0,
    iron_shovel: 1.0,
    diamond_shovel: 1.0,
    netherite_shovel: 1.0,
    wooden_pickaxe: 1.2,
    golden_pickaxe: 1.2,
    stone_pickaxe: 1.2,
    iron_pickaxe: 1.2,
    diamond_pickaxe: 1.2,
    netherite_pickaxe: 1.2,
    wooden_axe: 0.8,
    golden_axe: 1.0,
    stone_axe: 0.8,
    iron_axe: 0.9,
    diamond_axe: 1.0,
    netherite_axe: 1.0,
    wooden_hoe: 1.0,
    golden_hoe: 1.0,
    stone_hoe: 2.0,
    iron_hoe: 3.0,
    diamond_hoe: 4.0,
    netherite_hoe: 4.0,
    OTHER: 4.0,
  },

  // ============================================================================
  // BLOCK DETECTION & CACHING
  // ============================================================================
  BLOCK_DETECTION: {
    /** Time-to-live in milliseconds for solid block search cache */
    SOLID_CACHE_TTL: 500,
    /** Distance threshold to invalidate cache if bot moves too far from cached position */
    CACHE_POS_THRESHOLD: 0.5,
    /** Vertical offset to start searching for walkable ground relative to a target */
    WALKABLE_Y_OFFSET: -1,
    /** Maximum depth to search downwards for a solid block surface */
    WALKABLE_DEPTH: 2,
    /** Block names identified as liquid for physics/navigation */
    LIQUID_BLOCK_NAMES: ["water", "lava"],
    /** Blocks to avoid entirely due to hazard or movement impairment */
    UNWANTED_BLOCK_NAMES: ["water", "lava", "web", "cactus"],
  },

  // ============================================================================
  // TIMING & DELAYS
  // ============================================================================
  TIMING: {
    /** Delay in milliseconds before attempting to reconnect to a server */
    RECONNECT_MS: 6000,
    /** Number of ticks to wait after an item swap before using it */
    EQUIP_TICKS: 2,
    /** Default timeout for asynchronous operations */
    DEFAULT_TIMEOUT: 2000,
  },

  // ============================================================================
  // MATERIAL STATS (ARMOR & WEAPONS)
  // ============================================================================
  MATERIALS: {
    /** Defense points and toughness ratings for armor pieces */
    ARMOR: {
      leather: {
        helmet: { defense: 1, toughness: 0 },
        chestplate: { defense: 3, toughness: 0 },
        leggings: { defense: 2, toughness: 0 },
        boots: { defense: 1, toughness: 0 },
      },
      gold: {
        helmet: { defense: 2, toughness: 0 },
        chestplate: { defense: 5, toughness: 0 },
        leggings: { defense: 3, toughness: 0 },
        boots: { defense: 1, toughness: 0 },
      },
      chainmail: {
        helmet: { defense: 2, toughness: 0 },
        chestplate: { defense: 5, toughness: 0 },
        leggings: { defense: 4, toughness: 0 },
        boots: { defense: 1, toughness: 0 },
      },
      iron: {
        helmet: { defense: 2, toughness: 0 },
        chestplate: { defense: 6, toughness: 0 },
        leggings: { defense: 5, toughness: 0 },
        boots: { defense: 2, toughness: 0 },
      },
      diamond: {
        helmet: { defense: 3, toughness: 2 },
        chestplate: { defense: 8, toughness: 2 },
        leggings: { defense: 6, toughness: 2 },
        boots: { defense: 3, toughness: 2 },
      },
      netherite: {
        helmet: { defense: 3, toughness: 3 },
        chestplate: { defense: 8, toughness: 3 },
        leggings: { defense: 6, toughness: 3 },
        boots: { defense: 3, toughness: 3 },
      },
    },
    /** Damage and attack speed stats for common weapons */
    WEAPONS: {
      wooden_sword: { damage: 4, speed: 1.6 },
      stone_sword: { damage: 5, speed: 1.6 },
      gold_sword: { damage: 4, speed: 1.6 },
      iron_sword: { damage: 6, speed: 1.6 },
      diamond_sword: { damage: 7, speed: 1.6 },
      netherite_sword: { damage: 8, speed: 1.6 },
      wooden_axe: { damage: 7, speed: 0.8 },
      stone_axe: { damage: 9, speed: 0.8 },
      gold_axe: { damage: 7, speed: 1.0 },
      iron_axe: { damage: 9, speed: 0.9 },
      diamond_axe: { damage: 9, speed: 1.0 },
      netherite_axe: { damage: 10, speed: 1.0 },
    },
    /** Mapping of generic equipment slots to internal armor names */
    SLOT_MAP: {
      head: "helmet",
      torso: "chestplate",
      legs: "leggings",
      feet: "boots",
    },
  },
} as const;
