import { create } from "zustand"

export interface ActivityItem {
  id: string
  type: "ingest" | "lint" | "query" | "skill"
  title: string
  /**
   * "warning": finished, but not all of the work was done (a skill run that had tools denied).
   * "cancelled": the user stopped a skill run. The item stays cancelled when the killed process sends its exit.
   */
  status: "running" | "done" | "warning" | "error" | "cancelled"
  detail: string
  filesWritten: string[]
  createdAt: number
  /** Project the item belongs to. Set by the skill panel, so each project shows its own runs. */
  projectPath?: string
  /** The stream id of a background skill run, so the activity panel can stop it (`claude_cli_kill`). */
  streamId?: string
}

interface ActivityState {
  items: ActivityItem[]
  addItem: (item: Omit<ActivityItem, "id" | "createdAt">) => string
  updateItem: (id: string, updates: Partial<Pick<ActivityItem, "status" | "detail" | "filesWritten">>) => void
  appendDetail: (id: string, text: string) => void
  clearDone: () => void
}

let counter = 0

export const useActivityStore = create<ActivityState>((set) => ({
  items: [],

  addItem: (item) => {
    const id = `activity-${++counter}`
    set((state) => ({
      items: [
        { ...item, id, createdAt: Date.now() },
        ...state.items,
      ],
    }))
    return id
  },

  updateItem: (id, updates) =>
    set((state) => ({
      items: state.items.map((item) => {
        if (item.id !== id) return item
        // A cancelled run does not come back: the process that was killed still sends its progress and its exit.
        if (item.status === "cancelled" && updates.status !== undefined && updates.status !== "cancelled") return item
        return { ...item, ...updates }
      }),
    })),

  appendDetail: (id, text) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, detail: item.detail + text } : item
      ),
    })),

  clearDone: () =>
    set((state) => ({
      items: state.items.filter((i) => i.status === "running"),
    })),
}))
