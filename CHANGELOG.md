# Changelog

All notable changes to `remarkable-mcp`.

## 1.0.1 — docs polish

Documentation-only release; no code changes.

- Adds [PRIVACY.md](PRIVACY.md) — full data-flow audit. Required by Anthropic's [Software Directory policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy).
- README "Try it — example prompts" section with the three core flows (setup, pull, search) plus follow-up prompts. Required by the policy.
- README "Testing without a reMarkable tablet" subsection that walks reviewers through the static-test path (`remarkable_status` with no tablet, `npm run validate` for the full 58-assertion transcript). Substitutes for the policy-expected "test account with sample data" since the server is hardware-bound.
- Short Privacy + Security sections in the README linking to PRIVACY.md and the issue tracker.
- `package.json` `repository`, `homepage`, `bugs`, and `keywords` fields added (also required by npm provenance verification, which is why v1.0.0 took several attempts to land).

## 1.0.0 — V1 release

First public release. Combines all the hardening, polish, and features that landed across the 0.x line: a six-tool MCP surface (setup, list, pull, status, search, index, save_transcription), USB + WiFi + mDNS connectivity with categorised error reasons, host-key pinning, document caching, configurable PNG/JPEG rendering, client-aware response sizing, and full-text search.

The pre-1.0 entries below are kept for archaeology; they describe development milestones rather than published versions.

### Added at the V1 mark
- **Full-text search** across the OCR'd contents of cached documents. Powered by [MiniSearch](https://github.com/lucaong/minisearch) — a pure-JS BM25 index, no native deps, ~50 KB on disk for thousands of pages. Page-level hits with snippets, BM25 ranking, prefix and fuzzy matching, optional folder filter.
  - New tool **`remarkable_search`** — `{ query, limit?, folder? }` → ranked page hits.
  - New tool **`remarkable_index`** — bulk-OCRs every document on the tablet over USB and adds it to the corpus. Skips docs already cached and indexed for the current mtime unless `force: true`. Requires an OCR provider that produces text (`ollama` or `local`); refuses to run with `native`.
- **Opportunistic indexing.** Every successful `remarkable_pull` in `ollama` or `local` OCR mode now writes per-page text to the cache and updates the search index automatically. The corpus grows organically as the user pulls documents.
- **Per-document `meta.json`** in the cache (`<docId>/<mtime>/meta.json`): authoritative record of what pages have been OCR'd. Used by the index to drop stale entries cheaply when a doc is re-pulled.
- **`inline_images: false` on `remarkable_pull`** — skip inline image blocks and return only saved file paths. Useful for clients with a Read tool (Claude Code, Codex) and to bypass Claude Desktop's response-size cap entirely. Requires `output_dir`.

### Changed
- `pull.ts` now captures the folder map during document selection so the index gets a meaningful folder path (e.g. "Work / Engineering") for the folder boost in search.
- Validation script (`npm run validate`) now asserts on all six tools.
- Bundle's `long_description` mentions the search capability.

### Notes
- Search is **degraded in `native` OCR mode**: the host LLM is meant to read images directly, so no text is captured. To make documents searchable, set `ocr.provider` to `ollama` or `local` in `~/.config/remarkable-mcp/config.json` before pulling.
- The opportunistic-indexing approach means search results only cover documents you've previously pulled. Run `remarkable_index` once for a full library sweep; thereafter normal pulls keep the corpus current.

## 0.4.3

### Changed
- Tool descriptions and the bundle's `long_description` updated to mention refresh mode, mDNS fallback, the unflushed-page reporting, and categorised error reasons — so an agent reading `tools/list` (or a user browsing the directory) gets an accurate picture of capabilities without having to read the README.
- README has a new **Troubleshooting** section mapping each error category to its remedy, plus dedicated subsections for "WiFi IP changed", "Document came back missing pages", and "Response too large for Claude Desktop".

## 0.4.2

### Added
- **Refresh mode for `remarkable_setup`.** Call without a password to rediscover the WiFi IP using the existing SSH key. Tries USB SSH → saved WiFi IP → mDNS in order, then writes the discovered IP back to config. Use this after the tablet rejoins the network on a new DHCP lease.
- **mDNS fallback** in `remarkable_status`, `remarkable_list`, and `remarkable_pull`. When the saved `wifiHost` is unreachable, the server tries `remarkable.local` via the OS resolver — recovers automatically from stale DHCP leases.
- **Categorised SSH errors.** New `categoriseSshError()` translates raw error strings into actionable diagnostics: timeout (asleep / stale IP), refused (SSH down), unreachable (off-network), auth failed (key not deployed), host-key mismatch (tablet reflashed). Status / list / pull failures now show *which* host failed *why*.
- **`HostKeyMismatchError` type.** Surfaced specifically when the tablet's host key doesn't match the pinned fingerprint, with a clear message pointing to `remarkable_setup` for re-pinning.

### Changed
- WiFi SSH probe timeout in `remarkable_status` raised from 8 s to 20 s — gives the tablet time to wake its WiFi radio from cold standby.

