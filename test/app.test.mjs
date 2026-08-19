// Boots the real index.html + app.js in jsdom against the real schema, with the
// network stubbed. Checks the wiring the unit tests can't see: delegated actions,
// YAML ordering, AI fill, submit hand-off.
//   npm i jsdom js-yaml && node test/app.test.mjs
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

const APP = new URL('..', import.meta.url).pathname;
const SPEC = process.env.CDH_SPEC || new URL('../../metadata', import.meta.url).pathname;
const jsyaml = createRequire(import.meta.url)('js-yaml');


// The spec repo is a sibling checkout when working locally, and absent in CI, so fall
// back to the published bundle. Assertions that depend on unreleased annotations check
// the loaded schema rather than assuming.
async function loadSchema(spec) {
  const local = `${spec}/spec/schemas/profiles/cdh.schema.bundled.json`;
  if (fs.existsSync(local)) return { schema: JSON.parse(fs.readFileSync(local, 'utf8')), source: 'local spec repo' };
  const url = 'https://cgiar-climate-data-hub.github.io/cdh-metadata-standard/v0.2.0/schemas/profiles/cdh.schema.bundled.json';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`no schema: ${local} missing and ${url} returned ${r.status}`);
  return { schema: await r.json(), source: 'published v0.2.0' };
}
const { schema, source: schemaSource } = await loadSchema(SPEC);
console.log(`  schema: ${schemaSource}`);

// Same story as the schema: sibling checkout locally, GitHub raw in CI, so every
// assertion runs in both places rather than being skipped where it matters most.
const kitchenYaml = await (async () => {
  const local = `${SPEC}/examples/kitchen-sink/example-crop-suitability.yaml`;
  if (fs.existsSync(local)) return fs.readFileSync(local, 'utf8');
  const url = 'https://raw.githubusercontent.com/CGIAR-Climate-Data-Hub/cdh-metadata-standard'
    + '/main/examples/kitchen-sink/example-crop-suitability.yaml';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`no example record: ${local} missing and ${url} returned ${r.status}`);
  return r.text();
})();

const skill = 'STAGE 1: ...';   // stand-in for the GitHub-hosted skill

const dom = new JSDOM(fs.readFileSync(`${APP}/index.html`, 'utf8'), {
  url: 'https://example.org/', runScripts: 'outside-only', pretendToBeVisual: true,
});
const { window } = dom;
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Event',
  'getComputedStyle', 'CustomEvent', 'localStorage', 'sessionStorage', 'location', 'Blob', 'URL', 'confirm', 'alert'])
  Object.defineProperty(global, k, { value: window[k], configurable: true, writable: true });
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true });
global.jsyaml = window.jsyaml = jsyaml;
window.URL.createObjectURL = () => 'blob:stub';

const calls = [];
global.fetch = async (url, opts) => {
  calls.push({ url: String(url), opts });
  if (String(url).includes('cdh.schema.bundled.json')) return { ok: true, json: async () => schema };
  if (String(url).includes('SKILL.md')) return { ok: true, text: async () => skill };
  if (String(url).endsWith('prompt.md')) return { ok: true, text: async () => fs.readFileSync(`${APP}/prompt.md`, 'utf8') };
  if (String(url).includes('openrouter')) return {
    ok: true, json: async () => ({ choices: [{ message: { content:
      'Here is what I know.\n<fill>{"id":"chirts-daily","title":"CHIRTS-daily","license":"CC-BY-4.0","cdh":{"domain":["climate"]},"spatial":{"geography":["world"]}}</fill>\nI still need a data URL.' } }] }),
  };
  if (String(url).includes('api.github.com')) return { status: 204, ok: true, json: async () => ({}) };
  throw new Error('unexpected fetch: ' + url);
};

let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); if (!c) fail++; };
const wait = (ms = 250) => new Promise(r => setTimeout(r, ms));
const $ = id => window.document.getElementById(id);
const click = sel => window.document.querySelector(sel)?.dispatchEvent(
  new window.MouseEvent('click', { bubbles: true }));

window.localStorage.setItem('or_api_key', 'sk-or-test');
const app = await import(`${APP}/app.js`);
await wait();

// ── the form replaced the loading state ───────────────────────────────────────────
ok(!$('schema-loading-state'), 'loading placeholder replaced');
ok($('form-panel').querySelectorAll('.sec').length >= 8,
  `${$('form-panel').querySelectorAll('.sec').length} sections built from the schema`);
ok($('form-panel').querySelectorAll('.field').length > 40,
  `${$('form-panel').querySelectorAll('.field').length} fields`);
ok(calls.some(c => c.url.includes('cdh.schema.bundled.json')), 'schema fetched once at boot');

