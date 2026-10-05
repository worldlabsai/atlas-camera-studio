import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../server/ledger.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface WorkerResult { phoneCredits: number; phoneVerified: boolean; reservation: 'queued' | string }

function runWorker(dbPath: string, userId: string, key: string): Promise<WorkerResult> {
  const ledgerUrl = new URL('../server/ledger.ts', import.meta.url).href;
  const source = [
    'import { Ledger } from ' + JSON.stringify(ledgerUrl) + ';',
    'const [dbPath, userId, key] = process.argv.slice(1);',
    'const ledger = new Ledger(dbPath);',
    "const account = ledger.account(userId, 'same-verified-phone-hash');",
    'let reservation;',
    'try { ledger.reserve("buyer", key, "generate", { key }); reservation = "queued"; }',
    'catch (error) { reservation = error?.code ?? String(error); }',
    'process.stdout.write(JSON.stringify({ phoneCredits: account.credits, phoneVerified: account.phoneVerified, reservation }));',
    'ledger.close();',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', source, dbPath, userId, key], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error('ledger worker exited ' + code + ': ' + stderr));
      try { resolve(JSON.parse(stdout) as WorkerResult); }
      catch { reject(new Error('ledger worker returned invalid output: ' + stdout + '; stderr: ' + stderr)); }
    });
  });
}

it('serializes phone claims and final-credit reservations across processes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'camera-ledger-process-race-'));
  dirs.push(dir);
  const dbPath = join(dir, 'ledger.sqlite');
  const ledger = new Ledger(dbPath);
  ledger.account('phone-user-a', null);
  ledger.account('phone-user-b', null);
  ledger.account('buyer', null);
  ledger.creditPayment('buyer', 'single-credit-session', 1);
  ledger.close();

  const results = await Promise.all([
    runWorker(dbPath, 'phone-user-a', 'race-a'),
    runWorker(dbPath, 'phone-user-b', 'race-b'),
  ]);

  assert.equal(results.filter((result) => result.phoneCredits === 3).length, 1);
  assert.equal(results.reduce((sum, result) => sum + result.phoneCredits, 0), 3);
  assert.ok(results.every((result) => result.phoneVerified));
  assert.equal(results.filter((result) => result.reservation === 'queued').length, 1);
  assert.ok(results.every((result) => result.reservation === 'queued' || result.reservation === 'active_job_exists'));

  const verify = new Ledger(dbPath);
  assert.equal(verify.getAccount('buyer').credits, 0);
  assert.equal(verify.pendingJobs().filter((job) => job.userId === 'buyer').length, 1);
  verify.close();
});
