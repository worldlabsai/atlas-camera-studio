import "dotenv/config";
import express from "express";
import { clerkMiddleware, clerkClient, getAuth } from "@clerk/express";
import Stripe from "stripe";
import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { Ledger, LedgerError } from "./ledger.ts";
import {
  FRAMES,
  FPS,
  PACK_CREDITS,
  PACK_CENTS,
  poseSchema,
  generateSchema,
  type TaskResult,
} from "./contracts.ts";
import { readAsset } from "./marble.ts";
import { JobRunner } from "./jobs.ts";
import { fulfillCheckout } from "./payments.ts";

const mode = process.env.APP_MODE || "local";
if (!["local", "hosted"].includes(mode))
  throw new Error("APP_MODE must be local or hosted");
const hosted = mode === "hosted";
const origin =
  process.env.APP_ORIGIN || (hosted ? "" : "http://127.0.0.1:3030");
if (hosted) {
  for (const key of [
    "APP_ORIGIN",
    "CLERK_PUBLISHABLE_KEY",
    "CLERK_SECRET_KEY",
    "PHONE_HASH_SECRET",
    "WLT_API_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_ID",
  ]) {
    if (!process.env[key]) throw new Error("Hosted mode requires " + key);
  }
  const url = new URL(origin);
  const localTest =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    process.env.CLERK_SECRET_KEY!.startsWith("sk_test_") &&
    /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY!);
  if (
    (url.protocol !== "https:" && !localTest) ||
    process.env.PHONE_HASH_SECRET!.length < 32
  )
    throw new Error(
      "Hosted mode requires HTTPS and a strong phone hash secret",
    );
}
const loopbackOrigin = ["localhost", "127.0.0.1", "[::1]"].includes(
  new URL(origin).hostname,
);
const data = resolve(process.env.DATA_DIR || "data");
mkdirSync(data, { recursive: true, mode: 0o700 });
const ledger = new Ledger(resolve(data, "studio.sqlite"), {
  dailyLimit: hosted ? 10 : 100,
  globalDailyLimit: hosted ? 300 : 1000,
});
const runner = new JobRunner(ledger, resolve(data, "jobs"));
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;
const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  if (
    (!hosted || loopbackOrigin) &&
    !["127.0.0.1", "localhost", "[::1]"].includes(req.hostname)
  ) {
    res
      .status(403)
      .json({ error: "Local mode only accepts localhost requests." });
    return;
  }
  next();
});
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      res.sendStatus(503);
      return;
    }
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.header("stripe-signature") || "",
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch {
      res.status(400).json({ error: "Invalid webhook signature" });
      return;
    }
    try {
      if (
        [
          "checkout.session.completed",
          "checkout.session.async_payment_succeeded",
        ].includes(event.type)
      ) {
        await fulfillCheckout(
          stripe,
          ledger,
          event.data.object as Stripe.Checkout.Session,
          process.env.STRIPE_PRICE_ID!,
        );
      }
      if (
        event.type === "charge.refunded" ||
        event.type === "charge.dispute.created"
      ) {
        const object = event.data.object as any;
        const charge =
          event.type === "charge.refunded"
            ? object
            : await stripe.charges.retrieve(
                typeof object.charge === "string"
                  ? object.charge
                  : object.charge.id,
              );
        if (event.type === "charge.dispute.created" || charge.refunded) {
          const paymentIntent =
            typeof charge.payment_intent === "string"
              ? charge.payment_intent
              : charge.payment_intent?.id;
          if (paymentIntent) {
            const sessions = await stripe.checkout.sessions.list({
              payment_intent: paymentIntent,
              limit: 10,
            });
            for (const session of sessions.data)
              if (session.metadata?.app === "marble-camera-studio")
                ledger.reversePayment(session.id);
          }
        }
      }
      res.json({ received: true });
    } catch {
      console.error("Stripe event processing failed", {
        id: event.id,
        type: event.type,
      });
      res.sendStatus(500);
    }
  },
);
app.use(express.json({ limit: "7mb" }));
app.get("/api/config", (_req, res) =>
  res.json({
    mode,
    clerkPublishableKey: hosted ? process.env.CLERK_PUBLISHABLE_KEY : null,
    freeCredits: 3,
    packCredits: PACK_CREDITS,
    packPriceCents: PACK_CENTS,
    frames: FRAMES,
    fps: FPS,
    apiConfigured: !!process.env.WLT_API_KEY,
    repoUrl: process.env.REPOSITORY_URL || null,
  }),
);
app.get("/api/health", (_req, res) => res.json({ ok: true, mode }));
if (hosted) app.use(clerkMiddleware({ authorizedParties: [origin] }));
app.use("/api", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) {
    const received = req.header("origin");
    const allowed = new Set([
      origin,
      ...(!hosted
        ? [
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "http://localhost:3030",
          ]
        : []),
    ]);
    if (received && !allowed.has(received)) {
      res.status(403).json({ error: "Request origin is not allowed." });
      return;
    }
  }
  if (hosted) {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Sign in to continue." });
      return;
    }
    try {
      const user = await clerkClient.users.getUser(userId);
      const phone =
        user.phoneNumbers.find(
          (p) =>
            p.id === user.primaryPhoneNumberId &&
            p.verification?.status === "verified",
        ) ||
        user.phoneNumbers.find((p) => p.verification?.status === "verified");
      const phoneHash = phone
        ? createHmac("sha256", process.env.PHONE_HASH_SECRET!)
            .update(phone.phoneNumber)
            .digest("hex")
        : null;
      res.locals.userId = userId;
      res.locals.verified = !!phone;
      res.locals.account = ledger.account(userId, phoneHash);
    } catch (error) {
      next(error);
      return;
    }
  } else {
    res.locals.userId = "local";
    res.locals.verified = true;
    ledger.account("local", "local");
    ledger.creditPayment("local", "local-development", 100000);
    res.locals.account = ledger.getAccount("local");
  }
  next();
});
app.get("/api/account", (_req, res) =>
  res.json({ ...res.locals.account, phoneVerified: res.locals.verified }),
);
function cleanJob(job: any) {
  const { payload, userId, operationId, ...safe } = job;
  return safe;
}
app.get("/api/jobs", (_req, res) =>
  res.json(ledger.listJobs(res.locals.userId).map(cleanJob)),
);
app.get("/api/jobs/:id", (req, res) => {
  const job = ledger.getJob(res.locals.userId, String(req.params.id));
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }
  res.json(cleanJob(job));
});
app.use(
  ["/api/jobs/pose", "/api/jobs/generate", "/api/checkout"],
  (_req, res, next) => {
    if (!res.locals.verified) {
      res.status(403).json({
        error: "Verify a phone number in your account to continue.",
        code: "phone_required",
      });
      return;
    }
    next();
  },
);
app.post("/api/jobs/pose", (req, res) => {
  if (!process.env.WLT_API_KEY) {
    res.status(503).json({
      error: "Set WLT_API_KEY on the server before preparing an image.",
    });
    return;
  }
  const payload = poseSchema.parse(req.body);
  const bytes = Buffer.from(payload.image.base64, "base64");
  const valid =
    payload.image.mimeType === "image/jpeg"
      ? bytes[0] === 255 && bytes[1] === 216
      : payload.image.mimeType === "image/png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid) {
    res.status(400).json({ error: "Upload a valid JPEG, PNG, or WebP image." });
    return;
  }
  const job = ledger.reserve(res.locals.userId, payload.key, "pose", payload);
  void runner.start(job.id, res.locals.userId);
  res.status(202).json(cleanJob(job));
});
app.post("/api/jobs/generate", (req, res) => {
  const payload = generateSchema.parse(req.body);
  const source = ledger.getJob(res.locals.userId, payload.poseJobId);
  if (source?.kind !== "pose" || source.status !== "succeeded") {
    res.status(400).json({ error: "Prepare an image before generating." });
    return;
  }
  const job = ledger.reserve(
    res.locals.userId,
    payload.key,
    "generate",
    payload,
  );
  void runner.start(job.id, res.locals.userId);
  res.status(202).json(cleanJob(job));
});
app.get("/api/jobs/:id/media", async (req, res) => {
  const job = ledger.getJob(res.locals.userId, String(req.params.id));
  const index = Number(req.query.frame || 0);
  if (
    !job ||
    job.status !== "succeeded" ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= FRAMES
  ) {
    res.sendStatus(404);
    return;
  }
  const frame = (job.result as TaskResult)?.frames?.[index];
  const depth = req.query.kind === "depth";
  const asset = depth ? frame?.depth?.depthAsset : frame?.imageAsset;
  if (!asset) {
    res.sendStatus(404);
    return;
  }
  const bytes = await readAsset(asset);
  const imageType =
    bytes[0] === 255 && bytes[1] === 216
      ? "image/jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF"
        ? "image/webp"
        : "image/png";
  res.type(depth ? "image/x-exr" : imageType).send(bytes);
});
app.get("/api/jobs/:id/video", (req, res) => {
  const job = ledger.getJob(res.locals.userId, String(req.params.id));
  if (
    job?.kind !== "generate" ||
    job.status !== "succeeded" ||
    !(job.result as TaskResult)?.videoReady
  ) {
    res.sendStatus(404);
    return;
  }
  res.download(runner.videoPath(job.id), "marble-camera-" + job.id + ".mp4");
});
app.post("/api/checkout", async (_req, res) => {
  if (!hosted || !stripe) {
    res
      .status(400)
      .json({ error: "Billing is only available on the hosted app." });
    return;
  }
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    allowed_payment_method_types: ["card"],
    line_items: [{ price: process.env.STRIPE_PRICE_ID!, quantity: 1 }],
    client_reference_id: res.locals.userId,
    metadata: { app: "marble-camera-studio", userId: res.locals.userId },
    success_url: origin + "/?checkout=success",
    cancel_url: origin + "/?checkout=cancelled",
  });
  res.json({ url: session.url });
});
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));
app.use(express.static(resolve("dist"), { index: false }));
app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: "Please check the request fields.",
        details: error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
      return;
    }
    if (error instanceof LedgerError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    if (
      error instanceof SyntaxError &&
      "status" in error &&
      error.status === 400
    ) {
      res.status(400).json({ error: "Invalid JSON request." });
      return;
    }
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 413
    ) {
      res.status(413).json({ error: "The upload is too large." });
      return;
    }
    console.error("Request failed", {
      type: error instanceof Error ? error.name : "unknown",
    });
    res.status(500).json({ error: "Something went wrong. Please try again." });
  },
);
const port = Number(process.env.PORT || 3030);
const host = hosted && !loopbackOrigin ? "0.0.0.0" : "127.0.0.1";
const server = app.listen(port, host, () => {
  console.log(
    "Camera Studio listening on " +
      host +
      ":" +
      (server.address() as import("node:net").AddressInfo).port +
      " (" +
      mode +
      ")",
  );
  runner.resume();
  void runner.prune();
});
const cleanupTimer = setInterval(() => void runner.prune(), 60 * 60 * 1000);
cleanupTimer.unref();
function shutdown() {
  clearInterval(cleanupTimer);
  runner.stop();
  server.close(() => {
    ledger.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
