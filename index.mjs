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
  const aeorSelect   = elements['aeor-select'];
  const aeorCheckbox = elements['aeor-checkbox'];

  register(class GeminiOcrPlugin extends context.Plugin {
    static pluginID    = PLUGIN_ID;
    static name        = 'Gemini OCR';
    static version     = '1.4.0';
    static icon        = '\u{1F50D}'; // 🔍
    static description = 'OCR sessions with Google Gemini. Requires an API key — costs accrue to your Google account at the model\'s per-token rate.';

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
    renderConfigUI(container, currentConfig, _host) {
      const cfg = currentConfig || {};
      const apiKeyValue = cfg.apiKey || '';
      const modelValue  = cfg.model  || DEFAULT_MODEL;

      const apiKeyGroup = div.class('form-group')(
        label.class('form-label').for('gemini-ocr-api-key')('API key'),
        input.type('password').id('gemini-ocr-api-key').name('apiKey')
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
        label.class('form-label').for('gemini-ocr-model')('Model'),
        aeorSelect
          .id('gemini-ocr-model')
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

      // Phase toggle — Processing (block dispatch until OCR finishes) vs
      // Completion (dispatch immediately, OCR runs after and re-indexes
      // the session). Default is the safer "block" behavior so the very
      // first message a destination sees already carries the enrichment.
      // Uses the shared aeor-checkbox so the form harvester picks the
      // value up via the internal <input name="wait_until_completion">.
      const waitDefault = (cfg.wait_until_completion !== false); // default true
      let waitCheckbox = aeorCheckbox.name('wait_until_completion').id('gemini-ocr-wait');
      if (waitDefault) waitCheckbox = waitCheckbox.checked('');
      const waitGroup = div.class('form-group')(
        waitCheckbox('Wait until OCR completes before submission'),
        div.class('settings-hint')(
          'On (default): the session waits up to ~30s for Gemini to finish,',
          ' so destinations receive the OCR text and AI description with the',
          ' initial message. Useful for Claude / Codex / agent destinations.',
          ' Off: the session is dispatched immediately with no enrichment,',
          ' and Gemini runs in the background — the session is re-indexed',
          ' when OCR completes so search still finds it later. Useful if your',
          ' workflow only needs the screenshot delivered fast.',
        ),
      );

      const note = p.class('plugin-marketplace-notice')(
        'OCR runs automatically on every new session after this plugin is configured.',
        ' Existing sessions are not back-filled.',
      );

      container.appendChild(apiKeyGroup.build(document));
      container.appendChild(modelGroup.build(document));
      container.appendChild(waitGroup.build(document));
      container.appendChild(note.build(document));

      // Invalidate cached config so the next session pickup re-reads.
      this._configCache = null;
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

    /// PROCESSING phase — runs as part of the pre-dispatch barrier.
    /// Only does work if the user has the "Wait until OCR completes
    /// before submission" checkbox ON (the default). When OFF, we
    /// defer to onCompletion below so the session dispatches first
    /// and OCR backfills after.
    async onProcessing({ sessionID }) {
      const config = await this._loadConfig();
      if (config.wait_until_completion === false) return;
      return this._run(sessionID, config);
    }

    /// COMPLETION phase — runs after dispatch returns. Only does work
    /// if the user has explicitly opted out of the barrier above. In
    /// that case the destinations already saw an un-enriched session;
    /// our /enrich call re-indexes it so search picks it up.
    async onCompletion({ sessionID }) {
      const config = await this._loadConfig();
      if (config.wait_until_completion !== false) return;
      return this._run(sessionID, config);
    }

    async _run(sessionID, config) {
      if (!sessionID) return;
      if (this._inflight >= this._maxInflight) {
        log.info('skipping — another OCR call is already in flight for this user');
        return;
      }

      const apiKey = (config.apiKey || '').trim();
      const model  = (config.model  || DEFAULT_MODEL).trim();
      if (!apiKey) {
        // Quietly opt out until the user configures a key. Don't spam
        // the console on every session.
        return;
      }

      this._inflight++;
      try {
        const { ocrText, altDescription } = await this._extract(sessionID, apiKey, model);
        // Push both fields through xenocept's generic enrich endpoint
        // in a single round-trip; the backend merges them into
        // session.json and re-runs the indexer.
        await fetch(`/api/v1/sessions/${encodeURIComponent(sessionID)}/enrich`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            fields: {
              ocr_text:                ocrText,
              alternative_description: altDescription,
            },
          }),
        });
        log.info(`ocr ok for ${sessionID} (text=${ocrText.length}, desc=${altDescription.length})`);
      } catch (error) {
        log.warn(`ocr failed for ${sessionID}:`, error);
      } finally {
        this._inflight--;
      }
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
