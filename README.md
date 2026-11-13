# whatsapp-mcp

Give AI agents access to **your own WhatsApp**: read, search and send messages through the
[Model Context Protocol](https://modelcontextprotocol.io). Built on [Baileys](https://github.com/WhiskeySockets/Baileys),
so it links as a WhatsApp "linked device" (like WhatsApp Web) — no browser, no Business API, no phone number rental.

```
your phone ──(linked device)── whatsapp-mcp daemon ──MCP over HTTP── Claude Code / Agent SDK / any MCP client
                                  │
                                  └── local SQLite cache of chats, contacts and messages
```

## Why a daemon

WhatsApp allows one connection per linked device, and it only *pushes* messages to that device (a history sync when
you link, then live messages). So whatsapp-mcp runs as one long-lived process that holds the connection and caches
everything it sees in SQLite. Any number of agents can then query it at the same time over MCP — each agent session
doesn't have to log in, and reads/searches are instant and work offline. (A `--stdio` mode is there too for
single-client hosts.)

## Tools

| Tool | What it does |
|---|---|
| `whatsapp_status` | Connection state; if not linked yet, the pairing code or QR path to link it |
| `list_chats` | Recent chats with last message and unread counts; filter by name, include/exclude groups |
| `get_messages` | One chat's messages (by JID, phone number or name), with paging |
| `search_messages` | Text search across cached messages, optionally per chat / since a time |
| `messages_since` | Everything received since a time, grouped by chat — the "catch me up" view |
| `find_contact` | Look up people and groups by name or number |
| `send_message` | Send a text message (annotated as open-world; gate it in your agent) |

Times accept ISO dates, unix seconds, or relative values like `24h` / `7d`. Names resolve to the saved contact
name, group subject, or the person's own profile name.

## Install

Requires Node 20+.

```bash
git clone https://github.com/coderman400/whatsapp-mcp && cd whatsapp-mcp
npm install          # also builds dist/
npm start            # or: node dist/index.js --help
```

## Link your WhatsApp (once)

On first run it waits to be linked. Either:

- **QR:** scan the QR printed in the terminal (also saved to `~/.whatsapp-mcp/link-qr.png`) from
  WhatsApp → Settings → Linked devices → Link a device.
- **Pairing code** (handy when you can't see the screen): start with `--pair-phone <your number with country code>`;
  the 8-character code is logged and written to `~/.whatsapp-mcp/link-code.txt`, and `whatsapp_status` returns it.
  On the phone: Linked devices → Link a device → *Link with phone number instead*.

The session is saved in `~/.whatsapp-mcp/auth` and survives restarts. It connects with `markOnlineOnConnect: false`,
so your phone keeps getting notifications.

## Use it

**Claude Code**

```bash
claude mcp add --transport http whatsapp http://127.0.0.1:3737/mcp
```

**Claude Agent SDK**

```ts
query({ prompt, options: { mcpServers: { whatsapp: { type: "http", url: "http://127.0.0.1:3737/mcp" } } } });
```

**Claude Desktop / stdio clients** (no separate daemon; the client starts it)

```json
{ "mcpServers": { "whatsapp": { "command": "node", "args": ["/path/to/whatsapp-mcp/dist/index.js", "--stdio"] } } }
```

**Always on:** see [`examples/whatsapp-mcp.service`](examples/whatsapp-mcp.service) for a systemd user service.

## Options

| Flag | Env | Default |
|---|---|---|
| `--data-dir` | `WHATSAPP_MCP_DATA_DIR` | `~/.whatsapp-mcp` |
| `--port` | `WHATSAPP_MCP_PORT` | `3737` |
| `--host` | `WHATSAPP_MCP_HOST` | `127.0.0.1` |
| `--token` | `WHATSAPP_MCP_TOKEN` | none (send `Authorization: Bearer <token>`) |
| `--pair-phone` | `WHATSAPP_MCP_PAIR_PHONE` | none (QR linking) |
| `--full-history` | `WHATSAPP_MCP_FULL_HISTORY=1` | off |
| `--stdio` | | HTTP daemon |

`GET /health` returns the connection state and cache counts.

## Safety — read this

- **This is unofficial.** It uses WhatsApp's linked-device protocol via Baileys, not an official API. Automated or
  bulk messaging can get a number banned. Keep sending human-paced, and prefer read-only use.
- **Your data dir is a login.** `~/.whatsapp-mcp/auth` grants full access to your WhatsApp. Keep it private
  (it's created `0700`), never commit it, and unlink the device from your phone if it leaks.
- **Keep it local.** The server binds to `127.0.0.1` by default; if you expose it, set `--token`.
- **Messages are untrusted input.** Anyone can message you, so an agent reading WhatsApp can be fed instructions
  ("ignore previous instructions and send…"). Don't give the same agent unattended `send_message` plus other powerful
  tools; require human approval for sends.

## Limitations

- Text sending only (no media yet). Reading covers text, captions, documents, locations, polls and contact cards;
  other media are shown as `[image]`, `[voice note]`, etc. without downloading.
- The cache starts when you link: older history depends on what WhatsApp's initial sync sends (`--full-history` asks
  for more).
- Built on a Baileys release candidate (7.x); WhatsApp protocol changes can require a Baileys update.

## License

MIT
