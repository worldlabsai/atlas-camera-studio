import test from "node:test";
import assert from "node:assert/strict";
import { scrubNumber } from "../src/trajectory/numeric-scrub";

test("dragging adjusts position with coarse and fine increments", () => {
  assert.equal(scrubNumber(2, 30, 0.01, false), 2.3);
  assert.equal(scrubNumber(2, 30, 0.01, true), 2.03);
});
test("changing to fine mode continues from the current value", () => {
  const coarse = scrubNumber(0, 100, 0.01, false);
  assert.equal(scrubNumber(coarse, 10, 0.01, true), 1.01);
});
test("clamping stops at the floor and reversing responds immediately", () => {
  const floor = scrubNumber(0.1, -50, 0.01, false, 0);
  assert.equal(floor, 0);
  assert.equal(scrubNumber(floor, 1, 0.01, false, 0), 0.01);
  assert.equal(scrubNumber(88, 20, 0.5, false, -89, 89), 89);
});

test("fine drags do not accumulate rounding error across pointer events", () => {
  let value = 0;
  for (let i = 0; i < 8; i++) value = scrubNumber(value, 2.5, 0.01, true);
  assert.ok(Math.abs(value - scrubNumber(0, 20, 0.01, true)) < 1e-12);
});
