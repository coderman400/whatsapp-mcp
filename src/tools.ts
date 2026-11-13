import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MessageRow, Store } from "./store.js";
import type { WhatsApp } from "./whatsapp.js";

const VERSION = "0.1.0";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

/** "2026-11-13 14:05" in the server's local time. */
const when = (ts: number) => new Date(ts * 1000).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);

/** Accepts ISO dates, unix seconds, or relative "90m" / "24h" / "7d". Returns unix seconds. */
function parseSince(s: string): number | undefined {
  const rel = s.trim().match(/^(\d+)\s*([mhd])$/i);
  if (rel) return Math.floor(Date.now() / 1000) - Number(rel[1]) * { m: 60, h: 3600, d: 86400 }[rel[2].toLowerCase() as "m"];
  if (/^\d{9,11}$/.test(s.trim())) return Number(s.trim());
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

export function buildServer(store: Store, wa: WhatsApp): McpServer {
  const server = new McpServer({ name: "whatsapp", version: VERSION });

  const line = (m: MessageRow, withChat = false) => {
    const who = m.from_me ? "You" : store.nameOf(m.sender);
    const where = withChat ? `${store.nameOf(m.chat_jid)} | ` : "";
    const body = m.type === "text" ? (m.text ?? "") : `[${m.type}]${m.text ? " " + m.text : ""}`;
    return `[${when(m.ts)}] ${where}${who}: ${body}`;
  };

  /** Resolves a JID, phone number, or (unique) contact/group name to a chat JID. */
  async function resolve(input: string, forSending = false): Promise<{ jid: string } | { error: string }> {
    const q = input.trim();
    if (q.includes("@")) return { jid: store.canonical(q)! };
    const digits = q.replace(/[\s()+-]/g, "");
    if (/^\d{7,15}$/.test(digits)) {
      const jid = `${digits}@s.whatsapp.net`;
      if (forSending) {
        const found = await wa.lookupNumber(digits);
        return found ? { jid: found } : { error: `+${digits} isn't on WhatsApp.` };
      }
      return { jid };
    }
    const matches = store.findJids(q, 6);
    const exact = matches.filter((j) => store.nameOf(j).toLowerCase() === q.toLowerCase());
    if (exact.length === 1) return { jid: exact[0] };
    if (matches.length === 1) return { jid: matches[0] };
    if (!matches.length) return { error: `No chat or contact matches "${q}". Try find_contact, a phone number, or a JID.` };
    return {
      error: `"${q}" is ambiguous: ${matches.map((j) => `${store.nameOf(j)} (${j})`).join("; ")}. Use the JID or a fuller name.`,
    };
  }

  server.registerTool(
    "whatsapp_status",
    {
      description:
        "Connection status of the linked WhatsApp account, plus how many chats/messages are cached. If it isn't linked yet, includes the pairing code or QR image path to link it.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const s = wa.status;
      const stats = store.stats();
      const cache = `Cache: ${stats.chats} chats, ${stats.contacts} contacts, ${stats.messages} messages.`;
      switch (s.state) {
        case "connected":
          return text(`Connected as ${s.name ?? ""} (${s.me}) since ${s.since}. ${cache}`);
        case "needs_link":
          return text(
            "Not linked yet. " +
              (s.pairingCode
                ? `Pairing code: ${s.pairingCode} — on the phone: WhatsApp > Settings > Linked devices > Link a device > "Link with phone number instead", then enter the code.`
                : `Scan the QR image at ${s.qrPng} with WhatsApp > Settings > Linked devices > Link a device.`) +
              ` ${cache}`,
          );
        case "logged_out":
          return text(`Logged out. ${s.reason}`);
        default:
          return text(`Connecting… ${cache}`);
      }
    },
  );

  server.registerTool(
    "list_chats",
    {
      description: "Recent chats, newest activity first, with unread counts. Optionally filter by name.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("default 20"),
        query: z.string().optional().describe("filter by chat/contact name or number"),
        groups: z.enum(["include", "exclude", "only"]).optional().describe("default include"),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const chats = store.listChats({ limit: a.limit ?? 20, groups: a.groups ?? "include", query: a.query });
      if (!chats.length) return text("No chats cached yet.");
      return text(
        chats
          .map((c) => {
            const last = store.messages(c.jid, 1)[0];
            return `• ${store.nameOf(c.jid)}${c.is_group ? " (group)" : ""} — ${c.jid}${c.unread ? ` — ${c.unread} unread` : ""}\n  ${last ? line(last) : "(no cached messages)"}`;
          })
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "get_messages",
    {
      description: "Messages in one chat, oldest to newest. `chat` can be a JID, a phone number, or a contact/group name.",
      inputSchema: {
        chat: z.string(),
        limit: z.number().int().min(1).max(300).optional().describe("default 40"),
        before: z.string().optional().describe("only messages before this time (ISO or unix seconds), for paging back"),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const r = await resolve(a.chat);
      if ("error" in r) return fail(r.error);
      const beforeTs = a.before ? parseSince(a.before) : undefined;
      const msgs = store.messages(r.jid, a.limit ?? 40, beforeTs);
      if (!msgs.length) return text(`No cached messages with ${store.nameOf(r.jid)} (${r.jid}).`);
      return text(`Chat: ${store.nameOf(r.jid)} (${r.jid})\n` + msgs.map((m) => line(m)).join("\n"));
    },
  );

  server.registerTool(
    "search_messages",
    {
      description: "Full-text search across cached messages (newest first), optionally within one chat and/or since a time.",
      inputSchema: {
        query: z.string(),
        chat: z.string().optional(),
        since: z.string().optional().describe('ISO, unix seconds, or relative like "7d"'),
        limit: z.number().int().min(1).max(200).optional().describe("default 30"),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      let chatJid: string | undefined;
      if (a.chat) {
        const r = await resolve(a.chat);
        if ("error" in r) return fail(r.error);
        chatJid = r.jid;
      }
      const msgs = store.search(a.query, { chatJid, sinceTs: a.since ? parseSince(a.since) : undefined, limit: a.limit ?? 30 });
      return text(msgs.length ? msgs.map((m) => line(m, true)).join("\n") : `No messages matching "${a.query}".`);
    },
  );

  server.registerTool(
    "messages_since",
    {
      description:
        "Everything received since a time, grouped by chat — the catch-up view (e.g. since your last check). Excludes your own messages unless asked.",
      inputSchema: {
        since: z.string().describe('ISO, unix seconds, or relative like "24h"'),
        include_mine: z.boolean().optional(),
        include_groups: z.boolean().optional().describe("default true"),
        limit: z.number().int().min(1).max(1000).optional().describe("default 300"),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const sinceTs = parseSince(a.since);
      if (sinceTs === undefined) return fail(`Couldn't read "${a.since}" as a time.`);
      const msgs = store.since(sinceTs, { includeMine: !!a.include_mine, includeGroups: a.include_groups ?? true, limit: a.limit ?? 300 });
      if (!msgs.length) return text(`Nothing since ${when(sinceTs)}.`);
      const byChat = new Map<string, MessageRow[]>();
      for (const m of msgs) byChat.set(m.chat_jid, [...(byChat.get(m.chat_jid) ?? []), m]);
      const blocks = [...byChat].map(
        ([jid, ms]) => `## ${store.nameOf(jid)}${jid.endsWith("@g.us") ? " (group)" : ""} — ${jid} — ${ms.length} new\n${ms.map((m) => line(m)).join("\n")}`,
      );
      return text(`${msgs.length} messages in ${byChat.size} chats since ${when(sinceTs)}:\n\n${blocks.join("\n\n")}`);
    },
  );

  server.registerTool(
    "find_contact",
    {
      description: "Find people and groups by name or number. Returns names and JIDs to use with other tools.",
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const jids = store.findJids(a.query, 15);
      return text(jids.length ? jids.map((j) => `• ${store.nameOf(j)} — ${j}`).join("\n") : `No contacts or chats match "${a.query}".`);
    },
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Send a WhatsApp text message as the linked account. `to` can be a JID, a phone number with country code, or an exact contact/group name. This really sends: confirm the recipient and text first.",
      inputSchema: { to: z.string(), text: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (a) => {
      if (wa.status.state !== "connected") return fail(`WhatsApp isn't connected (${wa.status.state}); check whatsapp_status.`);
      const r = await resolve(a.to, true);
      if ("error" in r) return fail(r.error);
      try {
        const sent = await wa.sendText(r.jid, a.text);
        return text(`Sent to ${store.nameOf(r.jid)} (${r.jid}). id: ${sent?.key.id}`);
      } catch (e) {
        return fail(`Send failed: ${(e as Error).message}`);
      }
    },
  );

  return server;
}
