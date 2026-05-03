import { z } from 'zod';

/** zod schemas for incoming MCP tool arguments. */

export const SetupArgs = z.object({
  /**
   * Root password from the tablet.
   * - Provided  → full setup: deploy SSH key, enable USB web interface, capture host-key, save WiFi IP.
   * - Omitted   → light/refresh mode: assumes setup was done previously; just rediscovers the WiFi IP
   *               using the existing key (USB → existing wifiHost → mDNS).
   */
  password: z.string().min(1).optional(),
});

export const ListArgs = z.object({
  folder: z.string().optional(),
});

export const PullArgs = z.object({
  document: z.string().optional(),
  folder: z.string().optional(),
  page: z.union([z.string(), z.number()]).optional().transform((v) => v === undefined ? undefined : String(v)),
  output_dir: z.string().optional(),
  prompt: z.string().optional(),
  max_width: z.number().int().positive().max(2160).optional(),
  format: z.enum(['png', 'jpeg']).optional(),
  /**
   * If false, skip inline image blocks in the response and return only the saved file paths.
   * Useful for clients with a Read tool (Claude Code, Codex) that can open the saved files directly,
   * and to avoid the response-size cap entirely on large pulls. Requires output_dir.
   * Default: true (current behaviour — inline images plus optional save).
   */
  inline_images: z.boolean().optional(),
}).superRefine((val, ctx) => {
  if (val.inline_images === false && !val.output_dir) {
    ctx.addIssue({
      code: 'custom',
      path: ['output_dir'],
      message: 'output_dir is required when inline_images is false (otherwise the rendered images would be discarded)',
    });
  }
});

export const StatusArgs = z.object({});

export const SearchArgs = z.object({
  query: z.string().min(1, 'query is required'),
  limit: z.number().int().positive().max(100).optional(),
  folder: z.string().optional(),
});

export const IndexArgs = z.object({
  /** Limit how many documents to (re-)index in one call. Defaults to all. */
  limit: z.number().int().positive().max(500).optional(),
  /** Restrict to documents inside this folder name (substring match). */
  folder: z.string().optional(),
  /** If true, force re-OCR even when the cache already has text for a doc. Default: false. */
  force: z.boolean().optional(),
});

export type PullArgsT = z.infer<typeof PullArgs>;
export type ListArgsT = z.infer<typeof ListArgs>;
export type SetupArgsT = z.infer<typeof SetupArgs>;
