# xenocept-plugin-aeor-gemini

[![npm version](https://img.shields.io/npm/v/xenocept-plugin-aeor-gemini.svg)](https://www.npmjs.com/package/xenocept-plugin-aeor-gemini)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A [Xenocept](https://github.com/th317erd/xenocept) plugin for Google
Gemini. After every screen-annotation session you submit, this plugin
asks a Gemini vision model to read the screenshot — both the literal
on-screen text **and** a factual scene description — and writes both
back to the session so they're full-text indexed and searchable.

> **Provider plugin, not a feature plugin.** Today it's OCR-only.
> Tomorrow it can also expose a Gemini-as-destination role under the
> same `xenocept-plugin-aeor-gemini` package — one install, one API
> key, multiple capabilities. Pick which features you want from the
> Configure dialog instead of installing N separate `-ocr` / `-chat`
> packages.

---

## What you get per session

Every new session triggers one Gemini vision call. The plugin asks for
two distinct outputs that both land on the session record:

| Field on the session | Optimized for | Example output (a code editor screenshot) |
|---|---|---|
| `ocr_text` | Literal text recall — find a session by the exact words that were on screen. | `File Edit Selection View … src/lib/foo.rs  fn parse_template(... )  // Pre-parse string literals …` |
| `alternative_description` | Concept recall — find a session by what the application / scene WAS, even if the words don't match. | `Visual Studio Code in dark theme. Rust source file open showing the parse_template function. Left sidebar shows a git diff. Status bar reads "main • 0 ↑ 0 ↓".` |

Both fields are written through Xenocept's `/api/v1/sessions/{id}/enrich`
endpoint and immediately picked up by the trigram index. Search across
your session history works on either field — so "vscode rust parser
dark" finds it, and so does pasting the literal function name you saw.

---

## Requirements

- A **Google AI Studio API key** — generate one for free at
  [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
- **Internet** — one outbound `POST` to
  `generativelanguage.googleapis.com` per session.
- **Costs** — billed to your Google account at the model's per-token
  rate. `gemini-2.5-flash` (the default) typically costs a fraction of
  a US cent per screenshot. `gemini-2.5-pro` is several times that for
  higher accuracy on dense or small-text screenshots.

---

## Installation

### From npm (recommended)

1. In the Xenocept client, open **Settings → Plugins → Browse Plugins**.
2. Search for `gemini`.
3. Click **Install** on `xenocept-plugin-aeor-gemini`.
4. Click **Configure** on the installed card.
5. Paste your API key and hit **Save**.

### Local development

If you're hacking on the plugin source itself, push your local copy
straight into a running Xenocept instance without going through npm:

```sh
./install.sh                       # defaults to http://127.0.0.1:9500
./install.sh http://127.0.0.1:9500  # explicit
```

That `PUT`s `index.mjs` + `package.json` into Xenocept's plugin store.
Reload the client to pick the new code up.

---

## Configuration

| Field | Default | Notes |
|---|---|---|
| **API key** | _(empty)_ | Stored in Xenocept's local database; transmitted only to Google. |
| **Model** | `gemini-2.5-flash` | Curated dropdown of Gemini v1beta vision models. `2.5-flash` is the cheapest, `2.5-pro` the most accurate. |
| **Wait until OCR completes before submission** | _on_ | When **on** (default): a fresh session's auto-send dispatch waits up to ~30s for Gemini to finish, so destinations (Claude Code, Email, etc.) receive a message that already contains `ocrText` and `alternativeDescription`. When **off**: the session is dispatched immediately with empty enrichment, Gemini runs in the background, and Xenocept re-indexes the session when the result lands — so search still finds it, just a few seconds later. |

### Choosing the wait setting

| If your downstream consumer is… | Recommended |
|---|---|
| An AI agent (Claude Code, Codex, etc.) that reads the message and acts on it | **Wait on** — the agent needs the OCR text to be useful. |
| An archival destination (email, file dump) where you just want the screenshot delivered fast | **Wait off** — the screenshot ships immediately, OCR catches up in the background. |

---

## Per-session behavior

- Runs automatically on **every new session** after the plugin is
  configured. Existing sessions are not back-filled.
- **Inflight serialization** — at most one Gemini call in flight at a
  time per user. A rapid burst of captures queues; nothing fans out
  into a rate-limit hit.
- **Silent skip when unconfigured** — until you paste an API key the
  plugin is a no-op (no logs, no errors, just silence).
- **Failure is non-fatal** — if Gemini returns an error the session
  still dispatches with empty enrichment; the failure is logged to the
  Xenocept console (mirrored to `/tmp/xenocept.log` if you have the
  operator log tee installed).

---

## Privacy

Each session sends:

- The composite screenshot PNG.
- A prompt instructing the model to transcribe + describe.
- Your API key, in the request header.

All three go to `generativelanguage.googleapis.com` only. The plugin
makes no other outbound calls. Generated text stays in Xenocept's local
database — nothing is uploaded anywhere except Google.

---

## Roadmap

- **Gemini-as-destination role** under the same plugin — send sessions
  to Gemini for AI-driven analysis or response, the same way the Claude
  plugin pushes to Claude Code via MCP. Same `xenocept-plugin-aeor-gemini`
  install; new toggle in Configure.

---

## License

MIT — see [LICENSE](./LICENSE).
