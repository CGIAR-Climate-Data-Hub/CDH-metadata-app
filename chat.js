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
    const [override, skill, template] = await Promise.all(
      [get(PROMPT_URL, 'prompt.md'), get(SKILL_URL, 'skill'), get(TEMPLATE_URL, 'template')]);
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
            max_tokens: 1024,
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
      const reply = (await res.json()).choices?.[0]?.message?.content || '(empty response)';
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
