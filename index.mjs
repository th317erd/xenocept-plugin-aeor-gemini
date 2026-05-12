'use strict';

/**
 * xenocept-plugin-aeor-gemini
 *
 * Google-Gemini-provider plugin for Xenocept. Currently provides OCR
 * (and is designed to grow into a single Gemini-provider bundle —
 * one API key, multiple roles, no separate "-ocr" / "-chat" packages).
 *
 * OCR path: subscribes to xenocept's session-submitted hook. For each
 * newly created session, fetches the composite screenshot, asks a
 * Gemini vision model for literal on-screen text + a scene description,
 * and posts both back to xenocept so they get indexed and become
 * searchable.
 *
 * The plugin runs in the client webview, so the API key never leaves
 * the user's machine except in the one outbound request to
 * generativelanguage.googleapis.com. Costs and rate limits live with
 * the user's Google account; this plugin makes no attempt to manage
 * either beyond a soft inflight cap.
 */

const PLUGIN_ID    = 'org.aeor.xenocept.gemini';
const DEFAULT_MODEL = 'gemini-2.5-flash';

/// Two-task prompt: literal text extraction + analyst-style scene
/// description. Both fields are indexed by xenocept's trigram pipeline,
/// so the prompt is tuned for *search recall*: dense, factual, lots of
/// concrete nouns and verbs. Storyteller / narrative language is
/// explicitly discouraged because it adds tokens that don't help fuzzy
/// match.
const PROMPT = [
  'You will analyze a screen capture and produce a JSON object with exactly two string fields.',
  '',
  '"ocr_text":',
  '  Transcribe ALL visible text in the image — every word, label, button text, menu item,',
  '  filename, URL, code, error message, tooltip, watermark, anything literal.',
  '  Concatenate everything into one block of text in natural reading order',
  '  (top-to-bottom, left-to-right; group by logical region — window, panel, dialog).',
  '  Preserve casing and punctuation. Use newlines between distinct regions for clarity.',
  '  Do NOT include descriptions, formatting, or markdown. Just the literal text.',
  '  If the image contains no readable text, return an empty string.',
  '',
  '"alternative_description":',
  '  Describe the image in dense, analytical detail. The output is used for full-text indexing,',
  '  so optimize for SEARCH RECALL: concrete nouns, identifiable applications, named UI',
  '  elements, recognizable objects, file types, languages, frameworks, brand names.',
  '  Specifically include, when visible:',
  '    • The application/program/website (e.g. "Visual Studio Code", "Slack", "Firefox showing',
  '      github.com", "macOS Finder", "GIMP image editor"). Identify it specifically; if',
  '      uncertain, give your best guess and a runner-up.',
  '    • The window/panel layout (sidebar, tabs, modal, toolbar, status bar).',
  '    • Domain content: code language, repo/file paths, document type, chart type, app screen.',
  '    • Imagery: name objects/people/scenes if photos are present.',
  '    • Theme colors only if distinctive (dark vs light, dominant accent color).',
  '  Do NOT use storytelling language, mood adjectives, or aesthetic commentary.',
  '  Be exhaustive on facts, terse on prose. Multiple sentences are fine; bullet points are not.',
  '',
  'Respond with strict JSON: { "ocr_text": "...", "alternative_description": "..." }.',
  'No markdown fences, no commentary outside the JSON.',
].join('\n');

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    ocr_text:                { type: 'string' },
    alternative_description: { type: 'string' },
  },
  required: ['ocr_text', 'alternative_description'],
};

/// Curated list of vision-capable Gemini models that work against the
/// v1beta `generateContent` endpoint. Surfaced as the dropdown options;
/// the field is creatable so power users can still type any other model
/// id Google ships in the future without waiting for a plugin update.
const KNOWN_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
];

