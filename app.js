// Wiring: fetch the schema, build the form, YAML preview, validation panel.
import { createForm, flatten, unsupported, html, raw, DERIVED } from './schema-form.js';
import { initChat } from './chat.js';
import { initSubmit } from './submit.js';

// Bumping a release is this one line. Everything else — the checks URL, the version the
// UI shows, the draft key — comes from here or from the schema that actually loaded.
const VERSION = 'v0.2.0';
const BASE = `https://cgiar-climate-data-hub.github.io/cdh-metadata-standard/${VERSION}`;
const SCHEMA_URL = `${BASE}/schemas/profiles/cdh.schema.bundled.json`;
// The standard's own cross-field rules. spec/checks/cross-field.js is written and the
// publish workflow mirrors it, so this becomes `${BASE}/checks/cross-field.js` as soon as
// a release ships — one line, then delete vendor/cross-field.js. Until then it is a
// verbatim local copy, and check-schema.mjs fails if the two diverge.
const CHECKS_URL = new URL('./vendor/cross-field.js', import.meta.url);
const SPDX_URL = 'https://esm.sh/spdx-expression-validate@2';
// A long form and no persistence meant a refresh threw the work away.
const DRAFT_KEY = 'cdh_draft';
// Taken from the schema that loaded, not from the URL: if the two ever disagree the
// record is stamped with what was actually read, and the mismatch is reported below.
let SCHEMA_VERSION = VERSION;

const $ = id => document.getElementById(id);
export const setStatus = msg => { $('status').textContent = msg; };
// setData/validate trigger onChange a moment later, which would overwrite whatever the
// caller just reported. Anything set here survives the next onChange instead.
let pendingStatus = '';
const reportOnce = msg => { pendingStatus = msg; };

const ICON = {
  ok: `<svg class="val-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  err: `<svg class="val-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
};

export let form = null;

// ── YAML ────────────────────────────────────────────────────────────────────────
// Keys come out in the form's own reading order, so the same record always
// serialises identically. ponytail: no separate canonical-order list to maintain.
function ordered(rec) {
  const order = [...DERIVED, ...form.sections.flatMap(s => s.keys)];
  const rank = k => (order.indexOf(k) + 1 || order.length + 1);
  return Object.fromEntries(Object.entries(rec).sort(([a], [b]) => rank(a) - rank(b)));
}

export function toYAML() {
  const rec = ordered(form.record());
  const body = jsyaml.dump(rec, { indent: 2, lineWidth: 100, noRefs: true, skipInvalid: true });
  return `# yaml-language-server: $schema=../../spec/schemas/profiles/cdh.schema.json\n${body}`;
}

// ── The checks the schema cannot express ────────────────────────────────────────
// Absent until a release publishes them, so this degrades to "not run" rather than
// pretending a record is clean. checksNote says which state we are in.
export let checksNote = '';
async function loadCrossFieldChecks() {
  try {
    const [mod, spdx] = await Promise.all([
      import(CHECKS_URL),
      import(SPDX_URL).then(m => m.default, () => null),
    ]);
    const run = mod.default ?? mod.checkCrossFieldRules;
    if (typeof run !== 'function') throw new Error('no checkCrossFieldRules export');
    checksNote = spdx ? '' : 'the SPDX expression check could not load';
    return rec => run(rec, { isSpdx: spdx ?? (() => true) });
  } catch (err) {
    checksNote = 'the cross-field rules (duplicate asset names, href_template tokens, '
      + 'join fields, SPDX grammar) could not load — they run on the pull request, not here';
    console.warn('[CDH] cross-field checks unavailable:', err.message);
    return null;
  }
}

