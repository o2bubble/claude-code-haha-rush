"use strict";
/**
 * Protocol types for IDE ↔ Claude Code communication over WebSocket.
 *
 * All messages are JSON objects with a `type` field. These types mirror
 * the corresponding interfaces in src/entrypoints/ideMode.ts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isIncomingMessage = isIncomingMessage;
exports.parseMessage = parseMessage;
// ============================================================================
// Type guard
// ============================================================================
function isIncomingMessage(v) {
    return typeof v === 'object' && v !== null && 'type' in v;
}
/**
 * Parse a WebSocket message (always a JSON string) into a typed message.
 */
function parseMessage(data) {
    try {
        const parsed = JSON.parse(data);
        return isIncomingMessage(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=protocol.js.map