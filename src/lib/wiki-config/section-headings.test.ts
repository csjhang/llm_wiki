import { describe, it, expect } from "vitest"
import {
  HYPOTHESIS_SECTIONS,
  MECHANISM_SECTIONS,
  findSection,
  headingFor,
  removeSection,
} from "./section-headings"

const PARTS = MECHANISM_SECTIONS[0]

describe("section headings", () => {
  it("has the exact mechanism keys in order", () => {
    expect(MECHANISM_SECTIONS.map((section) => section.key)).toEqual([
      "parts",
      "flows",
      "constraints",
      "why",
      "failure",
      "instances",
    ])
  })

  it("has the exact hypothesis keys in order", () => {
    expect(HYPOTHESIS_SECTIONS.map((section) => section.key)).toEqual([
      "claim",
      "mapping",
      "gaps",
      "verify",
      "search",
      "related",
    ])
  })

  it("has the exact heading text in all three variants", () => {
    expect(MECHANISM_SECTIONS.map((s) => [s.key, s.en, s.zhHant, s.zhHans])).toEqual([
      ["parts", "Parts", "組成", "组成"],
      ["flows", "Flows", "流動", "流动"],
      ["constraints", "Constraints and trade-offs", "約束與取捨", "约束与取舍"],
      ["why", "Why it works", "為什麼有效", "为什么有效"],
      ["failure", "Failure conditions", "失效條件", "失效条件"],
      ["instances", "Known instances", "已知實例", "已知实例"],
    ])
    expect(HYPOTHESIS_SECTIONS.map((s) => [s.key, s.en, s.zhHant, s.zhHans])).toEqual([
      ["claim", "One-line hypothesis", "一句話假說", "一句话假说"],
      ["mapping", "Role mapping", "角色對照表", "角色对照表"],
      ["gaps", "Gaps and impact", "套不上的部分與影響", "套不上的部分与影响"],
      ["verify", "What to verify", "要驗證的事", "要验证的事"],
      ["search", "Search keywords", "建議搜尋關鍵字", "建议搜索关键词"],
      ["related", "Related pages", "相關頁面", "相关页面"],
    ])
  })

  it("headingFor maps languages", () => {
    expect(headingFor(PARTS, "Traditional Chinese")).toBe("組成")
    expect(headingFor(PARTS, "Chinese")).toBe("组成")
    expect(headingFor(PARTS, "English")).toBe("Parts")
    expect(headingFor(PARTS, "auto")).toBe("Parts")
    expect(headingFor(PARTS, "Japanese")).toBe("Parts")
  })

  it("finds headings across language variants and spacing", () => {
    const markdown = [
      "# Title",
      "",
      "## 组成 ：",
      "Body of parts.",
      "More parts.",
      "",
      "## 流動",
      "Body of flows.",
    ].join("\n")
    expect(findSection(markdown, PARTS)).toBe("Body of parts.\nMore parts.")
    expect(findSection("##   Parts\nText.\n", PARTS)).toBe("Text.")
    expect(findSection("## Parts:\nText.\n## Flows\nOther.\n", PARTS)).toBe("Text.")
    expect(findSection("## 組成\n\nText.\n\n", PARTS)).toBe("Text.")
  })

  it("does not match a level-3 heading, and keeps level-3 headings inside the body", () => {
    expect(findSection("### 組成\nText.\n", PARTS)).toBeNull()
    expect(findSection("## 組成\nIntro.\n### Detail\nMore.\n## 流動\nNext.\n", PARTS)).toBe(
      "Intro.\n### Detail\nMore.",
    )
  })

  it("returns null for a missing section", () => {
    expect(findSection("# Title\n\n## Flows\nText.\n", PARTS)).toBeNull()
    expect(findSection("", PARTS)).toBeNull()
  })

  it("returns an empty string for a heading with no body", () => {
    expect(findSection("## Parts\n## Flows\nText.\n", PARTS)).toBe("")
  })

  it("matches the English heading in any letter case, and keeps CJK matching exact", () => {
    const WHY = MECHANISM_SECTIONS[3]
    const CONSTRAINTS = MECHANISM_SECTIONS[2]
    expect(findSection("## Why It Works\nText.\n", WHY)).toBe("Text.")
    expect(findSection("## WHY IT WORKS:\nText.\n", WHY)).toBe("Text.")
    expect(findSection("## why it works\nText.\n## Failure conditions\nOther.\n", WHY)).toBe("Text.")
    expect(findSection("## Constraints And Trade-Offs\nText.\n", CONSTRAINTS)).toBe("Text.")
    expect(findSection("## parts\nText.\n", PARTS)).toBe("Text.")
    // A different word is still a different heading.
    expect(findSection("## Why It Work\nText.\n", WHY)).toBeNull()
    // CJK variants match as written. A Simplified Chinese heading does not match the Traditional one.
    expect(findSection("## 為什麼有效\nText.\n", WHY)).toBe("Text.")
    expect(findSection("## 为什么有效\nText.\n", WHY)).toBe("Text.")
    expect(findSection("## 為什麼有效\nText.\n", PARTS)).toBeNull()
    expect(findSection("## 為什么有效\nText.\n", WHY)).toBeNull()
  })
  describe("removeSection", () => {
    const INSTANCES = MECHANISM_SECTIONS[5]

    it("removes the heading and the body, and keeps the other sections", () => {
      const page = "# T\n\n## Why it works\nBecause.\n\n## Known instances\n\n- [[a]]\n- [[b]]\n\n## Parts\nP.\n"
      expect(removeSection(page, INSTANCES)).toBe("# T\n\n## Why it works\nBecause.\n\n## Parts\nP.\n")
    })

    it("removes the section at the end of the text", () => {
      expect(removeSection("# T\n\nIntro.\n\n## Known instances\n- [[a]]", INSTANCES)).toBe("# T\n\nIntro.\n")
    })

    it("matches every heading variant, any letter case, and a trailing colon", () => {
      for (const heading of ["Known instances", "known INSTANCES:", "已知實例", "已知实例", "已知實例："]) {
        expect(removeSection(`Intro.\n\n## ${heading}\n- [[a]]\n`, INSTANCES)).toBe("Intro.\n")
      }
    })

    it("removes every section of that heading", () => {
      const page = "A.\n## Known instances\n- x\n## Parts\nP.\n## 已知實例\n- y\n"
      expect(removeSection(page, INSTANCES)).toBe("A.\n## Parts\nP.")
    })

    it("keeps a level-3 heading inside the section it removes, and a level-3 heading of another name", () => {
      expect(removeSection("## Known instances\n### Sub\n- x\n## Parts\nP.\n", INSTANCES)).toBe("## Parts\nP.\n")
      expect(removeSection("### Known instances\n- x\n", INSTANCES)).toBe("### Known instances\n- x\n")
    })

    it("returns the text as it is when the section is missing", () => {
      const page = "# T\r\n\r\n## Parts\r\nP.\r\n"
      expect(removeSection(page, INSTANCES)).toBe(page)
    })
  })
})