// ── Load an existing record ─────────────────────────────────────────────────────
// The bookkeeping keys are re-derived rather than trusted: a record authored against
// an older release gets this app's pinned version, which is also why the
// version-mismatch failure mode cannot survive a round-trip. `created` is kept.
// Stored per schema version: a draft written against an older release would only
// half-load, and silently dropping the unknown half is worse than starting clean.
// `pristine` is a fresh form's data, which is not empty -- the schema's defaults land
// in it -- so without comparing against it, Clear would re-save a draft of nothing and
// the next visit would claim you had unsaved work.
let keepDrafts = false;
let pristine = '{}';
function saveDraft() {
  if (!keepDrafts) return;
  try {
    const data = form.data;
    if (JSON.stringify(data) !== pristine) localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: SCHEMA_VERSION, data }));
    else localStorage.removeItem(DRAFT_KEY);
  } catch (err) {
    keepDrafts = false;                       // quota or private mode; stop trying
    console.warn('[CDH] draft not saved:', err.message);
  }
}
function readDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (d?.version !== SCHEMA_VERSION || !d.data) return null;
    return JSON.stringify(d.data) === pristine ? null : d.data;
  } catch { return null; }
}

export function loadYAML(text) {
  const doc = jsyaml.load(text);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not a YAML mapping');
  const { $schema, cdh_schema_version, extensions, updated, ...rec } = doc;
  form.setData(rec);
  // Keys this schema has no property for would vanish from the form while still
  // reaching the record, so say so — the validator rejects them as unevaluated.
  const known = new Set(Object.keys(flatten(schema).props));
  return { fields: Object.keys(rec).length, unknown: Object.keys(rec).filter(k => !known.has(k)) };
}

// ── Modals ──────────────────────────────────────────────────────────────────────
const open = id => $(id).classList.add('open');
const close = id => $(id).classList.remove('open');

