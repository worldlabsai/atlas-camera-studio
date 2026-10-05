# Marble Camera Studio

Turn a still image into a camera-controlled shot with the Marble 5 API. Upload a photo, reconstruct its depth, choose a camera path, and generate a four-second MP4.

This repository contains the complete React editor, Express server, camera math, job runner, and optional hosted-demo billing. The local version uses your own API key. Hosted mode adds Clerk phone verification and one-time Stripe credit packs; there is no Metronome dependency.

## Run locally

You need Node.js 22.12+ (Node 24 recommended), FFmpeg on your PATH, and an API-enabled World Labs beta account.

1. Clone this repository and run `npm ci`.
2. Copy `.env.example` to `.env`.
3. Add your project API key as `WLT_API_KEY`.
4. Run `npm run build && npm start`.
5. Open [localhost:3030](http://localhost:3030), upload a JPG, PNG or WebP, and choose **Build scene depth**.

The editor crops inputs to 16:9. Use the depth preview to set waypoints or select a preset, then generate 48 frames at 12 FPS. MP4 encoding runs locally using FFmpeg.

For development, run `npm run dev` and `npx vite` in separate terminals. The Vite app proxies API requests to port 3030.

### Get an API key

Join the [World Labs beta waitlist](https://worldlabs.ai/waitlist) if you don't already have access. Signing up requests access; it does not immediately issue a key.

After your account is enabled, open the [developer portal](https://atlas-beta.worldlabs.ai/developers), select a project, and create an API key with task creation, operation reading, and asset creation/reading permissions. Keep the key in the server's `.env`; never paste it into frontend source or commit it.

The API is currently served from `https://api.atlas-beta.worldlabs.ai/api/v2`. See the [API quickstart](https://atlas-beta.worldlabs.ai/docs/quickstart) for current access and setup details. API charges are billed to the project that owns your key.

## How it works

1. The browser resizes the image to 1280 × 720.
2. The server calls `tasks:images2PosedRGBD` and polls the returned operation.
3. The editor decodes the EXR depth map and reconstructs a colored point cloud.
4. Position interpolation and quaternion SLERP produce 48 target cameras.
5. The server calls `tasks:atlasGenerate`, downloads the frames, and encodes an MP4.

The preview is a point cloud used to plan the camera. Generated views can reveal details that are absent from the original image.

## Host a demo

See [hosted setup](docs/hosting.md). Hosted mode requires verified phone ownership before preparing images or generating. Each phone can claim three free generations once, even across accounts. The default pack is three additional generations for $5, purchased once through Stripe Checkout.

Credits are reserved before generation and returned on terminal failure. Duplicate webhooks and repeated job requests do not double-credit or double-charge. Interrupted workers resume stored operation IDs.

Local mode has no authentication or paywall and binds to loopback only. Use hosted mode for any shared deployment.

## Verify changes

```sh
npm run typecheck
npm test
npm run build
```

Tests exercise camera transforms, ledger concurrency, payment validation, refunds, and job recovery. They do not replace a real Stripe Checkout, SMS verification, and Marble API smoke test before deployment.

## License and credits

MIT. Inspired by Gowthami's camera-trajectory prototype at World Labs. Built with Three.js, React Three Fiber, Clerk, Stripe, and FFmpeg. World Labs API usage is subject to the service's own terms and charges.
