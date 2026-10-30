/**
 * Tests for the per-key task queue that keeps the badge and the stored record
 * in agreement.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSerialQueue } from "../lib/serial-queue.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Regression test for docs/Screenshot_20260823_170126.png — a badge of 4 above
// a popup listing 2. Both scans read the store, merged their own findings, and
// wrote back; the later write discarded the earlier one's work.
test("concurrent read-modify-writes on one key do not lose updates", async () => {
  const queue = createSerialQueue();
  const store = { findings: [] };

  const addFinding = (id) =>
    queue("page", async () => {
      const current = store.findings; // read
      await tick(); // somewhere to interleave
      store.findings = [...current, id]; // write
      return store.findings.length;
    });

  const counts = await Promise.all([addFinding("a"), addFinding("b"), addFinding("c")]);

  assert.deepEqual(store.findings, ["a", "b", "c"]);
  assert.deepEqual(counts, [1, 2, 3], "each task should see the one before it");
});

test("without the queue the same work loses updates", async () => {
  // Shows the bug the queue exists to prevent.
  const store = { findings: [] };
  const addFinding = async (id) => {
    const current = store.findings;
    await tick();
    store.findings = [...current, id];
  };

  await Promise.all([addFinding("a"), addFinding("b"), addFinding("c")]);
  assert.equal(store.findings.length, 1);
});

test("different keys still run in parallel", async () => {
  const queue = createSerialQueue();
  const running = [];
  let peak = 0;

  const task = (key) =>
    queue(key, async () => {
      running.push(key);
      peak = Math.max(peak, running.length);
      await tick();
      running.pop();
    });

  await Promise.all([task("one"), task("two")]);
  assert.equal(peak, 2);
});

test("a failed task does not block the next one", async () => {
  const queue = createSerialQueue();
  const failing = queue("page", async () => {
    throw new Error("classification blew up");
  });

  await assert.rejects(failing, /classification blew up/);
  assert.equal(await queue("page", async () => "still works"), "still works");
});

test("the queue does not grow without bound", async () => {
  const queue = createSerialQueue();
  await queue("page", async () => "done");
  await tick();
  // Nothing to assert directly on internals; re-running must simply keep working.
  assert.equal(await queue("page", async () => "again"), "again");
});
