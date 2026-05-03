# remarkable-mcp

MCP server for reMarkable 2 — pull handwritten notes and diagrams into any AI agent.

Works with Claude Desktop, Claude Code, Codex, Cursor, and any MCP-compatible client.

## How it connects

- **USB connected:** uses the tablet's HTTP web interface (`http://10.11.99.1`) — fastest, no SSH needed
- **WiFi only:** falls back to SSH over the tablet's WiFi IP — requires SSH key setup

## Requirements

- Node.js 20+
- reMarkable 2 tablet running firmware **3.9 or later** (older firmware lacks the rmdoc download endpoint used by the USB HTTP path; the SSH fallback still works)

## Client configuration

### Claude Desktop — single-click install (recommended)

Download the latest **`remarkable-mcp-X.Y.Z.mcpb`** from [Releases](https://github.com/Scratchydisk/remarkable-mcr/releases) and double-click it. Claude Desktop opens the install dialog; click **Install**, restart Claude, and you're ready. No CLI, no config editing.

> `.mcpb` (MCP Bundle, formerly `.dxt`) is Anthropic's single-file extension format. The bundle ships with all dependencies embedded, so you don't need Node.js or `npm` for the Desktop install path.

### Claude Desktop — manual config

If you'd rather edit JSON, add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "remarkable": {
      "command": "npx",
      "args": ["-y", "remarkable-mcp"]
    }
  }
}
```

### Claude Code

```json
{
  "mcp": {
    "servers": {
      "remarkable": {
        "command": "npx",
        "args": ["-y", "remarkable-mcp"]
      }
    }
  }
}
```

### Other MCP clients

Any client that supports stdio MCP servers:

```json
{
  "command": "npx",
  "args": ["-y", "remarkable-mcp"]
}
```

### Optional: global install (faster startup)

```bash
npm install -g remarkable-mcp
```

Then use `"command": "remarkable-mcp"` with no `args`.

## First-time setup

Connect your tablet via USB, then ask your agent:

> "Set up my reMarkable. The password is [password from Settings → Help → Copyright and licenses]."

The agent calls `remarkable_setup`, which:

1. Deploys an SSH keypair (for WiFi use)
2. Enables the USB web interface on the tablet
3. Captures the tablet's SSH host-key fingerprint and pins it for future connections
4. Discovers and saves your tablet's WiFi IP

> **Security note:** the password is sent to your MCP client as a tool argument and may appear in agent transcripts or logs. The host-key fingerprint is captured over the USB cable (which is link-local and host-only) and verified on every WiFi SSH connect thereafter, so a man-in-the-middle on your LAN cannot impersonate the tablet.

## Tools

### `remarkable_setup`

Two modes:

- **Full setup** — call with `password` (from **Settings → Help → Copyright and licenses**). Generates an SSH keypair, deploys the public key over USB, enables the on-tablet USB web interface, captures and pins the SSH host-key fingerprint, and saves the WiFi IP.
- **Refresh** — call with no arguments. Assumes a prior full setup and just rediscovers the current WiFi IP using the existing SSH key. Tries USB SSH → saved WiFi IP → `remarkable.local` (mDNS). Use this after the tablet rejoins the network on a different DHCP lease — the agent's prompt could simply be "refresh my reMarkable WiFi".

### `remarkable_list`

Lists all documents on the tablet, sorted by most recently modified. Optional `folder` substring filter.

### `remarkable_pull`

Pulls a document and returns rendered page images.

| Parameter    | Type             | Description                                                                                                                |
|--------------|------------------|----------------------------------------------------------------------------------------------------------------------------|
| `document`   | string?          | Document name substring (defaults to most recent)                                                                          |
| `folder`     | string?          | Folder name substring to disambiguate when the same document name exists in multiple folders                               |
| `page`       | string?          | Single page (`"3"`) or inclusive range (`"1-4"`); defaults to all pages                                                    |
| `output_dir` | string?          | Local directory to save rendered images. All pages are saved here, even ones too large to inline                           |
| `prompt`     | string?          | Custom transcription instruction (native mode: returned as agent context)                                                  |
| `max_width`  | number?          | Render width in pixels (default 1024; native rM2 is 1404). Smaller = smaller payloads                                      |
| `format`     | `"png"`/`"jpeg"` | Output format. PNG preserves linework; JPEG is much smaller for OCR-grade pulls                                            |
| `inline_images` | boolean?      | If `false`, return only saved file paths and skip inline image blocks (bypasses the response-size cap). Requires `output_dir`. Default `true`. |

**Document caching.** Downloaded sources are cached at `~/.cache/remarkable-mcp/<docId>/<mtime>/` (override with `REMARKABLE_CACHE_DIR`). Repeat pulls of the same document at the same mtime are instant. The cache invalidates automatically when you edit the document on the tablet (mtime moves forward); stale entries are swept on the next write.

**Unflushed pages.** reMarkable saves a page's `.rm` file only when you change pages or close the document. If you pull while a notebook is open, any unsaved page is reported in the response (e.g. *"Page 3 had no saved data"*), and that pull is **not cached** — re-pull after closing the document on the tablet for a clean copy.

**Response sizing.** Claude Desktop has a ~1 MB tool-response cap. The server detects this and trims pages that wouldn't fit, returning a clear hint of the next call to make (e.g. `page="3-5"`). Set `format="jpeg"` and/or a smaller `max_width` to fit more pages per response. Override the cap with `REMARKABLE_INLINE_BUDGET_BYTES`.

### `remarkable_status`

Diagnoses connectivity and configuration. Reports USB HTTP reachability, WiFi SSH reachability, tablet firmware, host-key pinning state, config and cache paths, and the connected MCP client. Useful for the agent to ask itself "what's wrong?" before guessing.

### `remarkable_search`

Full-text search across the OCR'd contents of documents you've previously pulled. Returns ranked page-level hits with a snippet around each match. Powered by an in-process BM25 index (MiniSearch), so it's fast and offline.

| Parameter | Type    | Description                                                                            |
|-----------|---------|----------------------------------------------------------------------------------------|
| `query`   | string  | Search query. Supports prefix and fuzzy matching; multi-word queries are AND-combined. |
| `limit`   | number? | Maximum hits to return (default 20, max 100).                                          |
| `folder`  | string? | Restrict to documents whose folder path contains this substring.                       |

**Search requires OCR text.** `ocr.provider` must be `"ollama"` or `"local"` in `~/.config/remarkable-mcp/config.json` — `"native"` (the default) means the host LLM reads images directly and produces no searchable text. Documents are added to the corpus opportunistically every time you pull them; ranking favours doc-name and folder matches over body text.

### `remarkable_index`

Bulk-OCRs every document on the tablet (or a folder subset) and adds it to the search corpus. Long-running on large libraries; documents already cached and indexed for their current mtime are skipped unless `force: true`. Requires `ocr.provider` set to `"ollama"` or `"local"`. Run this once for a full library sweep, then let normal pulls keep the corpus current.

## OCR modes

Set in `~/.config/remarkable-mcp/config.json`:

- **native** (default): the host agent's LLM reads the image directly — no extra API key needed
- **ollama**: sends image to a local Ollama instance (`llama3.2-vision` or configured model)
- **local**: shells out to Tesseract for plain-text output

## Render defaults

The same config file carries render defaults:

```json
{
  "render": {
    "width": 1024,
    "format": "png",
    "jpegQuality": 80
  }
}
```

These are the fallback values when a `remarkable_pull` call doesn't specify `max_width` / `format`.

## Troubleshooting

Run `remarkable_status` first — it reports each connection path with a categorised reason for any failure. The full list of error categories and what they mean:

| Error in response | What it means | Fix |
|---|---|---|
| `timeout — tablet may be asleep, off, or the saved WiFi IP is stale` | TCP connect didn't complete in 20 s | Wake the tablet (tap / draw a stroke). If still failing, the saved IP is probably stale — see "WiFi IP changed" below |
| `connection refused — SSH daemon not listening` | TCP reached the host but port 22 was closed | Tablet is rebooting or the IP is wrong (some other device on the LAN) |
| `host unreachable — tablet not on the network` | No route to the IP | Tablet is offline or on a different subnet — check the on-tablet WiFi icon |
| `auth failed — SSH key not deployed` | TCP + host-key OK but key auth was rejected | Re-run `remarkable_setup` with the password over USB |
| `Host-key mismatch for X: expected sha256:…, got sha256:…. The tablet may have been reflashed` | The tablet's SSH host key changed since pinning | If you reflashed the tablet, re-run `remarkable_setup` with the password over USB to re-pin |

### WiFi IP changed (most common after a router reboot)

The server automatically tries `remarkable.local` (mDNS) when the saved IP is unreachable, so list and pull will usually self-recover. If you'd like to update the saved IP for faster future connections, ask the agent: *"Refresh my reMarkable WiFi"* — that calls `remarkable_setup` with no password, which probes USB SSH → saved IP → mDNS, picks the first one that works, and writes the discovered IP back to config.

### Document came back missing pages

The reMarkable saves a page's `.rm` file only when you change pages or close the document. Pulling while a notebook is open returns whatever's been flushed; the response lists the unsaved page numbers. Close the document on the tablet (or change pages) and re-pull — the cache is mtime-keyed, so a write on the tablet automatically invalidates it.

### Response too large for Claude Desktop

The server detects Claude Desktop's ~1 MB tool-response cap and trims pages that wouldn't fit, telling you the exact next call (`page="3-5"`). To fit more pages per response, use `format="jpeg"` and/or a smaller `max_width` (e.g. 800).

## Debugging

Set `DEBUG=remarkable-mcp` (or `DEBUG=*`) in the MCP client's environment to get diagnostic output on stderr (stdout is reserved for the MCP transport). The debug output covers:

- USB / WiFi / mDNS lookup attempts and their results
- Cache hits and stale-mtime sweeps
- Render failures with the underlying error (e.g. missing peer dep, malformed `.rm` file)
- Host-key mismatches with both fingerprints

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm run validate # spawn the server and assert on every tool's behaviour (writes validation-X.Y.Z.log)
npm run inspect  # interactive Inspector UI for end-to-end testing
npm run mcpb     # build remarkable-mcp-X.Y.Z.mcpb (Claude Desktop bundle)
```

