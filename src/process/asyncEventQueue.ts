/**
 * Minimal push/pull async queue bridging callback-style event delivery (a
 * warm worker/daemon's notification handlers) into an async generator that
 * routes/chat.ts's streaming path can `yield*` from. Shared by
 * process/claudePool.ts and process/codexAppServer.ts — both need the exact
 * same bridge, just fed by different event sources.
 */
export class AsyncEventQueue<T> {
  private items: T[] = [];
  private resolvers: ((result: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(item: T): void {
    const resolver = this.resolvers.shift();
    if (resolver) resolver({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    this.ended = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.ended) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}
