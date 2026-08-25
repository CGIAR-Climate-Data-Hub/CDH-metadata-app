// AI assistant: OpenRouter chat that fills the form by emitting a partial record.
import { flatten, scalarize, enumOf, html, raw, HIDDEN } from './schema-form.js';

const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OR_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const getKey = () => localStorage.getItem('or_api_key') || '';
const getModel = () => localStorage.getItem('or_model') || OR_MODEL;
const SKILL_URL = 'https://raw.githubusercontent.com/CGIAR-Climate-Data-Hub/skills/main/.agents/skills/cdh-metadata/SKILL.md';
const TEMPLATE_URL = 'https://raw.githubusercontent.com/CGIAR-Climate-Data-Hub/skills/main/.agents/skills/cdh-metadata/references/cdh-annotated-template.md';

const $ = id => document.getElementById(id);

// A fill naming spatial.geography must not take spatial.bbox with it, so nested objects
// merge key by key. Arrays replace whole — merging them by index would corrupt a bbox.
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  return out;
};

// The field reference is generated from the schema, so it can never drift from it.
// Semantics come from the skill; this is just the shape the <fill> block must take.
function fieldReference(schema) {
  const { props, required } = flatten(schema);
  // Unions collapse the same way they do in the form, so the reference describes the
  // shape the user will actually be shown.
  const cap = (list, n) => `${list.slice(0, n).join(' | ')}${list.length > n ? ' | …' : ''}`;
  const shape = d => {
    const s = scalarize(d), en = enumOf(d);
    if (s.type === 'array') {
      if (en) return `array of: ${cap(en, 6)}`;
      const it = scalarize(s.items || {});
      return it.properties ? `array of objects {${Object.keys(it.properties).join(', ')}}` : 'array of strings';
    }
    if (en) return `one of: ${cap(en, 8)}`;
    if (s.properties) return `object {${Object.keys(s.properties).join(', ')}}`;
    return s.type || 'string';
  };
  return Object.entries(props)
    .filter(([k]) => !HIDDEN.has(k))
    .map(([k, d]) => `  ${(k + (required.has(k) ? ' *' : '')).padEnd(22)}${shape(d)}`)
    .join('\n');
}

// SKILL.md and the template are the canonical, shared docs (Claude Code and other
// consumers read them whole) — we don't edit those files. Instead we trim OUR OWN copy
// of the fetched text before it goes in the system prompt, cutting only what this form
// never needs: content this app's own overrides make moot (Stage 1/3 are skipped,
// $schema/cdh_schema_version/extensions/created/updated are all HIDDEN — the AI is told
// never to emit them), pure migration history (old-version breaking-change tables), and
// shallow/low-novelty field shapes already stated in FIELD_REFERENCE + SKILL.md's own
// Hard Rules (contacts, citation, keywords, core identity, temporal) — any mistake there
// still gets caught by checkFill() after the fill. What's kept is exactly the ground
// truth for the parts most likely to be guessed wrong: spatial.resolution, dimensions/
// variables/joins, classification, the cdh.usage restructure, climate, and data assets.
// Fails safe: if a marker isn't found (the upstream doc got reworded), that cut is
// skipped rather than corrupting the text — this list just needs a look eventually.
const cut = (text, from, to) => {
  const s = text.indexOf(from);
  if (s === -1) return text;
  const e = to ? text.indexOf(to, s + from.length) : text.length;
  return e === -1 ? text : text.slice(0, s) + text.slice(e);
};

function trimSkill(text) {
  let t = text;
  t = cut(t, '## Stage 1', '## Stage 2');                                  // file inspection — this app skips it
  t = cut(t, '## Stage 3', '## Stage 4');                                  // plan confirmation — this app skips it
  t = cut(t, '**Mandatory header lines:**', '**Hard rules');               // HIDDEN fields' YAML
  t = cut(t, '**Extension URLs', '## Controlled vocabularies');            // extensions[] is HIDDEN
  t = cut(t, '## Reference', null);                                        // moot — we inline the template ourselves
  return t;
}

