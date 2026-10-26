/**
 * skills-view.tsx - the skill panel of a mechanism wiki.
 *
 * One card per entry of `plugins/llm-wiki/panel.yaml`: the label, the description from the
 * SKILL.md of the skill, the inputs the skill needs, and a button. A background button runs the
 * skill with Claude Code in the background and reports in the activity panel. A conversation
 * button opens Claude Code in a terminal. See `runSkill`.
 *
 * The fixed labels follow the labels of `panel.yaml`: they are not translated. The other text is.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { openClaudeTerminal } from "@/commands/terminal"
import { useMechanismWiki } from "@/hooks/use-mechanism-wiki"
import { detectClaudeCode, spawnClaudeSkill } from "@/lib/skill-panel/claude-skill-spawn"
import { PANEL_ENTRIES, type PanelEntry, type PanelInput } from "@/lib/skill-panel/panel-config"
import { runSkill, SkillCopyError, type SkillFallback } from "@/lib/skill-panel/run-skill"
import { loadWhiteboardOptions, type WhiteboardOption } from "@/lib/skill-panel/whiteboards"
import { useActivityStore, type ActivityItem } from "@/stores/activity-store"
import { useWikiStore } from "@/stores/wiki-store"

/** What the button of a whiteboard skill says while the project has no whiteboard list. */
export const NEED_SYNC_LABEL = "先執行一次同步 Heptabase"

export interface SkillNotice {
  tone: "info" | "error"
  text: string
  /** A command for the user to paste in a terminal. */
  command?: string
}

export interface SkillRunView {
  status: ActivityItem["status"]
  detail: string
}

// ---- notices ----

/** The notice after a start: a terminal opened, or a background run began. */
export function noticeForStart(entry: PanelEntry, t: TFunction): SkillNotice {
  return {
    tone: "info",
    text: entry.mode === "conversation" ? t("skillPanel.openedTerminal") : t("skillPanel.startedBackground"),
  }
}

/** The notice after the command was copied instead of run. It names the reason in one line. */
export function noticeForFallback(fallback: SkillFallback, t: TFunction): SkillNotice {
  const reasonKey = {
    "claude-missing": "skillPanel.copiedClaudeMissing",
    "spawn-failed": "skillPanel.copiedSpawnFailed",
    "terminal-failed": "skillPanel.copiedTerminalFailed",
  }[fallback.reason]
  const detail = fallback.detail.trim().split("\n")[0]
  const text = `${t(reasonKey)} ${t("skillPanel.copiedHint")}${detail ? ` (${detail})` : ""}`
  return { tone: "info", text, command: fallback.command }
}

/** The notice for an error. When the copy failed too, it shows the command to copy by hand. */
export function noticeForError(error: unknown, t: TFunction): SkillNotice {
  if (error instanceof SkillCopyError) {
    return { tone: "error", text: t("skillPanel.copyFailed", { reason: error.reason }), command: error.command }
  }
  return { tone: "error", text: error instanceof Error ? error.message : String(error) }
}

// ---- the panel ----

export interface SkillPanelProps {
  entries: PanelEntry[]
  whiteboards: WhiteboardOption[]
  /** Values of the inputs, by name. */
  values: Partial<Record<PanelInput, string>>
  onValueChange(name: PanelInput, value: string): void
  /** Skills whose start is pending. */
  busy: ReadonlySet<string>
  /** The latest notice of each skill. */
  notices: Record<string, SkillNotice>
  /** The latest run of each skill. */
  runs: Record<string, SkillRunView>
  onRun(entry: PanelEntry): void
}

