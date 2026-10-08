import { readFileSync } from "node:fs";
import { cameraSchema, type Frame } from "./contracts.ts";

// Bundled bytes work with any API project, including a locally hosted fork.
// Never accept a client-supplied URL or reuse a private user's pose job here.
export function exampleFrame(): Frame {
  const dir = new URL("../public/example/", import.meta.url);
  const metadata = JSON.parse(readFileSync(new URL("igloo.json", dir), "utf8"));
  return {
    camera: cameraSchema.parse(metadata.camera),
    imageAsset: {
      base64:
        "data:image/jpeg;base64," +
        readFileSync(new URL("igloo.jpg", dir)).toString("base64"),
    },
    depth: {
      depthAsset: {
        base64:
          "data:image/x-exr;base64," +
          readFileSync(new URL("igloo.exr", dir)).toString("base64"),
      },
    },
  };
}
