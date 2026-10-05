import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type JobKind = "pose" | "generate";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";
export interface Job {
  id: string;
  userId: string;
  kind: JobKind;
  status: JobStatus;
  payload: unknown;
  operationId: string | null;
  result: unknown;
  error: string | null;
  createdAt: number;
}
export interface Account {
  credits: number;
  phoneVerified: boolean;
}
export interface LedgerOptions {
  freeCredits?: number;
  dailyLimit?: number;
  globalDailyLimit?: number;
}

export class LedgerError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

const prunable = `expired_at IS NULL AND status IN ('succeeded','failed') AND created_at < ?
  AND NOT EXISTS (SELECT 1 FROM jobs AS active WHERE active.status IN ('queued','running')
    AND active.kind = 'generate' AND json_extract(active.payload_json,'$.poseJobId') = jobs.id)`;

const json = (value: unknown): string => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new LedgerError(
      "Value must be JSON serializable",
      400,
      "invalid_payload",
    );
  return encoded;
};
const decode = (value: string | null): unknown =>
  value === null ? null : JSON.parse(value);
const utcDayStart = (now: number): number => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

export class Ledger {
  private readonly db: Database.Database;
  private readonly freeCredits: number;
  private readonly dailyLimit: number;
  private readonly globalDailyLimit: number;

