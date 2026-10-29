/**
 * A generic fixed-capacity ring buffer.
 *
 * Keeps at most `capacity` items. When full, pushing a new item overwrites the
 * oldest one. `toArray()` returns the items in insertion order, oldest first.
 */
export class RingBuffer<T> {
  private readonly buffer: Array<T | undefined>;
  private readonly _capacity: number;
  /** Index at which the next item will be written. */
  private writeIndex = 0;
  /** Number of items currently stored (never exceeds capacity). */
  private _size = 0;

  /**
   * @param capacity Maximum number of items retained. Must be a positive integer.
   */
  constructor(capacity = 500) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('RingBuffer capacity must be a positive integer');
    }
    this._capacity = capacity;
    this.buffer = new Array<T | undefined>(capacity);
  }

  /** Maximum number of items this buffer retains. */
  get capacity(): number {
    return this._capacity;
  }

  /** Number of items currently stored. */
  get size(): number {
    return this._size;
  }

  /**
   * Append an item. If the buffer is full, the oldest item is dropped.
   */
  push(item: T): void {
    this.buffer[this.writeIndex] = item;
    this.writeIndex = (this.writeIndex + 1) % this._capacity;
    if (this._size < this._capacity) {
      this._size += 1;
    }
  }

  /**
   * Return a snapshot of stored items, ordered oldest-to-newest.
   */
  toArray(): T[] {
    const out: T[] = [];
    // The oldest item is at writeIndex when full, otherwise at index 0.
    const start = this._size === this._capacity ? this.writeIndex : 0;
    for (let i = 0; i < this._size; i += 1) {
      const idx = (start + i) % this._capacity;
      out.push(this.buffer[idx] as T);
    }
    return out;
  }

  /** Remove all items. */
  clear(): void {
    this.buffer.fill(undefined);
    this.writeIndex = 0;
    this._size = 0;
  }
}
