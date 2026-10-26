/**
 * template-picker.test.tsx - the template picker shows each template in the language of the UI.
 *
 * The picker renders to static markup: the tests need no DOM.
 */
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import i18n from "@/i18n"
import { mechanismTemplate } from "@/lib/mechanism-template"
import { templates } from "@/lib/templates"
import { TemplatePicker } from "./template-picker"

const LANGUAGES = ["en", "it", "ru", "zh"] as const

function render(): string {
  return renderToStaticMarkup(createElement(TemplatePicker, { selected: "general", onSelect: () => {} }))
}

/** Characters of the Han script that exist only in the Traditional form, and a few that exist only in the Simplified form. */
const TRADITIONAL_ONLY = /[機學個這後點開關據寫類說對與來時動體應區語]/
const SIMPLIFIED_ONLY = /[机学个这后点开关据写类说对与来时动体应区语]/

afterEach(async () => {
  await i18n.changeLanguage("en")
})

describe("TemplatePicker", () => {
  it("has a translation of the name and the description of every template in every language", () => {
    for (const language of LANGUAGES) {
      const t = i18n.getFixedT(language)
      for (const template of templates) {
        expect(i18n.exists(`templates.${template.id}.name`, { lng: language, fallbackLng: false }), `${language} ${template.id} name`).toBe(true)
        expect(i18n.exists(`templates.${template.id}.description`, { lng: language, fallbackLng: false }), `${language} ${template.id} description`).toBe(true)
        expect(t(`templates.${template.id}.name`).trim(), `${language} ${template.id}`).not.toBe("")
      }
    }
  })

  it("shows the mechanism template in English with the name and the description of the template", async () => {
    await i18n.changeLanguage("en")
    const html = render()

    expect(html).toContain(mechanismTemplate.name)
    expect(html).toContain(mechanismTemplate.description)
  })

  it("shows the mechanism template in the language of the UI, not in English", async () => {
    for (const language of ["it", "ru", "zh"] as const) {
      await i18n.changeLanguage(language)
      const html = render()
      expect(html, language).not.toContain(mechanismTemplate.name)
      expect(html, language).not.toContain(mechanismTemplate.description)
      const t = i18n.getFixedT(language)
      expect(html, language).toContain(t("templates.mechanism.name"))
      expect(html, language).toContain(t("templates.mechanism.description"))
    }
  })

  it("shows Chinese in the Chinese UI, in Simplified characters like the other zh strings", async () => {
    await i18n.changeLanguage("zh")
    const name = i18n.t("templates.mechanism.name")
    const description = i18n.t("templates.mechanism.description")

    expect(name).toMatch(/[一-鿿]/)
    expect(description).toMatch(/[一-鿿]/)
    expect(`${name}${description}`).not.toMatch(TRADITIONAL_ONLY)
    expect(`${name}${description}`).toMatch(SIMPLIFIED_ONLY)
    // The description names the three jobs of the template, as the English one does.
    expect(description).toContain("Heptabase")
  })

  it("writes the Russian name in Cyrillic and the Italian one in Latin letters", async () => {
    await i18n.changeLanguage("ru")
    expect(i18n.t("templates.mechanism.name")).toMatch(/^[Ѐ-ӿ\s]+$/)
    expect(i18n.t("templates.mechanism.description")).toMatch(/[Ѐ-ӿ]/)
    await i18n.changeLanguage("it")
    expect(i18n.t("templates.mechanism.name")).toMatch(/^[A-Za-zÀ-ÿ\s]+$/)
  })
})
