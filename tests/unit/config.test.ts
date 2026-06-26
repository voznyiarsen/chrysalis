/**
 * @fileoverview Unit tests for RuntimeConfig.
 */

import { RuntimeConfig } from "../../src/config";
import { Constants } from "../../src/constants";

describe("RuntimeConfig", () => {
  let config: RuntimeConfig;

  beforeEach(() => {
    config = new RuntimeConfig();
  });

  describe("get", () => {
    test("returns default constant value when no override is set", () => {
      expect(config.get("COMBAT", "ATTACK_RANGE")).toBe(3.5);
    });

    test("returns override value when set", () => {
      config.set("COMBAT", "ATTACK_RANGE", 4.0);
      expect(config.get("COMBAT", "ATTACK_RANGE")).toBe(4.0);
    });

    test("returns undefined for unknown category", () => {
      expect(config.get("UNKNOWN", "KEY")).toBeUndefined();
    });

    test("returns undefined for unknown key in known category", () => {
      expect(config.get("COMBAT", "UNKNOWN_KEY")).toBeUndefined();
    });
  });

  describe("set", () => {
    test("sets a numeric override", () => {
      config.set("COMBAT", "ATTACK_RANGE", 5.0);
      expect(config.get("COMBAT", "ATTACK_RANGE")).toBe(5.0);
    });

    test("sets a string override", () => {
      config.set("COMBAT", "ATTACK_RANGE", "test");
      expect(config.get("COMBAT", "ATTACK_RANGE")).toBe("test");
    });

    test("overrides previous value", () => {
      config.set("COMBAT", "ATTACK_RANGE", 4.0);
      config.set("COMBAT", "ATTACK_RANGE", 5.0);
      expect(config.get("COMBAT", "ATTACK_RANGE")).toBe(5.0);
    });
  });

  describe("reset", () => {
    test("removes an override and reverts to default", () => {
      config.set("COMBAT", "ATTACK_RANGE", 4.0);
      config.reset("COMBAT", "ATTACK_RANGE");
      expect(config.get("COMBAT", "ATTACK_RANGE")).toBe(3.5);
    });

    test("does nothing when no override exists", () => {
      config.reset("COMBAT", "ATTACK_RANGE");
      expect(config.get("COMBAT", "ATTACK_RANGE")).toBe(3.5);
    });
  });

  describe("getAllOverrides", () => {
    test("returns empty object when no overrides", () => {
      expect(config.getAllOverrides()).toEqual({});
    });

    test("returns all active overrides", () => {
      config.set("COMBAT", "ATTACK_RANGE", 4.0);
      config.set("MOVEMENT", "STRAFE_RADIUS", 5.0);
      const overrides = config.getAllOverrides();
      expect(overrides).toEqual({
        "COMBAT.ATTACK_RANGE": 4.0,
        "MOVEMENT.STRAFE_RADIUS": 5.0,
      });
    });

    test("does not include reset overrides", () => {
      config.set("COMBAT", "ATTACK_RANGE", 4.0);
      config.set("MOVEMENT", "STRAFE_RADIUS", 5.0);
      config.reset("COMBAT", "ATTACK_RANGE");
      expect(config.getAllOverrides()).toEqual({
        "MOVEMENT.STRAFE_RADIUS": 5.0,
      });
    });
  });
});
