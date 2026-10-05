import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { Ledger, LedgerError } from '../server/ledger.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(options: ConstructorParameters<typeof Ledger>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'camera-ledger-'));
  dirs.push(dir);
  const ledger = new Ledger(join(dir, 'ledger.sqlite'), options);
  return { ledger, path: join(dir, 'ledger.sqlite') };
}
function errorCode(fn: () => unknown, code: string) {
  assert.throws(fn, (error: unknown) => error instanceof LedgerError && error.code === code);
}

describe('Ledger', () => {
  it('grants once per globally unique phone and never again when a user changes phone', () => {
    const { ledger } = setup();
    assert.deepEqual(ledger.account('a', null), { credits: 0, phoneVerified: false });
    assert.equal(ledger.account('a', 'hash-one').credits, 3);
    assert.deepEqual(ledger.account('b', 'hash-one'), { credits: 0, phoneVerified: true });
    assert.equal(ledger.account('a', 'hash-two').credits, 3);
    assert.equal(ledger.account('a', null).credits, 3);
    assert.equal(ledger.account('a', 'hash-three').credits, 3);
    ledger.close();
  });

  it('makes reservations idempotent and rejects changed input on a reused key', () => {
    const { ledger } = setup();
    ledger.account('u', 'phone');
    const first = ledger.reserve('u', 'req-1', 'generate', { prompt: 'tree' });
    const replay = ledger.reserve('u', 'req-1', 'generate', { prompt: 'tree' });
    assert.equal(replay.id, first.id);
    assert.equal(ledger.getAccount('u').credits, 2);
    errorCode(() => ledger.reserve('u', 'req-1', 'generate', { prompt: 'house' }), 'idempotency_conflict');
    errorCode(() => ledger.reserve('u', 'req-1', 'pose', { prompt: 'tree' }), 'idempotency_conflict');
    ledger.close();
  });

  it('prevents overspend under concurrent reservations', async () => {
    const { ledger } = setup();
    ledger.account('u', 'phone');
    // There are 3 credits. Active-job serialization means subsequent calls are blocked until completion.
    const first = ledger.reserve('u', 'one', 'generate', {});
    errorCode(() => ledger.reserve('u', 'two', 'generate', {}), 'active_job_exists');
    ledger.finish(first.id, { ok: true });
    const second = ledger.reserve('u', 'two', 'generate', {});
    ledger.finish(second.id, { ok: true });
    const third = ledger.reserve('u', 'three', 'generate', {});
    ledger.finish(third.id, { ok: true });
    errorCode(() => ledger.reserve('u', 'four', 'generate', {}), 'insufficient_credits');
    assert.equal(ledger.getAccount('u').credits, 0);
    ledger.close();
  });

  it('refunds failed generation once, never refunds success, and tolerates duplicate failure', () => {
    const { ledger } = setup();
    ledger.account('u', 'phone');
    const failed = ledger.reserve('u', 'fail', 'generate', {});
    ledger.fail(failed.id, 'worker error');
    ledger.fail(failed.id, 'duplicate notification');
    assert.equal(ledger.getAccount('u').credits, 3);
    const succeeded = ledger.reserve('u', 'ok', 'generate', {});
    ledger.finish(succeeded.id, { output: 'done' });
    errorCode(() => ledger.fail(succeeded.id, 'late error'), 'invalid_job_state');
    assert.equal(ledger.getAccount('u').credits, 2);
    ledger.close();
  });

  it('credits a payment session exactly once and rejects mismatched replays', () => {
    const { ledger } = setup();
    ledger.account('u', null);
    ledger.account('other', null);
    ledger.creditPayment('u', 'cs_1', 5);
    ledger.creditPayment('u', 'cs_1', 5);
    assert.equal(ledger.getAccount('u').credits, 5);
    errorCode(() => ledger.creditPayment('u', 'cs_1', 6), 'payment_conflict');
    errorCode(() => ledger.creditPayment('other', 'cs_1', 5), 'payment_conflict');
    assert.equal(ledger.getAccount('other').credits, 0);
    ledger.close();
  });

  it('reverses a payment once and blocks replay from restoring reversed credits', () => {
    const { ledger } = setup();
    ledger.account('u', null);
    ledger.creditPayment('u', 'cs_reverse', 4);
    ledger.reversePayment('cs_reverse');
    ledger.reversePayment('cs_reverse');
    ledger.creditPayment('u', 'cs_reverse', 4);
    assert.equal(ledger.getAccount('u').credits, -4);
    errorCode(() => ledger.reserve('u', 'spend', 'generate', {}), 'insufficient_credits');
    ledger.close();
  });

  it('scopes job lookup by owner and recovers queued/running jobs after reopening', () => {
    const { ledger, path } = setup();
    ledger.account('u', 'phone');
    ledger.account('other', 'other-phone');
    const queued = ledger.reserve('u', 'queued', 'pose', { frame: 1 });
    const running = ledger.reserve('other', 'running', 'pose', { frame: 2 });
    ledger.setOperation(running.id, 'op-7');
    assert.equal(ledger.getJob('other', queued.id), null);
    assert.deepEqual(ledger.listJobs('other').map((job) => job.id), [running.id]);
    ledger.close();
    const reopened = new Ledger(path);
    assert.deepEqual(reopened.pendingJobs().map((job) => [job.id, job.status]), [[queued.id, 'queued'], [running.id, 'running']]);
    assert.equal(reopened.getJob('other', running.id)?.operationId, 'op-7');
    reopened.close();
  });

  it('requires phone verification for free pose jobs and enforces daily/global quotas', () => {
    const { ledger } = setup({ dailyLimit: 1, globalDailyLimit: 1 });
    ledger.account('u', null);
    errorCode(() => ledger.reserve('u', 'pose', 'pose', {}), 'phone_verification_required');
    ledger.account('u', 'phone');
    const pose = ledger.reserve('u', 'pose', 'pose', {});
    ledger.finish(pose.id, {});
    const generate = ledger.reserve('u', 'gen', 'generate', {});
    ledger.finish(generate.id, {});
    const other = ledger.account('other', 'other');
    assert.equal(other.credits, 3);
    errorCode(() => ledger.reserve('other', 'gen', 'generate', {}), 'global_daily_limit');
    ledger.close();
  });
});
