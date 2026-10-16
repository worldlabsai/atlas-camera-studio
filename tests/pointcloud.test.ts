import test from "node:test";
import assert from "node:assert/strict";
import { Color, SRGBColorSpace } from "three";
import { srgbByteToLinear } from "../src/pointcloud";

test("sRGB vertex color conversion keeps black and white exact", () => {
  assert.equal(srgbByteToLinear(0), 0);
  assert.equal(srgbByteToLinear(255), 1);
});

test("sRGB vertex color conversion matches Three's Color SRGBToLinear", () => {
  const channel = new Color();
  for (const byte of [1, 26, 74, 128, 179, 203, 251]) {
    channel.setRGB(byte / 255, byte / 255, byte / 255, SRGBColorSpace);
    assert.ok(
      Math.abs(srgbByteToLinear(byte) - channel.r) < 1e-7,
      `byte ${byte} should convert like THREE.Color sRGBToLinear`,
    );
  }
});

test("midtone sRGB values decode to darker linear values", () => {
  // 128/255 would be naive; the sRGB gamma curve must land well below it.
  const linear = srgbByteToLinear(128);
  assert.ok(linear > 0 && linear < 0.5, `got ${linear}`);
  assert.ok(Math.abs(linear - 0.2158605) < 1e-4);
});

test("sRGB vertex color conversion is monotonic across the 8-bit range", () => {
  let previous = -1;
  for (let byte = 0; byte < 256; byte += 1) {
    const linear = srgbByteToLinear(byte);
    assert.ok(linear >= previous, `value dropped at byte ${byte}`);
    assert.ok(Number.isFinite(linear));
    previous = linear;
  }
});

test("sRGB vertex color conversion clamps out-of-range input", () => {
  assert.equal(srgbByteToLinear(-12), 0);
  assert.equal(srgbByteToLinear(300), 1);
});