const actions = {
  openModal() {
    $('yaml-out').textContent = toYAML();
    $('val-summary-bar').style.display = 'none';
    $('val-results').style.display = 'none';
    open('modal');
  },
  closeModal: () => close('modal'),
  closeSubmitModal: () => close('submit-modal'),

  copyYAML() {
    navigator.clipboard.writeText($('yaml-out').textContent)
      .then(() => setStatus('YAML copied to clipboard.'));
  },

  dlYAML() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([$('yaml-out').textContent], { type: 'text/yaml' }));
    a.download = `${form.record().id || 'metadata'}.yaml`;
    a.click();
  },

  clearAll() {
    if (!confirm('Clear all form fields?')) return;
    form.clear();
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* nothing to remove */ }
    setStatus('Form cleared.');
  },

  // Every rule comes from the schema — nothing to restate here.
  //
  // html`` escapes every interpolated value, so a message quoting a record value can
  // only ever be text. raw() marks markup we wrote; it is only ever given an icon.
  runValidation() {
    const { valid, perField, record } = form.validate();
    const rows = [...[...perField].map(([p, m]) => [p.replace(/^#\//, ''), m]), ...record.map(m => ['record', m])];

    const bar = $('val-summary-bar');
    bar.className = `val-summary ${valid ? 'ok' : 'err'}`;
    bar.style.display = 'flex';
    bar.replaceChildren(html`${raw(valid ? ICON.ok : ICON.err)} ${valid
      ? `Record passes ${checksNote ? 'every check that runs here' : 'the CDH profile'} — ready to submit`
      : `${rows.length} problem${rows.length === 1 ? '' : 's'} to fix before submission`}`);

    const section = html`<div class="val-section">
      ${raw(rows.length ? '<h4>Validation</h4>' : '')}<div class="val-list"></div>
    </div>`;
    const list = section.querySelector('.val-list');
    for (const [where, msg] of rows) {
      list.append(html`<div class="val-row fail">${raw(ICON.err)}<span><strong>${where}:</strong> ${msg}</span></div>`);
    }
    if (!rows.length) list.append(html`<div class="val-row pass">${raw(ICON.ok)} All checks passed.</div>`);

    const res = $('val-results');
    res.style.display = 'block';
    res.replaceChildren(section);
    if (checksNote) res.append(html`<div class="val-section"><div class="tip">${checksNote}</div></div>`);

    setStatus(valid ? 'Validation passed — ready to submit.' : `Validation failed: ${rows.length} problem(s).`);
    return valid;
  },

  validateThenSubmit() {
    $('yaml-out').textContent = toYAML();
    if (!actions.runValidation()) return;   // errors stay visible in this modal
    close('modal');
    actions.openSubmitModal();              // registered by submit.js
  },

};

export const act = (name, fn) => { actions[name] = fn; };

// One delegated listener instead of 22 inline handlers.
document.addEventListener('click', e => {
  const hit = e.target.closest('[data-act]');
  if (hit) return actions[hit.dataset.act]?.();
  const overlay = e.target.closest('[data-close]');
  if (overlay && e.target === overlay) actions[overlay.dataset.close]?.();
});
$('load-yaml').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  e.target.value = '';                       // re-selecting the same file must re-fire
  if (!file) return;
  if (Object.keys(form.data).length && !confirm(`Replace the current form with ${file.name}?`)) return;
  try {
    const { fields, unknown } = loadYAML(await file.text());
    const { valid, perField, record } = form.validate();
    const problems = perField.size + record.length;
    reportOnce(`Loaded ${file.name} — ${fields} fields`
      + (unknown.length ? `, ${unknown.length} not in this schema (${unknown.join(', ')})` : '')
      + (valid ? '. Valid against the CDH profile.' : `. ${problems} problem(s) to fix.`));
    setStatus(pendingStatus);
  } catch (err) {
    setStatus(`Could not read ${file.name}: ${err.message}`);
  }
});

// ── Boot ────────────────────────────────────────────────────────────────────────
const res = await fetch(SCHEMA_URL);
if (!res.ok) throw new Error(`Could not load the CDH schema (HTTP ${res.status})`);
const schema = await res.json();

// The version shown in the header, the AI pill and the YAML dialog is whatever the
// schema says it is, so a stale label is not possible.
SCHEMA_VERSION = schema.$id?.match(/\/(v\d+\.\d+\.\d+)\//)?.[1] ?? VERSION;
for (const n of document.querySelectorAll('[data-cdh-version]')) n.textContent = SCHEMA_VERSION;
if (SCHEMA_VERSION !== VERSION) {
  console.warn(`[CDH] pinned ${VERSION} but the schema declares ${SCHEMA_VERSION}`);
}

form = createForm({
  schema,
  mount: $('form-panel'),
  extraChecks: await loadCrossFieldChecks(),
  onChange(_rec, p) {
    saveDraft();
    if ($('modal').classList.contains('open')) $('yaml-out').textContent = toYAML();
    setStatus(pendingStatus || (p.valid
      ? 'Record is valid against the CDH profile.'
      : 'Ready — fill the form or ask the AI for help.'));
    pendingStatus = '';
  },
});

// Restore before wiring saves, so the empty form does not overwrite the draft first.
pristine = JSON.stringify(form.data);
const draft = readDraft();
if (draft) {
  reportOnce(`Restored your unsaved draft (${Object.keys(draft).length} fields). Clear discards it.`);
  form.setData(draft);
}
keepDrafts = true;

// The schema URL pins an immutable release, so this can only change when someone bumps
// the pin — which is exactly when they should see it, in the browser, before merging.
const gaps = unsupported(flatten(schema).props);
if (gaps.length) {
  console.warn('[CDH] shapes this form cannot render:', gaps);
  $('form-panel').prepend(html`<div class="tip">
    This schema has ${gaps.length} field${gaps.length === 1 ? '' : 's'} the form cannot render
    properly: ${gaps.map(([p, why]) => `${p.replace('#/', '')} (${why})`).join(', ')}.
    They are shown as placeholders — anything entered elsewhere is still fine, but these
    need a branch in widget() before the pin is bumped.
  </div>`);
}

initChat({ form, schema, setStatus, act });
initSubmit({ form, setStatus, act });
