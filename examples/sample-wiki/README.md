# Sample wiki

This folder is a small example of a finished Mechanism Wiki. It has two uses:

- A person can read it to see what the wiki holds after the first sources arrive.
- Tests can build it on disk and use it as a fixture. The helper `materializeSampleWiki` in `src/test-helpers/sample-wiki.ts` does this.

## Overlay on the template

The sample is an overlay on `templates/mechanism-wiki/`. It holds only the files that differ from the template. `materializeSampleWiki` first copies the template files. It then copies this folder on top, so a file here replaces the template file with the same path. It also creates the folders that the app makes for a new project.

## Files

| File | What it does |
|---|---|
| `purpose.md` | Replaces the template purpose. It sets the output language and the goal of the sample. |
| `domains.yaml` | Replaces the empty domain list with three domains: `hardware/async-circuits`, `ai/architecture`, and `business/franchising`. |
| `raw/sources/async-handshake-circuits.md` | A short article on circuits that run without a global clock. |
| `raw/sources/spiking-neural-networks.md` | A short article on neural networks that compute with spikes. |
| `raw/sources/franchise-licensing.md` | A short article on how franchising works. |

## What the sample shows

The circuits article and the spiking article come from two different fields. Both describe an event-driven design: work happens only when an event arrives, and idle parts use little energy. This makes the pair a mechanism candidate that spans two domains. The franchising article is a third field with no direct link to the first two.

The articles are written in plain English from general knowledge. They quote no outside text.
