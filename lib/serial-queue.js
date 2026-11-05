//Runs tasks one at a time per key.

export function createSerialQueue() {
  const tails = new Map();

  return function run(key, task) {
    const previous = tails.get(key) ?? Promise.resolve();
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
