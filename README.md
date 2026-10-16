# Atlas Camera Studio

[Try the hosted app](https://camera.wlt-ai.art) · [Explore an example — no signup](https://camera.wlt-ai.art/?example=igloo) · [Join the API beta waitlist](https://form.typeform.com/to/zHFR4r3A) · [API quickstart](https://atlas-beta.worldlabs.ai/docs/quickstart)

Turn a still image into a camera-controlled shot with the Marble 5 API. Upload a photo, reconstruct its depth, choose a camera path, and generate a four-second MP4.

Based on the original camera-trajectory editor created by [Gowthami Somepalli (@somepago)](https://github.com/somepago) at World Labs.

This repository contains the complete React editor, Express server, camera math, job runner, and optional hosted-demo billing. The local version uses your own API key. Hosted mode adds Clerk phone verification and one-time Stripe credit packs; there is no Metronome dependency.

![Keyframe a camera move in the 3D editor](docs/editor-light.png)

## Example videos

Two camera-controlled videos shared by Jos. Click a preview to open the full MP4; the original files are included in [`examples/`](examples/).

### Original camera demo

[![Generated camera move around a group seated indoors](examples/original-camera-demo.gif)](examples/original-camera-demo.mp4)

The video from Jos's [“what did Ilya see?” post](https://x.com/JosvdWest/status/2094859846982275213). This earlier demo is supplied at 2560 × 1440, 30 FPS, four seconds. [Download MP4](https://github.com/worldlabsai/atlas-camera-studio/raw/refs/heads/main/examples/original-camera-demo.mp4).

### Holographic fish orbit

[![Camera orbit around holographic fish above a city](examples/holographic-fish-orbit.gif)](examples/holographic-fish-orbit.mp4)

Prompt: **“camera orbits around holographic fish”**. Generated with Camera Studio: 1280 × 720, 48 frames at 12 FPS, seed 42. [Download MP4](https://github.com/worldlabsai/atlas-camera-studio/raw/refs/heads/main/examples/holographic-fish-orbit.mp4).

The current app produces four-second videos at 12 FPS. These are output examples; the original source images and saved camera paths are not included.

## Explore without signing up

Choose **Explore an example** to open a prepared igloo scene with an editable camera move. Pilot the camera, set and retime keys, and preview the move without an account or API key. The public image, EXR depth, and camera metadata are bundled in [`public/example/`](public/example/); no API task runs while you explore.

On the hosted app, sign in and verify a phone number when you want to **Generate video** or prepare your own image. Your example edits stay in the tab through sign-in. Generating the example uses the same credits and limits as any other video. A local fork sends the bundled scene with your own API key; it does not depend on our private asset IDs.

## Run locally

You need Node.js 22.12+ (Node 24 recommended), FFmpeg on your PATH, and an API-enabled World Labs beta account.

1. Clone this repository and run `npm ci`.
2. Copy `.env.example` to `.env`.
3. Add your project API key as `WLT_API_KEY`.
4. Run `npm run build && npm start`.
5. Open [localhost:3030](http://localhost:3030), upload a JPG, PNG or WebP, to prepare its 3D scene.

The editor crops inputs to 16:9. Set a few keyframes for the shot camera, preview the move, and choose **Generate video**. Each video contains 48 frames at 12 FPS. MP4 encoding runs locally using FFmpeg.

**Cmd/Ctrl-Z** undoes an edit; **Cmd/Ctrl-Shift-Z** redoes it. Each drag, pilot move, or sketched route is one undo step.

**Saved** contains drafts, generations, and favorites. Drafts are saved in this browser, separately for each signed-in account (up to 30 drafts), and need their source scene to remain available. Generated videos and scene data expire after seven days; download videos you want to keep.

For development, run `npm run dev` and `npx vite` in separate terminals. The Vite app proxies API requests to port 3030.

## Camera planning controls

A shot is one camera with keyframes on a 4-second timeline, the way Blender animates a camera. The editor animates the camera between keys, and generation uses exactly what the timeline plays.

**Pilot the camera** (the camera button, or **C**) turns the viewport into the shot camera. **W A S D** move, **Q**/**E** move down and up, drag or use the arrow keys to look, and hold **Shift** for fine moves. **I** (or **Set key**) records the camera at the playhead; **Escape** finishes. With **Auto key** on, every move records a key where the playhead is, and dragging the orange camera in the overview does the same. With it off, a change waits as an unkeyed pose until you set a key, and scrubbing away discards it.

A new scene starts with one key at the source camera. Jump to the end (**End**), pilot to where the shot should finish, and set a key; add a middle key anywhere for a curve. Drag diamonds on the timeline to retime keys, or type the time to the next key in seconds or frames on the Camera tab. **Even pace** spaces keys so the camera moves at a steady speed.

Motion between keys is **Smooth** (curved, easing in at the first key and out at the last), **Linear**, or **Hold**. **Settle** sets how fully the camera slows at a key. Smooth motion follows Blender's auto-clamped handles, so the camera passes through every key without overshooting it. The speed track under the keys shows where the camera speeds up, and the dots along the 3D path mark each frame.

**Aim** is **Free** (each key keeps its own pan and tilt), **Look at** (every frame faces one point you pick in the scene), or **Ahead** (faces the direction of travel). The field of view applies to the whole shot.

The **Path** tab shows a top-down plan with the scene's colors, the path colored by time, the keys with their times, and the camera's view at the playhead. Drag keys on the plan, switch to **Height** to raise or lower them, or sketch a new route that becomes evenly timed keys. **Push in**, **Pull back**, **Truck**, **Orbit**, **Crane up**, and **Arc reveal** replace the shot with three keys that start at the source camera; **Travel** sets how far they move. Undo restores your previous shot.

The camera monitor in the corner always shows the view at the playhead, including during playback. Click its corner button to enlarge it.

Drafts saved before keyframes open with their cameras converted to keys at the same moments in the move.

The editor follows your device's light or dark setting; the header button switches between device, light, and dark. On phones, the timeline sits under the viewport and the tools open in a sheet below, with on-screen move buttons while piloting.

Navigate the overview with the mouse (drag to orbit; right-drag or Shift-drag to pan) or **W A S D** and **Q**/**E**. **R** frames the scene and path. These controls move your view of the scene, not the shot camera.

The preview connects adjacent depth samples into textured surfaces wherever the depth supports them. In **Filled** mode (the default) it then fills the remaining gaps in screen space from blurred, lower-resolution copies of the cloud, so small gaps close and large ones fade out instead of showing holes. As the view moves away from the source photo's angle, points grow into soft discs and the texture fades. Gaps across depth jumps show as a faint, slowly shimmering glow in the colours on either side: the generated video fills these areas, and the preview does not pretend to know their detail. **Points** shows the raw measured samples.

### Get an API key

Join the [World Labs beta waitlist](https://form.typeform.com/to/zHFR4r3A) if you don't already have access. Signing up requests access; it does not immediately issue a key.

After your account is enabled, open the [developer portal](https://atlas-beta.worldlabs.ai/developers), select a project, and create an API key with task creation, operation reading, and asset creation/reading permissions. Keep the key in the server's `.env`; never paste it into frontend source or commit it.

The API is currently served from `https://api.atlas-beta.worldlabs.ai/api/v2`. See the [API quickstart](https://atlas-beta.worldlabs.ai/docs/quickstart) for current access and setup details. API charges are billed to the project that owns your key.

## How it works

1. The browser resizes the image to 1280 × 720.
2. The server calls `tasks:images2PosedRGBD` and polls the returned operation.
3. The editor decodes the EXR depth map and reconstructs a colored point cloud.
4. The editor smooths the drawn path and interpolates camera positions and directions into 48 target cameras.
5. The server calls `tasks:atlasGenerate`, downloads the frames, and encodes an MP4.

The preview is a point cloud used to plan the camera. Generated views can reveal details that are absent from the original image.

## Host a demo

See [hosted setup](docs/hosting.md). Hosted mode requires verified phone ownership before preparing images or generating. Each phone can claim three free generations once, even across accounts. One-time credit packs offer 3 generations for $5, 12 for $20, or 60 for $100 through Stripe Checkout.

Credits are reserved before generation and returned on terminal failure. Duplicate webhooks and repeated job requests do not double-credit or double-charge. Interrupted workers resume stored operation IDs. Job inputs and videos are kept for seven days; download finished shots before they expire.

Local mode has no authentication or paywall and binds to loopback only. Use hosted mode for any shared deployment.

## Verify changes

```sh
npm run typecheck
npm test
npm run build
```

Tests exercise the original trajectory drawing and camera math, coordinate transforms, ledger concurrency, payment validation, refunds, and job recovery. They do not replace a real Stripe Checkout, SMS verification, and Marble API smoke test before deployment.

## License and credits

MIT. The editor, drawing controls, and trajectory math are adapted from the original camera-trajectory app created by [Gowthami Somepalli (@somepago)](https://github.com/somepago) at World Labs. Built with Three.js, React Three Fiber, Clerk, Stripe, and FFmpeg. World Labs API usage is subject to the service's own terms and charges.
