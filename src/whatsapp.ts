import fs from "node:fs";
import path from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WAMessage,
  type WAMessageContent,
  type WASocket,
} from "baileys";
import { pino, destination } from "pino";
import QRCode from "qrcode";
import type { Config } from "./config.js";
import type { MessageRow, Store } from "./store.js";

export type LinkState =
  | { state: "connecting" }
  | { state: "needs_link"; qr?: string; qrPng?: string; pairingCode?: string; at: string }
  | { state: "connected"; me: string; name?: string; since: string }
  | { state: "logged_out"; reason: string };

const log = (...a: unknown[]) => console.error("[whatsapp]", ...a); // stderr: stdout may be an MCP stdio channel

export class WhatsApp {
  sock?: WASocket;
  status: LinkState = { state: "connecting" };
  private retries = 0;
  private sent = new Map<string, WAMessageContent>(); // recently sent, for WhatsApp's delivery retries
  private pairingRequested = false;

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
  ) {}

  async start(): Promise<void> {
    this.importLidMappings();
    const { state, saveCreds } = await useMultiFileAuthState(path.join(this.cfg.dataDir, "auth"));
    const logger = pino({ level: this.cfg.logLevel }, destination(2));
    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      /* fall back to Baileys' bundled version */
    }

    const sock = makeWASocket({
      version,
      logger,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      browser: Browsers.macOS("Chrome"),
      markOnlineOnConnect: false, // stay "offline" so your phone keeps getting notifications
      syncFullHistory: this.cfg.fullHistory,
      getMessage: async (key) => (key.id ? this.sent.get(key.id) : undefined),
    });
    this.sock = sock;
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (u) => {
      if (u.qr) await this.onQr(u.qr);
      if (u.connection === "open") {
        this.retries = 0;
        this.pairingRequested = false;
        this.clearLinkFiles();
        const me = jidNormalizedUser(sock.user?.id);
        this.status = { state: "connected", me, name: sock.user?.name, since: new Date().toISOString() };
        log(`connected as ${me}`);
        void this.loadGroups();
      }
      if (u.connection === "close") {
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          this.status = {
            state: "logged_out",
            reason: `Logged out from the phone. Delete ${path.join(this.cfg.dataDir, "auth")} and restart to link again.`,
          };
          log(this.status.reason);
          return;
        }
        this.pairingRequested = false; // a fresh socket gets a fresh pairing code
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 2_000 * 2 ** this.retries++);
        log(`connection closed (${code ?? "unknown"}), reconnecting in ${delay / 1000}s`);
        if (this.status.state === "connected") this.status = { state: "connecting" };
        setTimeout(() => void this.start().catch((e) => log("reconnect failed:", e)), delay);
      }
    });

    sock.ev.on("lid-mapping.update", (m) => this.store.addLidMapping(m.lid, m.pn));

    sock.ev.on("messaging-history.set", ({ chats, contacts, messages, lidPnMappings }) => {
      for (const m of lidPnMappings ?? []) this.store.addLidMapping(m.lid, m.pn);
      for (const c of contacts) this.onContact(c);
      for (const c of chats) {
        const jid = this.store.canonical(c.id);
        if (!jid || this.ignored(jid)) continue;
        this.store.upsertChat({
          jid,
          name: c.name ?? undefined,
          isGroup: !!isJidGroup(jid),
          lastTs: Number(c.conversationTimestamp ?? c.lastMessageRecvTimestamp ?? 0) || null,
          unread: c.unreadCount ?? undefined,
        });
      }
      let n = 0;
      for (const m of messages) if (this.onMessage(m)) n++;
      log(`history sync: ${chats.length} chats, ${contacts.length} contacts, ${n} new messages`);
    });

    sock.ev.on("messages.upsert", ({ messages }) => {
      for (const m of messages) this.onMessage(m);
    });
    sock.ev.on("contacts.upsert", (cs) => cs.forEach((c) => this.onContact(c)));
    sock.ev.on("contacts.update", (cs) => cs.forEach((c) => c.id && this.onContact(c as { id: string })));
    sock.ev.on("chats.upsert", (cs) => {
      for (const c of cs) {
        const jid = this.store.canonical(c.id);
        if (jid && !this.ignored(jid)) this.store.upsertChat({ jid, name: c.name ?? undefined, isGroup: !!isJidGroup(jid) });
      }
    });
    sock.ev.on("chats.update", (cs) => {
      for (const c of cs) {
        const jid = this.store.canonical(c.id);
        if (jid && !this.ignored(jid) && c.unreadCount != null) this.store.upsertChat({ jid, unread: c.unreadCount });
      }
    });
    sock.ev.on("groups.upsert", (gs) => gs.forEach((g) => this.store.upsertChat({ jid: g.id, name: g.subject, isGroup: true })));
    sock.ev.on("groups.update", (gs) => gs.forEach((g) => g.id && g.subject && this.store.upsertChat({ jid: g.id, name: g.subject, isGroup: true })));
  }

  /** Baileys keeps lid -> phone mappings in its auth state (lid-mapping-<lid>_reverse.json) that never reach
   *  our lid-mapping.update listener; copy them into the store so @lid chats resolve to phone numbers. */
  private importLidMappings() {
    const dir = path.join(this.cfg.dataDir, "auth");
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /^lid-mapping-\d+_reverse\.json$/.test(f));
    } catch {
      return;
    }
    for (const f of files) {
      try {
        const pn = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        const lid = f.slice("lid-mapping-".length, -"_reverse.json".length);
        if (typeof pn === "string" && /^\d+$/.test(pn)) this.store.addLidMapping(`${lid}@lid`, `${pn}@s.whatsapp.net`);
      } catch {
        /* skip unreadable entries */
      }
    }
  }

  // --- linking --------------------------------------------------------------------------------------

  private async onQr(qr: string) {
    const qrPng = path.join(this.cfg.dataDir, "link-qr.png");
    await QRCode.toFile(qrPng, qr, { width: 480 });
    let pairingCode: string | undefined;
    if (this.cfg.pairPhone && !this.pairingRequested && this.sock) {
      this.pairingRequested = true;
      try {
        pairingCode = await this.sock.requestPairingCode(this.cfg.pairPhone);
        fs.writeFileSync(path.join(this.cfg.dataDir, "link-code.txt"), pairingCode + "\n");
      } catch (e) {
        log("pairing code request failed:", (e as Error).message);
      }
    }
    const prev = this.status.state === "needs_link" ? this.status.pairingCode : undefined;
    this.status = { state: "needs_link", qr, qrPng, pairingCode: pairingCode ?? prev, at: new Date().toISOString() };
    if (this.status.pairingCode) {
      log(`link with code ${this.status.pairingCode}: WhatsApp > Linked devices > Link a device > Link with phone number instead`);
    } else {
      log(`scan the QR (WhatsApp > Linked devices > Link a device). Image: ${qrPng}`);
      if (process.stderr.isTTY) console.error(await QRCode.toString(qr, { type: "terminal", small: true }));
    }
  }

  private clearLinkFiles() {
    for (const f of ["link-qr.png", "link-code.txt"]) fs.rmSync(path.join(this.cfg.dataDir, f), { force: true });
  }

  // --- ingest ---------------------------------------------------------------------------------------

  private ignored(jid: string) {
    return isJidStatusBroadcast(jid) || !!isJidNewsletter(jid) || jid.endsWith("@broadcast");
  }

  private onContact(c: { id: string; lid?: string; phoneNumber?: string; name?: string; notify?: string; verifiedName?: string }) {
    if (c.lid && c.phoneNumber) this.store.addLidMapping(c.lid, c.phoneNumber);
    if (c.id.endsWith("@lid") && c.phoneNumber) this.store.addLidMapping(c.id, c.phoneNumber);
    const jid = this.store.canonical(c.phoneNumber ?? c.id);
    if (jid) this.store.upsertContact(jid, c.name, c.notify ?? c.verifiedName);
  }

  /** Picks the phone-number form of a JID pair when one is present, recording the lid mapping. */
  private pick(a?: string | null, b?: string | null): string | null {
    const lid = [a, b].find((j) => j?.endsWith("@lid"));
    const pn = [a, b].find((j) => j?.endsWith("@s.whatsapp.net"));
    if (lid && pn) this.store.addLidMapping(lid, jidNormalizedUser(pn));
    const j = pn ?? a ?? b;
    return j ? this.store.canonical(jidNormalizedUser(j)) : null;
  }

  private onMessage(m: WAMessage): boolean {
    const key = m.key;
    if (!key?.id || !key.remoteJid || !m.message) return false;
    const chat = this.pick(key.remoteJid, key.remoteJidAlt);
    if (!chat || this.ignored(chat)) return false;
    const content = describe(m.message);
    if (!content) return false;
    const isGroup = !!isJidGroup(chat);
    const fromMe = !!key.fromMe;
    const sender = fromMe
      ? jidNormalizedUser(this.sock?.user?.id) || "me"
      : isGroup
        ? this.pick(key.participant, key.participantAlt)
        : chat;
    const row: MessageRow = {
      chat_jid: chat,
      id: key.id,
      from_me: fromMe ? 1 : 0,
      sender,
      push_name: fromMe ? null : (m.pushName ?? null),
      ts: Number(m.messageTimestamp ?? Math.floor(Date.now() / 1000)),
      type: content.type,
      text: content.text,
    };
    if (!fromMe && !isGroup && m.pushName && sender) this.store.upsertContact(sender, undefined, m.pushName);
    return this.store.insertMessage(row);
  }

  private async loadGroups() {
    try {
      const groups = await this.sock!.groupFetchAllParticipating();
      for (const g of Object.values(groups)) this.store.upsertChat({ jid: g.id, name: g.subject, isGroup: true });
    } catch (e) {
      log("couldn't load group names:", (e as Error).message);
    }
  }

  // --- send -----------------------------------------------------------------------------------------

  async sendText(jid: string, text: string) {
    if (this.status.state !== "connected" || !this.sock) throw new Error(`WhatsApp isn't connected (${this.status.state}).`);
    const sent = await this.sock.sendMessage(jid, { text });
    if (sent?.key.id && sent.message) {
      this.sent.set(sent.key.id, sent.message);
      if (this.sent.size > 200) this.sent.delete(this.sent.keys().next().value!);
      this.onMessage(sent);
    }
    return sent;
  }

  /** Whether a phone number has WhatsApp, returning its JID. */
  async lookupNumber(digits: string): Promise<string | undefined> {
    if (!this.sock || this.status.state !== "connected") return undefined;
    const timeout = new Promise<undefined>((resolve) => setTimeout(resolve, 15_000));
    const [r] = (await Promise.race([this.sock.onWhatsApp(digits), timeout])) ?? [];
    return r?.exists ? jidNormalizedUser(r.jid) : undefined;
  }
}

