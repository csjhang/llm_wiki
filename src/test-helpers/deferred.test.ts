import { describe, expect, it } from "vitest"
import { waitFor, waitUntil } from "./deferred"

// Final review, I4: a wait that counts turns of the event loop is too short when real file I/O runs on a busy
// machine. `waitUntil` waits by time.
describe("waitUntil", () => {
  it("resolves at once when the condition is true", async () => {
    await expect(waitUntil(() => true)).resolves.toBeUndefined()
  })

  it("waits by time: a condition that turns true after real time passed is found", async () => {
    let ready = false
    setTimeout(() => {
      ready = true
    }, 80)
    // Many turns of the event loop pass in 80 ms. The wait must not count them.
    await waitUntil(() => ready, { timeout: 2000, interval: 5 })
    expect(ready).toBe(true)
  })

  it("takes a condition that is async", async () => {
    const started = Date.now()
    await waitUntil(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return Date.now() - started > 40
    })
  })

  it("rejects after the timeout, and says how long it waited", async () => {
    const started = Date.now()
    await expect(waitUntil(() => false, { timeout: 60, interval: 5 })).rejects.toThrow(/not true within 60 ms/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(50)
  })

  it("keeps trying while the condition throws, and rejects with its error at the end", async () => {
    let calls = 0
    await waitUntil(() => {
      calls += 1
      if (calls < 3) throw new Error("not readable yet")
      return true
    })
    expect(calls).toBe(3)
    await expect(
      waitUntil(
        () => {
          throw new Error("never readable")
        },
        { timeout: 40, interval: 5 },
      ),
    ).rejects.toThrow(/never readable/)
  })

  it("does not change waitFor, which the tests with a fake file system still use", async () => {
    let turns = 0
    await waitFor(() => ++turns >= 3)
    expect(turns).toBe(3)
  })
})
