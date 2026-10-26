/**
 * The `(<domain>)` of the Known instances lines of a mechanism page (ruling U4).
 *
 * A mechanism page lists its instances as `- [[<slug>]] (<domain>): <term>` under the heading "Known instances". The
 * fusion step reads the domains from these lines (`instanceDomainsOf` in `src/lib/mechanism-wiki/fusion-candidates.ts`
 * uses the same section reader and the same line form), so a recut must change them too. Only the domain inside the
 * parentheses changes; every other byte of the page stays, also the line breaks.
 */
import { MECHANISM_SECTIONS, sectionLineRange } from "@/lib/wiki-config/section-headings"

const INSTANCES_SECTION = MECHANISM_SECTIONS.filter((section) => section.key === "instances")[0]

/** The same line form as `INSTANCE_LINE` in `fusion-candidates.ts`, cut into the parts around the domain. */
const INSTANCE_LINE = /^([ \t]*[-*+][ \t]+!?\[\[)([^\]\r\n]*)(\]\][ \t]*\()([^)\r\n]+)\)/

export interface InstanceRewrite {
  text: string
  /** The number of lines that changed. */
  changed: number
  /** The lines that `resolve` could not decide. They stay as they are. */
  unresolved: Array<{ slug: string; domain: string }>
}

/**
 * Rewrite the domain of every instance line. `resolve` gets the domain (trimmed) and the slug of the link, and returns
 * the new domain, the same domain to leave the line, or null when it cannot decide: the line stays and is reported.
 */
export function rewriteInstanceLines(text: string, resolve: (domain: string, slug: string) => string | null): InstanceRewrite {
  const raw = text.split("\n")
  // The section is read on lines without a trailing "\r", as `findSection` does.
  const lines = raw.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
  const range = sectionLineRange(lines, INSTANCES_SECTION)
  const unresolved: InstanceRewrite["unresolved"] = []
  if (range === null) return { text, changed: 0, unresolved }

  let changed = 0
  for (let index = range.start; index < range.end; index += 1) {
    const match = INSTANCE_LINE.exec(lines[index])
    if (match === null) continue
    const domain = match[4].trim()
    const slug = match[2].split("|")[0].split("#")[0].trim()
    const next = resolve(domain, slug)
    if (next === null) {
      unresolved.push({ slug, domain })
      continue
    }
    if (next === domain) continue
    const lead = match[4].slice(0, match[4].length - match[4].trimStart().length)
    const trail = match[4].slice(match[4].trimEnd().length)
    const rewritten = `${match[1]}${match[2]}${match[3]}${lead}${next}${trail})${lines[index].slice(match[0].length)}`
    raw[index] = raw[index].endsWith("\r") ? `${rewritten}\r` : rewritten
    changed += 1
  }
  return { text: raw.join("\n"), changed, unresolved }
}
