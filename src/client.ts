/**
 * Tracks the connected MCP client so response builders can size payloads appropriately.
 * Populated lazily on the first tool call (after the MCP `initialize` handshake completes).
 */

let clientName: string | undefined;

export function setClientName(name: string | undefined): void {
  clientName = name;
}

export function getClientName(): string | undefined {
  return clientName;
}

/** True when the connected client is Claude Desktop (which has a ~1MB tool-response cap). */
export function isClaudeDesktop(): boolean {
  const n = (clientName ?? '').toLowerCase();
  return n.includes('claude-ai') || n.includes('claude desktop') || n === 'claude-desktop';
}

/**
 * Maximum total bytes (after base64 inflation) that may go inline in a single tool response.
 * Defaults are conservative; override with REMARKABLE_INLINE_BUDGET_BYTES.
 */
export function getInlineBudgetBytes(): number {
  const override = parseInt(process.env.REMARKABLE_INLINE_BUDGET_BYTES ?? '', 10);
  if (Number.isFinite(override) && override > 0) return override;
  return isClaudeDesktop() ? 900_000 : 4_000_000;
}