// --- message content → readable text -------------------------------------------------------------------

function unwrap(m: WAMessageContent): WAMessageContent {
  let cur: WAMessageContent | null | undefined = m;
  for (let i = 0; i < 5 && cur; i++) {
    const inner: WAMessageContent | null | undefined =
      cur.ephemeralMessage?.message ??
      cur.viewOnceMessage?.message ??
      cur.viewOnceMessageV2?.message ??
      cur.viewOnceMessageV2Extension?.message ??
      cur.documentWithCaptionMessage?.message ??
      cur.editedMessage?.message;
    if (!inner) break;
    cur = inner;
  }
  return cur ?? m;
}

export function describe(raw: WAMessageContent): { type: string; text: string | null } | null {
  const m = unwrap(raw);
  if (m.conversation) return { type: "text", text: m.conversation };
  if (m.extendedTextMessage?.text) return { type: "text", text: m.extendedTextMessage.text };
  if (m.imageMessage) return { type: "image", text: m.imageMessage.caption || null };
  if (m.videoMessage) return { type: m.videoMessage.gifPlayback ? "gif" : "video", text: m.videoMessage.caption || null };
  if (m.audioMessage) return { type: m.audioMessage.ptt ? "voice note" : "audio", text: null };
  if (m.documentMessage)
    return { type: "document", text: [m.documentMessage.fileName, m.documentMessage.caption].filter(Boolean).join(" — ") || null };
  if (m.stickerMessage) return { type: "sticker", text: null };
  if (m.locationMessage) return { type: "location", text: [m.locationMessage.name, m.locationMessage.address].filter(Boolean).join(", ") || null };
  if (m.liveLocationMessage) return { type: "live location", text: null };
  if (m.contactMessage) return { type: "contact card", text: m.contactMessage.displayName || null };
  if (m.contactsArrayMessage) return { type: "contact cards", text: m.contactsArrayMessage.displayName || null };
  const poll = m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3;
  if (poll) return { type: "poll", text: [poll.name, ...(poll.options ?? []).map((o) => `• ${o.optionName}`)].join("\n") };
  if (m.reactionMessage) return m.reactionMessage.text ? { type: "reaction", text: m.reactionMessage.text } : null;
  if (m.buttonsResponseMessage) return { type: "text", text: m.buttonsResponseMessage.selectedDisplayText || null };
  if (m.listResponseMessage) return { type: "text", text: m.listResponseMessage.title || null };
  return null; // protocol messages, key distribution, receipts and other non-content
}
