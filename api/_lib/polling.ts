// Cron invokes once a minute. Keep a bounded serial worker alive for its second
// check; never detach work after response or recurse into deployment HTTP URLs.
export async function runPollingWindow<T>(run: () => Promise<T>, now = Date.now,
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
  const startedAt = now();
  const first = await run();
  // Lock acquisition/storage reads can move actual start past handler start.
  const actualStart = first && typeof first === 'object' && 'lastAttempt' in first &&
    typeof first.lastAttempt === 'number' ? Math.max(startedAt, first.lastAttempt) : startedAt;
  const wait = actualStart + 30000 - now();
  if (wait > 0) await sleep(wait);
  // A slow first check is not overlapped or interrupted to manufacture cadence.
  const second = await run();
  return { targetIntervalSeconds: 30, checks: [first, second] };
}
