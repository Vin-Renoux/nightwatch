/**
 * Runs tasks one at a time per key.
 *
 * Two scans of the same page can land together — a load scan and a mutation
 * rescan, say. Each would read the stored record, merge its own findings, and
 * write the result back, so whichever wrote last silently discarded the
 * other's work. The badge (set by one scan) then disagreed with the popup
 * (reading what the other wrote): docs/Screenshot_20260823_170126.png shows a
 * badge of 4 above a popup listing 2.
 *
 * Keyed rather than global so scans of different pages still run in parallel.
 */
export function createSerialQueue() {
  const tails = new Map();

  return function run(key, task) {
    const previous = tails.get(key) ?? Promise.resolve();
    // Run the task whether or not the one before it failed.
    const result = previous.then(task, task);

    const settled = result.then(
      () => {},
      () => {},
    );
    tails.set(key, settled);
    settled.then(() => {
      if (tails.get(key) === settled) tails.delete(key);
    });

    return result;
  };
}
