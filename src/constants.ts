/**
 * Centralized constants for Pupa bot
 * Organized by category: Physics, Geometry, Movement, Block Detection, Timing, Combat, and Materials
 */

export const Constants = {
  // ============================================================================
  // PHYSICS & GEOMETRY
  // ============================================================================
  PHYSICS: {
    /** Tick-based vertical gravity (blocks per tick squared) */
    TICK_GRAVITY: 0.08,
    /** Tick-based vertical drag multiplier (applied to velocity every tick) */
    TICK_DRAG: 0.98,
    /** Terminal velocity for falling (m/t) */
    TERMINAL_VELOCITY_Y: -3.92,
    /** Base momentum conservation factor for airborne and some ground movement */
    MOMENTUM_CONSERVATION: 0.91,
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
      STRAFE_MULTIPLIER: 0.98,
      STRAFE_45_MULTIPLIER: 1.0,
    },
    /** Projectile gravity context (specific to projectile motion simulation) */
    GRAVITY: 1.6, // Keep for projectiles, but movement uses TICK_GRAVITY
    /** Initial upwards vertical velocity for a jump (V_Y,1) */
    JUMP_VELOCITY: 0.42,
    /** Instantaneous horizontal velocity boost applied during a sprint-jump takeoff */
    SPRINT_JUMP_BOOST: 0.2,
    /** Empirical calibration factor for jump velocity to account for model inaccuracies */
    JUMP_VELOCITY_CALIBRATION: 0.95,
    /** Empirical calibration factor for strafe velocity to account for model inaccuracies */
    STRAFE_VELOCITY_CALIBRATION: 0.95,
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
    EYE_HEIGHT_OFFSET: 1.62,
    /** Small offset used to prevent precision-related collision issues (1/16th of a block) */
    COLLISION_OFFSET_FINE: 0.0625,
  },

  GEOMETRY: {
    /** Width used for liquid collision checking */
    LIQUID_CHECK_WIDTH: 0.6,
    /** Height used for liquid collision checking */
    LIQUID_CHECK_HEIGHT: 1.8,
    /** Vertical levels (indices) used to sample liquid presence */
    LIQUID_CHECK_LEVELS: [0, 1, 2],
    /** Width used for unwanted block detection (e.g., webs, cactus) */
    UNWANTED_CHECK_WIDTH: 0.6,
    /** Height used for unwanted block detection */
    UNWANTED_CHECK_HEIGHT: 1.8,
    /** Horizontal offset for sampling points around the entity position */
    UNWANTED_CHECK_OFFSET: 0.3,
    /** Number of horizontal corners checked for collision/unwanted blocks */
    BOX_CORNERS: 4,
    /** Number of vertical layers sampled for unwanted blocks */
    UNWANTED_CHECK_LAYERS: 2,
  },

  // ============================================================================
  // MOVEMENT & NAVIGATION
  // ============================================================================
  MOVEMENT: {
    /** Asymptotic walking speed on ground (blocks per tick) */
    WALKING_GROUND_SPEED: 0.21585,
    /** Asymptotic sprinting speed on ground (blocks per tick) */
    SPRINTING_GROUND_SPEED: 0.280605,
    /** Maximum allowed horizontal velocity per axis (X or Z) for strafing impulses */
    PER_AXIS_MAX_SPEED: 0.35635,
    /** Velocity used for fine-tuned horizontal positioning (e.g., micro-adjustments) */
    FLAT_VELOCITY_XZ: 0.05,
    /** Radius (in blocks) to search for solid floor blocks for strafing targets */
    SOLID_BLOCK_SEARCH_RADIUS: 3,
    /** Maximum distance from target or source to consider a strafe point valid */
    STRAFE_POINT_MAX_DISTANCE: 3.25,
    /** Minimum distance between consecutive strafe points to avoid repetitive paths */
    STRAFE_POINT_MIN_SPACING: 2.5,
    /** Minimum distance from the bot's current position to consider a strafe point valid */
    STRAFE_POINT_SOURCE_MIN_DISTANCE: 1.5,
    /** Preferred distance range from the PvP target when selecting strafe points */
    STRAFE_PREFERRED_MIN: 1.0,
    STRAFE_PREFERRED_MAX: 2.0,
    /** Maximum number of previous strafe points to keep in history for spacing checks */
    STRAFE_POINTS_MAX_HISTORY: 3,
    /** Step size for segmenting trajectory paths during collision checks */
    COLLISION_SEGMENT_SIZE: 0.2,
    /** Vertical offsets used for Sampling 1.8m high collision box */
    COLLISION_CHECK_HEIGHTS: [0, 0.6, 1.2, 1.8],
    /** Horizontal X/Z offsets for Sampling the 0.6m wide collision box corners */
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
    FOLLOW_RANGE: 3.45,
    /** Maximum distance to track/respond to entities */
    VIEW_DISTANCE: 128,
    /** Horizontal distance threshold for initiating/maintaining strafing maneuvers */
    STRAFE_RANGE: 3.5,
    /** Multiplier to prioritize actions when health is dangerously low */
    CRITICAL_HEALTH_MULTIPLIER: 2,
    /** Food level below which sprinting and health regeneration are disabled */
    LOW_FOOD_THRESHOLD: 18,
    /** Default power for custom projectile calculations */
    DEFAULT_PROJECTILE_VELOCITY: 10,
    /** Vertical eye offset for projectile origin */
    PROJECTILE_EYE_OFFSET: 1.62,
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
    USE_OFFSET_BASED_PEARLS: true,
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
      DANGER_THRESHOLD: 2,
      GAPPLE_ABSORPTION: 8,
      ENCHANTED_GAPPLE_ABSORPTION: 32,
      ENCHANTED_GAPPLE_RESISTANCE: 0.8,
      EAT_TICKS: 32,
      EAT_TICKS_BUFFER: 10,
    },
  },

  // ============================================================================
  // WEAPON ATTACK SPEEDS (from mineflayer-pvp AttackSpeeds.json)
  // ============================================================================
  WEAPON_ATTACK_SPEEDS: {
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
    /** Time in milliseconds to cache solid block search results */
    SOLID_BLOCKS_CACHE_DURATION: 500,
    /** Distance threshold to invalidate cache if bot moves too far from cached position */
    CACHE_POSITION_THRESHOLD: 0.5,
    /** Vertical offset to start searching for walkable ground relative to a target */
    MIN_WALKABLE_Y_OFFSET: -1,
    /** Maximum depth to search downwards for a solid block surface */
    WALKABLE_SEARCH_DEPTH: 2,
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
    RECONNECT_DELAY: 6000,
    /** Number of ticks to wait after an item swap before using it */
    EQUIP_WAIT_TICKS: 2,
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
    /** Hunger restoration and saturation values for food items */
    FOOD: {
      suspicious_stew: { hunger: 13, saturation: 21.2 },
      golden_carrot: { hunger: 6, saturation: 14.4 },
      cooked_porkchop: { hunger: 8, saturation: 12.8 },
      steak: { hunger: 8, saturation: 12.8 },
      rabbit_stew: { hunger: 10, saturation: 12.0 },
      cooked_mutton: { hunger: 6, saturation: 9.6 },
      cooked_salmon: { hunger: 6, saturation: 9.6 },
      golden_apple: { hunger: 4, saturation: 9.6 },
      enchanted_golden_apple: { hunger: 4, saturation: 9.6 },
      cooked_chicken: { hunger: 6, saturation: 7.2 },
      mushroom_stew: { hunger: 6, saturation: 7.2 },
      beetroot_soup: { hunger: 6, saturation: 7.2 },
      baked_potato: { hunger: 5, saturation: 6.0 },
      bread: { hunger: 5, saturation: 6.0 },
      cooked_cod: { hunger: 5, saturation: 6.0 },
      cooked_rabbit: { hunger: 5, saturation: 6.0 },
      pumpkin_pie: { hunger: 8, saturation: 4.8 },
      carrot: { hunger: 3, saturation: 3.6 },
      apple: { hunger: 4, saturation: 2.4 },
      chorus_fruit: { hunger: 4, saturation: 2.4 },
      raw_beef: { hunger: 3, saturation: 1.8 },
      raw_porkchop: { hunger: 3, saturation: 1.8 },
      raw_rabbit: { hunger: 3, saturation: 1.8 },
      beetroot: { hunger: 1, saturation: 1.2 },
      honey_bottle: { hunger: 6, saturation: 1.2 },
      melon_slice: { hunger: 2, saturation: 1.2 },
      poisonous_potato: { hunger: 2, saturation: 1.2 },
      raw_chicken: { hunger: 2, saturation: 1.2 },
      raw_mutton: { hunger: 2, saturation: 1.2 },
      sweet_berries: { hunger: 2, saturation: 1.2 },
      rotten_flesh: { hunger: 4, saturation: 0.8 },
      potato: { hunger: 1, saturation: 0.6 },
      dried_kelp: { hunger: 1, saturation: 0.6 },
      cookie: { hunger: 2, saturation: 0.4 },
      glow_berries: { hunger: 2, saturation: 0.4 },
      raw_cod: { hunger: 2, saturation: 0.4 },
      raw_salmon: { hunger: 2, saturation: 0.4 },
      pufferfish: { hunger: 1, saturation: 0.2 },
      tropical_fish: { hunger: 1, saturation: 0.2 },
    },
  },

  // ============================================================================
  // SHAPE & BOUNDING BOX
  // ============================================================================
  SHAPE: {
    /** Index mapping for block collision shape arrays [minX, minY, minZ, maxX, maxY, maxZ] */
    MIN_X: 0,
    MIN_Y: 1,
    MIN_Z: 2,
    MAX_X: 3,
    MAX_Y: 4,
    MAX_Z: 5,
  },
} as const;
