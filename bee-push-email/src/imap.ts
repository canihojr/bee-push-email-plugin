import { ImapFlow } from "imapflow";
import type { ImapConfig, EmailMeta } from "./schemas.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NewEmailEvent {
  emails: EmailMeta[];
}

export type NewEmailHandler = (event: NewEmailEvent) => Promise<void>;

// ─── Reconnect backoff ────────────────────────────────────────────────────────

const BACKOFF_INITIAL = 10_000;    // 10s
const BACKOFF_MAX = 300_000;       // 5 min
const BACKOFF_MULTIPLIER = 2;

// ─── UID state ────────────────────────────────────────────────────────────────

import { readFile, writeFile, rename } from "fs/promises";

interface UidState {
  last_uid: number;
  updated: string;
}

async function loadLastUid(statePath: string): Promise<number> {
  try {
    const raw = await readFile(statePath, "utf-8");
    // Number() coercion guards against the unlikely case where the file contains
    // a string-typed uid (e.g. {"last_uid": "100"}) — without it, `lastUid + 1`
    // would produce "1001" (string concat) instead of 101.
    const parsed = Number((JSON.parse(raw) as UidState).last_uid);
    return isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
  } catch {
    return 0;
  }
}

async function saveLastUid(statePath: string, uid: number): Promise<void> {
  const tmp = statePath + ".tmp";
  const state: UidState = { last_uid: uid, updated: new Date().toISOString() };
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp, statePath); // atomic write
}

// ─── Email metadata fetch ─────────────────────────────────────────────────────

async function fetchEmailMeta(
  client: ImapFlow,
  folder: string,
  uids: number[]
): Promise<EmailMeta[]> {
  const results: EmailMeta[] = [];

  for (const uid of uids) {
    try {
      // imapflow fetch — grab envelope + body structure
      const msg = await client.fetchOne(
        String(uid),
        { envelope: true, bodyStructure: true, bodyParts: ["text"] },
        { uid: true }
      );

      if (!msg?.envelope) continue;

      const from = msg.envelope.from?.[0];
      const fromStr = from
        ? (from.name && from.address
            ? `${from.name} <${from.address}>`
            : (from.address ?? from.name ?? "unknown"))
        : "unknown";
      const fromDomain = from?.address?.split("@")[1] ?? "";
      const to = msg.envelope.to?.[0]?.address ?? "";
      const subject = msg.envelope.subject ?? "(no subject)";

      // Get a plain text preview
      let bodyPreview = "";
      try {
        // imapflow returns body parts as a Map
        const textPart = msg.bodyParts?.get("text");
        if (textPart instanceof Uint8Array) {
          bodyPreview = new TextDecoder().decode(textPart).slice(0, 300);
        }
      } catch {
        // body preview is best-effort
      }

      results.push({
        uid,
        from: fromStr,
        from_domain: fromDomain,
        to,
        subject,
        folder,
        body_preview: bodyPreview,
        received_at: msg.envelope.date ?? new Date(),
      });
    } catch {
      // Skip malformed messages — don't break the whole batch
    }
  }

  return results;
}

// ─── IMAP service ─────────────────────────────────────────────────────────────

export class ImapService {
  private client: ImapFlow | null = null;
  private running = false;
  private backoff = BACKOFF_INITIAL;
  private onNewEmail: NewEmailHandler;
  private config: ImapConfig;
  private statePath: string;
  private logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  // In-memory dedup: UIDs processed since service start — prevents catch-up
  // from re-delivering emails already notified in the same session
  private processedUids = new Set<number>();

  constructor(
    config: ImapConfig,
    statePath: string,
    onNewEmail: NewEmailHandler,
    logger: ImapService["logger"]
  ) {
    this.config = config;
    this.statePath = statePath;
    this.onNewEmail = onNewEmail;
    this.logger = logger;
  }

  async start(): Promise<void> {
    this.running = true;
    this.logger.info("[bee-push-email] IMAP service starting");
    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.logger.info("[bee-push-email] IMAP service stopping");
    try {
      await this.client?.logout();
    } catch {
      // ignore logout errors on shutdown
    }
    this.client = null;
  }

  // ── Main reconnect loop ──

