import { useEffect, useState } from "react"
import { isMechanismWiki } from "@/lib/mechanism-wiki/context"

/**
 * Is the project a mechanism wiki (`domains.yaml` exists)? `null` while the check runs.
 * A missing project is not one. The answer is read again when the project changes.
 */
export function useMechanismWiki(projectPath: string | null): boolean | null {
  const [found, setFound] = useState<{ path: string | null; mechanism: boolean } | null>(null)

  useEffect(() => {
    if (projectPath === null) return
    let cancelled = false
    void isMechanismWiki(projectPath).then((mechanism) => {
      if (!cancelled) setFound({ path: projectPath, mechanism })
    })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  if (projectPath === null) return false
  // An answer for another project does not count.
  return found !== null && found.path === projectPath ? found.mechanism : null
}
