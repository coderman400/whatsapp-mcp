import Database from "better-sqlite3";

// Local SQLite cache of everything the linked device sees: chats, contacts and messages.
// WhatsApp only pushes messages to a linked device (history sync on link, then live), so this cache is
// what makes reading and searching possible. JIDs are stored in phone-number form (…@s.whatsapp.net)
// whenever the phone number is known, falling back to the privacy ID (…@lid).

export interface MessageRow {
  chat_jid: string;
  id: string;
  from_me: number;
  sender: string | null;
  push_name: string | null;
  ts: number; // unix seconds
  type: string;
  text: string | null;
}

export interface ChatRow {
  jid: string;
  name: string | null;
  is_group: number;
  last_ts: number | null;
  unread: number;
}

export class Store {
  readonly db: Database.Database;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY, name TEXT, is_group INTEGER NOT NULL DEFAULT 0,
        last_ts INTEGER, unread INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY, name TEXT, notify TEXT);
      CREATE TABLE IF NOT EXISTS lid_map (lid TEXT PRIMARY KEY, pn TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        chat_jid TEXT NOT NULL, id TEXT NOT NULL, from_me INTEGER NOT NULL, sender TEXT, push_name TEXT,
        ts INTEGER NOT NULL, type TEXT NOT NULL, text TEXT, PRIMARY KEY (chat_jid, id));
      CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);
      CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat_jid, ts);
    `);
    // Drop masked-number placeholders ("+91∙∙∙∙∙∙∙∙01") stored as names before they were filtered out.
    this.db.exec(`UPDATE contacts SET name = NULL WHERE name LIKE '%∙%'; UPDATE chats SET name = NULL WHERE name LIKE '%∙%';`);
  }

  // --- identity -------------------------------------------------------------------------------------

  /** Phone-number JID for a @lid if we know it, else the input unchanged. */
  canonical(jid: string | null | undefined): string | null {
    if (!jid) return null;
    if (!jid.endsWith("@lid")) return jid;
    const row = this.db.prepare("SELECT pn FROM lid_map WHERE lid = ?").get(jid) as { pn: string } | undefined;
    return row?.pn ?? jid;
  }

  /** Records lid -> phone number and moves anything stored under the lid onto the phone-number JID. */
  addLidMapping(lid: string, pn: string) {
    if (!lid?.endsWith("@lid") || !pn?.endsWith("@s.whatsapp.net")) return;
    const known = this.db.prepare("SELECT pn FROM lid_map WHERE lid = ?").get(lid) as { pn: string } | undefined;
    if (known?.pn === pn) return;
    this.db.transaction(() => {
      this.db.prepare("INSERT OR REPLACE INTO lid_map (lid, pn) VALUES (?, ?)").run(lid, pn);
      this.db.prepare("UPDATE OR IGNORE messages SET chat_jid = ? WHERE chat_jid = ?").run(pn, lid);
      this.db.prepare("DELETE FROM messages WHERE chat_jid = ?").run(lid);
      this.db.prepare("UPDATE messages SET sender = ? WHERE sender = ?").run(pn, lid);
      const chat = this.db.prepare("SELECT * FROM chats WHERE jid = ?").get(lid) as ChatRow | undefined;
      if (chat) {
        this.upsertChat({ jid: pn, name: chat.name, isGroup: false, lastTs: chat.last_ts, unread: chat.unread });
        this.db.prepare("DELETE FROM chats WHERE jid = ?").run(lid);
      }
      const contact = this.db.prepare("SELECT * FROM contacts WHERE jid = ?").get(lid) as
        | { name: string | null; notify: string | null }
        | undefined;
      if (contact) {
        this.upsertContact(pn, contact.name, contact.notify);
        this.db.prepare("DELETE FROM contacts WHERE jid = ?").run(lid);
      }
    })();
  }

  // --- writes ---------------------------------------------------------------------------------------

  upsertChat(c: { jid: string; name?: string | null; isGroup?: boolean; lastTs?: number | null; unread?: number | null }) {
    c = { ...c, name: realName(c.name) };
    this.db
      .prepare(
        `INSERT INTO chats (jid, name, is_group, last_ts, unread) VALUES (@jid, @name, @isGroup, @lastTs, COALESCE(@unread, 0))
         ON CONFLICT(jid) DO UPDATE SET
           name = COALESCE(excluded.name, chats.name),
           is_group = MAX(chats.is_group, excluded.is_group),
           last_ts = MAX(COALESCE(chats.last_ts, 0), COALESCE(excluded.last_ts, 0)),
           unread = COALESCE(@unread, chats.unread)`,
      )
      .run({ jid: c.jid, name: c.name ?? null, isGroup: c.isGroup ? 1 : 0, lastTs: c.lastTs ?? null, unread: c.unread ?? null });
  }

  upsertContact(jid: string, name?: string | null, notify?: string | null) {
    name = realName(name);
    notify = realName(notify);
    this.db
      .prepare(
        `INSERT INTO contacts (jid, name, notify) VALUES (?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET name = COALESCE(excluded.name, contacts.name), notify = COALESCE(excluded.notify, contacts.notify)`,
      )
      .run(jid, name ?? null, notify ?? null);
  }

  /** Returns true if the message was new. */
  insertMessage(m: MessageRow): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (chat_jid, id, from_me, sender, push_name, ts, type, text)
         VALUES (@chat_jid, @id, @from_me, @sender, @push_name, @ts, @type, @text)`,
      )
      .run(m);
    if (r.changes) this.upsertChat({ jid: m.chat_jid, isGroup: m.chat_jid.endsWith("@g.us"), lastTs: m.ts });
    return r.changes > 0;
  }

  // --- reads ----------------------------------------------------------------------------------------

  /** Best human name for a JID: saved contact name, group subject, their own profile name, or the number. */
  nameOf(jid: string | null): string {
    if (!jid) return "unknown";
    const contact = this.db.prepare("SELECT name, notify FROM contacts WHERE jid = ?").get(jid) as
      | { name: string | null; notify: string | null }
      | undefined;
    if (contact?.name) return contact.name;
    const chat = this.db.prepare("SELECT name FROM chats WHERE jid = ?").get(jid) as { name: string | null } | undefined;
    if (chat?.name) return chat.name;
    if (contact?.notify) return contact.notify;
    const push = this.db
      .prepare("SELECT push_name FROM messages WHERE sender = ? AND push_name IS NOT NULL ORDER BY ts DESC LIMIT 1")
      .get(jid) as { push_name: string } | undefined;
    if (push?.push_name) return push.push_name;
    return jid.endsWith("@s.whatsapp.net") ? "+" + jid.split("@")[0] : jid;
  }

  listChats(opts: { limit: number; groups: "include" | "exclude" | "only"; query?: string }): ChatRow[] {
    const where: string[] = ["last_ts IS NOT NULL"];
    if (opts.groups === "exclude") where.push("is_group = 0");
    if (opts.groups === "only") where.push("is_group = 1");
    const rows = this.db
      .prepare(`SELECT * FROM chats WHERE ${where.join(" AND ")} ORDER BY last_ts DESC LIMIT ?`)
      .all(opts.query ? 5000 : opts.limit) as ChatRow[];
    if (!opts.query) return rows;
    const q = opts.query.toLowerCase();
    return rows.filter((c) => this.nameOf(c.jid).toLowerCase().includes(q) || c.jid.includes(q)).slice(0, opts.limit);
  }

  messages(chatJid: string, limit: number, beforeTs?: number): MessageRow[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE chat_jid = ? AND ts < ? ORDER BY ts DESC LIMIT ?")
      .all(chatJid, beforeTs ?? Number.MAX_SAFE_INTEGER, limit) as MessageRow[];
    return rows.reverse();
  }

  search(query: string, opts: { chatJid?: string; sinceTs?: number; limit: number }): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE text LIKE ? ESCAPE '\\' AND ts >= ? ${opts.chatJid ? "AND chat_jid = ?" : ""}
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(
        ...[`%${query.replace(/[\\%_]/g, (c) => "\\" + c)}%`, opts.sinceTs ?? 0, ...(opts.chatJid ? [opts.chatJid] : []), opts.limit],
      ) as MessageRow[];
  }

  since(sinceTs: number, opts: { includeMine: boolean; includeGroups: boolean; limit: number }): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE ts > ? ${opts.includeMine ? "" : "AND from_me = 0"}
         ${opts.includeGroups ? "" : "AND chat_jid NOT LIKE '%@g.us'"} ORDER BY ts ASC LIMIT ?`,
      )
      .all(sinceTs, opts.limit) as MessageRow[];
  }

  /** People and groups whose name, number or JID matches. */
  findJids(query: string, limit = 10): string[] {
    const q = query.toLowerCase().replace(/^\+/, "");
    const jids = new Set<string>();
    const all = this.db
      .prepare(
        `SELECT jid FROM chats UNION SELECT jid FROM contacts`,
      )
      .all() as { jid: string }[];
    for (const { jid } of all) {
      if (jids.size >= limit * 5) break;
      if (jid.toLowerCase().includes(q) || this.nameOf(jid).toLowerCase().includes(q)) jids.add(this.canonical(jid)!);
    }
    // Most recently active first.
    return [...jids]
      .map((jid) => ({ jid, ts: (this.db.prepare("SELECT last_ts FROM chats WHERE jid = ?").get(jid) as { last_ts: number } | undefined)?.last_ts ?? 0 }))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
      .map((x) => x.jid);
  }

  stats() {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return { chats: n("SELECT COUNT(*) n FROM chats"), contacts: n("SELECT COUNT(*) n FROM contacts"), messages: n("SELECT COUNT(*) n FROM messages") };
  }
}

/** WhatsApp sends a masked number ("+91∙∙∙∙∙∙∙∙01") as the name of contacts not in the address book; treat it as no name. */
function realName(name?: string | null): string | null {
  return name && !name.includes("∙") ? name : null;
}
