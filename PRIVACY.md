# Privacy

`remarkable-mcp` is a local-only MCP server. It runs on your machine, talks to your reMarkable tablet, and reports results to whichever AI agent loaded it (Claude Desktop, Claude Code, etc.). No telemetry, no analytics, no remote servers operated by the maintainer.

## What data the server reads

- **Document metadata** from the tablet — names, folders, modification times, page UUIDs — fetched only when you invoke `remarkable_list`, `remarkable_pull`, `remarkable_status`, or `remarkable_index`.
- **Document contents** — `.rm` binary stroke files and rendered page images — fetched only when you invoke `remarkable_pull` or `remarkable_index`.
- **Tablet root password** — only when you invoke `remarkable_setup` and pass it as an argument. Used once to deploy the SSH public key, then discarded. Never written to disk.
- **Tablet SSH host-key fingerprint** — captured during `remarkable_setup` and pinned to `~/.config/remarkable-mcp/config.json` so future SSH connections can verify the tablet hasn't been swapped.

## Where that data goes

| Data | Destination |
|---|---|
| Document metadata + contents | The MCP client (your AI agent) on the same machine, as the tool response. |
| Cached source files + per-page text | `~/.cache/remarkable-mcp/` on your local filesystem (override with `REMARKABLE_CACHE_DIR`). |
| Optional: rendered images saved to `output_dir` | The directory you pass in the `output_dir` argument. Your choice. |
| Optional: per-page OCR via Ollama | The Ollama HTTP endpoint you configured (default `localhost:11434`). |
| Optional: per-page OCR via Tesseract | Stays on your machine. |
| Tablet password (during setup only) | Sent over USB SSH to the tablet itself; not stored, logged, or transmitted off the host. |
| Search index | A local JSON file at `~/.cache/remarkable-mcp/index.json`. |

**Nothing is sent to anthropic.com, github.com, npmjs.com, or any maintainer-controlled service** during normal operation. The server has no network code targeting any host other than your tablet (USB or LAN), and — if you've configured it — your local Ollama instance.

The only exception is the **MCP client's own behaviour**: when it consumes the tool response, the host AI may transmit text and image content to its model provider (Anthropic, OpenAI, etc.) per its own privacy policy. That's outside `remarkable-mcp`'s control; it's the same data the client would send for any other tool result.

## What the server logs

Nothing, by default. Setting `DEBUG=remarkable-mcp` in the MCP client's environment writes diagnostic lines to stderr (the local terminal that spawned the server). Stderr stays on your machine. The server never opens a log file or sends logs anywhere.

## Caveat — the password as a tool argument

`remarkable_setup` takes the tablet's root password as a tool argument. Tool arguments traverse your MCP client (e.g. Claude Desktop), and your client may include them in conversation transcripts or local logs depending on its own behaviour. The server itself does not retain the password after deploying the SSH key. After setup runs once, you never need to provide the password again — the WiFi path uses key authentication thereafter.

## Retention

Cache and search index live until you delete `~/.cache/remarkable-mcp/`. Configuration lives until you delete `~/.config/remarkable-mcp/`. Neither directory is touched by uninstall (npm or `.mcpb`); to remove every trace, delete those two directories yourself.

## Contact

Privacy or security questions: open an issue at <https://github.com/Scratchydisk/remarkable-mcp/issues>, or for sensitive security reports email the address listed in [SECURITY.md](SECURITY.md) (where present) or in the repo's profile.
