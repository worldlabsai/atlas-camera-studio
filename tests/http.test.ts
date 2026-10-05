import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request } from "node:http";

it("local HTTP server rejects hostile origins, malformed input, and unavailable upstream work", async () => {
  const data = await mkdtemp(join(tmpdir(), "camera-http-"));
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", "server/index.ts"],
    {
      env: {
        ...process.env,
        APP_MODE: "local",
        PORT: "0",
        DATA_DIR: data,
        WLT_API_KEY: "",
        STRIPE_SECRET_KEY: "",
        DOTENV_CONFIG_PATH: "/dev/null",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let errors = "";
  child.stderr.on("data", (data) => {
    errors += data;
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server did not start: " + errors)),
      10000,
    );
    child.stdout.on("data", (data) => {
      output += data;
      const match = output.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("server exited " + code + ": " + errors));
    });
  });
  const base = "http://127.0.0.1:" + port;
  try {
    assert.equal((await fetch(base + "/api/health")).status, 200);
    const hostileHostStatus = await new Promise<number>((resolve, reject) => {
      const req = request(
        base + "/api/health",
        { headers: { Host: "hostile.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(hostileHostStatus, 403);
    assert.equal(
      (
        await fetch(base + "/api/jobs/pose", {
          method: "POST",
          headers: { origin: "https://hostile.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/jobs/pose", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + "/api/jobs/pose", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      503,
    );
    assert.equal(
      (
        await fetch(base + "/api/jobs/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      400,
    );
    assert.equal((await fetch(base + "/api/jobs/unknown/video")).status, 404);
    assert.equal(
      (await fetch(base + "/api/checkout", { method: "POST" })).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + "/api/stripe/webhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      503,
    );
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    await rm(data, { recursive: true, force: true });
  }
});

it("hosted server refuses to start without required credentials", async () => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", "server/index.ts"],
    {
      env: {
        ...process.env,
        APP_MODE: "hosted",
        APP_ORIGIN: "",
        DOTENV_CONFIG_PATH: "/dev/null",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let error = "";
  child.stderr.on("data", (data) => {
    error += data;
  });
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
  assert.match(error, /Hosted mode requires APP_ORIGIN/);
});