  constructor(path: string, options: LedgerOptions = {}) {
    this.freeCredits = options.freeCredits ?? 3;
    this.dailyLimit = options.dailyLimit ?? 10;
    this.globalDailyLimit = options.globalDailyLimit ?? 300;
    for (const [name, value] of Object.entries({
      freeCredits: this.freeCredits,
      dailyLimit: this.dailyLimit,
      globalDailyLimit: this.globalDailyLimit,
    })) {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError(`${name} must be a non-negative integer`);
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        user_id TEXT PRIMARY KEY, phone_hash TEXT, credits INTEGER NOT NULL DEFAULT 0,
        free_claimed INTEGER NOT NULL DEFAULT 0 CHECK (free_claimed IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS phone_claims (
        phone_hash TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, claimed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(user_id), idempotency_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('pose', 'generate')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        payload_json TEXT NOT NULL, operation_id TEXT, result_json TEXT, error TEXT, created_at INTEGER NOT NULL,
        expired_at INTEGER, refunded INTEGER NOT NULL DEFAULT 0 CHECK (refunded IN (0, 1)), UNIQUE(user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS jobs_user_created ON jobs(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
      CREATE TABLE IF NOT EXISTS payments (
        session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(user_id),
        credits INTEGER NOT NULL CHECK (credits > 0), created_at INTEGER NOT NULL, reversed INTEGER NOT NULL DEFAULT 0 CHECK (reversed IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS payment_reversals (
        session_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL
      );
    `);
    const columns = this.db.pragma("table_info(jobs)") as { name: string }[];
    if (!columns.some((c) => c.name === "expired_at"))
      this.db.exec("ALTER TABLE jobs ADD COLUMN expired_at INTEGER");
  }

  account(userId: string, phoneHash: string | null): Account {
    if (!userId)
      throw new LedgerError("userId is required", 400, "invalid_user");
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO accounts(user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING",
        )
        .run(userId);
      const account = this.db
        .prepare("SELECT free_claimed FROM accounts WHERE user_id = ?")
        .get(userId) as { free_claimed: number };
      if (phoneHash === null) {
        this.db
          .prepare("UPDATE accounts SET phone_hash = NULL WHERE user_id = ?")
          .run(userId);
      } else {
        const claim = this.db
          .prepare(
            "INSERT INTO phone_claims(phone_hash,owner_user_id,claimed_at) VALUES(?,?,?) ON CONFLICT(phone_hash) DO NOTHING",
          )
          .run(phoneHash, userId, now);
        this.db
          .prepare("UPDATE accounts SET phone_hash = ? WHERE user_id = ?")
          .run(phoneHash, userId);
        if (account.free_claimed === 0) {
          // The first verified phone consumes the one-time eligibility even if another account claimed it first.
          this.db
            .prepare(
              "UPDATE accounts SET free_claimed = 1, credits = credits + ? WHERE user_id = ?",
            )
            .run(claim.changes === 1 ? this.freeCredits : 0, userId);
        }
      }
      const row = this.db
        .prepare("SELECT credits,phone_hash FROM accounts WHERE user_id = ?")
        .get(userId) as { credits: number; phone_hash: string | null };
      return { credits: row.credits, phoneVerified: row.phone_hash !== null };
    });
    return tx.immediate();
  }

  getAccount(userId: string): Account {
    const row = this.db
      .prepare("SELECT credits,phone_hash FROM accounts WHERE user_id = ?")
      .get(userId) as
      { credits: number; phone_hash: string | null } | undefined;
    return row
      ? { credits: row.credits, phoneVerified: row.phone_hash !== null }
      : { credits: 0, phoneVerified: false };
  }

  reserve(userId: string, key: string, kind: JobKind, payload: unknown): Job {
    if (!userId || !key)
      throw new LedgerError(
        "userId and idempotency key are required",
        400,
        "invalid_request",
      );
    if (kind !== "pose" && kind !== "generate")
      throw new LedgerError("Unknown job kind", 400, "invalid_kind");
    const payloadJson = json(payload);
    const now = Date.now();
    const dayStart = utcDayStart(now);
    const tx = this.db.transaction(() => {
      const prior = this.db
        .prepare("SELECT * FROM jobs WHERE user_id = ? AND idempotency_key = ?")
        .get(userId, key) as DbJob | undefined;
      if (prior) {
        if (prior.expired_at !== null)
          throw new LedgerError(
            "This job has expired. Start a new request.",
            410,
            "job_expired",
          );
        if (prior.kind !== kind || prior.payload_json !== payloadJson)
          throw new LedgerError(
            "Idempotency key was already used with different input",
            409,
            "idempotency_conflict",
          );
        return toJob(prior);
      }
      const account = this.db
        .prepare("SELECT credits,phone_hash FROM accounts WHERE user_id = ?")
        .get(userId) as
        { credits: number; phone_hash: string | null } | undefined;
      if (!account)
        throw new LedgerError("Account not found", 403, "account_required");
      if (account.phone_hash === null)
        throw new LedgerError(
          "Verified phone required",
          403,
          "phone_verification_required",
        );
      if (
        this.db
          .prepare(
            "SELECT 1 FROM jobs WHERE user_id = ? AND status IN ('queued','running') LIMIT 1",
          )
          .get(userId)
      )
        throw new LedgerError(
          "User already has an active job",
          409,
          "active_job_exists",
        );
      const count = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM jobs WHERE user_id = ? AND kind = ? AND created_at >= ?",
        )
        .get(userId, kind, dayStart) as { count: number };
      const limit = kind === "pose" ? 6 : this.dailyLimit;
      if (count.count >= limit)
        throw new LedgerError("Daily user limit reached", 429, "daily_limit");
      if (kind === "pose" && account.credits < 1)
        throw new LedgerError(
          "Add credits before preparing another image",
          402,
          "insufficient_credits",
        );
      const allJobs = this.db
        .prepare("SELECT COUNT(*) AS count FROM jobs WHERE created_at >= ?")
        .get(dayStart) as { count: number };
      if (allJobs.count >= this.globalDailyLimit * 3)
        throw new LedgerError(
          "The daily demo limit has been reached",
          429,
          "global_daily_limit",
        );
      if (kind === "generate") {
        const global = this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM jobs WHERE kind = 'generate' AND created_at >= ?",
          )
          .get(dayStart) as { count: number };
        if (global.count >= this.globalDailyLimit)
          throw new LedgerError(
            "Global daily limit reached",
            429,
            "global_daily_limit",
          );
        if (account.credits < 1)
          throw new LedgerError(
            "Insufficient credits",
            402,
            "insufficient_credits",
          );
        const deducted = this.db
          .prepare(
            "UPDATE accounts SET credits = credits - 1 WHERE user_id = ? AND credits >= 1",
          )
          .run(userId);
        if (deducted.changes !== 1)
          throw new LedgerError(
            "Insufficient credits",
            402,
            "insufficient_credits",
          );
      }
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO jobs(id,user_id,idempotency_key,kind,status,payload_json,created_at) VALUES(?,?,?,?,'queued',?,?)",
        )
        .run(id, userId, key, kind, payloadJson, now);
      return toJob(
        this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as DbJob,
      );
    });
    return tx.immediate();
  }

  setOperation(jobId: string, operationId: string): void {
    const update = this.db
      .prepare(
        "UPDATE jobs SET operation_id = ?, status = 'running' WHERE id = ? AND status = 'queued'",
      )
      .run(operationId, jobId);
    if (!update.changes)
      throw new LedgerError(
        "Job not found or no longer queued",
        409,
        "invalid_job_state",
      );
  }

  finish(jobId: string, result: unknown): void {
    const update = this.db
      .prepare(
        "UPDATE jobs SET status = 'succeeded', result_json = ?, error = NULL WHERE id = ? AND status IN ('queued','running')",
      )
      .run(json(result), jobId);
    if (!update.changes)
      throw new LedgerError(
        "Job not found or already finalized",
        409,
        "invalid_job_state",
      );
  }

  fail(jobId: string, message: string): void {
    const tx = this.db.transaction(() => {
      const job = this.db
        .prepare("SELECT user_id,kind,status,refunded FROM jobs WHERE id = ?")
        .get(jobId) as
        | {
            user_id: string;
            kind: JobKind;
            status: JobStatus;
            refunded: number;
          }
        | undefined;
      if (!job || job.status === "succeeded")
        throw new LedgerError(
          "Job not found or already finalized",
          409,
          "invalid_job_state",
        );
      if (job.status === "failed") return;
      this.db
        .prepare("UPDATE jobs SET status = 'failed', error = ? WHERE id = ?")
        .run(message, jobId);
      if (job.kind === "generate" && job.refunded === 0) {
        this.db
          .prepare(
            "UPDATE accounts SET credits = credits + 1 WHERE user_id = ?",
          )
          .run(job.user_id);
        this.db.prepare("UPDATE jobs SET refunded = 1 WHERE id = ?").run(jobId);
      }
    });
    tx.immediate();
  }

  getJob(userId: string, id: string): Job | null {
    const row = this.db
      .prepare(
        "SELECT * FROM jobs WHERE user_id = ? AND id = ? AND expired_at IS NULL",
      )
      .get(userId, id) as DbJob | undefined;
    return row ? toJob(row) : null;
  }

  listJobs(userId: string, limit = 20): Job[] {
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new TypeError("limit must be a non-negative integer");
    return (
      this.db
        .prepare(
          "SELECT * FROM jobs WHERE user_id = ? AND expired_at IS NULL ORDER BY created_at DESC,rowid DESC LIMIT ?",
        )
        .all(userId, limit) as DbJob[]
    ).map(toJob);
  }

  pendingJobs(): Job[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at,rowid",
        )
        .all() as DbJob[]
    ).map(toJob);
  }

  creditPayment(userId: string, sessionId: string, credits: number): void {
    if (!sessionId)
      throw new LedgerError("sessionId is required", 400, "invalid_session");
    if (!Number.isSafeInteger(credits) || credits <= 0)
      throw new LedgerError(
        "credits must be a positive integer",
        400,
        "invalid_credits",
      );
    const tx = this.db.transaction(() => {
      const prior = this.db
        .prepare("SELECT user_id,credits FROM payments WHERE session_id = ?")
        .get(sessionId) as { user_id: string; credits: number } | undefined;
      if (prior) {
        if (prior.user_id !== userId || prior.credits !== credits)
          throw new LedgerError(
            "Payment session replay mismatch",
            409,
            "payment_conflict",
          );
        return;
      }
      if (
        !this.db.prepare("SELECT 1 FROM accounts WHERE user_id = ?").get(userId)
      )
        throw new LedgerError("Account not found", 403, "account_required");
      const reversed = this.db
        .prepare("SELECT 1 FROM payment_reversals WHERE session_id = ?")
        .get(sessionId);
      this.db
        .prepare(
          "INSERT INTO payments(session_id,user_id,credits,created_at,reversed) VALUES(?,?,?,?,?)",
        )
        .run(sessionId, userId, credits, Date.now(), reversed ? 1 : 0);
      if (!reversed)
        this.db
          .prepare(
            "UPDATE accounts SET credits = credits + ? WHERE user_id = ?",
          )
          .run(credits, userId);
    });
    tx.immediate();
  }

  reversePayment(sessionId: string): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO payment_reversals(session_id,created_at) VALUES(?,?) ON CONFLICT(session_id) DO NOTHING",
        )
        .run(sessionId, Date.now());
      const payment = this.db
        .prepare(
          "SELECT user_id,credits,reversed FROM payments WHERE session_id = ?",
        )
        .get(sessionId) as
        { user_id: string; credits: number; reversed: number } | undefined;
      if (!payment || payment.reversed) return;
      this.db
        .prepare("UPDATE accounts SET credits = credits - ? WHERE user_id = ?")
        .run(payment.credits, payment.user_id);
      this.db
        .prepare("UPDATE payments SET reversed = 1 WHERE session_id = ?")
        .run(sessionId);
    });
    tx.immediate();
  }

  prunableJobs(cutoff: number): string[] {
    return (
      this.db
        .prepare(`SELECT id FROM jobs WHERE ${prunable} LIMIT 100`)
        .all(cutoff) as { id: string }[]
    ).map((row) => row.id);
  }

  expireJob(id: string, cutoff: number): void {
    this.db
      .prepare(
        `UPDATE jobs SET payload_json = 'null', result_json = NULL,
      operation_id = NULL, error = NULL, expired_at = ? WHERE id = ? AND ${prunable}`,
      )
      .run(Date.now(), id, cutoff);
  }

  close(): void {
    this.db.close();
  }
}

interface DbJob {
  expired_at: number | null;
  id: string;
  user_id: string;
  kind: JobKind;
  status: JobStatus;
  payload_json: string;
  operation_id: string | null;
  result_json: string | null;
  error: string | null;
  created_at: number;
}
function toJob(row: DbJob): Job {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    status: row.status,
    payload: decode(row.payload_json),
    operationId: row.operation_id,
    result: decode(row.result_json),
    error: row.error,
    createdAt: row.created_at,
  };
}
