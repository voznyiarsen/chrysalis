/**
 * @fileoverview E2E integration tests for Pupa inventory functionality.
 *
 * These tests connect to a real Minecraft server using configuration from `.env`,
 * create a bot instance, load all Pupa managers, and run inventory-related debug methods
 * against the live server.
 *
 * Environment variables (`.env`):
 *   E2E_HOST      - Server hostname (default: localhost)
 *   E2E_PORT      - Server port     (default: 25565)
 *   E2E_VERSION   - Game version    (default: 1.12.2)
 *   E2E_TIMEOUT   - Seconds per test (default: 30)
 *
 * Skipped automatically when E2E_HOST is not set.
 */
