/**
 * The picker of "Use an existing domain" on a `new-domain` review item (spec 6.6).
 *
 * `DomainPickerForm` is the form: what the choice does, a select of the domains of `domains.yaml`, a Cancel button, and a
 * confirm button that is off until the user has chosen a domain. `DomainPickerDialog` puts it in a dialog with a title. The review view opens the dialog when
 * `mech:use-existing-domain` asks for a choice (`chooseDomain` of the action dependencies) and settles it with the
 * domain or with null.
 */
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export interface DomainPickerRequest {
  /** The domains of domains.yaml that the user may choose. */
  domains: string[]
  /** The domain that the ingest proposed. */
  proposed: string
  /** Settle the request: the chosen domain, or null for Cancel. */
  resolve(choice: string | null): void
}

export function DomainPickerForm({
  domains,
  proposed,
  initial = "",
  onChoose,
  onCancel,
}: {
  domains: readonly string[]
  proposed: string
  /** The domain that is selected at the start. None by default. */
  initial?: string
  onChoose(domain: string): void
  onCancel(): void
}) {
  const { t } = useTranslation()
  const [choice, setChoice] = useState(initial)
  return (
    <>
      <p className="break-words text-sm text-muted-foreground">{t("review.useDomainMessage", { proposed })}</p>
      <label className="block space-y-1 text-xs">
        <span className="text-muted-foreground">{t("review.useDomainLabel")}</span>
        <select
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">{t("review.useDomainChoose")}</option>
          {domains.map((domain) => (
            <option key={domain} value={domain}>
              {domain}
            </option>
          ))}
        </select>
      </label>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button disabled={choice === ""} onClick={() => onChoose(choice)}>
          {t("review.useDomainConfirm")}
        </Button>
      </DialogFooter>
    </>
  )
}

export function DomainPickerDialog({ request }: { request: DomainPickerRequest }) {
  const { t } = useTranslation()
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) request.resolve(null)
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("review.useDomainTitle")}</DialogTitle>
        </DialogHeader>
        <DomainPickerForm
          domains={request.domains}
          proposed={request.proposed}
          onChoose={(domain) => request.resolve(domain)}
          onCancel={() => request.resolve(null)}
        />
      </DialogContent>
    </Dialog>
  )
}
