/**
 * @fileoverview Runtime configuration manager for Pupa bot.
 * Provides mutable wrappers around combat and movement constants
 * that can be adjusted at runtime without restarting the bot.
 */
import { Constants } from "./constants";

export class RuntimeConfig {
  private readonly _overrides: Map<string, unknown> = new Map();

  /**
   * Get a config value, checking overrides first, then falling back to Constants.
   * @param category - Category name (e.g., "COMBAT", "MOVEMENT")
   * @param key - Key within the category (e.g., "ATTACK_RANGE")
   * @returns The configured value
   */
  get<T = unknown>(category: string, key: string): T {
    const overrideKey = `${category}.${key}`;
    if (this._overrides.has(overrideKey)) {
      return this._overrides.get(overrideKey) as T;
    }
    return (Constants as Record<string, Record<string, unknown>>)[category]?.[
      key
    ] as T;
  }

  /**
   * Set a runtime override for a config value.
   * @param category - Category name (e.g., "COMBAT", "MOVEMENT")
   * @param key - Key within the category (e.g., "ATTACK_RANGE")
   * @param value - New value
   */
  set(category: string, key: string, value: unknown): void {
    this._overrides.set(`${category}.${key}`, value);
  }

  /**
   * Remove a runtime override, reverting to the default constant.
   * @param category - Category name
   * @param key - Key within the category
   */
  reset(category: string, key: string): void {
    this._overrides.delete(`${category}.${key}`);
  }

  /**
   * Get all current overrides as a flat object.
   * @returns Record of override key-value pairs
   */
  getAllOverrides(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of this._overrides) {
      result[key] = value;
    }
    return result;
  }
}
