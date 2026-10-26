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

  replaceItemsOfType: (type, results) =>
    set((state) => {
      const kept = state.items.filter((item) => item.type !== type)
      // Nothing to remove and nothing to add: keep the same array, so nothing is saved again.
      if (kept.length === state.items.length && results.length === 0) return state
      return { items: [...kept, ...results.map(lintResultToItem)] }
    }),
}))