// ── no bare form-control selectors: the form is generated, so a global `label` or
//    `input` rule reaches every control the app emits, anywhere ─────────────────────
const css = fs.readFileSync(`${APP}/app.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const bare = [];
for (const block of css.split('}')) {
  if (!block.includes('{')) continue;
  const sel = block.split('{')[0].trim();
  if (!sel || sel.startsWith('@') || /^\d/.test(sel)) continue;
  for (const part of sel.split(',').map(x => x.trim()).filter(Boolean)) {
    if (part.includes('.') || part.includes('#')) continue;
    const head = part.split(/[\s>+~]/)[0].split(':')[0];
    if (['label', 'input', 'select', 'textarea'].includes(head)) bare.push(part);
  }
}
ok(bare.length === 0, `form controls are styled through a scope, not globally (bare: ${bare.join(', ') || 'none'})`);
const fileLabel = document.querySelector('label.btn input[type=file]')?.closest('label');
ok(!!fileLabel, 'the picker is a label styled as a button');
ok(!fileLabel.closest('.field'), 'and it sits outside .field, so no form-field styling reaches it');

// ── cross-field checks run here, or the panel says why not ────────────────────────
ok(app.checksNote === '' || /could not load|SPDX/.test(app.checksNote),
  `cross-field checks loaded${app.checksNote ? ' partially: ' + app.checksNote.slice(0, 60) : ' fully'}`);
// A record that is schema-clean but breaks a cross-field rule must be rejected here,
// not only by CI. Duplicate asset names across data[] and additional_assets[].
const stateBefore = structuredClone(app.form.data);   // later sections rely on it
const clean = jsyaml.load(kitchenYaml);
delete clean.$schema;
app.form.setData(clean);
await wait(250);
ok(app.form.validate().valid, 'the kitchen-sink example is valid with cross-field checks on');
const dup = structuredClone(clean);
dup.additional_assets = [{ ...dup.additional_assets[0], name: dup.data[0].name }];
app.form.setData(dup);
await wait(250);
const dupResult = app.form.validate();
ok(!dupResult.valid, 'a duplicate asset name is caught in the form, not just on the PR');
ok([...dupResult.perField.values()].concat(dupResult.record).some(m => /duplicate asset name/.test(m)),
  `and named: "${[...dupResult.perField.values()].concat(dupResult.record).find(m => /duplicate/.test(m))?.slice(0, 58)}"`);
app.form.setData(stateBefore);
await wait(250);

// ── delegated actions replace the old inline handlers ─────────────────────────────
ok(!fs.readFileSync(`${APP}/index.html`, 'utf8').includes('onclick'), 'no inline handlers left in index.html');
click('[data-act=openModal]');
await wait(50);
ok($('modal').classList.contains('open'), 'data-act="openModal" opens the YAML modal');
ok($('yaml-out').textContent.startsWith('# yaml-language-server:'), 'YAML carries the editor schema header');
click('[data-act=closeModal]');
ok(!$('modal').classList.contains('open'), 'and closes again');

// ── AI fill: the model emits a record, not a flat dialect ─────────────────────────
$('chat-inp').value = 'CHIRTS-daily from the UCSB Climate Hazards Center';
click('[data-act=sendChat]');
await wait(300);
const rec = app.form.record();
ok(rec.id === 'chirts-daily', `<fill> populated id: ${rec.id}`);
ok(rec.cdh?.domain?.[0] === 'climate', 'nested cdh.domain applied');
ok(rec.spatial?.geography?.[0] === 'world', 'nested spatial.geography applied');
ok($('form-panel').querySelector('[data-path="#/id"] input')?.value === 'chirts-daily',
  'and the input shows it');
ok($('chat-msgs').querySelectorAll('.msg').length === 3, 'user + assistant messages rendered');
ok(!$('chat-msgs').textContent.includes('<fill>'), 'the fill block is stripped from the transcript');
ok($('chat-msgs').textContent.includes('Form fields updated'), 'fill is acknowledged in the UI');

const sys = calls.find(c => c.url.includes('openrouter'));
const prompt = JSON.parse(sys.opts.body).messages[0].content;
ok(prompt.includes(skill), 'the skill is appended to the system prompt');
ok(prompt.includes('BROWSER FORM'), 'prompt.md is fetched and prepended');
ok(!prompt.includes('{{FIELD_REFERENCE}}'), 'the placeholder is substituted, not left literal');
ok(fs.readFileSync(`${APP}/prompt.md`, 'utf8').includes('{{FIELD_REFERENCE}}'),
  'prompt.md keeps the placeholder so the field list stays schema-generated');
ok($('skill-status').textContent.includes('Prompt + skill loaded'), 'both halves reported in the UI');
ok(/^\s+id \*/m.test(prompt), 'field reference is generated from the schema (id marked required)');
ok(prompt.includes('commodities'), 'extension fields appear in the reference too');
const ref = prompt.split('FIELD REFERENCE')[1].split('━━━')[0];
ok(!/bbox_west|citation_authors|res_type/.test(ref), 'the field reference is schema keys only, no flat dialect');

// ── YAML ordering is deterministic and schema-derived ─────────────────────────────
click('[data-act=openModal]');
await wait(50);
const keys = Object.keys(jsyaml.load($('yaml-out').textContent.split('\n').slice(1).join('\n')));
ok(keys.slice(0, 3).join(',') === '$schema,cdh_schema_version,extensions', `bookkeeping first: ${keys.slice(0, 3)}`);
ok(keys.indexOf('id') < keys.indexOf('license'), 'then the form reading order (identity before rights)');
ok(keys.includes('created') && keys.includes('updated'), 'derived dates present');

// ── validation panel is driven by the schema ──────────────────────────────────────
click('[data-act=runValidation]');
await wait(150);
ok($('val-summary-bar').style.display === 'flex', 'validation summary shown');
ok(/problem/.test($('val-summary-bar').textContent), `incomplete record reports problems: "${$('val-summary-bar').textContent.trim()}"`);
ok($('val-results').textContent.includes('description'), 'missing required fields are listed by name');

// ── submit hand-off carries the previewed bytes ───────────────────────────────────
const yamlShown = $('yaml-out').textContent;
window.sessionStorage.setItem('gh_token', 'ghp_test');   // the default, tab-scoped
click('[data-act=validateThenSubmit]');
await wait(50);
ok(!$('submit-modal').classList.contains('open'), 'invalid record does not reach the submit modal');

app.form.setData(jsyaml.load(kitchenYaml));
await wait(200);
click('[data-act=validateThenSubmit]');
await wait(50);
ok($('submit-modal').classList.contains('open'), 'a valid record opens the submit modal');
ok($('step-record-id').textContent === 'example-crop-suitability', 'record id shown in the steps');
click('[data-act=doSubmit]');
await wait(200);
ok($('gh-remember') && !$('gh-remember').checked, 'the token is not persisted unless asked');
ok($('gh-token').value === 'ghp_test', 'and a tab-scoped token is still picked up');

// The disclosure has to be where the decision is, so it is driven by the checkbox.
const note = () => $('gh-remember-note').textContent;
const toggleRemember = on => {
  $('gh-remember').checked = on;
  $('gh-remember').dispatchEvent(new window.Event('change'));
};
ok(/forgotten when you close it/.test(note()), 'the default explains what happens to the token');
toggleRemember(true);
ok(/can then read it/.test(note()), `ticking it states the risk: "${note().slice(0, 52)}…"`);
toggleRemember(false);
ok(/forgotten when you close it/.test(note()), 'and unticking goes back');

// Offering persistence means offering a way to undo it.
window.localStorage.setItem('gh_token', 'ghp_persisted');
toggleRemember(true);
ok($('gh-forget-row').style.display !== 'none', 'a stored token can be forgotten from here');
click('[data-act=forgetToken]');
await wait(50);
ok(window.localStorage.getItem('gh_token') === null && window.sessionStorage.getItem('gh_token') === null,
  'forgetting clears both stores');
ok($('gh-token').value === '' && !$('gh-remember').checked, 'and resets the dialog');
window.sessionStorage.setItem('gh_token', 'ghp_test');   // restore for the submit below
const dispatch = calls.find(c => c.url.includes('/dispatches'));
ok(!!dispatch, 'workflow_dispatch called');
const inputs = JSON.parse(dispatch.opts.body).inputs;
ok(inputs.record_id === 'example-crop-suitability', 'record_id sent');
ok(window.localStorage.getItem('gh_token') === null, 'submitting did not write the token to localStorage');
ok(inputs.yaml_content === $('yaml-out').textContent, 'the submitted YAML is exactly what was previewed');

// ── loading an existing record ────────────────────────────────────────────────────
const kitchen = kitchenYaml;
const picker = $('load-yaml');
ok(picker && picker.accept.includes('.yaml'), 'a native file picker exists in the header');
ok(picker.closest('label') !== null, 'wrapped in a label, so it needs no click handler');
const loaded = app.loadYAML(kitchen);
await wait(250);
ok(loaded.unknown.length === 0, `every key in the example has a field: ${loaded.unknown.join(', ') || 'none missing'}`);
ok(app.form.record().id === 'example-crop-suitability', 'record replaced by the loaded file');
ok($('form-panel').querySelector('[data-path="#/id"] input').value === 'example-crop-suitability',
  'and the inputs show the loaded values');
ok(app.form.validate().valid, 'the loaded record validates');
const fileCreated = jsyaml.load(kitchen).created;
ok(app.form.record().created === fileCreated, `created is preserved from the file (${fileCreated})`);
ok(app.form.record().cdh_schema_version === 'v0.2.0', 'version bookkeeping is re-derived, not trusted');
// A record from an older release, carrying a field this schema dropped.
const stale = app.loadYAML(kitchen.replace('\nid:', '\nlegacy_field: x\nid:'));
await wait(250);
ok(stale.unknown.includes('legacy_field'), `unknown keys are reported, not silently dropped: ${stale.unknown}`);
ok(!app.form.validate().valid, 'and the record is reported invalid because of it');
let threw = '';
try { app.loadYAML('just a string'); } catch (e) { threw = e.message; }
ok(/mapping/.test(threw), `a non-record file is rejected: "${threw}"`);
app.loadYAML(kitchen);
await wait(250);


// ── the rule, not just this instance: no data may be parsed as HTML ───────────────
// An interpolated innerHTML is how the validation panel became injectable. Static
// strings we wrote (the icons) and mdToHtml, which escapes before formatting, are fine.
const interpolated = [];
for (const f of ['app.js', 'submit.js', 'chat.js', 'schema-form.js']) {
  const src = fs.readFileSync(`${APP}/${f}`, 'utf8');
  for (const m of src.matchAll(/innerHTML\s*=\s*`([^`]*)`/g)) {
    if (m[1].includes('${')) interpolated.push(`${f}: ${m[0].slice(0, 58)}…`);
  }
}
ok(interpolated.length === 0,
  `no innerHTML is assigned an interpolated template${interpolated.length ? ':\n         ' + interpolated.join('\n         ') : ''}`);

