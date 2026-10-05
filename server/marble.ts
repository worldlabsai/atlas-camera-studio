import type { Asset, TaskResult } from "./contracts.ts";
const base = (
  process.env.WLT_API_BASE_URL || "https://api.atlas-beta.worldlabs.ai/api/v2"
).replace(/\/$/, "");
export class ApiFailure extends Error {
  constructor(
    message: string,
    public terminal: boolean,
    public status: number = 503,
  ) {
    super(message);
  }
}
export type Operation = {
  id: string;
  done?: boolean;
  error?: { message?: string; code?: string };
  response?: TaskResult;
};
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
) {
  if (!process.env.WLT_API_KEY)
    throw new ApiFailure("The Marble API key is not configured.", true);
  let response: Response;
  try {
    response = await fetch(base + path, {
      method,
      headers: {
        "WLT-Api-Key": process.env.WLT_API_KEY,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
      redirect: "error",
    });
  } catch {
    throw new ApiFailure(
      "Marble is temporarily unreachable. This job will retry safely.",
      false,
    );
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const terminal =
      response.status >= 400 &&
      response.status < 500 &&
      ![404, 408, 409, 429].includes(response.status);
    throw new ApiFailure(
      terminal
        ? "Marble could not accept this request. Please check your API access or input."
        : "Marble is busy. This job will retry safely.",
      terminal,
      response.status,
    );
  }
  return data;
}
export const submit = (
  task: string,
  body: unknown,
  key: string,
): Promise<Operation> => request("/tasks:" + task, "POST", body, key);
export const operation = (id: string): Promise<Operation> =>
  request("/operations/" + encodeURIComponent(id));
export async function readAsset(asset: Asset): Promise<Buffer> {
  let url = asset.url;
  if (asset.assetId) {
    const fresh = await request(
      "/assets/" + encodeURIComponent(asset.assetId) + ":createReadUrl",
      "POST",
      {},
    );
    url = fresh.url ?? fresh.readUrl;
  }
  if (!url)
    throw new ApiFailure("The generated media is not available yet.", false);
  const target = new URL(url);
  if (target.protocol !== "https:" || target.username || target.password)
    throw new ApiFailure("Unsupported media URL.", true);
  const response = await fetch(target, {
    signal: AbortSignal.timeout(60000),
    redirect: "error",
  });
  if (!response.ok)
    throw new ApiFailure(
      "Unable to download generated media.",
      false,
      response.status,
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) throw new ApiFailure("Empty media response.", false);
  for await (const chunk of response.body as any) {
    size += chunk.length;
    if (size > 25 * 1024 * 1024) {
      await response.body.cancel().catch(() => {});
      throw new ApiFailure("Media exceeds the size limit.", true);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