  private async loop(): Promise<void> {
    let lastUid = await loadLastUid(this.statePath);
    this.logger.info(`[bee-push-email] Last seen UID: ${lastUid}`);

    while (this.running) {
      try {
        await this.connectAndIdle(lastUid, (newLastUid) => {
          lastUid = newLastUid;
        });
        // Successful connection — reset backoff
        this.backoff = BACKOFF_INITIAL;
      } catch (err) {
        if (!this.running) break;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[bee-push-email] Connection error: ${msg}`);
      }

      if (!this.running) break;

      this.logger.info(`[bee-push-email] Reconnecting in ${this.backoff / 1000}s`);
      await sleep(this.backoff);
      this.backoff = Math.min(this.backoff * BACKOFF_MULTIPLIER, BACKOFF_MAX);
    }

    this.logger.info("[bee-push-email] IMAP service stopped");
  }

  // ── Single connection lifetime ──

  private async connectAndIdle(
    initialLastUid: number,
    updateLastUid: (uid: number) => void
  ): Promise<void> {
    const { host, port, ssl, email, password, folder } = this.config;

    this.client = new ImapFlow({
      host,
      port,
      secure: ssl,
      auth: { user: email, pass: password },
      logger: false, // suppress imapflow's own logging
    });

    await this.client.connect();
    this.logger.info(`[bee-push-email] Connected to ${host} as ${email}`);

    // Open folder and check for emails missed while disconnected
    await this.client.mailboxOpen(folder);
    let lastUid = initialLastUid;

    // On fresh install (lastUid === 0), initialize to current UIDNEXT - 1
    // to avoid flooding the user with all historical emails.
    if (lastUid === 0) {
      const status = await this.client.status(folder, { uidNext: true });
      lastUid = Math.max(0, (status.uidNext ?? 1) - 1);
      await saveLastUid(this.statePath, lastUid);
      this.logger.info(`[bee-push-email] Fresh install — starting from UID ${lastUid} (skipping history)`);
      updateLastUid(lastUid);
    }

    const catchupUids = await this.getNewUids(lastUid);
    if (catchupUids.length > 0) {
      this.logger.info(`[bee-push-email] Catch-up: ${catchupUids.length} emails missed while disconnected`);
      lastUid = await this.processNewUids(catchupUids, folder, lastUid);
      updateLastUid(lastUid);
      // UID already saved inside processNewUids before delivery
    }

    // IDLE loop
    let processing = false;
    this.client.on("exists", async (data: { path: string; count: number; prevCount: number }) => {
      if (!this.running || !this.client) return;
      if (data.path !== folder) return;
      if (processing) return;

      processing = true;
      try {
        const newUids = await this.getNewUids(lastUid);
        if (newUids.length > 0) {
          this.logger.info(`[bee-push-email] ${newUids.length} new email(s) detected`);
          lastUid = await this.processNewUids(newUids, folder, lastUid);
          updateLastUid(lastUid);
          // UID already saved inside processNewUids before delivery
        }
      } catch (err) {
        this.logger.warn(`[bee-push-email] Error processing new emails: ${err}`);
      } finally {
        processing = false;
      }
    });

    // Keep IDLE connection alive — imapflow handles IDLE refresh automatically
    await this.client.idle();
    // idle() resolves when the connection drops — we then reconnect via the outer loop
  }

  // ── UID helpers ──

  private async getNewUids(lastUid: number): Promise<number[]> {
    if (!this.client) return [];
    try {
      const uids: number[] = [];
      for await (const msg of this.client.fetch(`${lastUid + 1}:*`, { uid: true }, { uid: true })) {
        if (msg.uid > lastUid) uids.push(msg.uid);
      }
      return uids.sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  private async processNewUids(
    uids: number[],
    folder: string,
    currentLastUid: number
  ): Promise<number> {
    if (!this.client || uids.length === 0) return currentLastUid;

    // Filter out UIDs already processed in this session (dedup catch-up re-delivery)
    const freshUids = uids.filter(uid => !this.processedUids.has(uid));
    if (freshUids.length === 0) {
      this.logger.info(`[bee-push-email] Skipping ${uids.length} already-processed UID(s)`);
      return Math.max(currentLastUid, ...uids);
    }

    // Save UID state BEFORE delivering — so if delivery fails or connection drops,
    // reconnect catch-up won't re-process these UIDs
    const newLastUid = Math.max(currentLastUid, ...freshUids);
    await saveLastUid(this.statePath, newLastUid);

    // Mark as processed in memory
    for (const uid of freshUids) this.processedUids.add(uid);

    const emails = await fetchEmailMeta(this.client, folder, freshUids);
    if (emails.length > 0) {
      await this.onNewEmail({ emails });
    }

    return newLastUid;
  }

  // ── IMAP actions (called by action executor) ──

  async moveEmail(uid: number, targetFolder: string): Promise<void> {
    if (!this.client) throw new Error("IMAP client not connected");
    await this.client.messageMove(String(uid), targetFolder, { uid: true });
  }

  async markRead(uid: number, read: boolean): Promise<void> {
    if (!this.client) throw new Error("IMAP client not connected");
    if (read) {
      await this.client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
    } else {
      await this.client.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true });
    }
  }

  isConnected(): boolean {
    return this.client?.usable ?? false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
