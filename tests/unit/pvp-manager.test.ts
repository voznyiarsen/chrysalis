/**
 * @fileoverview Unit tests for pvp-manager utility functions.
 */

import {
  getAttackSpeed,
  getCooldown,
  getDamageMultiplier,
} from "../../src/pvp";
import { Constants } from "../../src/constants";

describe("getAttackSpeed", () => {
  test("returns OTHER speed for null/undefined", () => {
    expect(getAttackSpeed(null)).toBe(Constants.WEAPON_ATTACK_SPEEDS.OTHER);
    expect(getAttackSpeed(undefined)).toBe(
      Constants.WEAPON_ATTACK_SPEEDS.OTHER,
    );
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
      Constants.WEAPON_ATTACK_SPEEDS.OTHER,
    );
    expect(getAttackSpeed("minecraft:stick")).toBe(
      Constants.WEAPON_ATTACK_SPEEDS.OTHER,
    );
  });

  test("returns OTHER speed for empty string", () => {
    expect(getAttackSpeed("")).toBe(Constants.WEAPON_ATTACK_SPEEDS.OTHER);
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
