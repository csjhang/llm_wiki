/**
 * Option parser shared by the wiki-tool commands.
 *
 * A command lists the options it takes by name (without the `--`): `values` take
 * one value each and may be given once, `lists` take one value each and may repeat,
 * `flags` take no value. A value is the next token (`--name value`), or the text after the first `=`
 * (`--name=value`); only the second form can give a value that starts with `--`. parseArgs collects every
 * problem instead of stopping at the first, so one run can report them all.
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
    const equals = token.indexOf("=")
    const name = token.slice(2, equals === -1 ? undefined : equals)
    const inline = equals === -1 ? undefined : token.slice(equals + 1)
    if (valueNames.has(name) || listNames.has(name)) {
      let value = inline
      if (value === undefined) {
        value = valueAfter(index)
        if (value === undefined) {
          problems.push(`missing value for ${token}`)
          continue
        }
        index += 1
      }
      if (listNames.has(name)) {
        parsed.lists[name].push(value)
      } else if (Object.prototype.hasOwnProperty.call(parsed.values, name)) {
        problems.push(`option given more than once: --${name}`)
      } else {
        parsed.values[name] = value
      }
    } else if (flagNames.has(name)) {
      if (inline === undefined) parsed.flags[name] = true
      else problems.push(`option takes no value: --${name}`)
    } else {
      problems.push(`unknown option: ${token}`)
      // The token after an unknown option is probably its value; do not report it as well.
      if (inline === undefined && valueAfter(index) !== undefined) index += 1
    }
  }
  return { parsed, problems }
}

/**
 * The time of a `--now` option: the clock when the option is not given, else the date and time
 * it names (ISO 8601, such as 2026-10-24T08:00:00Z). Anything else is a problem and returns null.
 */
export function parseNowOption(value: string | undefined, problems: string[]): Date | null {
  if (value === undefined) return new Date()
  const time = /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : Number.NaN
  if (Number.isNaN(time)) {
    problems.push(`--now must be an ISO date and time, such as 2026-10-24T08:00:00Z: ${value}`)
    return null
  }
  return new Date(time)
}
