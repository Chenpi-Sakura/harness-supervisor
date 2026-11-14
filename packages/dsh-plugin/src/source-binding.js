/** Serialize connection replacement; cancellation never stops a daemon or Worker. */
export function createSourceBinding(mount) {
  let current, generation = 0, disposed = false, queue = Promise.resolve();
  let closing;
  const closeCurrent = () => {
    if (!current) return Promise.resolve();
    if (!closing) {
      const fiber = current;
      closing = Promise.resolve().then(() => fiber.dispose()).then(() => {
        if (current === fiber) current = undefined;
      }).finally(() => { closing = undefined; });
    }
    return closing;
  };
  return {
    update(config) {
      if (disposed) return Promise.resolve();
      const ticket = ++generation;
      const closed = closeCurrent().then(() => null, error => ({ error }));
      queue = queue.catch(() => {}).then(async () => {
        const failure = await closed;
        if (failure) throw failure.error;
        if (disposed || ticket !== generation) return;
        const fiber = mount(config);
        current = fiber;
        try { await fiber; }
        catch (error) { if (current === fiber) await closeCurrent(); throw error; }
        if ((disposed || ticket !== generation) && current === fiber) await closeCurrent();
      });
      return queue;
    },
    async dispose() {
      disposed = true; generation++;
      const closed = closeCurrent().then(() => null, error => ({ error }));
      await queue.catch(() => {});
      const failure = await closed;
      if (failure) throw failure.error;
    },
  };
}
