/**
 * cancel-skill.ts - stop a background skill run from the activity panel.
 *
 * A background run keeps its button off until it ends (`isRunBlocked`). A run that hangs would keep
 * the button off for good, so every running `skill` item gets a Cancel button. The item stores the
 * stream id of its process; `claude_cli_kill` stops the process.
 *
 * The code never touches Tauri. The caller passes the kill function and the activity store.
 */
import type { ActivityItem } from "@/stores/activity-store"
import type { ActivityApi } from "./run-skill"

/** The text of a cancelled item. The panel shows it as the detail of the last run. */
export const CANCELLED_DETAIL = "Cancelled. Claude Code was stopped before it finished."

/** A skill run can be stopped while it runs, and when its item has the stream id of the process. */
export function canCancelSkillRun(item: Pick<ActivityItem, "type" | "status" | "streamId">): boolean {
  return item.type === "skill" && item.status === "running" && typeof item.streamId === "string" && item.streamId !== ""
}

export interface CancelDeps {
  /** `useActivityStore.getState()`, read when the button is pressed, not at the last render. */
  activity: { items: readonly ActivityItem[]; updateItem: ActivityApi["updateItem"] }
  /** `claude_cli_kill`. */
  kill(streamId: string): Promise<void>
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/**
 * Stop the run of one activity item. The item shows "cancelled" first, so the button is free at once and
 * the exit of the killed process does not change the item (the store keeps a cancelled item cancelled).
 * Resolves to false when there was nothing to stop: the item is gone, or its run ended. Never rejects.
 * When the kill call fails, the item stays cancelled and its text says that the run may still go on.
 */
export async function cancelSkillRun(itemId: string, deps: CancelDeps): Promise<boolean> {
  const item = deps.activity.items.find((candidate) => candidate.id === itemId)
  if (!item || !canCancelSkillRun(item) || item.streamId === undefined) return false
  deps.activity.updateItem(itemId, { status: "cancelled", detail: CANCELLED_DETAIL })
  try {
    await deps.kill(item.streamId)
  } catch (error) {
    deps.activity.updateItem(itemId, {
      detail: `${CANCELLED_DETAIL}\nThe process could not be stopped and may still run: ${messageOf(error)}`,
    })
  }
  return true
}