### Releasing

1. Bump `version` in `package.json` and update `CHANGELOG.md`.
2. `npm test && npm run lint && npm run typecheck`.
3. `npm run mcpb` — produces `remarkable-mcp-X.Y.Z.mcpb` (single-click installable).
4. `npm pack` — produces `remarkable-mcp-X.Y.Z.tgz` (npm-installable for CLI users).
5. Validate end-to-end with [**MCP Inspector**](https://modelcontextprotocol.io/docs/tools/inspector) — the test harness referenced in Anthropic's [connector review criteria](https://claude.com/docs/connectors/building/review-criteria):
   ```bash
   npm run inspect
   ```
   This builds and launches the server under the Inspector UI. Pre-submission checklist:
   - **Tools tab** — confirm all four tools appear with `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` populated, and that descriptions don't read as instructions to Claude.
   - **Happy paths** — `remarkable_status` (no args), `remarkable_list`, `remarkable_pull` (defaults), `remarkable_pull` with `page="1-2"` and `format="jpeg"`.
   - **Error paths** — call each tool with bad input (`max_width: "huge"`, `format: "gif"`, missing `password`). Errors should be specific and actionable, never "Internal Server Error".
   - **Static-test path** — run `remarkable_status` with no tablet attached. It should return a clean diagnostic ("USB not reachable; WiFi SSH no host configured"), not a stack trace. Reviewers can run this without hardware.
   - **Notifications pane** — set `DEBUG=remarkable-mcp` in the server env field; debug lines should appear here, not on stdout.
6. Tag and push:
   ```bash
   git tag vX.Y.Z && git push --tags
   ```
7. Create a GitHub Release with both artefacts attached.
8. `npm publish` (when ready for the npm registry).
9. **Submit the `.mcpb` to Anthropic's curated directory** via <https://forms.gle/tyiAZvch1kDADKoP9>.

### Reviewer test plan

Anthropic's review process expects test credentials, but this server talks to physical hardware that reviewers won't have on hand. Provide the following with the submission:

- **Repro video** demonstrating each of the four tools against a real tablet (setup → status → list → pull). 60–90 seconds is plenty.
- **Spec links**: the firmware ≥ 3.9 requirement (USB HTTP path), the WiFi SSH fallback, and the on-tablet password location (Settings → Help → Copyright and licenses).
- **Static-test path**: reviewers can install the `.mcpb` and run `remarkable_status` with no tablet connected; it returns a clean diagnostic ("USB HTTP not reachable; WiFi SSH no host configured") instead of crashing or returning a generic error. This exercises the schema, the manifest, and the error-message standard without hardware.
- **Source code** is public on GitHub (MIT) — reviewers can audit the SSH/USB code paths directly.

## Licence

MIT
