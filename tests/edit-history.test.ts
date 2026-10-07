import { it } from "node:test";
import assert from "node:assert/strict";
import { EditHistory } from "../src/trajectory/edit-history.ts";

it("undoes an entire camera drag and redoes its final position", () => {
  const history = new EditHistory(0);
  history.record(1, 1);
  history.record(2, 1);
  history.record(3, 1);
  assert.equal(history.undo(), 0);
  assert.equal(history.canUndo, false);
  assert.equal(history.redo(), 3);
});
it("keeps separate gestures and clears redo after a new edit", () => {
  const history = new EditHistory(0);
  history.record(1, 1);
  history.record(2, 2);
  assert.equal(history.undo(), 1);
  history.record(4, 3);
  assert.equal(history.canRedo, false);
  assert.equal(history.undo(), 1);
  assert.equal(history.undo(), 0);
});
it("canceled and unchanged gestures create no undo entry", () => {
  const history = new EditHistory(0);
  history.record(0, 1);
  history.record(5, 1);
  history.record(0, 1);
  assert.equal(history.canUndo, false);
});
it("bounds retained edits and restores complete path and aim snapshots", () => {
  const original = {
    points: [0, 1, 2],
    target: null as number | null,
    closed: false,
  };
  const history = new EditHistory(original, Object.is, 2);
  history.record({ points: [0, 2], target: null, closed: false });
  history.record({ points: [0, 2], target: 9, closed: false });
  history.record({ points: [0, 2, 4], target: 9, closed: true });
  assert.deepEqual(history.undo(), {
    points: [0, 2],
    target: 9,
    closed: false,
  });
  assert.deepEqual(history.undo(), {
    points: [0, 2],
    target: null,
    closed: false,
  });
  assert.equal(history.undo(), null);
});
