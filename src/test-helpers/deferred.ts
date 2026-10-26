import { vi } from "vitest"

/**
 * A promise whose resolve/reject handles are exposed so tests can drive
 * completion timing manually. Essential for race/abort/concurrency tests
 * where we need to pause a long-running operation at a specific await point.
 */
export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  settled: boolean
}

export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  const d: Deferred<T> = {
    promise,
    resolve: (v) => {
      if (d.settled) return
      d.settled = true
      resolve(v)
    },
    reject: (e) => {
      if (d.settled) return
      d.settled = true
      reject(e)
    },
    settled: false,
  }
  return d
}

/**
 * Yield to the microtask queue so pending .then / await continuations run.
 * Use after triggering an async operation you want to observe mid-flight.
 */
export async function flushMicrotasks(ticks: number = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve()
  }
}

/**
 * Yield to the event loop (macrotasks) so real I/O promises (fs.writeFile,
 * network, etc.) get a chance to settle. Use after triggering an async
 * operation backed by libuv rather than pure promise continuations.
 */
export async function flushIO(ticks: number = 3): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/**
 * Wait until `predicate()` returns true, or throw after `maxAttempts`.
 * Yields the event loop between attempts so real I/O can land.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  maxAttempts: number = 100,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`waitFor: predicate never became true after ${maxAttempts} attempts`)
}

export interface WaitUntilOptions {
  /** How long to wait, in milliseconds. */
  timeout?: number
  /** How long to sleep between two checks, in milliseconds. */
  interval?: number
}

/**
 * Wait until `predicate()` returns true, by time: a check every `interval` ms (5 by default), for at most `timeout` ms
 * (5000 by default). Use it when real I/O runs (a real temporary folder, the libuv thread pool). `waitFor` counts turns
 * of the event loop, and 5000 turns of an idle loop take only tens of milliseconds, so on a busy machine the I/O is
 * not done when the count ends. A predicate that throws counts as false; at the timeout the wait rejects with the
 * error that the last check threw, or with a message that says how long it waited.
 */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeout = 5000, interval = 5 }: WaitUntilOptions = {},
): Promise<void> {
  await vi.waitFor(
    async () => {
      if (!(await predicate())) throw new Error(`waitUntil: the condition was not true within ${timeout} ms`)
    },
    { timeout, interval },
  )
}
