import { RingBuffer } from './ringBuffer';
import type { IngestPayload, LogEvent } from './types';

/** A subscriber callback invoked with each published event on a channel. */
export type Subscriber = (event: LogEvent) => void;

/** Handle returned by {@link LogHub.subscribe}; call it to unsubscribe. */
export type Unsubscribe = () => void;

/**
 * Central fan-out hub.
 *
 * Maintains a per-channel ring buffer of recent events and a per-channel set of
 * subscribers. Publishing an event stores it in the channel's buffer, assigns a
 * sequence number and timestamp if missing, and delivers it to all subscribers
 * of that channel.
 */
export class LogHub {
  private readonly buffers = new Map<string, RingBuffer<LogEvent>>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly capacity: number;
  private nextSeq = 0;

  /**
   * @param capacity Ring buffer capacity per channel (default 500).
   */
  constructor(capacity = 500) {
    this.capacity = capacity;
  }

  private bufferFor(channel: string): RingBuffer<LogEvent> {
    let buffer = this.buffers.get(channel);
    if (!buffer) {
      buffer = new RingBuffer<LogEvent>(this.capacity);
      this.buffers.set(channel, buffer);
    }
    return buffer;
  }

  /**
   * Publish an event to its channel.
   *
   * Assigns a monotonic `seq` and, if not supplied, a `ts`. Stores the event in
   * the channel's ring buffer and fans it out to all current subscribers.
   *
   * @returns The fully-formed, stored event.
   */
  publish(payload: IngestPayload): LogEvent {
    const event: LogEvent = {
      channel: payload.channel,
      level: payload.level,
      message: payload.message,
      ...(payload.meta !== undefined ? { meta: payload.meta } : {}),
      ts: payload.ts ?? Date.now(),
      seq: this.nextSeq,
    };
    this.nextSeq += 1;

    this.bufferFor(event.channel).push(event);

    const subs = this.subscribers.get(event.channel);
    if (subs) {
      // Snapshot to tolerate subscribers that unsubscribe during delivery.
      for (const fn of [...subs]) {
        fn(event);
      }
    }

    return event;
  }

  /**
   * Return the recent events for a channel, oldest-to-newest.
   *
   * A channel that has never received an event returns an empty array.
   */
  history(channel: string): LogEvent[] {
    const buffer = this.buffers.get(channel);
    return buffer ? buffer.toArray() : [];
  }

  /**
   * Subscribe to live events on a channel.
   *
   * @returns An unsubscribe handle. Calling it removes the subscriber.
   */
  subscribe(channel: string, fn: Subscriber): Unsubscribe {
    let subs = this.subscribers.get(channel);
    if (!subs) {
      subs = new Set<Subscriber>();
      this.subscribers.set(channel, subs);
    }
    subs.add(fn);

    return () => {
      const current = this.subscribers.get(channel);
      if (!current) return;
      current.delete(fn);
      if (current.size === 0) {
        this.subscribers.delete(channel);
      }
    };
  }

  /** Number of active subscribers on a channel. */
  subscriberCount(channel: string): number {
    return this.subscribers.get(channel)?.size ?? 0;
  }

  /** Names of channels that currently have a ring buffer. */
  channels(): string[] {
    return [...this.buffers.keys()];
  }
}
