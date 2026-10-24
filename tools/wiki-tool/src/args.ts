/**
 * Option parser shared by the wiki-tool commands.
 *
 * A command lists the options it takes by name (without the `--`): `values` take
 * one value each and may be given once, `lists` take one value each and may repeat,
 * `flags` take no value. parseArgs collects every problem instead of stopping at
 * the first, so one run can report them all.
 */

export interface ArgSpec {
  values?: readonly string[]
  lists?: readonly string[]
  flags?: readonly string[]
}

export interface ParsedArgs {
  /** The options of `values` that were given. */
  values: Record<string, string>
  /** Every option of `lists`; an empty list when it was not given. */
  lists: Record<string, string[]>
  /** Every option of `flags`; false when it was not given. */
  flags: Record<string, boolean>
}

export function parseArgs(args: readonly string[], spec: ArgSpec): { parsed: ParsedArgs; problems: string[] } {
  const valueNames = new Set(spec.values ?? [])
  const listNames = new Set(spec.lists ?? [])
  const flagNames = new Set(spec.flags ?? [])
  const parsed: ParsedArgs = { values: {}, lists: {}, flags: {} }
  for (const name of listNames) parsed.lists[name] = []
  for (const name of flagNames) parsed.flags[name] = false
  const problems: string[] = []

  /** The token after `index` when it can be a value, which is when it is not an option. */
  const valueAfter = (index: number): string | undefined => {
    const next = args[index + 1]
    return next !== undefined && !next.startsWith("--") ? next : undefined
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token.startsWith("--")) {
      problems.push(`unexpected argument: ${token}`)
      continue
    }
    const name = token.slice(2)
    if (valueNames.has(name) || listNames.has(name)) {
      const value = valueAfter(index)
      if (value === undefined) {
        problems.push(`missing value for ${token}`)
        continue
      }
      index += 1
      if (listNames.has(name)) {
        parsed.lists[name].push(value)
      } else if (Object.prototype.hasOwnProperty.call(parsed.values, name)) {
        problems.push(`option given more than once: ${token}`)
      } else {
        parsed.values[name] = value
      }
    } else if (flagNames.has(name)) {
      parsed.flags[name] = true
    } else {
      problems.push(`unknown option: ${token}`)
      // The token after an unknown option is probably its value; do not report it as well.
      if (valueAfter(index) !== undefined) index += 1
    }
  }
  return { parsed, problems }
}
