# remarkable-mcr Design Spec

**Date:** 2026-04-12  
**Status:** Approved  
**Licence:** MIT

## Overview

A standalone MCP server that pulls handwritten notes and diagrams from a reMarkable 2 tablet over SSH, renders pages to PNG, and returns them as MCP image content blocks so the host agent's native LLM can read them in-context. An optional local OCR mode (Tesseract) pre-transcribes text for non-vision agents or token-constrained workflows.

Works with any MCP-compatible client: Claude Desktop, Claude Code, Codex, Cursor, or anything else that speaks the MCP stdio protocol.

---

## Architecture

TypeScript project using `@modelcontextprotocol/sdk`. Compiled to JS and run via `node`. No backend, no external API keys required for the default configuration.

```
remarkable-mcr/
  src/
    index.ts          — MCP server entry point, registers tools
    config.ts         — read/write ~/.config/remarkable-mcr/config.json
    ssh.ts            — USB + WiFi SSH connection, key deployment
    render.ts         — .rm → SVG → PNG via vendored Python, thumbnail fallback
    ocr.ts            — native (pass-through) or local engine (Tesseract)
    tools/
      setup.ts        — remarkable_setup tool handler
      list.ts         — remarkable_list tool handler
      pull.ts         — remarkable_pull tool handler
  vendor/
    remarkable/       — vendored rmscene/rmc (Rick Lupton, MIT licensed)
                        copied from sasystem; JS port planned for later
  docs/
  package.json
  tsconfig.json
  README.md
```

---

## Connection & Setup

### USB connection

The reMarkable 2 exposes a fixed USB network interface at `10.11.99.1:22`. The SSH username is always `root`. The password is unique per device and shown on-tablet under **Settings → Help → Copyright and licenses → GPLv3 Compliance**.

### WiFi SSH

WiFi SSH is disabled by default on the tablet. To enable it, connect via USB and run:

```
rm-ssh-over-wlan on
```

`remarkable_setup` offers to do this automatically during first-time configuration.

### Key-based authentication

After the initial password-authenticated connection, `remarkable_setup` generates an Ed25519 keypair, deploys the public key to `/home/root/.ssh/authorized_keys` on the tablet, and stores the private key at `~/.config/remarkable-mcr/id_ed25519`. All subsequent connections are passwordless.

### Config file

Stored at `~/.config/remarkable-mcr/config.json`:

```json
{
  "connection": {
    "host": "192.168.x.x",
    "usbHost": "10.11.99.1",
    "port": 22,
    "username": "root",
    "privateKeyPath": "~/.config/remarkable-mcr/id_ed25519"
  },
  "ocr": {
    "provider": "native",
    "localEngine": "tesseract"
  }
}
```

`host` is the WiFi IP stored after setup. `usbHost` is always `10.11.99.1` and used as fallback if the WiFi host is unreachable. `provider` is `"native"` (default), `"ollama"`, or `"local"`.

---

## Tools

### `remarkable_setup`

First-time configuration wizard. Steps:

1. Prompt for the tablet root password (found on-device as above).
2. Connect via USB (`10.11.99.1:22`) using password auth.
3. Ask whether to enable WiFi SSH. If yes, run `rm-ssh-over-wlan on` then prompt for the tablet's WiFi IP address.
4. Generate Ed25519 keypair, deploy public key to tablet, store private key locally.
5. Write `~/.config/remarkable-mcr/config.json`.
6. Verify connection works with key auth and report success.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `password` | string | yes | Root password shown on-tablet under Settings → Help → Copyright and licenses |
| `enableWifi` | boolean | no | Run `rm-ssh-over-wlan on` to enable WiFi SSH (default: false) |
| `wifiHost` | string | no | Tablet WiFi IP to store for future connections (required if enableWifi is true) |

The agent collects these from the user in conversation before calling the tool. The tool executes the full setup flow in a single call.

---

### `remarkable_list`

Lists all documents on the tablet.

**Parameters:** none

**Process:**
- SSH to tablet (WiFi if configured, USB fallback).
- Read all `.metadata` files from `/home/root/.local/share/remarkable/xochitl/` where `type === "DocumentType"`.
- Return list sorted by `lastModified` descending.

