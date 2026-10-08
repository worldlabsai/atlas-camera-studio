import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Ledger } from "../server/ledger.ts";
import { JobRunner } from "../server/jobs.ts";
import { ApiFailure } from "../server/marble.ts";
import type { Frame } from "../server/contracts.ts";

const camera = {
  intrinsics: {
    width: 1280 as const,
    height: 720 as const,
    fx: 900,
    fy: 900,
    cx: 640,
    cy: 360,
  },
  extrinsics: {
    position: [0, 0, 0] as [number, number, number],
    quaternion: [0, 0, 0, 1] as [number, number, number, number],
    coordinateSystem: "rub" as const,
  },
};
const frame: Frame = {
  camera,
  imageAsset: { assetId: "image" },
  depth: { depthAsset: { assetId: "depth" } },
};
const pause = async () => {};
const newPose = (ledger: Ledger) =>
  ledger.reserve("user", randomUUID(), "pose", {
    key: randomUUID(),
    image: { base64: "AAAA", mimeType: "image/png" },
  });
const newGeneration = (ledger: Ledger) => {
  const pose = newPose(ledger);
  ledger.finish(pose.id, { frames: [frame] });
  return ledger.reserve("user", randomUUID(), "generate", {
    key: randomUUID(),
    poseJobId: pose.id,
    cameras: Array.from({ length: 48 }, () => camera),
    prompt: "",
    seed: 42,
  });
};

