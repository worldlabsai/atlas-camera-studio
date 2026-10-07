import { z } from "zod";
export const FRAMES = 48;
export const FPS = 12;
export const PACK_CREDITS = 3;
export const PACK_CENTS = 500;
export const CREDIT_PACKS = [
  { id: "starter", credits: 3, priceCents: 500, quantity: 1 },
  { id: "bulk", credits: 12, priceCents: 2000, quantity: 4 },
  { id: "studio", credits: 60, priceCents: 10000, quantity: 20 },
] as const;
export const checkoutSchema = z
  .object({
    packId: z.enum(["starter", "bulk", "studio"]).default("starter"),
  })
  .strict();
export function checkoutPack(input: unknown) {
  const { packId } = checkoutSchema.parse(input);
  return CREDIT_PACKS.find((pack) => pack.id === packId)!;
}
const finite = z.number().finite();
export const cameraSchema = z
  .object({
    intrinsics: z
      .object({
        width: z.literal(1280),
        height: z.literal(720),
        fx: finite.min(100).max(10000),
        fy: finite.min(100).max(10000),
        cx: finite.min(0).max(1280),
        cy: finite.min(0).max(720),
      })
      .strict(),
    extrinsics: z
      .object({
        position: z.tuple([
          finite.min(-10000).max(10000),
          finite.min(-10000).max(10000),
          finite.min(-10000).max(10000),
        ]),
        quaternion: z
          .tuple([finite, finite, finite, finite])
          .refine(
            (q) => Math.abs(Math.hypot(...q) - 1) < 0.001,
            "Quaternion must have unit length",
          ),
        coordinateSystem: z.enum(["rub", "rdf"]),
      })
      .strict(),
  })
  .strict();
export const poseSchema = z
  .object({
    key: z.uuid(),
    image: z
      .object({
        base64: z
          .string()
          .min(4)
          .max(6_000_000)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/),
        mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      })
      .strict(),
  })
  .strict();
export const generateSchema = z
  .object({
    key: z.uuid(),
    poseJobId: z.uuid(),
    cameras: z.array(cameraSchema).length(FRAMES),
    prompt: z.string().max(2000).default(""),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 31 - 1)
      .default(42),
  })
  .strict();
export type Camera = z.infer<typeof cameraSchema>;
export type Asset = { assetId?: string; url?: string };
export type Frame = {
  camera: Camera;
  imageAsset: Asset;
  depth?: { depthAsset: Asset };
};
export type TaskResult = {
  frames: Frame[];
  videoReady?: boolean;
  promptUsed?: string;
};
