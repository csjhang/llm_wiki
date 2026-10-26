import { create } from "zustand"
import type { LintResult } from "@/lib/lint"

export interface LintItem {
  id: string
  type: LintResult["type"]
  severity: LintResult["severity"]
  page: string
  detail: string
  affectedPages?: string[]
  brokenTarget?: string
  suggestedTarget?: string
  suggestedSource?: string
  /** Only for type "structure": the id of the check. */
  check?: string
  createdAt: number
}

function lintResultToItem(result: LintResult): LintItem {
  return {
    type: result.type,
    severity: result.severity,
    page: result.page,
    detail: result.detail,
    affectedPages: result.affectedPages,
    brokenTarget: result.brokenTarget,
    suggestedTarget: result.suggestedTarget,
    suggestedSource: result.suggestedSource,
    check: result.check,
    id: `lint-${++counter}`,
    createdAt: Date.now(),
  }
}

/** True when two items of one type say the same: the same page, check, and detail. */
function sameFinding(a: LintItem, b: LintItem): boolean {
  return a.page === b.page && a.check === b.check && a.detail === b.detail
}

/**
 * `items` without those of `type`, and then `results` as items. A new item that says the same as an old
 * item of its type (same page, check, and detail) takes the id of that old item, so a view that keeps
 * the selection by id keeps it after a refresh. One old id goes to one new item. Returns `items` itself
 * when nothing changes.
 */
function replaceOfType(items: LintItem[], type: LintResult["type"], results: LintResult[]): LintItem[] {
  const old = items.filter((item) => item.type === type)
  const free = [...old]
  const next = results.map((result) => {
    const item = lintResultToItem(result)
    const at = free.findIndex((candidate) => sameFinding(candidate, item))
    if (at !== -1) item.id = free.splice(at, 1)[0].id
    return item
  })
  const replaced = [...items.filter((item) => item.type !== type), ...next]
  const unchanged =
    replaced.length === items.length &&
    replaced.every((item, index) => item.id === items[index].id && item.type === items[index].type && item.severity === items[index].severity && sameFinding(item, items[index]))
  return unchanged ? items : replaced
}

function syncCounterFromItems(items: readonly LintItem[]): void {
  for (const item of items) {
    const match = /^lint-(\d+)$/.exec(item.id)
    if (!match) continue
    const idNumber = Number(match[1])
    if (Number.isFinite(idNumber) && idNumber > counter) {
      counter = idNumber
    }
  }
}

interface LintState {
  items: LintItem[]
  setItems: (items: LintItem[]) => void
  addItems: (results: LintResult[]) => void
  /**
   * Add the results of a manual lint run. The results of type "structure" replace the structure items
   * that are in the store (see `replaceItemsOfType`), so a refresh by the ingest queue during the run
   * cannot give two of each. The other results are added.
   */
  addRunResults: (results: LintResult[]) => void
  removeItem: (id: string) => void
  removeItems: (ids: string[]) => void
  clearItems: () => void
  /** Remove every item of `type` and add `results`, in one step. Every item of another type stays. */
  replaceItemsOfType: (type: LintResult["type"], results: LintResult[]) => void
}

let counter = 0

export const useLintStore = create<LintState>((set) => ({
  items: [],

  setItems: (items) => {
    syncCounterFromItems(items)
    set({ items })
  },

  addItems: (results) =>
    set((state) => ({
      items: [...state.items, ...results.map(lintResultToItem)],
    })),

  removeItem: (id) =>
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
    })),

  removeItems: (ids) =>
    set((state) => {
      const remove = new Set(ids)
      return {
        items: state.items.filter((item) => !remove.has(item.id)),
      }
    }),

  clearItems: () => set({ items: [] }),

  addRunResults: (results) =>
    set((state) => {
      const others = results.filter((result) => result.type !== "structure")
      const base = others.length === 0 ? state.items : [...state.items, ...others.map(lintResultToItem)]
      const items = replaceOfType(
        base,
        "structure",
        results.filter((result) => result.type === "structure"),
      )
      return items === state.items ? state : { items }
    }),

  replaceItemsOfType: (type, results) =>
    set((state) => {
      const items = replaceOfType(state.items, type, results)
      // Nothing changes: keep the same array, so nothing is saved again.
      return items === state.items ? state : { items }
    }),
}))
