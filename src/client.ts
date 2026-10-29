/**
 * A tiny, dependency-free producer helper.
 *
 * Producers construct a LogClient with the server base URL and a target
 * channel, then call log()/debug()/info()/warn()/error() to emit events. Each
 * call POSTs a JSON payload to `${baseUrl}/ingest` using the global `fetch`
 * (available in Node 18+ and in browsers), so this file can be copied as-is
 * into any producer with no extra dependencies.
 */

/** Options accepted by {@link LogClient}. */
export interface LogClientOptions {
  /** Base URL of the streaming server, e.g. "http://localhost:4000". */
  baseUrl: string;
  /** Channel to which this client publishes. */
  channel: string;
}

/** Shape of the payload POSTed to the ingest endpoint. */
interface IngestBody {
  channel: string;
  level: string;
  message: string;
  meta?: Record<string, unknown>;
  ts?: number;
}

export class LogClient {
  private readonly baseUrl: string;
  private readonly channel: string;

  constructor(options: LogClientOptions) {
    // Normalize trailing slash so `${baseUrl}/ingest` is always well-formed.
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.channel = options.channel;
  }

  /**
   * Emit a log event at the given level.
   *
   * @returns A promise that resolves once the server has accepted the event.
   */
  async log(level: string, message: string, meta?: Record<string, unknown>): Promise<void> {
    const body: IngestBody = {
      channel: this.channel,
      level,
      message,
      ts: Date.now(),
    };
    if (meta !== undefined) {
      body.meta = meta;
    }

    const response = await fetch(`${this.baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`ingest failed: ${response.status} ${response.statusText}`);
    }
  }

  debug(message: string, meta?: Record<string, unknown>): Promise<void> {
    return this.log('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): Promise<void> {
    return this.log('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): Promise<void> {
    return this.log('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): Promise<void> {
    return this.log('error', message, meta);
  }
}