it("limits work across users, drains queued jobs, and preserves queued reservations on shutdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "camera-concurrency-"));
  const ledger = new Ledger(join(dir, "ledger.sqlite"));
  const jobs = Array.from({ length: 4 }, (_, i) => {
    const user = "user-" + i;
    ledger.account(user, "phone-" + i);
    const job = ledger.reserve(user, randomUUID(), "pose", {
      key: randomUUID(),
      image: { base64: "AAAA", mimeType: "image/png" },
    });
    return { user, job };
  });
  const releases: Array<() => void> = [];
  let active = 0,
    peak = 0,
    submits = 0;
  const runner = new JobRunner(
    ledger,
    dir,
    {
      submit: async () => {
        const id = "operation-" + ++submits;
        peak = Math.max(peak, ++active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return { id, done: true, response: { frames: [frame] } };
      },
      operation: async () => {
        throw new Error("completed operation");
      },
      readAsset: async () => {
        throw new Error("pose needs no download");
      },
    },
    pause,
  );
  const running = jobs.map(({ user, job }) => runner.start(job.id, user));
  try {
    assert.equal(submits, 2);
    await runner.start(jobs[2].job.id, jobs[2].user);
    assert.equal(submits, 2, "duplicate queued job must not be submitted");
    releases.shift()!();
    await running[0];
    await Promise.resolve();
    assert.equal(submits, 3, "one queued job starts when a slot opens");
    assert.equal(peak, 2);
    runner.stop();
    await running[3];
    assert.equal(ledger.getJob(jobs[3].user, jobs[3].job.id)?.status, "queued");
    for (const release of releases.splice(0)) release();
    await Promise.all(running);
    assert.equal(submits, 3, "shutdown must not submit queued work");
    const resumed = new JobRunner(
      ledger,
      dir,
      {
        submit: async () => ({
          id: "resumed",
          done: true,
          response: { frames: [frame] },
        }),
        operation: async () => {
          throw new Error("not submitted before restart");
        },
        readAsset: async () => {
          throw new Error("not needed");
        },
      },
      pause,
    );
    await resumed.start(jobs[3].job.id, jobs[3].user);
    assert.equal(
      ledger.getJob(jobs[3].user, jobs[3].job.id)?.status,
      "succeeded",
    );
  } finally {
    runner.stop();
    for (const release of releases.splice(0)) release();
    await Promise.all(running);
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("encodes exactly 48 generated frames and reserves one credit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "camera-runner-"));
  const ledger = new Ledger(join(dir, "ledger.sqlite"));
  ledger.account("user", "phone");
  const job = newGeneration(ledger);
  const image = join(dir, "frame.png");
  execFileSync("ffmpeg", [
    "-nostdin",
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x558877:s=64x36:d=0.1",
    "-frames:v",
    "1",
    image,
  ]);
  const bytes = await readFile(image);
  let submits = 0;
  const runner = new JobRunner(
    ledger,
    join(dir, "jobs"),
    {
      submit: async (task, body, key) => {
        submits++;
        assert.equal(task, "atlasGenerate");
        assert.equal(key, "camera-studio-" + job.id);
        assert.equal((body as any).targetCameras.length, 48);
        assert.equal(
          (body as any).contextFrames[0].depth.depthAsset.assetId,
          "depth",
        );
        return {
          id: "op-video",
          done: true,
          response: { frames: Array.from({ length: 48 }, () => frame) },
        };
      },
      operation: async () => {
        throw new Error("should not poll finished operation");
      },
      readAsset: async () => bytes,
    },
    pause,
  );
  try {
    await runner.start(job.id, "user");
    assert.equal(submits, 1);
    assert.equal(ledger.getJob("user", job.id)?.status, "succeeded");
    assert.equal(ledger.getAccount("user").credits, 2);
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=nb_frames,r_frame_rate",
          "-of",
          "json",
          runner.videoPath(job.id),
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(probe.streams[0].nb_frames, "48");
    assert.equal(probe.streams[0].r_frame_rate, "12/1");
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("preserves a reservation across uncertain polling and resumes its existing operation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "camera-resume-"));
  let ledger = new Ledger(join(dir, "ledger.sqlite"));
  ledger.account("user", "phone");
  const job = newGeneration(ledger);
  ledger.setOperation(job.id, "op-existing");
  const neverSubmit = async () => {
    throw new Error("must not resubmit stored operation");
  };
  const unavailable = new JobRunner(
    ledger,
    dir,
    {
      submit: neverSubmit,
      operation: async () => {
        throw new ApiFailure("Temporary network failure", false);
      },
      readAsset: async () => {
        throw new Error("not reached");
      },
    },
    async () => unavailable.stop(),
  );
  await unavailable.start(job.id, "user");
  assert.equal(ledger.getAccount("user").credits, 2);
  assert.equal(ledger.getJob("user", job.id)?.status, "running");
  ledger.close();
  ledger = new Ledger(join(dir, "ledger.sqlite"));
  const resumed = new JobRunner(
    ledger,
    dir,
    {
      submit: neverSubmit,
      operation: async (id) => {
        assert.equal(id, "op-existing");
        return {
          id,
          done: true,
          error: { message: "terminal upstream failure" },
        };
      },
      readAsset: async () => {
        throw new Error("not reached");
      },
    },
    pause,
  );
  try {
    await resumed.start(job.id, "user");
    await resumed.start(job.id, "user");
    assert.equal(ledger.getJob("user", job.id)?.status, "failed");
    assert.equal(ledger.getAccount("user").credits, 3);
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("returns the credit when completed upstream frames cannot be encoded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "camera-bad-video-"));
  const ledger = new Ledger(join(dir, "ledger.sqlite"));
  try {
    ledger.account("user", "phone");
    const job = newGeneration(ledger);
    const runner = new JobRunner(
      ledger,
      join(dir, "jobs"),
      {
        submit: async () => ({
          id: "op-bad-video",
          done: true,
          response: { frames: Array.from({ length: 48 }, () => frame) },
        }),
        operation: async () => {
          throw new Error("finished task must not be resubmitted");
        },
        readAsset: async () => Buffer.from("invalid-image"),
      },
      async () => {
        throw new Error("encoding failure must not retry indefinitely");
      },
    );
    await runner.start(job.id, "user");
    assert.equal(ledger.getJob("user", job.id)?.status, "failed");
    assert.match(
      ledger.getJob("user", job.id)?.error || "",
      /could not be encoded/,
    );
    assert.equal(ledger.getAccount("user").credits, 3);
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("the public example uses bundled inline assets, normal credits, and no pose task", async () => {
  const { EXAMPLE_ID } = await import("../src/example.ts");
  const { exampleFrame } = await import("../server/example.ts");
  const example = exampleFrame();
  const dir = await mkdtemp(join(tmpdir(), "camera-example-"));
  const ledger = new Ledger(join(dir, "ledger.sqlite"));
  ledger.account("user", "phone");
  const job = ledger.reserve("user", randomUUID(), "generate", {
    key: randomUUID(),
    poseJobId: EXAMPLE_ID,
    cameras: Array.from({ length: 48 }, () => example.camera),
    prompt: "Igloo",
    seed: 42,
  });
  let calls = 0;
  const runner = new JobRunner(
    ledger,
    dir,
    {
      submit: async (task, body) => {
        calls++;
        assert.equal(task, "atlasGenerate");
        const context = (body as any).contextFrames[0];
        assert.deepEqual(context.camera, example.camera);
        assert.match(context.imageAsset.base64, /^data:image\/jpeg;base64,/);
        assert.match(
          context.depth.depthAsset.base64,
          /^data:image\/x-exr;base64,/,
        );
        assert.equal(context.imageAsset.assetId, undefined);
        assert.equal(context.depth.depthAsset.url, undefined);
        return { id: "sample-operation" };
      },
      operation: async () => ({
        id: "sample-operation",
        done: true,
        error: { message: "test failure" },
      }),
      readAsset: async () => {
        throw new Error("No download on failure");
      },
    },
    async () => {
      assert.equal(ledger.getAccount("user").credits, 2);
    },
  );
  try {
    await runner.start(job.id, "user");
    assert.equal(calls, 1);
    assert.equal(ledger.getJob("user", job.id)?.status, "failed");
    assert.equal(
      ledger.getAccount("user").credits,
      3,
      "failed example generation is refunded",
    );
  } finally {
    runner.stop();
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});