export function setup(context) {
  const { register, elements, log } = context;
  const { div, label, input, p, code, option } = elements;
  const aeorSelect        = elements['aeor-select'];
  const aeorConfirmButton = elements['aeor-confirm-button'];

  register(class GeminiPlugin extends context.Plugin {
    static pluginID    = PLUGIN_ID;
    static name        = 'Gemini';
    static version     = '1.6.0';
    static icon        = '\u{1F50D}'; // 🔍
    static description = 'OCR sessions with Google Gemini. Requires an API key — costs accrue to your Google account at the model\'s per-token rate.';
    /// Declare the OCR role so the loader's master/slave chain knows
    /// to include this plugin (and skip it from the parallel
    /// onProcessing fan-out, where it would race other OCR providers).
    static role        = 'ocr';

    constructor(ctx) {
      super(ctx);
      this._ctx           = ctx;
      this._inflight      = 0;
      this._maxInflight   = 1; // serialize OCR calls so a burst of submits doesn't fan out
      this._configCache   = null;
    }

    /// Plugin-level config UI. Same renderConfigUI shape destinations
    /// use, so the host's generic config modal can host us. Any [name]'d
    /// field is auto-persisted by the host.
    ///
    /// Async because the OCR-master row needs to know who the current
    /// master is before deciding whether to render a "Hold to promote"
    /// confirm-button vs a "you're the master" status hint. The host
    /// awaits this method (see openPluginConfigModal) so the modal
    /// mounts in its final layout, not flickering.
    async renderConfigUI(container, currentConfig, _host) {
      const cfg = currentConfig || {};
      const apiKeyValue = cfg.apiKey || '';
      const modelValue  = cfg.model  || DEFAULT_MODEL;

      const apiKeyGroup = div.class('form-group')(
        label.class('form-label').for('gemini-api-key')('API key'),
        input.type('password').id('gemini-api-key').name('apiKey')
          .placeholder('AIza...').value(apiKeyValue)(),
        div.class('settings-hint')(
          'Generate one at ', code('aistudio.google.com/apikey'),
          '. Stored in xenocept\'s local database; never transmitted except to Google.',
        ),
      );

      // Plain aeor-select — Gemini's model list is finite and curated.
      // If the saved value isn't one we know about (older config from a
      // previous list), we still include it as an option so the select
      // resolves to a real entry instead of falling back to placeholder.
      const modelOptions = KNOWN_MODELS.includes(modelValue)
        ? KNOWN_MODELS
        : [modelValue, ...KNOWN_MODELS];

      const modelGroup = div.class('form-group')(
        label.class('form-label').for('gemini-model')('Model'),
        aeorSelect
          .id('gemini-model')
          .name('model')
          .placeholder(DEFAULT_MODEL)
          .value(modelValue)(
            ...modelOptions.map((m) => option.value(m)(m)),
          ),
        div.class('settings-hint')(
          'Default ', code(DEFAULT_MODEL), ' is the cheapest vision-capable Gemini.',
          ' ', code('gemini-2.5-pro'), ' is the highest-accuracy option (and costs more per token).',
        ),
      );

      const note = p.class('plugin-marketplace-notice')(
        'OCR runs automatically on every new session after this plugin is configured.',
        ' Existing sessions are not back-filled.',
      );

      container.appendChild(apiKeyGroup.build(document));
      container.appendChild(modelGroup.build(document));
      container.appendChild(note.build(document));

      // OCR master/slave promotion. The button takes 5 seconds of
      // sustained hold to confirm (aeor-confirm-button) so it can't be
      // accidentally clicked. When confirmed, this plugin becomes the
      // master; the loader's chain calls it first on every session
      // and only falls through to slaves on failure.
      await this._renderOcrMasterControl(container);

      // Invalidate cached config so the next session pickup re-reads.
      this._configCache = null;
    }

    async _renderOcrMasterControl(container) {
      const { div }           = context.elements;
      const aeorConfirmButton = context.elements['aeor-confirm-button'];
      const aeorInfoBox       = context.elements['aeor-info-box'];

      // Resolve role-level state BEFORE building so we can express the
      // whole row declaratively in one DSL tree. No post-build innerHTML
      // or appendChild rewriting.
      let currentMasterID = null;
      try { currentMasterID = await context.getOcrMaster?.(); } catch { /* ignore */ }
      const amMaster = currentMasterID === 'xenocept-plugin-aeor-gemini';

      // The button is always present. When this plugin is the current
      // master, it's disabled — there's nothing to promote to. When this
      // plugin is a slave (or no master is set), holding the button for
      // 5 seconds promotes it. Master/slave is explained in the info-box
      // beneath either way so the user understands what the action
      // implies before they perform it.
      let confirmBtn = aeorConfirmButton
        .label(amMaster ? 'OCR master (current)' : 'Hold to make OCR master')
        .confirmedText('Now OCR master ✓')
        .duration('5000')
        .ariaLabel(amMaster
          ? 'This plugin is already the OCR master'
          : 'Hold for 5 seconds to make Gemini the OCR master');
      if (amMaster) {
        confirmBtn = confirmBtn.disabled('');
      } else {
        // The DSL maps `.onXxx(handler)` to addEventListener('xxx') —
        // same wiring as `.onClick`, just for the custom `confirm`
        // event aeor-confirm-button dispatches when the hold completes.
        confirmBtn = confirmBtn.onConfirm(async () => {
          try {
            await context.setOcrMaster('xenocept-plugin-aeor-gemini');
            log.info('promoted to OCR master');
          } catch (error) {
            log.warn('failed to promote to OCR master:', error);
          }
        });
      }

      const masterRow = div.class('form-group')(
        confirmBtn(),
        aeorInfoBox.kind(amMaster ? 'success' : 'info')(
          amMaster
            ? 'This plugin is the current OCR master. It runs first on every session; other OCR plugins are slaves and only run if it fails. To swap, open another OCR plugin\'s Configure dialog and hold its master button.'
            : 'OCR runs in a master/slave chain. The master tries first on every session; if it returns no result or fails, the loader falls through to slaves in install order. Hold the button above for 5 seconds to make this plugin the master.',
        ),
      );

      container.appendChild(masterRow.build(document));
    }

    async _loadConfig() {
      // Fetch fresh on every call — caching here causes a real bug: if
      // the plugin instance is created before the user configures their
      // API key, the cached empty object short-circuits every future
      // onSubmit even after the key is saved. A single GET against a
      // local endpoint per session is cheap.
      try {
        const r = await fetch(`/api/v1/plugins/npm/${encodeURIComponent(PLUGIN_ID)}/config`);
        // Plugin id and directory id can diverge for npm plugins — try
        // the package name as a fallback so we work whether the host
        // keys configs by directory or by pluginID.
        let cfg = r.ok ? await r.json() : null;
        if (!cfg || !cfg.apiKey) {
          const r2 = await fetch(`/api/v1/plugins/npm/xenocept-plugin-aeor-gemini/config`);
          if (r2.ok) cfg = await r2.json();
        }
        return cfg || {};
      } catch (error) {
        log.warn('failed to read plugin config:', error);
        return {};
      }
    }

    /// OCR-role provider — called by the loader's OCR chain. Returns
    /// `{ ocr_text, alternative_description }` on success; throws or
    /// returns null on failure so the chain can fall through to the
    /// next slave provider. The loader takes care of writing the
    /// result to `/enrich`, so this method just produces data.
    async onOcr({ sessionID }) {
      if (!sessionID) return null;
      if (this._inflight >= this._maxInflight) {
        log.info('skipping — another Gemini OCR call is already in flight');
        return null;
      }
      const config = await this._loadConfig();
      const apiKey = (config.apiKey || '').trim();
      const model  = (config.model  || DEFAULT_MODEL).trim();
      if (!apiKey) return null; // unconfigured — declining lets the chain move on

      this._inflight++;
      try {
        const { ocrText, altDescription } = await this._extract(sessionID, apiKey, model);
        if (!ocrText && !altDescription) return null;
        return {
          ocr_text:                ocrText,
          alternative_description: altDescription,
        };
      } finally {
        this._inflight--;
      }
    }

    /// Tells the loader's chain whether to invoke us during the
    /// OCR runs in the Processing phase — the session waits for OCR
    /// to land before dispatch so the very first message a destination
    /// receives already carries the enrichment. This used to be a
    /// per-plugin toggle; we collapsed it to a fixed default because
    /// the alternative (background-then-reindex) was confusing in the
    /// UI and no one set it.
    async preferredOcrPhase() {
      return 'processing';
    }

    async _extract(sessionID, apiKey, model) {
      // Fetch the composite screenshot as bytes, base64-encode for the
      // Gemini inlineData payload. Browsers don't expose btoa for raw
      // binary cleanly, so we go via Uint8Array → chunked btoa.
      const imgURL = `/api/v1/sessions/${encodeURIComponent(sessionID)}/files/screenshot.png`;
      const imgRes = await fetch(imgURL);
      if (!imgRes.ok) throw new Error(`screenshot ${imgRes.status}`);
      const buf = await imgRes.arrayBuffer();
      const b64 = bytesToBase64(new Uint8Array(buf));

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const body = {
        contents: [{
          parts: [
            { text: PROMPT },
            { inlineData: { mimeType: 'image/png', data: b64 } },
          ],
        }],
        generationConfig: {
          temperature:      0,
          // Allow plenty of room — alternative_description can be long
          // when the screenshot has lots of identifiable detail.
          maxOutputTokens:  8192,
          // Force structured JSON so we don't have to scrape markdown
          // fences or apologize-prefixes.
          responseMimeType: 'application/json',
          responseSchema:   RESPONSE_SCHEMA,
        },
      };

      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`gemini ${res.status}: ${errBody.slice(0, 200)}`);
      }
      const json = await res.json();

      // With responseMimeType=application/json the model returns the
      // structured object as a JSON string in parts[0].text.
      const parts   = json?.candidates?.[0]?.content?.parts || [];
      const rawJson = parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('').trim();
      let parsed;
      try {
        parsed = JSON.parse(rawJson);
      } catch (error) {
        throw new Error(`gemini returned non-JSON: ${rawJson.slice(0, 200)}`);
      }
      return {
        ocrText:        typeof parsed.ocr_text                === 'string' ? parsed.ocr_text                : '',
        altDescription: typeof parsed.alternative_description === 'string' ? parsed.alternative_description : '',
      };
    }
  });
}

/// Encode a Uint8Array as base64 without blowing the call stack on big
/// images (window.btoa is fine, but String.fromCharCode(...largeArray)
/// can OOM the spread).
function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
