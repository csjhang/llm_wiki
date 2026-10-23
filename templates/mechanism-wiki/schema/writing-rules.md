# Writing rules

These rules apply to the text of wiki pages in any output language.
The rules are in English. Each rule has one short example in Traditional Chinese.
In each example, 壞 marks a bad example and 好 marks a good example.

## 1. One term has one meaning

Use the term from `docs/glossary.md`. Do not use a synonym for a glossary term. Do not use one word for two meanings.

壞：同一頁先寫「機制」，後面改寫「模式」或「原理」，指的是同一件事。
好：全頁只寫「機制」。

## 2. One idea per sentence

Write one idea in each sentence. If a sentence has two ideas, split it in two.

壞：事件驅動電路沒有時鐘，所以省電，而且它也比較難驗證。
好：事件驅動電路沒有時鐘。所以它省電。它也比較難驗證。

## 3. Use active voice

Name the actor first. Then write the action.

壞：計算是由輸入的變化觸發的。
好：輸入的變化觸發計算。

## 4. Put the conclusion first

Start a page with the conclusion. Start a paragraph with its main point. Then give the reasons.

壞：因為電路沒有全域時鐘，每個模組要自己交握，所以事件驅動電路比較省電。
好：事件驅動電路比較省電。原因是電路沒有全域時鐘，只有變化時才計算。

## 5. Keep sentences short

In English, use at most 25 words in a sentence. In Chinese, use at most 40 characters in a sentence.

壞：這個機制在輸入沒有變化的時候不會進行任何計算而且也不會消耗額外的能量並且能夠在變化發生時立刻回應。
好：輸入沒有變化時，這個機制不計算。它也不耗能。變化發生時，它立刻回應。

## 6. Write a user note as the user's view

A note is the view of the user. Write who holds the view. Do not write it as a fact.

壞：事件驅動一定比輪詢省電。
好：使用者認為事件驅動比輪詢省電。

## 7. Cite a source for every claim

Add the source file name to `sources` in the frontmatter, for example `paper.md`. A `sources` entry is the name of a source file. Link the source page in the body with `[[slug]]`. If you have no source, write the claim as a question to verify.

壞：非同步電路的功耗比同步電路低 30%。
好：一篇原文指出，非同步電路的功耗比同步電路低，但沒有給數字。[[async-circuits-survey]]

## Source of these rules

These rules are our own summary. They are inspired by the principles of Simplified Technical English.
The source of those principles is ASD-STE100, Issue 9 (2025).
This repository does not include the standard itself, because ASD owns its copyright.
To read the standard, get a copy from ASD. Keep your copy on your own computer.
Write the path of your copy in your own notes. Add that path to `.gitignore`. Never commit the copy.
