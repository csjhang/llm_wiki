import { describe, expect, it } from "vitest"
import { bashCommandPermitted, bashPattern, bashRuleMatches, matchingBashRules } from "./permission-rules"

describe("bashRuleMatches: the table of the Claude Code docs", () => {
  it("matches an exact rule only", () => {
    expect(bashRuleMatches("Bash(npm run build)", "npm run build")).toBe(true)
    expect(bashRuleMatches("Bash(npm run build)", "npm run build --watch")).toBe(false)
  })

  it("lets a trailing * match more words and the bare command", () => {
    expect(bashRuleMatches("Bash(npm run *)", "npm run build")).toBe(true)
    expect(bashRuleMatches("Bash(npm run *)", "npm run test --watch")).toBe(true)
    expect(bashRuleMatches("Bash(npm run *)", "npm run")).toBe(true)
    expect(bashRuleMatches("Bash(npm run *)", "npm install")).toBe(false)
  })

  it("needs the space before a trailing *", () => {
    expect(bashRuleMatches("Bash(ls *)", "ls -la")).toBe(true)
    expect(bashRuleMatches("Bash(ls *)", "ls")).toBe(true)
    expect(bashRuleMatches("Bash(ls *)", "lsof")).toBe(false)
    expect(bashRuleMatches("Bash(ls*)", "lsof")).toBe(true)
  })

  it("matches a * in the middle and at the start, spaces included", () => {
    expect(bashRuleMatches("Bash(git log * main)", "git log --oneline main")).toBe(true)
    expect(bashRuleMatches("Bash(git log * main)", "git log main")).toBe(false)
    expect(bashRuleMatches("Bash(git * main)", "git -c core.fsmonitor=x diff main")).toBe(true)
    expect(bashRuleMatches("Bash(* --version)", "node --version")).toBe(true)
    expect(bashRuleMatches("Bash(* --version)", "node -v")).toBe(false)
  })

  it("gives the bare command to a rule with one wildcard only", () => {
    expect(bashRuleMatches("Bash(* --help *)", "npm --help x")).toBe(true)
    expect(bashRuleMatches("Bash(* --help *)", "npm --help")).toBe(false)
  })

  it("matches the raw text: a quote is not removed", () => {
    expect(bashRuleMatches("Bash(git push *)", "git push origin main")).toBe(true)
    expect(bashRuleMatches("Bash(git push *)", "git 'push' origin main")).toBe(false)
    expect(bashRuleMatches("Bash(git push *)", "git -C . push origin main")).toBe(false)
    expect(bashRuleMatches("Bash(node */a.mjs *)", 'node "/x/a.mjs" go')).toBe(false)
    expect(bashRuleMatches('Bash(node "*/a.mjs" *)', 'node "/x/a.mjs" go')).toBe(true)
  })

  it("treats regular expression characters in a rule as plain text", () => {
    expect(bashRuleMatches("Bash(a.b (c) [d] $e ^f|g *)", "a.b (c) [d] $e ^f|g x")).toBe(true)
    expect(bashRuleMatches("Bash(a.b *)", "aXb x")).toBe(false)
  })

  it("can ignore case, for a deny check", () => {
    expect(bashRuleMatches("Bash(git * -c *)", "git -C x rev-parse HEAD")).toBe(false)
    expect(bashRuleMatches("Bash(git -c *)", "GIT -C x", true)).toBe(true)
    expect(bashRuleMatches("Bash(git -c *)", "GIT -C x", false)).toBe(false)
  })
})

describe("rule lists", () => {
  it("reads the pattern of a Bash rule and refuses another rule", () => {
    expect(bashPattern("Bash(git log *)")).toBe("git log *")
    expect(() => bashPattern("Edit(/x/**)")).toThrow(/Not a Bash rule/)
  })

  it("lists the Bash rules that match, and skips other rules", () => {
    const rules = ["mcp__llm-wiki", "Edit(/x/**)", "Bash(git log *)", "Bash(git *)"]
    expect(matchingBashRules(rules, "git log -3")).toEqual(["Bash(git log *)", "Bash(git *)"])
  })

  it("permits a command only with an allow rule and no deny rule: deny wins", () => {
    const permissions = { allow: ["Bash(git *)"], deny: ["Bash(git push *)"] }
    expect(bashCommandPermitted(permissions, "git status")).toBe(true)
    expect(bashCommandPermitted(permissions, "git push origin main")).toBe(false)
    expect(bashCommandPermitted(permissions, "ls")).toBe(false)
  })
})
