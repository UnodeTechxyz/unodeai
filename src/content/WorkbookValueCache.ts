/** A cache size is an eviction policy, never an input/value limit. The newest value always remains usable. */
export class WorkbookValueCache<T> {
  private readonly entries = new Map<number, { value: T; size: number }>(); private size = 0;
  constructor(private readonly budget = 1024 * 1024) {}
  get(key: number, load: () => T | undefined): T | undefined {
    const old = this.entries.get(key);
    if (old) { this.entries.delete(key); this.entries.set(key, old); return old.value; }
    const value = load(); if (value === undefined) return undefined;
    const size = JSON.stringify(value).length; this.entries.set(key, { value, size }); this.size += size;
    for (const [id, item] of this.entries) {
      if (this.size <= this.budget || this.entries.size <= 1) break; this.entries.delete(id); this.size -= item.size;
    }
    return value;
  }
}
