# reMarkable 2 USB HTTP API

Reverse-engineered from firmware observation and community research. Not officially documented by reMarkable.

**Base URL:** `http://10.11.99.1` (USB only — fixed IP, no auth required)

Must be enabled before use. Older firmware exposed a toggle at **Settings → Storage → USB web interface**, but this option is absent on current firmware (3.x+). Enable via SSH instead — see [Enabling the USB web interface via SSH](#enabling-the-usb-web-interface-via-ssh) below.

---

## Endpoints

### `GET /documents/`

Lists all items (documents and folders) on the tablet.

**Response:** JSON array of objects.

```json
[
  {
    "ID": "6df75e33-ccd7-4983-9e3a-a74255b15023",
    "VissibleName": "Quick sheets",
    "Type": "DocumentType",
    "ModifiedClient": "2024-03-01T12:00:00Z",
    "Parent": ""
  }
]
```

| Field | Notes |
|-------|-------|
| `ID` | UUID — used in all other endpoints |
| `VissibleName` | Deliberate double-s typo in firmware, present since v1 |
| `Type` | `"DocumentType"` (notebook) or `"CollectionType"` (folder) |
| `ModifiedClient` | ISO 8601 timestamp of last client-side modification |
| `Parent` | UUID of parent folder, or `""` for root |

---

### `GET /download/{id}/rmdoc`

Downloads the full document as an rmdoc archive (ZIP).

**Available since:** firmware 3.9+

**Response:** ZIP file containing:

| Path | Description |
|------|-------------|
| `{id}.content` | Page order and metadata (JSON) |
| `{id}.metadata` | Document metadata (JSON) |
| `{id}/{pageId}.rm` | Stroke data per page (reMarkable binary format) |

#### `.content` file structure

```json
{
  "cPages": {
    "pages": [
      {
        "id": "e2411fbf-e746-4897-a930-617b2beac5eb",
        "template": { "value": "Blank" }
      }
    ],
    "lastOpened": {
      "value": "fe8f5959-8eea-4450-afef-dc947db28a85"
    }
  }
}
```

Older firmware may use a flat `"pages": ["uuid1", "uuid2"]` array instead of `cPages`.

---

### `GET /thumbnail/{id}`

Returns a pre-rendered thumbnail PNG of the most recently viewed page.

**Response:** PNG image (~384×512 px)

**Notes:**
- Only available for documents that have been opened on the tablet at least once
- Always a single image regardless of page count
- Lower resolution than rendering from `.rm` files directly

---

## HTTP Protocol Quirk

The reMarkable embedded web server sends **both** `Content-Length` and `Transfer-Encoding: chunked` headers on download responses. This violates HTTP/1.1 (RFC 7230 §3.3.2) and is rejected by strict clients including Node.js `fetch` (undici) and the `http` module.

**Workaround:** Use a raw TCP socket, send HTTP/1.0 (which has no chunked encoding), and read the body by `Content-Length`. HTTP/1.0 also avoids keep-alive negotiation.

```
GET /download/{id}/rmdoc HTTP/1.0\r\n
Host: 10.11.99.1\r\n
Connection: close\r\n
\r\n
```

The `/documents/` endpoint does not appear to have this issue (small JSON response, no chunked encoding).

---

## SSH Interface

Separate from the HTTP API. Accessed via USB at `10.11.99.1:22` or WiFi IP.

- Username: `root`
- Password: shown on-tablet at **Settings → Help → Copyright and licenses**
- WiFi SSH disabled by default; enable with: `rm-ssh-over-wlan on` (run over USB SSH)

### Document storage path

```
/home/root/.local/share/remarkable/xochitl/
```

Each document is stored as a set of files sharing the document UUID as a prefix:

| File | Description |
|------|-------------|
| `{id}.metadata` | Name, type, last modified |
| `{id}.content` | Page order (same format as rmdoc) |
| `{id}.pagedata` | Per-page template names |
| `{id}/{pageId}.rm` | Stroke data |
| `{id}.thumbnails/{pageId}.jpg` | Cached page thumbnails |

### Enabling the USB web interface via SSH

```bash
if grep -q 'WebInterfaceEnabled=true' /home/root/.config/remarkable/xochitl.conf; then
  echo already-enabled
else
  grep -q 'WebInterfaceEnabled' /home/root/.config/remarkable/xochitl.conf \
    && sed -i 's/WebInterfaceEnabled=false/WebInterfaceEnabled=true/' /home/root/.config/remarkable/xochitl.conf \
    || echo 'WebInterfaceEnabled=true' >> /home/root/.config/remarkable/xochitl.conf
  systemctl restart xochitl && echo enabled || echo failed
fi
```

Wait ~3 seconds after restart before probing the HTTP interface.

### Discovering WiFi IP

```bash
ip -4 addr show wlan0
```

Parse the `inet` address from the output.

---

## `.rm` File Format

Binary stroke format used by the reMarkable rendering engine. Two versions in active use:

| Version | Firmware | Notes |
|---------|----------|-------|
| v5 | Pre-3.x | Older format |
| v6 | 3.x+ | Current format |

Parse and render with [remarkable-rm](https://github.com/Scratchydisk/remarkable-rm) (TypeScript) or [rmscene](https://github.com/ricklupton/rmscene) (Python, MIT, by Rick Lupton).

remarkable-rm has a detailed description of the [v5 and v6 formats](https://github.com/Scratchydisk/remarkable-rm/blob/main/docs/rm-v6-format.md) culled from existing open source documents and original findings.
