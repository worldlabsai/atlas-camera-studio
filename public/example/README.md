# Igloo example

A prepared scene for exploring Atlas Camera Studio without signing up or calling the API.

- Image: the World Labs [API examples igloo](https://github.com/worldlabsai/worldlabs-api-examples/blob/main/igloo.jpg), resized to the editor's 1280 × 720 input.
- Depth and camera: generated from that example with `images2PosedRGBD`.
- `igloo.json` contains only camera geometry and the scene centroid. It contains no account IDs, API asset IDs, signed URLs, or credentials.

The same bundled image, linear-depth EXR, and camera are used for the browser preview and for generation. A local fork can generate with its own API key. Only the public sample is accessible anonymously; uploads, jobs, and generated videos keep their normal access controls.