function trimTemplate(text) {
  let t = text;
  t = cut(t, '# ── Schema declaration', '# ── Series');                    // HIDDEN fields + shallow core identity
  t = cut(t, '# ── Keywords', '# ── Spatial');                             // shallow: keywords/contact/citation/etc.
  t = cut(t, '# ── Temporal', '# ── Datacube extension — Dimensions');     // already spelled out in Hard Rules
  t = cut(t, '# ── Additional links', '```');                              // trivial, low risk
  t = cut(t, '## Key v0.3.0 breaking changes', null);                      // migration history, not relevant live
  t = t.replace(
    '# Full commodity vocab includes: wheat, rice, maize, barley, sorghum, millets, pearl-millet,\n' +
    '# cassava, potato, sweet-potatoes, yams, common-bean, chickpeas, cowpeas, pigeon-pea, lentils,\n' +
    '# soybeans, groundnuts, coconuts, oil-palms, sunflower, rapeseed, sesame, sugarcane, sugarbeet,\n' +
    '# cotton, coffee, robusta-coffee, cocoa, tea, tobacco, banana, plantains, citrus, tomatoes,\n' +
    '# onions, vegetables, rubber, cattle, buffalo, chickens, goats, swine, sheep, and more.\n',
    '# Closed vocabulary — see FIELD_REFERENCE; an unlisted value gets flagged after fill, not fatal.\n'
  );
  return t;
}

// The form-specific override that goes in front of the skill. Kept as prose in
// prompt.md so it can be edited without touching JS — no backtick or ${} escaping.
// Resolved against this module, not the page, so it survives being moved.
const PROMPT_URL = new URL('prompt.md', import.meta.url);
const FALLBACK = 'You are a CDH Metadata Assistant embedded in a browser form. Never print YAML.\n' +
  'Whenever you know field values, emit them as a partial CDH record inside <fill>{...}</fill>\n' +
  'using real schema keys and nesting. Fields ( * = required):\n{{FIELD_REFERENCE}}';

