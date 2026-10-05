import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

test("upstream credit exhaustion is terminal and explains which balance needs funding", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(402, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "insufficient_credits" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  process.env.WLT_API_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.WLT_API_KEY = "fixture";
  const { submit, ApiFailure } = await import("../server/marble.ts");
  try {
    for (const mode of ["local", "hosted"]) {
      process.env.APP_MODE = mode;
      await assert.rejects(
        submit("images2PosedRGBD", {}, "fixture"),
        (error: unknown) => {
          assert(error instanceof ApiFailure);
          assert.equal(error.status, 402);
          assert.equal(error.terminal, true);
          assert.match(
            error.message,
            mode === "hosted" ? /demo is temporarily out/ : /developer credits/,
          );
          return true;
        },
      );
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
