/**
 * Claude Code permission rules, as far as the tests of the template need them.
 *
 * Facts from code.claude.com/docs/en/permissions.md:
 * - A Bash rule matches the whole command text, as the AI wrote it. Quotes are not removed.
 * - A `*` can be anywhere in the rule and matches any text, including spaces.
 * - A trailing ` *` (a space, then the only `*` of the rule) also matches the bare command.
 * - A deny rule wins over an allow rule.
 *
 * This is a model of the rules for the contract tests. It is not the code of Claude Code.
 */

const BASH_RULE = /^Bash\(([\s\S]*)\)$/

/** The pattern inside `Bash(...)`. Throws for any other rule. */
export function bashPattern(rule: string): string {
  const match = BASH_RULE.exec(rule)
  if (!match) throw new Error(`Not a Bash rule: ${rule}`)
  return match[1]
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * True when the Bash rule matches the command text. Matching is case sensitive: the docs name
 * PowerShell and WebFetch as the case-insensitive rules. `ignoreCase` is for a test that wants the worst case.
 */
export function bashRuleMatches(rule: string, command: string, ignoreCase = false): boolean {
  const pattern = bashPattern(rule)
  const parts = pattern.split("*")
  const flags = ignoreCase ? "i" : ""
  const body = parts.map(escapeRegExp).join("[\\s\\S]*")
  if (new RegExp(`^${body}$`, flags).test(command)) return true
  // "ls *" also matches "ls", but only when that `*` is the one wildcard of the rule.
  if (parts.length === 2 && pattern.endsWith(" *")) {
    return new RegExp(`^${escapeRegExp(pattern.slice(0, -2))}$`, flags).test(command)
  }
  return false
}

/** The Bash rules of a list that match the command. */
export function matchingBashRules(rules: readonly string[], command: string, ignoreCase = false): string[] {
  return rules.filter((rule) => BASH_RULE.test(rule) && bashRuleMatches(rule, command, ignoreCase))
}

/**
 * Would a background run (`claude -p`) run this Bash command without a person?
 * It needs an allow rule, and no deny rule may match.
 */
export function bashCommandPermitted(
  permissions: { allow: readonly string[]; deny: readonly string[] },
  command: string,
): boolean {
  return (
    matchingBashRules(permissions.deny, command).length === 0 &&
    matchingBashRules(permissions.allow, command).length > 0
  )
}
