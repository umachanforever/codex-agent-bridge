import Database from "better-sqlite3";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Usage } from "../http/chat-normalize.js";
import {
  pricing,
  referenceCost,
  validateRates,
  type Rates,
} from "./pricing.js";

/** Public metadata never includes a recoverable key. */
export interface ManagedKey {
  id: string;
  name: string;
  prefix: string;
  enabled: number;
  created: number;
  last_used: number | null;
}
/** Minimal request accounting; prompt, result, arguments and credentials are excluded. */
export interface RequestRecord {
  id: string;
  keyId: string;
  model: string;
  started: number;
  duration: number;
  status: number;
  error: string | null;
  usage: Usage | null;
}
/** Allowlisted hot settings; no filesystem or permission overrides. */
export interface RuntimeSettings {
  model: string;
  timeoutMs: number;
  maxRequests: number;
}
/** Validated reporting filters shared by request tables and token aggregates. */
export interface UsageFilter {
  since?: number;
  until?: number;
  keyId?: string;
  model?: string;
  offset?: number;
}

/** Stable lookup digest avoids retaining plaintext credentials in indexes. */
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** SQLite persistence and authenticated key encryption behind one small interface. */
export class AdminStore {
  readonly #db: Database.Database;
  readonly #master: Buffer;
  #rates: Rates = pricing.rates;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const masterFile = join(directory, "master.key");
    // Never silently regenerate a missing master key for an existing database.
    if (!existsSync(masterFile)) {
      if (existsSync(join(directory, "admin.sqlite")))
        throw new Error(
          "Missing admin encryption master key; restore it from your private backup.",
        );
      writeFileSync(masterFile, randomBytes(32), { flag: "wx", mode: 0o600 });
    }
    this.#master = readFileSync(masterFile);
    if (this.#master.length !== 32)
      throw new Error("Invalid admin encryption master key.");
    const file = join(directory, "admin.sqlite");
    this.#db = new Database(file);
    chmodSync(file, 0o600);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("busy_timeout = 5000");
    this.#db.function("reference_cost", {}, (model, input, output, cached) =>
      referenceCost(
        model as string,
        input as number | null,
        output as number | null,
        cached as number | null,
        this.#rates,
      ),
    );
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, digest TEXT UNIQUE NOT NULL, cipher TEXT NOT NULL, enabled INTEGER NOT NULL, created INTEGER NOT NULL, last_used INTEGER);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, key_id TEXT NOT NULL, model TEXT NOT NULL, started INTEGER NOT NULL, duration INTEGER NOT NULL, status INTEGER NOT NULL, error TEXT, input INTEGER, output INTEGER, cached INTEGER, reasoning INTEGER, total INTEGER);
      CREATE INDEX IF NOT EXISTS requests_time ON requests(started);
      CREATE INDEX IF NOT EXISTS requests_key ON requests(key_id, started);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS price_settings (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_sessions (digest TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL, credential TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
    this.#rates = this.prices().rates;
  }
  /** Prices are independent of runtime settings and survive restarts. */
  prices() {
    const row = this.#db
      .prepare("SELECT value, updated FROM price_settings WHERE id=1")
      .get() as { value: string; updated: string } | undefined;
    const rates = row ? validateRates(JSON.parse(row.value)) : pricing.rates;
    return {
      ...pricing,
      rates,
      custom: Boolean(row),
      updatedAt: row?.updated ?? null,
      revision: digest(JSON.stringify(rates)),
    };
  }
  /** Optimistic concurrency prevents an old browser from overwriting newer edits. */
  savePrices(value: unknown, revision: unknown): void {
    const rates = validateRates(value);
    if (revision !== this.prices().revision)
      throw new Error("Prices changed; reload before saving.");
    this.#db
      .prepare(
        "INSERT INTO price_settings VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, updated=excluded.updated",
      )
      .run(JSON.stringify(rates), new Date().toISOString());
    this.#rates = rates;
  }
  /** Keeps only hashed bearer sessions; expired and excess sessions are pruned. */
  saveSession(
    id: string,
    csrf: string,
    expires: number,
    credential: string,
  ): void {
    this.#db
      .prepare(
        "DELETE FROM admin_sessions WHERE expires <= ? OR credential != ?",
      )
      .run(Date.now(), credential);
    this.#db
      .prepare("INSERT INTO admin_sessions VALUES (?, ?, ?, ?)")
      .run(digest(id), csrf, expires, credential);
    this.#db.exec(
      "DELETE FROM admin_sessions WHERE digest NOT IN (SELECT digest FROM admin_sessions ORDER BY expires DESC LIMIT 128)",
    );
  }
  /** Credential rotation invalidates remembered sessions at the next startup. */
  session(
    id: string,
    credential: string,
  ): { csrf: string; expires: number } | undefined {
    return this.#db
      .prepare(
        "SELECT csrf, expires FROM admin_sessions WHERE digest=? AND credential=? AND expires>?",
      )
      .get(digest(id), credential, Date.now()) as
      { csrf: string; expires: number } | undefined;
  }
  /** Logout revokes the server-side session, not merely browser storage. */
  deleteSession(id: string): void {
    this.#db
      .prepare("DELETE FROM admin_sessions WHERE digest=?")
      .run(digest(id));
  }
  /** Stores a new named key, returning plaintext only to its explicit creator. */
  createKey(name: string): ManagedKey & { secret: string } {
    name = name.trim();
    if (!name || name.length > 80)
      throw new Error("Key name must contain 1–80 characters.");
    const id = randomUUID();
    const secret = `sk-${randomBytes(32).toString("base64url")}`;
    this.#db
      .prepare("INSERT INTO keys VALUES (?, ?, ?, ?, ?, 1, ?, NULL)")
      .run(
        id,
        name,
        secret.slice(0, 10),
        digest(secret),
        this.#encrypt(secret),
        Date.now(),
      );
    return { ...this.listKeys().find((key) => key.id === id)!, secret };
  }
  /** Returns metadata suitable for lists and usage filtering. */
  listKeys(): ManagedKey[] {
    return this.#db
      .prepare(
        "SELECT id,name,prefix,enabled,created,last_used FROM keys ORDER BY created DESC",
      )
      .all() as ManagedKey[];
  }
  /** Validates enabled credentials, updating only last-use metadata. */
  authenticate(secret: string): string | undefined {
    const row = this.#db
      .prepare("SELECT id FROM keys WHERE digest=? AND enabled=1")
      .get(digest(secret)) as { id: string } | undefined;
    if (!row) return undefined;
    this.#db
      .prepare("UPDATE keys SET last_used=? WHERE id=?")
      .run(Date.now(), row.id);
    return row.id;
  }
  /** Reveals a key only after the management HTTP layer reauthenticates. */
  revealKey(id: string): string {
    const row = this.#db
      .prepare("SELECT cipher FROM keys WHERE id=?")
      .get(id) as { cipher: string } | undefined;
    if (!row) throw new Error("Key not found.");
    const packed = Buffer.from(row.cipher, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#master,
      packed.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from("codex-bridge-key-v1"));
    decipher.setAuthTag(packed.subarray(12, 28));
    return Buffer.concat([
      decipher.update(packed.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  }
  /** Rotates a key atomically; old bearer values stop working immediately. */
  rotateKey(id: string): string {
    const secret = `sk-${randomBytes(32).toString("base64url")}`;
    const result = this.#db
      .prepare("UPDATE keys SET prefix=?,digest=?,cipher=? WHERE id=?")
      .run(secret.slice(0, 10), digest(secret), this.#encrypt(secret), id);
    if (!result.changes) throw new Error("Key not found.");
    return secret;
  }
  /** Disabling admission does not cancel already executing requests. */
  setKeyEnabled(id: string, enabled: boolean): void {
    if (
      !this.#db
        .prepare("UPDATE keys SET enabled=? WHERE id=?")
        .run(enabled ? 1 : 0, id).changes
    )
      throw new Error("Key not found.");
  }
  /** Records one terminal HTTP request idempotently, preserving unknown usage as NULL. */
  record(entry: RequestRecord): void {
    const u = entry.usage;
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        entry.id,
        entry.keyId,
        entry.model.slice(0, 160),
        entry.started,
        entry.duration,
        entry.status,
        entry.error?.slice(0, 80) ?? null,
        u?.prompt_tokens ?? null,
        u?.completion_tokens ?? null,
        u?.prompt_tokens_details?.cached_tokens ?? null,
        u?.completion_tokens_details?.reasoning_tokens ?? null,
        u?.total_tokens ?? null,
      );
    // Bounded retention, not an unbounded archive of client activity.
    this.#db
      .prepare("DELETE FROM requests WHERE started < ?")
      .run(Date.now() - 90 * 86400000);
  }
  /** Lists distinct model names from retained requests, independent of report filters. */
  requestModels(): string[] {
    return (
      this.#db
        .prepare(
          "SELECT DISTINCT model FROM requests WHERE model != '' AND model != 'unknown' ORDER BY model",
        )
        .all() as { model: string }[]
    ).map((row) => row.model);
  }
  /** Returns bounded, paginated request metadata and exact aggregate counters. */
  report(filter: UsageFilter = {}): Record<string, unknown> {
    const clauses = ["started >= ?", "started <= ?"];
    const args: (number | string)[] = [
      filter.since ?? Date.now() - 7 * 86400000,
      filter.until ?? Date.now(),
    ];
    if (filter.keyId) {
      clauses.push("key_id=?");
      args.push(filter.keyId);
    }
    if (filter.model) {
      clauses.push("model=?");
      args.push(filter.model);
    }
    const where = clauses.join(" AND ");
    const cost = "reference_cost(model,input,output,cached)";
    const aggregate =
      `SUM(${cost}) AS costUsd, COUNT(${cost}) AS priced, ` +
      "COUNT(*) AS requests, SUM(CASE WHEN status>=200 AND status<300 AND error IS NULL THEN 1 ELSE 0 END) AS successful, COUNT(total) AS measured, SUM(input) AS input, SUM(output) AS output, SUM(cached) AS cached, SUM(reasoning) AS reasoning, SUM(total) AS total";
    return {
      pricing: this.prices(),
      summary: this.#db
        .prepare(`SELECT ${aggregate} FROM requests WHERE ${where}`)
        .get(...args),
      trend: this.#db
        .prepare(
          `SELECT strftime('%Y-%m-%d', started/1000, 'unixepoch') AS day, ${aggregate} FROM requests WHERE ${where} GROUP BY day ORDER BY day`,
        )
        .all(...args),
      byModel: this.#db
        .prepare(
          `SELECT model, ${aggregate} FROM requests WHERE ${where} GROUP BY model ORDER BY requests DESC LIMIT 100`,
        )
        .all(...args),
      rows: this.#db
        .prepare(
          `SELECT *, ${cost} AS costUsd FROM requests WHERE ${where} ORDER BY started DESC LIMIT 50 OFFSET ?`,
        )
        .all(...args, filter.offset ?? 0),
    };
  }
  /** Retrieves validated operational overrides, if any. */
  settings(): RuntimeSettings | undefined {
    const row = this.#db
      .prepare("SELECT value FROM settings WHERE id=1")
      .get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as RuntimeSettings) : undefined;
  }
  /** Persists only non-permission operational settings. */
  saveSettings(value: RuntimeSettings): void {
    if (
      typeof value.model !== "string" ||
      !value.model.trim() ||
      value.model.length > 160 ||
      !Number.isSafeInteger(value.timeoutMs) ||
      value.timeoutMs < 1000 ||
      value.timeoutMs > 21600000 ||
      !Number.isSafeInteger(value.maxRequests) ||
      value.maxRequests < 0 ||
      value.maxRequests > 10000
    )
      throw new Error(
        "Invalid model, timeout (1–21600 seconds), or concurrency (0–10000).",
      );
    this.#db
      .prepare(
        "INSERT INTO settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(
        JSON.stringify({
          model: value.model.trim(),
          timeoutMs: value.timeoutMs,
          maxRequests: value.maxRequests,
        }),
      );
  }
  /** Closes SQLite before process shutdown or backup. */
  close(): void {
    this.#db.close();
    this.#master.fill(0);
  }
  /** Uses unique nonces with authenticated encryption for recoverable API keys. */
  #encrypt(value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#master, nonce);
    cipher.setAAD(Buffer.from("codex-bridge-key-v1"));
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    );
  }
}
