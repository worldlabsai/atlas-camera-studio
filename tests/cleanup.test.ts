import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Ledger, LedgerError } from "../server/ledger.ts";
import { JobRunner } from "../server/jobs.ts";

test("cleanup preserves active inputs, then removes content without resetting claims or replay protection", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-cleanup-"));
  const path = join(root, "ledger.sqlite");
  const ledger = new Ledger(path);
  const db = new Database(path);
  try {
    ledger.account("user", "phone");
    ledger.creditPayment("user", "paid-pack", 3);
    const pose = ledger.reserve("user", "pose-key", "pose", {
      image: "private-input",
    });
    ledger.finish(pose.id, { frames: [{ imageAsset: "private-reference" }] });
    const job = ledger.reserve("user", "generation-key", "generate", {
      poseJobId: pose.id,
    });
    db.prepare("UPDATE jobs SET created_at = 0").run();
    const dir = join(root, "jobs");
    const runner = new JobRunner(ledger, dir);
    await runner.prune(1);
    assert(ledger.getJob("user", pose.id));
    assert(ledger.getJob("user", job.id));
    ledger.finish(job.id, { videoReady: true });
    await mkdir(join(dir, job.id), { recursive: true });
    await writeFile(runner.videoPath(job.id), "private-video");
    await runner.prune(1);
    await assert.rejects(access(runner.videoPath(job.id)), { code: "ENOENT" });
    assert.equal(ledger.getJob("user", pose.id), null);
    assert.equal(ledger.getJob("user", job.id), null);
    assert.deepEqual(ledger.listJobs("user"), []);
    const rows = db
      .prepare("SELECT payload_json,result_json,operation_id FROM jobs")
      .all();
    assert.deepEqual(rows, [
      { payload_json: "null", result_json: null, operation_id: null },
      { payload_json: "null", result_json: null, operation_id: null },
    ]);
    assert.throws(
      () => ledger.reserve("user", "generation-key", "generate", {}),
      (error: unknown) => error instanceof LedgerError && error.status === 410,
    );
    ledger.creditPayment("user", "paid-pack", 3);
    assert.equal(ledger.getAccount("user").credits, 5);
    assert.equal(ledger.account("second-user", "phone").credits, 0);
  } finally {
    db.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});
