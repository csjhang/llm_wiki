/**
 * git-history-setting.tsx - the "Version history (git)" switch of the open project.
 *
 * It sits in the maintenance section, which holds the other settings of a single project. The
 * choice applies at once, like the switch of the file version history: a press stores the choice
 * and forgets the answer that the session cached, so the next ingest follows it. See
 * `setGitHistoryEnabled`.
 */
import { useCallback, useEffect, useState } from "react"
import { GitBranch } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Label } from "@/components/ui/label"
import { loadGitHistoryEnabled, setGitHistoryEnabled } from "@/lib/git-history-setting"
import { useWikiStore } from "@/stores/wiki-store"

export interface GitHistoryToggleProps {
  /** The stored choice. `null` while it loads. */
  enabled: boolean | null
  /** A press is being handled. */
  busy: boolean
  /** No project is open. */
  disabled: boolean
  error: string | null
  onToggle(next: boolean): void
}

/** The switch, its label, and its help text. It keeps no state. */
export function GitHistoryToggle({ enabled, busy, disabled, error, onToggle }: GitHistoryToggleProps) {
  const { t } = useTranslation()
  const on = enabled === true
  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="git-history-enabled" className="flex items-center gap-2 text-sm font-semibold">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            {t("settings.sections.maintenance.gitHistory.title")}
          </Label>
          <p className="mt-1 text-xs text-muted-foreground">{t("settings.sections.maintenance.gitHistory.hint")}</p>
        </div>
        <button
          id="git-history-enabled"
          type="button"
          role="switch"
          aria-checked={on}
          disabled={disabled || busy || enabled === null}
          onClick={() => onToggle(!on)}
          className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-50 ${on ? "border-primary bg-primary" : "border-border bg-muted"}`}
        >
          <span
            className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-background shadow-sm transition-transform ${on ? "left-[22px]" : "left-0.5"}`}
          />
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** The switch for the open project. */
export function GitHistorySetting() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const projectId = project?.id ?? null
  const projectPath = project?.path ?? null
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Another project has its own choice.
  useEffect(() => {
    setEnabled(null)
    setBusy(false)
    setError(null)
    if (projectId === null) return
    let cancelled = false
    void loadGitHistoryEnabled(projectId)
      .then((on) => {
        if (!cancelled) setEnabled(on)
      })
      .catch((err: unknown) => {
        console.warn("[git-history] could not read the version history choice:", err)
        if (!cancelled) setEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (projectId === null || projectPath === null) return
      setBusy(true)
      setError(null)
      try {
        const on = await setGitHistoryEnabled(projectId, projectPath, next)
        if (useWikiStore.getState().project?.id !== projectId) return
        setEnabled(on)
        if (next && !on) setError(t("settings.sections.maintenance.gitHistory.failed"))
      } catch (err) {
        console.warn("[git-history] could not change the version history choice:", err)
        if (useWikiStore.getState().project?.id === projectId) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (useWikiStore.getState().project?.id === projectId) setBusy(false)
      }
    },
    [projectId, projectPath, t],
  )

  return (
    <GitHistoryToggle
      enabled={enabled}
      busy={busy}
      disabled={projectId === null}
      error={error}
      onToggle={(next) => void handleToggle(next)}
    />
  )
}
