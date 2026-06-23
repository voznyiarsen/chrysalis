/**
 * @fileoverview Listener manager for bot event lifecycle.
 * Tracks registered listeners and provides bulk cleanup via offAll().
 */

export class ListenerManager {
  private readonly listeners: Map<string, Set<(...args: any[]) => void>> =
    new Map();

  on(emitter: any, event: string, handler: (...args: any[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    emitter.on(event, handler);
  }

  offAll(emitter: any): void {
    for (const [event, handlers] of this.listeners) {
      for (const handler of handlers) {
        emitter.off(event, handler);
      }
    }
    this.listeners.clear();
  }
}
