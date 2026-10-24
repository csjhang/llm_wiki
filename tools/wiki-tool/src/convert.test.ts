/**
 * convert.test.ts - tests for the Markdown <-> Hepta Markdown converters.
 *
 * Ids are placeholders (00000000-0000-4000-8000-0000000000NN) and titles are generic.
 */
import { describe, expect, it } from "vitest"
import { cardLink, cardToSnapshotBody, type LinkTarget, wikiPageToCard } from "./convert"

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
}

const CARD_A: LinkTarget = { cardId: id(1), title: "Card A" }
const CARD_B: LinkTarget = { cardId: id(2), title: "Card B" }

const UNSYNCED = "（僅在 wiki）"
const FOOTER_TAIL = "由 wiki 產生，請勿直接編輯。"
const UNSUPPORTED = "<!-- heptabase: unsupported block -->"

type Options = Parameters<typeof wikiPageToCard>[1]

/** Options where only `alpha` resolves; titles are "Title of <slug>". */
function options(overrides: Partial<Options> = {}): Options {
  return {
    title: "Page Title",
    resolveLink: (slug) => (slug === "alpha" ? CARD_A : null),
    titleForSlug: (slug) => `Title of ${slug}`,
    sourceCards: [],
    ...overrides,
  }
}

describe("cardLink", () => {
  it("writes a heptabase card link", () => {
    expect(cardLink(CARD_A)).toBe(`[Card A](heptabase://card/${id(1)})`)
  })

  it("trims the title after collapsing whitespace", () => {
    expect(cardLink({ cardId: id(3), title: "  Card \n  A  " })).toBe(`[Card A](heptabase://card/${id(3)})`)
  })

  it("escapes brackets and backslashes in the title", () => {
    expect(cardLink({ cardId: id(3), title: "Draft [v2] notes" })).toBe(
      `[Draft \\[v2\\] notes](heptabase://card/${id(3)})`,
    )
    expect(cardLink({ cardId: id(3), title: "Ends with slash\\" })).toBe(
      `[Ends with slash\\\\](heptabase://card/${id(3)})`,
    )
  })
})