**Returns:** Text content — document names, page counts, and last-modified dates.

---

### `remarkable_pull`

Fetches a document, renders each page, and returns text + image per page.

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `document` | string? | most recent | Substring match against document name |
| `page` | number? | all pages | Specific page number to pull |
| `prompt` | string? | built-in | Custom OCR instruction (native mode only — passed as context to the agent) |

**Process:**

1. SSH to tablet, list documents, find target.
2. Download document files via `ssh ... tar cf - | tar xf -` to a temp directory.
3. Read `.content` file for page order (falls back to `.rm` file listing).
4. For each page:
   a. **Render:** run vendored Python renderer (`rmscene/rmc`) to produce SVG, convert to PNG with `rsvg-convert` or ImageMagick. Fall back to tablet-generated thumbnails if Python or converter unavailable.
   b. **OCR:** if `provider === "native"`, read PNG into base64 and return as MCP image content block. If `provider === "local"`, shell out to Tesseract and return text.
5. Clean up temp directory.

**Returns:** Array of per-page results, each containing:
- MCP text content block: page number and OCR text (if local provider) or prompt to the agent to transcribe (if native provider)
- MCP image content block: base64 PNG of the rendered page

---

## OCR Modes

### Native (default)

The MCP tool returns the rendered page PNG as an MCP image content block. The host agent's LLM sees the image directly in context and transcribes it using its own vision capability. Works with any vision-capable model (Claude, GPT-4o, Gemini, etc.). No additional API keys required.

### Ollama

The MCP server sends the PNG to a local or remote Ollama instance via its OpenAI-compatible API (`/v1/chat/completions`) and returns the transcription as text. Requires a vision-capable model to be pulled (e.g. `llama3.2-vision`). Good for fully offline / no-cloud setups or for users who want consistent OCR quality independent of the host agent.

Config:
```json
{
  "ocr": {
    "provider": "ollama",
    "ollamaHost": "http://localhost:11434",
    "ollamaModel": "llama3.2-vision"
  }
}
```

Remote Ollama is identical — change `ollamaHost` to the remote address. No API key required unless the remote instance is configured to require one (add `ollamaApiKey` to config if so).

### Local

The MCP server shells out to a local OCR engine before returning. `localEngine` in config selects the binary (`tesseract` by default). Returns plain text. Useful for:
- Non-vision LLMs
- Air-gapped / offline setups
- Reducing context token usage on large documents

---

## Rendering Pipeline

1. Download `.rm` stroke files from tablet via SSH+tar.
2. Run vendored Python renderer (`vendor/remarkable/`) to convert `.rm` → SVG.
3. Convert SVG → PNG using `rsvg-convert` (preferred) or ImageMagick `convert`.
4. **Fallback:** if Python 3 is not available or rendering fails, use tablet-generated thumbnail PNGs (lower resolution, ~500px, but always present for opened documents).

The Python vendor (`rmscene`/`rmc` by Rick Lupton, MIT) is copied from sasystem. A native JS port of this renderer is planned as a future milestone to remove the Python dependency entirely.

---

## Error Handling

- **Tablet unreachable:** try WiFi, fall back to USB, report which was tried and suggest checking USB connection or WiFi IP.
- **No documents found:** report clearly with suggestion to open at least one document on the tablet.
- **Render failure:** fall back to thumbnails silently, note in response that thumbnails were used.
- **OCR failure (local):** include error message in page result, still return the image.
- **Missing Python/converter:** skip high-res render path, use thumbnails, note in response.

---

## Client Configuration Examples

### Claude Desktop

```json
{
  "mcpServers": {
    "remarkable": {
      "command": "node",
      "args": ["/path/to/remarkable-mcr/dist/index.js"]
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
        "command": "node",
        "args": ["/path/to/remarkable-mcr/dist/index.js"]
      }
    }
  }
}
```

### Generic stdio

```bash
node /path/to/remarkable-mcr/dist/index.js
```

---

## Future Work

- **JS renderer port:** replace vendored Python `rmscene` with a native TypeScript implementation, eliminating the Python dependency.
- **`remarkable_push`:** write text back to the tablet as a new document.
- **npm publish:** ship as `remarkable-mcr` for one-line install.
