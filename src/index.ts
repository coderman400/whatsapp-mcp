#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { buildServer } from "./tools.js";
import { WhatsApp } from "./whatsapp.js";

const HELP = `whatsapp-mcp — WhatsApp for AI agents, over MCP (built on Baileys)

Usage:
  whatsapp-mcp                 run the daemon: keeps WhatsApp connected, serves MCP at http://127.0.0.1:3737/mcp
  whatsapp-mcp --stdio         single-client mode: MCP over stdin/stdout (e.g. Claude Desktop)

Options (or env vars):
  --data-dir <dir>     WHATSAPP_MCP_DATA_DIR    auth state + message cache (default ~/.whatsapp-mcp)
  --port <n>           WHATSAPP_MCP_PORT        HTTP port (default 3737)
  --host <addr>        WHATSAPP_MCP_HOST        bind address (default 127.0.0.1 — keep it local)
  --token <secret>     WHATSAPP_MCP_TOKEN       require "Authorization: Bearer <secret>"
  --pair-phone <num>   WHATSAPP_MCP_PAIR_PHONE  link with a pairing code for this number (country code, digits)
  --full-history       WHATSAPP_MCP_FULL_HISTORY=1  ask for full history on first link

First run: link it from your phone (WhatsApp > Settings > Linked devices > Link a device) by scanning the QR
printed here / saved to <data-dir>/link-qr.png, or with --pair-phone and the code in <data-dir>/link-code.txt.
`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const cfg = loadConfig(argv);
const store = new Store(path.join(cfg.dataDir, "messages.db"));
const wa = new WhatsApp(cfg, store);
if (!cfg.stdio) wa.startWatchdog(); // daemon runs under a supervisor that restarts it; stdio clients may not
await wa.start();

if (cfg.stdio) {
  await buildServer(store, wa).connect(new StdioServerTransport());
  console.error("[whatsapp-mcp] serving MCP on stdio");
} else {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (cfg.token && req.headers.authorization !== `Bearer ${cfg.token}`) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...wa.status, qr: undefined, ...store.stats() }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      // Stateless server: no server-initiated streams or sessions to resume/delete.
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      // Stateless: a fresh MCP server per request, all sharing the one WhatsApp connection and cache.
      const mcp = buildServer(store, wa);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error("[whatsapp-mcp] request failed:", e);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  server.listen(cfg.port, cfg.host, () => {
    console.error(`[whatsapp-mcp] MCP at http://${cfg.host}:${cfg.port}/mcp  (health: /health)  data: ${cfg.dataDir}`);
  });
}

const shutdown = () => {
  store.db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