describe("wikiPageToCard", () => {
  it("replaces frontmatter with H1 title", () => {
    const markdown = "---\ntype: concept\nsources: [a, b]\n---\n\nBody text.\n"
    const card = wikiPageToCard(markdown, options())
    expect(card.startsWith("# Page Title\n\nBody text.")).toBe(true)
    expect(card).not.toContain("type: concept")
  })

  it("keeps a thematic break that is not frontmatter", () => {
    const card = wikiPageToCard("Intro\n\n---\n\nAfter break\n", options())
    expect(card).toContain("Intro\n\n---\n\nAfter break")
  })

  it("does not duplicate an existing H1", () => {
    const markdown = "---\ntype: concept\n---\n# Old Heading\n\nBody text.\n"
    const card = wikiPageToCard(markdown, options())
    expect(card.startsWith("# Page Title\n\nBody text.")).toBe(true)
    expect(card).not.toContain("Old Heading")
    expect(card.match(/^# /gm)).toHaveLength(1)
  })

  it("replaces an H1 when there is no frontmatter", () => {
    const card = wikiPageToCard("# Old Heading\nBody text.\n", options())
    expect(card.startsWith("# Page Title\n\nBody text.")).toBe(true)
  })

  it("replaces an underlined H1", () => {
    const card = wikiPageToCard("Old Heading\n===========\n\nBody text.\n", options())
    expect(card.startsWith("# Page Title\n\nBody text.")).toBe(true)
    expect(card).not.toContain("Old Heading")
  })

  it("keeps deeper headings", () => {
    const card = wikiPageToCard("## Section\n\nBody.\n", options())
    expect(card.startsWith("# Page Title\n\n## Section\n\nBody.")).toBe(true)
  })

  it("resolves wikilinks to card links", () => {
    const card = wikiPageToCard("See [[alpha]] for more.\n", options())
    expect(card).toContain(`See [Card A](heptabase://card/${id(1)}) for more.`)
  })

  it("keeps the label as the link text of a resolved wikilink", () => {
    const card = wikiPageToCard("See [[alpha|the first card]].\n", options())
    expect(card).toContain(`See [the first card](heptabase://card/${id(1)}).`)
  })

  it("escapes a label like a title", () => {
    const card = wikiPageToCard("See [[alpha|ends with slash\\]].\n", options())
    expect(card).toContain(`See [ends with slash\\\\](heptabase://card/${id(1)}).`)
  })

  it("uses the card title for a resolved wikilink with an empty label", () => {
    const card = wikiPageToCard("See [[alpha| ]].\n", options())
    expect(card).toContain(`See [Card A](heptabase://card/${id(1)}).`)
  })

  it("marks unsynced links", () => {
    const card = wikiPageToCard("See [[beta]] for more.\n", options())
    expect(card).toContain(`See Title of beta${UNSYNCED} for more.`)
  })

  it("uses wikilink label", () => {
    const card = wikiPageToCard("See [[beta|the second card]] for more.\n", options())
    expect(card).toContain(`See the second card${UNSYNCED} for more.`)
  })

  it("escapes link titles", () => {
    const target: LinkTarget = { cardId: id(3), title: "Draft [v2]" }
    const card = wikiPageToCard("See [[gamma]].\n", options({ resolveLink: () => target }))
    expect(card).toContain(`See [Draft \\[v2\\]](heptabase://card/${id(3)}).`)
  })

  it("treats an embed like a link", () => {
    const card = wikiPageToCard("![[alpha]] and ![[beta]] and ![[beta|label]]\n", options())
    expect(card).toContain(`[Card A](heptabase://card/${id(1)}) and Title of beta${UNSYNCED} and label${UNSYNCED}`)
    expect(card).not.toContain("![[")
  })

  it("converts a wikilink whose pipe is escaped for a table cell", () => {
    const card = wikiPageToCard("| [[beta\\|label]] |\n", options())
    expect(card).toContain(`| label${UNSYNCED} |`)
  })

  it("trims spaces inside a wikilink", () => {
    const card = wikiPageToCard("[[ alpha ]]\n", options())
    expect(card).toContain(`[Card A](heptabase://card/${id(1)})`)
  })

  it("resolves an anchored wikilink by the slug without the anchor", () => {
    const resolved: string[] = []
    const titled: string[] = []
    const card = wikiPageToCard(
      "[[alpha#Some heading]] [[alpha#^block|the label]] [[ alpha #h ]] [[beta#Heading]] [[beta#Heading|the label]]\n",
      options({
        resolveLink: (slug) => {
          resolved.push(slug)
          return slug === "alpha" ? CARD_A : null
        },
        titleForSlug: (slug) => {
          titled.push(slug)
          return `Title of ${slug}`
        },
      }),
    )
    expect(card).toContain(
      `[Card A](heptabase://card/${id(1)}) [the label](heptabase://card/${id(1)}) [Card A](heptabase://card/${id(1)}) ` +
        `Title of beta${UNSYNCED} the label${UNSYNCED}`,
    )
    expect(resolved).toEqual(["alpha", "alpha", "alpha", "beta", "beta"])
    expect(titled).toEqual(["beta"])
  })

  it("writes a same-page anchor as plain text", () => {
    const calls: string[] = []
    const card = wikiPageToCard(
      "See [[#Some heading]] and [[#Some heading|this part]].\n",
      options({
        resolveLink: (slug) => {
          calls.push(slug)
          return null
        },
      }),
    )
    expect(card).toContain("See Some heading and this part.")
    expect(calls).toEqual([])
  })

  it("writes a same-page block reference as the block id, with or without a space after the #", () => {
    const calls: string[] = []
    const card = wikiPageToCard(
      "See [[#^block-one]] and [[# ^block-two]] and [[ # ^ block-three ]] and [[#^block-four|this part]].\n",
      options({
        resolveLink: (slug) => {
          calls.push(slug)
          return null
        },
      }),
    )
    expect(card).toContain("See block-one and block-two and block-three and this part.")
    expect(calls).toEqual([])
  })

  it("passes the slug to resolveLink and titleForSlug", () => {
    const resolved: string[] = []
    const titled: string[] = []
    wikiPageToCard(
      "[[one]] [[two|label]]\n",
      options({
        resolveLink: (slug) => {
          resolved.push(slug)
          return null
        },
        titleForSlug: (slug) => {
          titled.push(slug)
          return slug
        },
      }),
    )
    expect(resolved).toEqual(["one", "two"])
    expect(titled).toEqual(["one"])
  })

  it("adds footer with source cards", () => {
    const card = wikiPageToCard("Body.\n", options({ sourceCards: [CARD_A, CARD_B] }))
    expect(card.endsWith(`\n\n---\n來源：${cardLink(CARD_A)}, ${cardLink(CARD_B)}\n${FOOTER_TAIL}`)).toBe(true)
  })

  it("footer says 無 without source cards", () => {
    const card = wikiPageToCard("Body.\n", options())
    expect(card.endsWith(`\n\n---\n來源：無\n${FOOTER_TAIL}`)).toBe(true)
  })

  it("puts the footer after a body that ends without a newline", () => {
    const card = wikiPageToCard("Last line", options())
    expect(card).toBe(`# Page Title\n\nLast line\n\n---\n來源：無\n${FOOTER_TAIL}`)
  })

  it("makes an empty page a title and a footer", () => {
    const card = wikiPageToCard("---\ntype: concept\n---\n", options())
    expect(card).toBe(`# Page Title\n\n---\n來源：無\n${FOOTER_TAIL}`)
  })

  it("reads CRLF input", () => {
    const card = wikiPageToCard("---\r\ntype: concept\r\n---\r\n# Old\r\n\r\nSee [[alpha]].\r\n", options())
    expect(card).toBe(`# Page Title\n\nSee [Card A](heptabase://card/${id(1)}).\n\n---\n來源：無\n${FOOTER_TAIL}`)
  })

  it("leaves code blocks unchanged", () => {
    const markdown = [
      "Real [[alpha]] and `inline [[alpha]]` and ``double `tick` [[alpha]]``.",
      "",
      "```md",
      "fenced [[alpha]] ![[beta]]",
      "```",
      "",
      "~~~",
      "tilde [[alpha]]",
      "~~~",
      "",
      "After [[beta]].",
      "",
    ].join("\n")
    const card = wikiPageToCard(markdown, options())
    const link = `[Card A](heptabase://card/${id(1)})`
    expect(card).toContain(`Real ${link} and \`inline [[alpha]]\` and \`\`double \`tick\` [[alpha]]\`\`.`)
    expect(card).toContain("```md\nfenced [[alpha]] ![[beta]]\n```")
    expect(card).toContain("~~~\ntilde [[alpha]]\n~~~")
    expect(card).toContain(`After Title of beta${UNSYNCED}.`)
  })

  it("keeps a fence open until its matching close", () => {
    const markdown = "````\n```\n[[alpha]]\n```\n[[alpha]]\n````\n[[alpha]]\n"
    const card = wikiPageToCard(markdown, options())
    const link = `[Card A](heptabase://card/${id(1)})`
    expect(card).toContain("````\n```\n[[alpha]]\n```\n[[alpha]]\n````\n" + link)
  })

  it("leaves a fence inside a list item or a quote unchanged", () => {
    const markdown = "- item [[alpha]]\n  ```js\n  [[alpha]]\n  ```\n\n> ```\n> [[alpha]]\n> ```\n"
    const card = wikiPageToCard(markdown, options())
    expect(card).toContain(`- item [Card A](heptabase://card/${id(1)})\n  \`\`\`js\n  [[alpha]]\n  \`\`\`\n\n> \`\`\`\n> [[alpha]]\n> \`\`\``)
  })

  it("keeps an unclosed fence as code and closes it before the footer", () => {
    const card = wikiPageToCard("Intro.\n\n```\n[[alpha]]\n", options())
    expect(card).toBe(`# Page Title\n\nIntro.\n\n\`\`\`\n[[alpha]]\n\`\`\`\n\n---\n來源：無\n${FOOTER_TAIL}`)
  })

  it("closes an unclosed fence with the same marker and indent", () => {
    const card = wikiPageToCard("- item\n  ~~~~js\n  code\n\n", options())
    expect(card).toBe(`# Page Title\n\n- item\n  ~~~~js\n  code\n  ~~~~\n\n---\n來源：無\n${FOOTER_TAIL}`)
  })

  it("does not add a closing fence when the fence is closed", () => {
    const card = wikiPageToCard("```\ncode\n```\n", options())
    expect(card).toBe(`# Page Title\n\n\`\`\`\ncode\n\`\`\`\n\n---\n來源：無\n${FOOTER_TAIL}`)
  })

  it("treats a lone backtick as text", () => {
    const card = wikiPageToCard("A ` tick and [[alpha]].\n", options())
    expect(card).toContain(`A \` tick and [Card A](heptabase://card/${id(1)}).`)
  })

  it("does not end a code span across a blank line", () => {
    const card = wikiPageToCard("One ` open\n\n[[alpha]] close `\n", options())
    expect(card.match(/heptabase:\/\/card/g)).toHaveLength(1)
  })

  it("leaves text without a closed wikilink alone", () => {
    const markdown = "Open [[alpha and [single] and [[]] and [[a\nb]]\n"
    const card = wikiPageToCard(markdown, options())
    expect(card).toContain("Open [[alpha and [single] and [[]] and [[a\nb]]")
  })
})

describe("cardToSnapshotBody", () => {
  it("snapshot strips mentions, colors, and card links", () => {
    const hepta = [
      `A mention <hepta-mention type="whiteboard" id="${id(5)}">Full Whiteboard Title</hepta-mention> here.`,
      `Some <hepta-color type="text" color="blue">blue words</hepta-color> and <hepta-color type="background" color="yellow">marked</hepta-color>.`,
      `A card [Card A](heptabase://card/${id(1)}) link.`,
      "",
    ].join("\n")
    expect(cardToSnapshotBody(hepta)).toBe(
      ["A mention Full Whiteboard Title here.", "Some blue words and marked.", "A card Card A link.", ""].join("\n"),
    )
  })

  it("strips app.heptabase.com card links", () => {
    const hepta = `See [Card A](https://app.heptabase.com/${id(9)}/card/${id(1)}) and [DOI](https://doi.org/10.0000/example).`
    expect(cardToSnapshotBody(hepta)).toBe("See Card A and [DOI](https://doi.org/10.0000/example).")
  })

  it("keeps other heptabase links and images", () => {
    const hepta = `[Board](https://app.heptabase.com/${id(9)}/whiteboard/${id(4)}) ![pic](heptabase://card/${id(1)})`
    expect(cardToSnapshotBody(hepta)).toBe(hepta)
  })

  it("keeps escaped brackets in a card link title", () => {
    const hepta = `[Draft \\[v2\\]](heptabase://card/${id(3)})`
    expect(cardToSnapshotBody(hepta)).toBe("Draft \\[v2\\]")
  })

  it("strips nested colors and a mention inside a color", () => {
    const hepta =
      `<hepta-color type="text" color="red">a <hepta-color type="background" color="blue">b</hepta-color> ` +
      `<hepta-mention type="card" id="${id(6)}">Mentioned</hepta-mention></hepta-color>`
    expect(cardToSnapshotBody(hepta)).toBe("a b Mentioned")
  })

  it("snapshot marks unsupported blocks", () => {
    const hepta = [
      "Before.",
      `<hepta-placeholder type="whiteboard" id="${id(7)}" />`,
      "Middle.",
      `<hepta-table rows="2">`,
      "| a | b |",
      "|---|---|",
      `<hepta-mention type="card" id="${id(6)}">Inside</hepta-mention>`,
      "</hepta-table>",
      "After.",
    ].join("\n")
    expect(cardToSnapshotBody(hepta)).toBe(
      ["Before.", UNSUPPORTED, "Middle.", UNSUPPORTED, "After."].join("\n"),
    )
  })

  it("marks a placeholder with a closing tag, and only the opening tag of an unclosed table", () => {
    expect(cardToSnapshotBody("<hepta-placeholder></hepta-placeholder>\nx")).toBe(`${UNSUPPORTED}\nx`)
    expect(cardToSnapshotBody('x\n<hepta-table a="1">\nrow')).toBe(`x\n${UNSUPPORTED}\nrow`)
  })

  it("matches tag names in any case and drops a stray closing tag", () => {
    expect(cardToSnapshotBody('<HEPTA-COLOR color="red">R</HEPTA-COLOR> a</hepta-table> <Hepta-Placeholder />')).toBe(
      `R a ${UNSUPPORTED}`,
    )
  })

  it("leaves code blocks unchanged", () => {
    const hepta = [
      `Real [A](heptabase://card/${id(1)}) and \`[A](heptabase://card/${id(1)})\`.`,
      "",
      "```html",
      `<hepta-mention type="card" id="${id(6)}">Kept</hepta-mention>`,
      `<hepta-placeholder />`,
      "```",
      "",
    ].join("\n")
    expect(cardToSnapshotBody(hepta)).toBe(
      [
        `Real A and \`[A](heptabase://card/${id(1)})\`.`,
        "",
        "```html",
        `<hepta-mention type="card" id="${id(6)}">Kept</hepta-mention>`,
        `<hepta-placeholder />`,
        "```",
        "",
      ].join("\n"),
    )
  })

  it("returns text without hepta markup unchanged", () => {
    const text = "# Title\n\nPlain **text** with [a link](https://example.com) and `code`.\n"
    expect(cardToSnapshotBody(text)).toBe(text)
  })
})