## 0.4.1

### Fixed
- **JPEG output now actually works.** `remarkable-rm`'s `renderToJpeg` does `await import('sharp')` internally, but `sharp` was never declared as a dependency. Every JPEG render threw `MODULE_NOT_FOUND`, the catch block silently dropped the page, and the user saw a misleading "page not found or not renderable" error. `sharp` is now a direct dependency.
- **Render failures are no longer silent.** `renderRmFile` now logs the underlying error via `debug()` (`DEBUG=remarkable-mcp`) so future "all pages missing" mysteries are diagnosable in one step.

### Added
- Tool annotations on every tool: `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` — required by Anthropic's connector review criteria.
- `npm run inspect` script — builds and launches the server under [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) for pre-submission validation.

### Changed
- Tool descriptions tightened to remove instructional language ("IMPORTANT: …user can open them immediately") that risks being flagged as prompt-injection-style content.

## 0.4.0 — V1 candidate

### Added
- **Document caching.** Downloaded rmdoc sources are cached to `~/.cache/remarkable-mcp/<docId>/<mtime>/` (override with `REMARKABLE_CACHE_DIR`). Repeat pulls of the same document at the same mtime are instant and offline-capable. Stale mtime directories for the same document are swept on write.
- **Unflushed-page detection.** When the tablet has a document open, the in-progress page may not be saved to disk yet. `remarkable_pull` now reports which page numbers had no `.rm` source and tells the user how to flush them: *"Close the document or change pages on the tablet to save them, then call remarkable_pull again."* Partial documents are deliberately not cached.
- **`remarkable_status` tool.** Reports USB HTTP reachability, WiFi SSH reachability, tablet firmware version, host-key pinning state, config and cache locations, render defaults, and the connected MCP client.
- **Configurable render width and format.** `max_width` and `format` (`png`|`jpeg`) tool args, plus `render.width` / `render.format` / `render.jpegQuality` config defaults. Defaults to PNG @ 1024px (down from native 1404 — ~2× smaller, no legibility loss).
- **JPEG output.** Uses `remarkable-rm`'s `renderToJpeg`; ~5–10× smaller than PNG for OCR-grade pulls.
- **Input validation with zod.** Tool arguments are validated at the boundary; client mistakes (wrong types, missing required fields) get clean error messages instead of regex misses or silent ignores.
- **Lint + CI.** `npm run lint` (eslint + typescript-eslint) and `npm run typecheck`. GitHub Actions workflow runs both plus tests on Node 20 and 22.

### Changed
- `renderPages` now returns `{ rendered: ExportedPage[]; missing: number[] }` so callers can warn about unflushed pages instead of silently dropping them.
- `Config` gains a `render` section (`width`, `format`, `jpegQuality`).
- README documents the firmware ≥ 3.9 requirement for rmdoc download (USB HTTP path), and the new render/cache features.

### Notes for users upgrading from 0.1.x / 0.2.x / 0.3.x
- **Host-key pinning was added in 0.2.0.** If your config predates that, the next SSH connect will TOFU-capture the fingerprint automatically (no action required). Re-running `remarkable_setup` over USB pins it explicitly.
- **`render` section is new.** Existing configs are merged with the defaults — no manual edit needed.

## 0.3.0

### Added
- Client-aware response sizing. Detects Claude Desktop's ~1 MB response cap and trims inline pages to fit, with a clear "call again with page=N" hint. Override budget via `REMARKABLE_INLINE_BUDGET_BYTES`.
- `output_dir` always saves all rendered pages, including ones dropped from the inline payload.

## 0.2.0

### Security
- SSH host-key TOFU pinning. The tablet's host-key fingerprint is captured during `remarkable_setup` (over the USB link, which is host-only and link-local) and verified on every subsequent SSH connect.
- `deployPublicKey` no longer interpolates the public key into a shell command — it base64-encodes it (shell-safe alphabet) and decodes server-side. Also idempotent: appends only if not already present.
- README clarifies that the setup password traverses the agent transcript.

### Correctness
- `rawHttpGet` rejects on truncated bodies (Content-Length advertised but socket closed early) instead of silently resolving with partial data.
- `sshPipeTar` clears the timer and kills `tarProc` on connection error / exec failure paths.
- `enableUsbWebInterface` rewritten as a `set -e` shell script with explicit branches.
- `selectPageIds` filters out empty/missing page UUIDs.
- UUID validation in `remarkable_pull` now sits one line before the shell interpolation that uses it.

### Quality
- Unified `UnifiedDoc` type and shared filter/sort/lookup helpers replace duplicated USB/SSH branches.
- Opt-in stderr debug logging via `DEBUG=remarkable-mcp`.
- `engines.node >= 20` declared.
- Server version read from `package.json` to prevent drift.

## 0.1.0

Initial release. `remarkable_setup`, `remarkable_list`, `remarkable_pull` over USB HTTP and WiFi SSH.
