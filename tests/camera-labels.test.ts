import test from "node:test";
import assert from "node:assert/strict";
import { layoutCameraLabels } from "../src/trajectory/camera-labels";

test("coincident and nearby cameras get separate number labels", () => {
  const labels = layoutCameraLabels(
    [
      { x: 100, y: 100 },
      { x: 100, y: 100 },
      { x: 104, y: 101 },
      { x: 108, y: 103 },
    ],
    400,
    300,
  );
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++)
      assert.ok(
        Math.abs(labels[i].x - labels[j].x) >= 26 ||
          Math.abs(labels[i].y - labels[j].y) >= 20,
      );
});
test("labels near the edges stay inside the viewport", () => {
  for (const label of layoutCameraLabels(
    [
      { x: 0, y: 0 },
      { x: 398, y: 299 },
    ],
    400,
    300,
  )) {
    assert.ok(label.x >= 12 && label.x <= 388);
    assert.ok(label.y >= 9 && label.y <= 291);
  }
});
test("distant cameras retain the same close label offset", () => {
  assert.deepEqual(
    layoutCameraLabels(
      [
        { x: 100, y: 100 },
        { x: 300, y: 100 },
      ],
      500,
      300,
    ),
    [
      { x: 118, y: 124 },
      { x: 318, y: 124 },
    ],
  );
});