// ── record values must not be able to inject markup ───────────────────────────────
// A shared .yaml opened with Load YAML is untrusted input. Its values reach the
// validation panel through the messages (an enum error quotes the offending value),
// and that panel is built with innerHTML.
app.form.setData({ id: '<img src=x onerror="window.__xss=1">', spatial: { geography: ['<svg onload="window.__xss=1">'] } });
await wait(250);
click('[data-act=runValidation]');
await wait(200);
const panel = $('val-results');
ok(panel.textContent.includes('<svg onload'), 'the offending value is shown to the author, as text');
ok(!panel.querySelector('img, script, [onload], [onerror]'),
  'no element came from the record — the only svgs in there are our own icons');
ok(window.__xss === undefined, 'and nothing executed');
app.form.clear();
await wait(200);

// ── a refresh must not throw the work away ────────────────────────────────────────
app.form.setData({ id: 'draft-survives', title: 'Half-finished record', keywords: ['a'] });
await wait(250);
const stored = JSON.parse(window.localStorage.getItem('cdh_draft'));
ok(stored?.data?.id === 'draft-survives', `edits are written to localStorage: ${stored?.data?.id}`);
ok(stored.version === 'v0.2.0', `stamped with the schema version (${stored.version}) so an old draft is not half-loaded`);