export function SkillPanel(props: SkillPanelProps) {
  const { t } = useTranslation()
  return (
    <div className="h-full overflow-y-auto px-8 py-6">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t("skillPanel.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("skillPanel.intro")}</p>
        </div>
        {props.entries.map((entry) => (
          <SkillCard key={entry.skill} entry={entry} {...props} />
        ))}
      </div>
    </div>
  )
}

function SkillCard({
  entry,
  whiteboards,
  values,
  onValueChange,
  busy,
  notices,
  runs,
  onRun,
}: SkillPanelProps & { entry: PanelEntry }) {
  const { t } = useTranslation()
  const needsWhiteboard = entry.inputs.includes("whiteboard")
  const hasHypothesisInput = entry.inputs.includes("hypothesis")
  const noWhiteboardList = needsWhiteboard && whiteboards.length === 0
  const whiteboardChosen = whiteboards.some((board) => board.id === values.whiteboard)
  const disabled = busy.has(entry.skill) || (needsWhiteboard && !whiteboardChosen)
  const notice = notices[entry.skill]
  const run = runs[entry.skill]

  return (
    <section data-skill={entry.skill} className="space-y-3 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{entry.label}</h3>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {entry.mode === "background" ? t("skillPanel.modeBackground") : t("skillPanel.modeConversation")}
            </span>
          </div>
          <p className="whitespace-pre-line text-sm text-muted-foreground">{entry.description}</p>
        </div>
        <Button data-action="run" disabled={disabled} onClick={() => onRun(entry)} className="shrink-0">
          {busy.has(entry.skill) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {noWhiteboardList ? NEED_SYNC_LABEL : entry.label}
        </Button>
      </div>

      {needsWhiteboard && !noWhiteboardList && (
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">{t("skillPanel.whiteboard")}</span>
          <select
            value={whiteboardChosen ? values.whiteboard : ""}
            onChange={(event) => onValueChange("whiteboard", event.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">{t("skillPanel.chooseWhiteboard")}</option>
            {whiteboards.map((board) => (
              <option key={board.id} value={board.id}>
                {board.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {hasHypothesisInput && (
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">{t("skillPanel.hypothesis")}</span>
          <input
            type="text"
            value={values.hypothesis ?? ""}
            onChange={(event) => onValueChange("hypothesis", event.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
      )}

      {notice && (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={`space-y-1 rounded-md px-3 py-2 text-xs ${
            notice.tone === "error" ? "bg-destructive/10 text-destructive" : "bg-muted text-foreground"
          }`}
        >
          <p className="whitespace-pre-wrap break-words">{notice.text}</p>
          {notice.command && (
            <code className="block select-all break-all rounded bg-background px-2 py-1 font-mono">{notice.command}</code>
          )}
        </div>
      )}

      {run && (
        <div className="space-y-1 text-xs">
          <div className="flex items-center gap-1.5 font-medium">
            {run.status === "running" && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
            {run.status === "done" && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
            {run.status === "error" && <AlertCircle className="h-3 w-3 text-destructive" />}
            <span>
              {t("skillPanel.lastRun")}: {t(`skillPanel.status.${run.status}`)}
            </span>
          </div>
          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 px-3 py-2 font-sans text-muted-foreground">
            {run.detail}
          </pre>
        </div>
      )}
    </section>
  )
}

// ---- the view ----

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record
  return rest
}

/** The view of the sidebar entry "Skill panel". */
export function SkillPanelView() {
  const { t } = useTranslation()
  const projectPath = useWikiStore((s) => s.project?.path ?? null)
  const activityItems = useActivityStore((s) => s.items)
  const mechanism = useMechanismWiki(projectPath)
  const [whiteboards, setWhiteboards] = useState<WhiteboardOption[]>([])
  const [values, setValues] = useState<Partial<Record<PanelInput, string>>>({})
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [notices, setNotices] = useState<Record<string, SkillNotice>>({})

  // Another project has other whiteboards, other values, and other runs.
  useEffect(() => {
    setWhiteboards([])
    setValues({})
    setNotices({})
  }, [projectPath])

  // The sync keeps the whiteboard list. Read it each time the panel opens.
  useEffect(() => {
    if (projectPath === null || mechanism !== true) return
    let cancelled = false
    void loadWhiteboardOptions(projectPath).then((options) => {
      if (!cancelled) setWhiteboards(options)
    })
    return () => {
      cancelled = true
    }
  }, [projectPath, mechanism])

  const runs = useMemo(() => {
    const byLabel: Record<string, SkillRunView> = {}
    // The newest item comes first.
    for (const entry of PANEL_ENTRIES) {
      const item = activityItems.find((candidate) => candidate.type === "skill" && candidate.title === entry.label)
      if (item) byLabel[entry.skill] = { status: item.status, detail: item.detail }
    }
    return byLabel
  }, [activityItems])

  const handleValueChange = useCallback((name: PanelInput, value: string) => {
    setValues((current) => ({ ...current, [name]: value }))
  }, [])

  const handleRun = useCallback(
    async (entry: PanelEntry) => {
      if (projectPath === null) return
      setBusy((current) => new Set(current).add(entry.skill))
      setNotices((current) => withoutKey(current, entry.skill))
      const seen: { fallback: SkillFallback | null } = { fallback: null }
      let notice: SkillNotice
      try {
        const outcome = await runSkill(entry, values, {
          projectPath,
          detectClaude: detectClaudeCode,
          spawnClaude: spawnClaudeSkill,
          openTerminal: openClaudeTerminal,
          copy: (text) => navigator.clipboard.writeText(text),
          activity: useActivityStore.getState(),
          onFallback: (fallback) => {
            seen.fallback = fallback
          },
        })
        notice =
          outcome === "copied" && seen.fallback ? noticeForFallback(seen.fallback, t) : noticeForStart(entry, t)
      } catch (error) {
        notice = noticeForError(error, t)
      }
      setNotices((current) => ({ ...current, [entry.skill]: notice }))
      setBusy((current) => {
        const next = new Set(current)
        next.delete(entry.skill)
        return next
      })
    },
    [projectPath, values, t],
  )

  if (mechanism === null) return <div className="h-full" />
  if (!mechanism) {
    return (
      <div className="h-full overflow-y-auto px-8 py-6">
        <p className="mx-auto max-w-3xl text-sm text-muted-foreground">{t("skillPanel.notMechanism")}</p>
      </div>
    )
  }
  return (
    <SkillPanel
      entries={PANEL_ENTRIES}
      whiteboards={whiteboards}
      values={values}
      onValueChange={handleValueChange}
      busy={busy}
      notices={notices}
      runs={runs}
      onRun={(entry) => void handleRun(entry)}
    />
  )
}
