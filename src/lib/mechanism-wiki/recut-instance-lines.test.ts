/**
 * Contract between the fusion step and the recut: the lines that `instanceDomainsOf` reads as instance domains are
 * the lines that `rewriteInstanceLines` of `wiki-tool recut` rewrites (ruling U4). After a rewrite, the fusion reader
 * must see the new domains and no old one. Domains and slugs are placeholders.
 */
import { describe, expect, it, vi } from "vitest"
import { rewriteInstanceLines } from "./recut-instance-lines"

// fusion-candidates.ts reads files through the Tauri bridge; this test reads no file.
vi.mock("@/commands/fs", () => ({ readFile: vi.fn(), writeFileAtomic: vi.fn() }))

import { instanceDomainsOf } from "./fusion-candidates"

/** Each page with the number of lines that the rewrite changes when `example/alpha` becomes `example/gamma`. */
const PAGES: Record<string, { page: string; changed: number }> = {
  english: {
    page: "# M\n\n## Parts\n- [[x]] (example/alpha): not an instance\n\n## Known instances\n\n- [[a]] (example/alpha): t\n- [[b]] (example/beta): u\n",
    changed: 1,
  },
  "traditional Chinese": { page: "# M\n\n## 已知實例：\n- [[a]] (example/alpha): 詞\n* [[c]] (example/alpha/child): 詞\n", changed: 2 },
  "simplified Chinese": { page: "# M\r\n\r\n## 已知实例\r\n+ ![[a]] (example/alpha): 词\r\n", changed: 1 },
  "no section": { page: "# M\n\n- [[a]] (example/alpha): t\n", changed: 0 },
  "odd spacing": { page: "## known INSTANCES\n  -   [[a|Alias]]  (  example/alpha  ) : t\n- [[b#Part]](example/beta): u\n", changed: 1 },
}

describe("instance lines: fusion reader and recut rewriter", () => {
  const map = (domain: string): string => (domain.startsWith("example/alpha") ? domain.replace("example/alpha", "example/gamma") : domain)

  for (const [name, { page, changed }] of Object.entries(PAGES)) {
    it(`agree on the ${name} page`, () => {
      const before = instanceDomainsOf(page)
      const result = rewriteInstanceLines(page, (domain) => map(domain))
      expect(instanceDomainsOf(result.text)).toEqual([...new Set(before.map(map))])
      expect(result.changed).toBe(changed)
    })
  }
})