// Simulate the reload: fresh document, fresh module instance, same localStorage.
const dom2 = new JSDOM(fs.readFileSync(`${APP}/index.html`, 'utf8'),
  { url: 'https://example.org/', runScripts: 'outside-only', pretendToBeVisual: true });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'getComputedStyle',
  'CustomEvent', 'localStorage', 'sessionStorage', 'location', 'Blob', 'URL', 'confirm', 'alert'])
  Object.defineProperty(global, k, { value: dom2.window[k], configurable: true, writable: true });
Object.defineProperty(global, 'navigator', { value: dom2.window.navigator, configurable: true });
global.jsyaml = dom2.window.jsyaml = jsyaml;
dom2.window.URL.createObjectURL = () => 'blob:stub';
dom2.window.confirm = () => true;   // jsdom's confirm returns undefined
Object.defineProperty(global, 'confirm', { value: dom2.window.confirm, configurable: true });
for (const [k, v] of Object.entries({ or_api_key: 'sk-or-test', cdh_draft: JSON.stringify(stored) }))
  dom2.window.localStorage.setItem(k, v);
const app2 = await import(`${APP}/app.js?reload=1`);
await wait(400);
ok(app2.form.record().id === 'draft-survives', `the draft comes back after a reload: ${app2.form.record().id}`);
ok(dom2.window.document.querySelector('[data-path="#/id"] input')?.value === 'draft-survives',
  'and is visible in the inputs, not just the record');
ok(/Restored your unsaved draft/.test(dom2.window.document.getElementById('status').textContent),
  'the status bar says so rather than restoring silently');
dom2.window.document.querySelector('[data-act=clearAll]')
  ?.dispatchEvent(new dom2.window.MouseEvent('click', { bubbles: true }));
await wait(250);
ok(dom2.window.localStorage.getItem('cdh_draft') === null, 'and Clear discards the saved draft');
await wait(200);
ok(dom2.window.localStorage.getItem('cdh_draft') === null,
  'and does not immediately re-save one made of schema defaults');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
