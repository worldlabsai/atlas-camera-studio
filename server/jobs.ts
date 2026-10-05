import { mkdir, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { Ledger } from "./ledger.ts";
import {
  FRAMES,
  FPS,
  generateSchema,
  poseSchema,
  type TaskResult,
} from "./contracts.ts";
import { ApiFailure, operation, readAsset, submit } from "./marble.ts";
const run = promisify(execFile);
export class JobRunner {
  private busy = new Set<string>();
  private stopping = false;
  private cleaning = false;
  constructor(
    private ledger: Ledger,
    private dir: string,
    private client = { submit, operation, readAsset },
    private sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}
  resume() {
    for (const job of this.ledger.pendingJobs())
      void this.start(job.id, job.userId);
  }
  stop() {
    this.stopping = true;
  }
  async start(id: string, userId: string) {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    let delay = 1500;
    try {
      while (!this.stopping) {
        const job = this.ledger.getJob(userId, id);
        if (!job || ["failed", "succeeded"].includes(job.status)) return;
        try {
          let op;
          if (job.operationId)
            op = await this.client.operation(job.operationId);
          else {
            let body: unknown, task: string;
            if (job.kind === "pose") {
              const p = poseSchema.parse(job.payload);
              body = {
                frames: [
                  {
                    imageAsset: {
                      base64:
                        "data:" +
                        p.image.mimeType +
                        ";base64," +
                        p.image.base64,
                    },
                  },
                ],
                targetResolution: [1280, 720],
              };
              task = "images2PosedRGBD";
            } else {
              const p = generateSchema.parse(job.payload);
              const source = this.ledger.getJob(userId, p.poseJobId);
              const context = (source?.result as TaskResult)?.frames?.[0];
              if (!context?.depth || source?.status !== "succeeded")
                throw new ApiFailure(
                  "Prepare an image before generating.",
                  true,
                );
              body = {
                contextFrames: [
                  {
                    imageAsset: context.imageAsset,
                    camera: context.camera,
                    depth: context.depth,
                  },
                ],
                targetCameras: p.cameras,
                prompt: p.prompt || null,
                modelParameters: { seed: p.seed },
                returnDepth: false,
              };
              task = "atlasGenerate";
            }
            op = await this.client.submit(task, body, "camera-studio-" + id);
            if (!op.id)
              throw new ApiFailure("Marble returned no operation ID.", false);
            this.ledger.setOperation(id, op.id);
          }
          if (op.done) {
            if (op.error)
              throw new ApiFailure(
                "Generation failed. Your generation credit has been returned.",
                true,
              );
            const result = op.response;
            if (!result?.frames?.length)
              throw new ApiFailure("Marble returned no frames.", true);
            if (job.kind === "generate") {
              if (result.frames.length !== FRAMES)
                throw new ApiFailure(
                  "Marble returned an incomplete camera path.",
                  true,
                );
              await this.makeVideo(id, result);
              result.videoReady = true;
            }
            this.ledger.finish(id, result);
            return;
          }
          delay = 3000;
        } catch (error) {
          if (
            (error instanceof ApiFailure && error.terminal) ||
            error instanceof z.ZodError
          ) {
            console.error("Job failed", {
              id,
              status: error instanceof ApiFailure ? error.status : 400,
            });
            this.ledger.fail(
              id,
              error instanceof z.ZodError
                ? "Invalid generation request."
                : error.message,
            );
            return;
          }
          // A timeout never proves the upstream task stopped. Keep its reservation and resume it.
          console.error("Job will retry", {
            id,
            type: error instanceof Error ? error.name : "unknown",
          });
          delay = Math.min(delay * 2, 30000);
        }
        await this.sleep(delay);
      }
    } finally {
      this.busy.delete(id);
    }
  }
  async prune(cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000) {
    if (this.cleaning || this.stopping) return;
    this.cleaning = true;
    try {
      for (const id of this.ledger.prunableJobs(cutoff)) {
        if (this.stopping) break;
        try {
          await rm(join(this.dir, id), { recursive: true, force: true });
          if (!this.stopping) this.ledger.expireJob(id, cutoff);
        } catch {
          console.error("Job cleanup will retry", { id });
        }
      }
    } finally {
      this.cleaning = false;
    }
  }
  videoPath(id: string) {
    return join(this.dir, id, "video.mp4");
  }
  private async makeVideo(id: string, result: TaskResult) {
    const dir = join(this.dir, id);
    await mkdir(dir, { recursive: true });
    try {
      await access(this.videoPath(id));
      return;
    } catch {}
    for (let i = 0; i < result.frames.length; i++) {
      const file = join(dir, String(i).padStart(3, "0") + ".png");
      await writeFile(
        file,
        await this.client.readAsset(result.frames[i].imageAsset),
        { mode: 0o600 },
      );
    }
    await run(
      "ffmpeg",
      [
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-framerate",
        String(FPS),
        "-i",
        join(dir, "%03d.png"),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        join(dir, "video.partial.mp4"),
      ],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    const { rename } = await import("node:fs/promises");
    await rename(join(dir, "video.partial.mp4"), this.videoPath(id));
    for (let i = 0; i < result.frames.length; i++)
      await rm(join(dir, String(i).padStart(3, "0") + ".png"));
  }
}
