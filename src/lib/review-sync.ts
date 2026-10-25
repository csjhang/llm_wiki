/**
 * Review sync - the app applies the review changes of its own API server to the review store.
 *
 * The routes of the API server that write `.llm-wiki/review.json` (add, resolve, reopen, delete) emit the Tauri
 * event `review://changed`. The store is the source of truth of the app, and its auto-save rewrites the file from
 * the store. A change that only reached the file would be lost at the next store change. So the listener here puts
 * the same change into the store, and the next auto-save writes it back.
 *
 * Only a payload for the open project counts. The listener changes the store items one by one. It never reloads the
 * file, so an item that the user removed in the app does not come back.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { normalizePath } from "@/lib/path-utils"
import { mergeReviewItems, reviewIdFor, useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

/** Name of the event that `src-tauri/src/api_server.rs` emits (`REVIEW_CHANGED_EVENT`). */
export const REVIEW_CHANGED_EVENT = "review://changed"

/** The payload of `review://changed`. A key is left out when it has no entries. */
export interface ReviewChangedPayload {
  /** Path of the project whose `review.json` changed. */
  projectPath: string
  /** Full items. An item whose id is in the store is merged into it. */
  added?: ReviewItem[]
  /** Items that became resolved. `action` is the label that the card shows, or null. */
  resolved?: Array<{ id: string; action?: string | null }>
  /** Ids of items that are open again. */
  reopened?: string[]
  /** Ids of items that were removed. */
  deleted?: string[]
}

/** Compare two project paths: separators, a trailing slash, and the case of a Windows path do not matter. */
function sameProjectPath(a: string, b: string): boolean {
  const clean = (path: string): string => {
    const normalized = normalizePath(path).replace(/\/+$/, "")
    return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
  }
  return clean(a) === clean(b)
}

/** The API names an item by the id it has in the file. The store can hold an older id for the same item. */
function itemHasId(item: ReviewItem, id: string): boolean {
  return item.id === id || reviewIdFor(item) === id
}

/** The items after the change. The input array and its items stay as they are. */
export function applyReviewChange(items: ReviewItem[], change: ReviewChangedPayload): ReviewItem[] {
  let next = [...items]

  for (const incoming of change.added ?? []) {
    const index = next.findIndex((item) => itemHasId(item, incoming.id))
    const complete: ReviewItem = { ...incoming, options: incoming.options ?? [] }
    next =
      index === -1
        ? [...next, complete]
        : next.map((item, at) => (at === index ? mergeReviewItems(item, { ...complete, id: item.id }) : item))
  }

  for (const { id, action } of change.resolved ?? []) {
    next = next.map((item) =>
      itemHasId(item, id)
        ? { ...item, resolved: true, resolvedAction: action ?? item.resolvedAction }
        : item,
    )
  }

  for (const id of change.reopened ?? []) {
    next = next.map((item) => {
      if (!itemHasId(item, id)) return item
      const { resolvedAction: _dropped, ...rest } = item
      return { ...rest, resolved: false }
    })
  }

  const deleted = change.deleted ?? []
  if (deleted.length > 0) {
    next = next.filter((item) => !deleted.some((id) => itemHasId(item, id)))
  }

  return next
}

/** Apply one `review://changed` payload to the store, when it is for the open project. */
export function handleReviewChanged(payload: ReviewChangedPayload): void {
  if (!payload || typeof payload.projectPath !== "string") return
  const open = useWikiStore.getState().project
  if (!open || !sameProjectPath(open.path, payload.projectPath)) return
  const store = useReviewStore.getState()
  store.setItems(applyReviewChange(store.items, payload))
}

/**
 * Start listening. Returns a function that stops the listener. Call it once, when the app starts.
 */
export async function startReviewSync(): Promise<() => void> {
  const unlisten: UnlistenFn = await listen<ReviewChangedPayload>(REVIEW_CHANGED_EVENT, (event) => {
    handleReviewChanged(event.payload)
  })
  return () => unlisten()
}