// Bold, italic, inline code. Escaping comes first, so nothing the model writes can
// become an element. ponytail: `.bubble` is pre-wrap, so newlines and "- item" lines
// keep their shape without a list parser.
const mdToHtml = text => text
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  .replace(/`([^`\n]+)`/g, '<code>$1</code>');

export function initChat({ form, schema, setStatus, act }) {
  let history = [], busy = false, SYS = null;

  // Two halves: prompt.md is the form-specific override (local, editable prose),
  // SKILL.md is the CDH knowledge base (fetched from the skills repo).
  (async function loadPrompt() {
    const el = $('skill-status');
    const get = async (url, what) => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.text();
      } catch (err) {
        console.warn(`[CDH] ${what} unavailable:`, err.message);
        return null;
      }
    };
    const [override, skillRaw, templateRaw] = await Promise.all(
      [get(PROMPT_URL, 'prompt.md'), get(SKILL_URL, 'skill'), get(TEMPLATE_URL, 'template')]);
    const skill = skillRaw ? trimSkill(skillRaw) : skillRaw;
    const template = templateRaw ? trimTemplate(templateRaw) : templateRaw;
    SYS = (override ?? FALLBACK).replace('{{FIELD_REFERENCE}}', fieldReference(schema)) + '\n' +
      (skill ?? 'Follow the CDH metadata standard.') +
      (template ? '\n\n━━━ FULL ANNOTATED FIELD TEMPLATE (ground truth for field shapes — never invent one) ━━━\n' + template : '');
    el.textContent = override && skill && template ? '✓ Prompt + skill + template loaded'
      : override && skill ? '⚠ Template offline (extension blocks may be guessed)'
      : override ? '⚠ Skill offline' : '⚠ Using built-in prompt';
    if (!override || !skill || !template) el.style.color = '#f57c00';
  })();

  // The settings modal is OpenRouter's own config, so it lives with the client.
  const openSettings = () => {
    $('s-key').value = getKey();
    const m = getModel();
    const known = [...$('s-model').options].some(o => o.value === m);
    $('s-model').value = known ? m : '_custom';
    $('s-model-custom').value = known ? '' : m;
    $('s-model-custom').style.display = known ? 'none' : 'block';
    if (!$('settings-modal').open) $('settings-modal').showModal();
  };
  act('openSettings', openSettings);
  act('closeSettings', () => $('settings-modal').close());
  act('saveSettings', () => {
    const key = $('s-key').value.trim();
    let model = $('s-model').value;
    if (model === '_custom') model = $('s-model-custom').value.trim();
    if (key) localStorage.setItem('or_api_key', key);
    if (model) localStorage.setItem('or_model', model);
    $('model-label').textContent = `OpenRouter · ${getModel()}`;
    $('settings-modal').close();
    setStatus('Settings saved.');
  });
  $('s-model').addEventListener('change', e => {
    $('s-model-custom').style.display = e.target.value === '_custom' ? 'block' : 'none';
  });
  $('model-label').textContent = `OpenRouter · ${getModel()}`;
  if (!getKey()) setTimeout(openSettings, 600);

  function addMsg(role, content, filled = false, retry = false) {
    // mdToHtml is the one thing allowed through raw(): it escapes & < > before it
    // formats, so the model cannot get an element past it.
    const body = mdToHtml(content.replace(/<fill>[\s\S]*?<\/fill>/g, '').trim());
    const box = $('chat-msgs');
    box.append(html`
      <div class="msg ${role}">
        <div class="avatar">${role === 'user' ? 'You' : 'AI'}</div>
        <div>
          <div class="bubble">${raw(body)}</div>
          ${raw(filled ? '<div class="fill-notice">Form fields updated</div>' : '')}
          ${raw(retry ? '<button class="add-row" style="margin-top:6px;width:auto;padding:5px 12px" data-act="retryLast">Retry</button>' : '')}
        </div>
      </div>`);
    box.scrollTop = box.scrollHeight;
  }

  // The AI speaks the record, so filling the form is one call. Returns the parsed keys it
  // wrote (so the caller can check just those against the schema) or null if nothing filled.
  function applyFill(text) {
    const block = text.match(/<fill>([\s\S]*?)<\/fill>/) || text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (!block) return null;
    let json;
    try { json = JSON.parse(block[1]); } catch (e) { console.warn('[CDH] fill parse error', e); return null; }
    if (!isObj(json)) { console.warn('[CDH] fill is not an object'); return null; }
    // The derived keys are never sent to the AI, so they are not its to write either:
    // record() lets data win over derive(), so a stray $schema or created would stick.
    for (const k of HIDDEN) delete json[k];
    form.setData(merge(form.data, json));
    return json;
  }

  // The model can still hallucinate a field name, an enum value, or a wrong shape despite
  // FIELD_REFERENCE and the skill. Rather than trust the JSON on faith, run it through the
  // exact same JSON Schema validator the form itself uses (form.validate()) and only trust
  // what survives. This is the schema-level backstop — the equivalent of validating an LLM's
  // structured output against a Pydantic model, just reusing the JSON Schema already pinned
  // for the form instead of a second, hand-maintained model that could drift from it.
  function checkFill(json) {
    const { perField } = form.validate();
    const topKeys = Object.keys(json);
    const flagged = [...perField.entries()]
      .filter(([path]) => topKeys.some(k => path === `#/${k}` || path.startsWith(`#/${k}/`)))
      .map(([, msg]) => msg);
    return [...new Set(flagged)];
  }

  const snapshot = () => {
    const rec = Object.fromEntries(Object.entries(form.record()).filter(([k]) => !HIDDEN.has(k)));
    return Object.keys(rec).length
      ? `\n\n[CURRENT FORM STATE — already filled by the user. Do NOT overwrite these unless asked. Fill only what is missing.]\n${JSON.stringify(rec, null, 2)}`
      : '';
  };

  async function sendChat() {
    if (busy) return;
    const inp = $('chat-inp');
    const txt = inp.value.trim();
    if (!txt) return;

    if (!SYS) return addMsg('assistant', '⏳ Skill is still loading, please try again in a moment.');
    if (!getKey()) { addMsg('assistant', '⚙ Please enter your OpenRouter API key in Settings first.'); return openSettings(); }

    inp.value = '';
    busy = true;
    $('send-btn').disabled = true;
    addMsg('user', txt);
    history.push({ role: 'user', content: txt });
    $('typing').classList.add('show');
    setStatus('AI is thinking…');

    try {
      // The snapshot goes to the API but never into history, so the transcript stays clean.
      const recent = history.slice(-12);
      const snap = snapshot();
      const messages = snap
        ? [...recent.slice(0, -1), { role: 'user', content: recent.at(-1).content + snap }]
        : recent;

      // A rich fill (dimensions/variables, cdh.usage.intended_uses + not_recommended_for)
      // can run well past a small token budget — that showed up as replies silently cut
      // off mid-JSON, no closing </fill>, so applyFill() found nothing to parse and the
      // form just... didn't update, with no error anywhere. call() throws OpenRouter's
      // own error cases (429/402/network) same as before; truncation is caller's job to
      // detect via finishReason, since retrying belongs at the sendChat level, not here.
      async function call(maxTokens) {
        let res;
        try {
          res = await fetch(OR_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${getKey()}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': location.href,
              'X-Title': 'CDH Metadata Generator',
            },
            body: JSON.stringify({
              model: getModel(),
              messages: [{ role: 'system', content: SYS }, ...messages],
              max_tokens: maxTokens,
              temperature: 0.3,
            }),
          });
        } catch (netErr) {
          throw new Error(`Network error — cannot reach OpenRouter. (${netErr.message})`);
        }
        if (!res.ok) {
          if (res.status === 429) throw new Error('Rate limit reached (429). The free tier allows ~20 req/min, 50 req/day.');
          if (res.status === 402) throw new Error('No credits (402). Add credits at openrouter.ai or pick a :free model in ⚙ Settings.');
          const j = await res.json().catch(() => null);
          throw new Error(`HTTP ${res.status}: ${j?.error?.message ?? await res.text().catch(() => '')}`);
        }
        const data = await res.json();
        // Some providers pass an upstream failure through as HTTP 200 with an `error`
        // body instead of a completion — that reads as "(empty response)" otherwise,
        // which is indistinguishable from the model just declining to say anything.
        if (data.error) throw new Error(`Provider error: ${data.error.message ?? JSON.stringify(data.error)}`);
        const choice = data.choices?.[0];
        return { content: choice?.message?.content ?? '', finishReason: choice?.finish_reason };
      }

      // <fill> opened but never closed is the unambiguous truncation signature — the
      // regex in applyFill() requires the closing tag, so a cut-off reply silently fills
      // nothing otherwise. finish_reason === 'length' is the same signal from the API
      // side; either one alone is enough to call it truncated.
      const looksTruncated = (content, finishReason) =>
        finishReason === 'length' || (content.includes('<fill>') && !content.includes('</fill>'));

      let { content: reply, finishReason } = await call(4096);
      if (looksTruncated(reply, finishReason)) {
        setStatus('Response was cut off — retrying with more room…');
        ({ content: reply, finishReason } = await call(8192));
      }
      if (!reply) {
        throw new Error('Empty response from the model — the free endpoint may be overloaded. Try again, or switch models in ⚙ Settings.');
      }
      if (looksTruncated(reply, finishReason)) {
        // Still cut off even at 8192 — say so plainly instead of silently applying a
        // broken partial fill (applyFill() would just find nothing to parse anyway).
        reply += '\n\n⚠ This reply was cut off twice in a row even with a larger budget — the model itself may be having trouble, not just running out of room. Try asking for fewer fields at once.';
      }
      history.push({ role: 'assistant', content: reply });
      const json = applyFill(reply);
      const filled = !!json;
      const problems = filled ? checkFill(json) : [];
      const warning = problems.length
        ? `\n\n⚠ The schema flags ${problems.length} of the value${problems.length > 1 ? 's' : ''} just filled: ${problems.join('; ')}`
        : '';
      addMsg('assistant', reply + warning, filled);
      setStatus(problems.length ? 'AI updated the form — some values need a look.' : filled ? 'AI updated the form.' : 'Ready.');
    } catch (err) {
      addMsg('assistant', `⚠ ${err.message}`, false, true);
      setStatus('Error — see chat.');
    } finally {
      $('typing').classList.remove('show');
      busy = false;
      $('send-btn').disabled = false;
    }
  }

  act('sendChat', sendChat);
  act('clearChat', () => {
    history = [];
    $('chat-msgs').replaceChildren(html`
      <div class="msg assistant"><div class="avatar">AI</div>
        <div><div class="bubble">Chat cleared. Ask me anything about CDH metadata.</div></div>
      </div>`);
    setStatus('Chat history cleared.');
  });
  act('retryLast', () => {
    const last = [...history].reverse().find(m => m.role === 'user');
    if (!last) return;
    if (history.at(-1)?.role === 'assistant') history.pop();
    history.pop();
    $('chat-inp').value = last.content;
    sendChat();
  });
  act('toggleChat', () => {
    const isOpen = $('chat-panel').classList.toggle('open');
    $('chat-tab').classList.toggle('open', isOpen);
    document.querySelector('.form-panel').classList.toggle('shifted', isOpen);
    $('chat-tab').title = isOpen ? 'Close AI Assistant' : 'Open AI Assistant';
  });

  $('chat-inp').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
}
