/**
 * Types shared by the mechanism ingest code.
 *
 * `AnalysisDecisions` is what the analysis step decided for one source: its
 * domain and the mechanisms it shows. The generation prompt reads it, and the
 * page enforcement reads it after generation.
 */

export interface MechanismDecision {
  /** `existing`: the wiki already has the mechanism page. `new`: it does not. */
  kind: "existing" | "new"
  slug: string
  /** One line that says what the mechanism does, in domain-neutral words. */
  summary: string
}

export interface AnalysisDecisions {
  /** A domain from `domains.yaml`, or null when none was chosen. */
  domain: string | null
  /** A domain that is not listed yet, waiting for the user to approve it. */
  proposedDomain: { path: string; lens: string; description: string } | null
  /** The valid MECHANISM lines only. A line that could not be used is in `problems`, not here. */
  mechanisms: MechanismDecision[]
  /** Human-readable problems found while reading the analysis: dropped or invalid lines, and gaps. */
  problems: string[]
}

/** Decisions with nothing decided except the domain, which may come from a hint. */
export function emptyDecisions(domain: string | null): AnalysisDecisions {
  return { domain, proposedDomain: null, mechanisms: [], problems: [] }
}
