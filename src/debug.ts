import { format } from 'util';

const enabled = (() => {
  const v = process.env.DEBUG;
  if (!v) return false;
  return v === '*' || v.split(',').some((part) => part.trim() === 'remarkable-mcp');
})();

/**
 * Print to stderr only when DEBUG=remarkable-mcp (or DEBUG=*) is set.
 * stdout is reserved for the MCP transport and must never receive log lines.
 */
export function debug(message: string, ...args: unknown[]): void {
  if (!enabled) return;
  process.stderr.write(`[remarkable-mcp] ${format(message, ...args)}\n`);
}
