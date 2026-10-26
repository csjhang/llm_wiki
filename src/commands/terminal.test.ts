import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}))

import { openClaudeTerminal } from "./terminal"

describe("openClaudeTerminal", () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
  })

  it("invokes open_claude_terminal with the project path and the command", async () => {
    mocks.invoke.mockResolvedValue("gnome-terminal")

    const launcher = await openClaudeTerminal(
      "/home/user/wiki",
      "/wiki-fuse 00000000-0000-4000-8000-000000000001",
    )

    expect(launcher).toBe("gnome-terminal")
    expect(mocks.invoke).toHaveBeenCalledWith("open_claude_terminal", {
      projectPath: "/home/user/wiki",
      command: "/wiki-fuse 00000000-0000-4000-8000-000000000001",
    })
  })

  it("lets the error through so the caller can offer to copy the command", async () => {
    mocks.invoke.mockRejectedValue("Could not open a terminal (xterm: not found).")

    await expect(openClaudeTerminal("/home/user/wiki", "/wiki-lint")).rejects.toBe(
      "Could not open a terminal (xterm: not found).",
    )
  })
})
