import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  dataDir: string; // auth state, message cache, link QR/code
  host: string;
  port: number;
  token?: string; // optional bearer token for the HTTP endpoint
  pairPhone?: string; // digits only, e.g. 15551234567: link with a pairing code instead of a QR
  fullHistory: boolean;
  logLevel: string;
  stdio: boolean;
}

export function loadConfig(argv: string[]): Config {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? (argv[i + 1] ?? "") : undefined;
  };
  const env = process.env;
  const dataDir = path.resolve(flag("data-dir") ?? env.WHATSAPP_MCP_DATA_DIR ?? path.join(os.homedir(), ".whatsapp-mcp"));
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const pair = (flag("pair-phone") ?? env.WHATSAPP_MCP_PAIR_PHONE ?? "").replace(/\D/g, "");
  return {
    dataDir,
    host: flag("host") ?? env.WHATSAPP_MCP_HOST ?? "127.0.0.1",
    port: Number(flag("port") ?? env.WHATSAPP_MCP_PORT ?? 3737),
    token: flag("token") ?? env.WHATSAPP_MCP_TOKEN ?? undefined,
    pairPhone: pair || undefined,
    fullHistory: (flag("full-history") !== undefined) || env.WHATSAPP_MCP_FULL_HISTORY === "1",
    logLevel: env.WHATSAPP_MCP_LOG_LEVEL ?? "warn",
    stdio: argv.includes("--stdio"),
  };
}
