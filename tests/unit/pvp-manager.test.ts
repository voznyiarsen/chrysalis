/**
 * @fileoverview Unit tests for pvp-manager utility functions.
 */

import {
  getAttackSpeed,
  getCooldown,
  getDamageMultiplier,
  getAttackInterval,
  getDefaultAttackRange,
  isLegacyCombatVersion,
  isVersionAtLeast,
  parseMcVersion,
  MODERN_REACH_RANGE,
} from "../../src/pvp";
import { Constants } from "../../src/constants";

describe("getAttackSpeed", () => {
  test("returns OTHER speed for null/undefined", () => {
    expect(getAttackSpeed(null)).toBe(Constants.WEAPON_SPEEDS.OTHER);
    expect(getAttackSpeed(undefined)).toBe(Constants.WEAPON_SPEEDS.OTHER);
  });

  test("returns correct speed for swords", () => {
    expect(getAttackSpeed("minecraft:iron_sword")).toBe(1.6);
    expect(getAttackSpeed("minecraft:diamond_sword")).toBe(1.6);
  });

  test("returns correct speed for trident", () => {
    expect(getAttackSpeed("minecraft:trident")).toBe(1.1);
  });

  test("returns correct speed for axes", () => {
    expect(getAttackSpeed("minecraft:iron_axe")).toBe(0.9);
    expect(getAttackSpeed("minecraft:diamond_axe")).toBe(1.0);
  });

  test("returns OTHER speed for non-weapon items", () => {
    expect(getAttackSpeed("minecraft:apple")).toBe(
      Constants.WEAPON_SPEEDS.OTHER,
    );
    expect(getAttackSpeed("minecraft:stick")).toBe(
      Constants.WEAPON_SPEEDS.OTHER,
    );
  });

  test("returns OTHER speed for empty string", () => {
    expect(getAttackSpeed("")).toBe(Constants.WEAPON_SPEEDS.OTHER);
  });
});

describe("getCooldown", () => {
  test("returns correct cooldown for sword (speed 1.6)", () => {
    // Math.floor((1 / 1.6) * 20) = Math.floor(12.5) = 12
    expect(getCooldown("minecraft:iron_sword")).toBe(12);
  });

  test("returns correct cooldown for trident (speed 1.1)", () => {
    // Math.floor((1 / 1.1) * 20) = Math.floor(18.18...) = 18
    expect(getCooldown("minecraft:trident")).toBe(18);
  });

  test("returns correct cooldown for null (fist, speed 4.0)", () => {
    // Math.floor((1 / 4.0) * 20) = Math.floor(5) = 5
    expect(getCooldown(null)).toBe(5);
  });
});

describe("getDamageMultiplier", () => {
  test("returns value between 0.2 and 1.0", () => {
    const multiplier = getDamageMultiplier("minecraft:iron_sword");
    expect(multiplier).toBeGreaterThanOrEqual(0.2);
    expect(multiplier).toBeLessThanOrEqual(1.0);
  });

  test("returns consistent value for same weapon", () => {
    const m1 = getDamageMultiplier("minecraft:diamond_sword");
    const m2 = getDamageMultiplier("minecraft:diamond_sword");
    expect(m1).toBe(m2);
  });

  test("returns value for null (fist)", () => {
    const multiplier = getDamageMultiplier(null);
    expect(multiplier).toBeGreaterThanOrEqual(0.2);
    expect(multiplier).toBeLessThanOrEqual(1.0);
  });
});

describe("parseMcVersion", () => {
  test("parses major.minor.patch", () => {
    expect(parseMcVersion("1.12.2")).toEqual([1, 12, 2]);
    expect(parseMcVersion("1.20.5")).toEqual([1, 20, 5]);
  });

  test("defaults a missing patch to 0", () => {
    expect(parseMcVersion("1.21")).toEqual([1, 21, 0]);
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseMcVersion(" 1.20.5 ")).toEqual([1, 20, 5]);
  });

  test("returns null for unparseable versions", () => {
    expect(parseMcVersion(null)).toBeNull();
    expect(parseMcVersion(undefined)).toBeNull();
    expect(parseMcVersion("")).toBeNull();
    expect(parseMcVersion("nope")).toBeNull();
  });
});

describe("isVersionAtLeast", () => {
  test("compares each component in order", () => {
    expect(isVersionAtLeast("1.20.5", 1, 20, 5)).toBe(true);
    expect(isVersionAtLeast("1.20.4", 1, 20, 5)).toBe(false);
    expect(isVersionAtLeast("1.21", 1, 20, 5)).toBe(true);
    expect(isVersionAtLeast("2.0", 1, 20, 5)).toBe(true);
  });

  test("treats an unknown version as modern", () => {
    expect(isVersionAtLeast(undefined, 1, 20, 5)).toBe(true);
    expect(isVersionAtLeast("garbage", 1, 20, 5)).toBe(true);
  });
});

describe("isLegacyCombatVersion", () => {
  test("is true for 1.8 and earlier", () => {
    expect(isLegacyCombatVersion("1.7.10")).toBe(true);
    expect(isLegacyCombatVersion("1.8.9")).toBe(true);
  });

  test("is false from 1.9 on", () => {
    expect(isLegacyCombatVersion("1.9")).toBe(false);
    expect(isLegacyCombatVersion("1.12.2")).toBe(false);
    expect(isLegacyCombatVersion("1.21")).toBe(false);
  });

  test("treats unknown versions as modern", () => {
    expect(isLegacyCombatVersion(null)).toBe(false);
  });
});

describe("getDefaultAttackRange", () => {
  test("uses classic 3.5 hitbox reach before 1.20.5", () => {
    expect(getDefaultAttackRange("1.8.9")).toBe(Constants.COMBAT.ATTACK_RANGE);
    expect(getDefaultAttackRange("1.12.2")).toBe(Constants.COMBAT.ATTACK_RANGE);
    expect(getDefaultAttackRange("1.20.4")).toBe(Constants.COMBAT.ATTACK_RANGE);
  });

  test("uses server-enforced 3.0 interaction range from 1.20.5", () => {
    expect(getDefaultAttackRange("1.20.5")).toBe(MODERN_REACH_RANGE);
    expect(getDefaultAttackRange("1.21")).toBe(MODERN_REACH_RANGE);
  });

  test("defaults unknown versions to modern reach", () => {
    expect(getDefaultAttackRange(undefined)).toBe(MODERN_REACH_RANGE);
  });
});

describe("getAttackInterval", () => {
  test("rounds the vanilla cooldown up with a half-tick discount", () => {
    // iron sword: 20 / 1.6 = 12.5 -> ceil(12.0) = 12
    expect(getAttackInterval("minecraft:iron_sword")).toBe(12);
    // trident: 20 / 1.1 = 18.18 -> ceil(17.68) = 18
    expect(getAttackInterval("minecraft:trident")).toBe(18);
    // diamond axe: 20 / 1.0 = 20 -> ceil(19.5) = 20
    expect(getAttackInterval("minecraft:diamond_axe")).toBe(20);
  });

  test("fist cooldown is 5 ticks", () => {
    expect(getAttackInterval(null)).toBe(5);
  });

  test("never returns less than one tick", () => {
    expect(getAttackInterval("minecraft:iron_sword")).toBeGreaterThanOrEqual(1);
  });
});
