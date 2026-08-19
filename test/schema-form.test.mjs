// Headless checks for schema-form.js against the real CDH bundled schema.
// ponytail: no test framework — node + jsdom is enough for 48 assertions.
//   npm i jsdom js-yaml && node test/schema-form.test.mjs   (validator is vendored)
// CDH_SPEC=/path/to/metadata overrides where the spec repo lives.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const APP = new URL('..', import.meta.url).pathname;
const SPEC = process.env.CDH_SPEC || new URL('../../metadata', import.meta.url).pathname;
const HERE = new URL('.', import.meta.url).pathname;


const dom = new JSDOM('<body><div id="mount"></div></body>');
for (const k of ['document', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent']) global[k] = dom.window[k];
global.window = dom.window;

const { createForm, flatten, extensionRules } = await import(`${APP}/schema-form.js`);

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

const wait = () => new Promise(r => setTimeout(r, 220));
let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}`); if (!cond) fail++; };

// ── 1. flatten / extension derivation ────────────────────────────────────────────
const { props, required } = flatten(schema);
ok(Object.keys(props).length > Object.keys(schema.properties).length,
  `flatten sees ${Object.keys(props).length} props (root properties alone has ${Object.keys(schema.properties).length})`);
ok(required.size >= 9, `required: ${[...required].join(', ')}`);
const rules = extensionRules(schema);
const ver = schema.$id.match(/\/(v\d+\.\d+\.\d+)\//)[1];
ok(rules.always[0] === `https://cgiar-climate-data-hub.github.io/cdh-metadata-standard/${ver}/extensions/cdh/schema.json`,
  `always ext: ${rules.always[0]}`);
ok(rules.conditional.length >= 1, `${rules.conditional.length} conditional extension rules`);
ok(rules.conditional.every(r => /^https:\/\/\S+schema\.json$/.test(r.url)), 'conditional URLs de-regexed cleanly');

// ── 2. build the form ────────────────────────────────────────────────────────────
let last;
const form = createForm({
  schema,
  mount: document.getElementById('mount'),
  onChange: (rec, p) => { last = { rec, p } },
});
await wait();
const mount = document.getElementById('mount');
ok(mount.querySelectorAll('.sec').length >= 8, `${mount.querySelectorAll('.sec').length} sections rendered`);
ok(mount.querySelectorAll('.field').length > 50, `${mount.querySelectorAll('.field').length} fields rendered`);
ok(!mount.querySelector('.hint')?.textContent.includes('undefined'), 'hints come from schema descriptions');

const dl = mount.querySelectorAll('datalist');
ok(dl.length >= 2, `${dl.length} datalists (filter-as-you-type enums)`);
const vocab = ptr => ptr.split('/').slice(1).reduce((o, k) => o.properties?.[k] ?? o[k], { properties: props }).items.enum.length;
const geo = [...dl].find(d => d.id.includes('geography'));
ok(geo?.children.length === vocab('#/spatial/geography'), `geography datalist matches the schema's ${vocab('#/spatial/geography')} values`);
const commodities = [...dl].find(d => d.id.includes('commodities'));
ok(commodities?.children.length === vocab('#/commodities'), `commodities datalist matches the schema's ${vocab('#/commodities')} values`);
// `examples` on array items become suggestions too, not just enums — asset roles are
// free strings with six documented values.
const suggestionsFor = ptr => {
  const inp = mount.querySelector(`[data-path="${ptr}"] input`);
  const id = inp?.getAttribute('list');
  return id ? mount.querySelector(`#${id}`)?.children.length ?? 0 : 0;
};
ok(mount.querySelectorAll('.chips').length >= 1, `${mount.querySelectorAll('.chips').length} chip groups (small enums)`);
const secTitles = [...mount.querySelectorAll('.sec-title')].map(t => t.textContent.trim().split('\n')[0]);
ok(secTitles.includes('Datacube Extension'), `extension sections titled by the schema: ${secTitles.slice(-5).join(' / ')}`);
ok(secTitles.includes('Climate Extension'), 'Climate Extension section exists');
ok(!secTitles.includes('More fields'), 'nothing falls through to "More fields" for this schema');
const climateSec = [...mount.querySelectorAll('.sec')].find(x => /Climate Extension/.test(x.textContent));
ok(/Climate projection provenance/.test(climateSec.querySelector('.sec-body > .hint')?.textContent || ''),
  'an extension branch description renders as section-level help');
const described = [...mount.querySelectorAll('.sec')].filter(x => x.querySelector(':scope > .sec-body > .hint')).length;
ok(described === 5, `${described} sections carry the schema's own blurb`);
ok(!mount.querySelector('[data-path="#/extensions"]'), 'extensions[] hidden (derived)');
ok(!mount.querySelector('[data-path="#/created"]'), 'created hidden (derived)');
const bbox = mount.querySelector('[data-path="#/spatial/bbox"]');
ok(bbox.querySelectorAll('input').length === 4, `bbox renders ${bbox.querySelectorAll('input').length} positional inputs`);
const slotLabels = [...bbox.querySelectorAll('.grid4 .hint')].map(h => h.textContent).join('/');
const slotTitled = !!schema.allOf[0].properties.spatial.properties.bbox.oneOf[0].oneOf[0].prefixItems[0].title;
ok(slotTitled ? slotLabels.startsWith('West/South/East/North') : /^position 0/.test(slotLabels),
  slotTitled ? `slot labels come from the schema titles: ${slotLabels}`
    : `this schema has no slot titles, so slots fall back to their index: ${slotLabels}`);
ok(bbox.querySelector('input').min === '-180', 'slot bounds come from the schema');
ok(!!bbox.querySelector('.add-row'), 'the schema allows a list of boxes, so rows are repeatable');

// ── 2b. every control is reachable by name ───────────────────────────────────────
const controls = [...mount.querySelectorAll('.field input, .field select, .field textarea')];
const named = c => c.id && mount.querySelector(`label[for="${c.id}"]`);
const grouped = c => c.closest('[role=group][aria-labelledby]');
const unlabelled = controls.filter(c => !named(c) && !grouped(c));
ok(unlabelled.length === 0,
  `all ${controls.length} controls are reachable by name (${controls.filter(named).length} by for/id, the rest inside a labelled group)`);
ok([...mount.querySelectorAll('[aria-required]')].length === mount.querySelectorAll('label.req').length,
  'required fields say so to a screen reader, not just with a CSS asterisk');
// A single-control field must not also be announced as a group.
const bogusGroups = [...mount.querySelectorAll('[role=group]')]
  .filter(g => g.querySelectorAll('input, select, textarea').length === 1);
ok(bogusGroups.length === 0, `no single control is wrapped in a redundant role=group (${bogusGroups.length})`);

// Regressions against the hardcoded form: it had hand-written picklists and one
// pre-seeded card for each required list. Both come from the schema now.
const optionsFor = ptr => {
  const inp = mount.querySelector(`[data-path="${ptr}"] input`);
  const id = inp?.getAttribute('list');
  return id ? mount.querySelector(`#${id}`)?.children.length ?? 0 : 0;
};
ok(optionsFor('#/license') > 0, `license offers ${optionsFor('#/license')} schema examples as a picklist`);
ok(mount.querySelectorAll('[data-path="#/contact"] > div > .dyn-list > .card').length === 1,
  'a required card list opens with one card, as the old form did');
ok(mount.querySelectorAll('[data-path="#/funding"] > div > .dyn-list > .card').length === 0,
  'an optional one does not');

// A free-string array with documented examples offers them without constraining.
form.setData({ additional_assets: [{ name: 't', locations: [{ url: 'https://x' }], roles: ['not-a-listed-role'] }] });
await wait();
const rolesPtr = '#/additional_assets/0/roles';
const rolesField = mount.querySelector(`[data-path="${rolesPtr}"]`);
if (rolesField) {
  // The role examples are only in schemas that document them, so ask the schema first.
  const documented = props.additional_assets?.items?.properties?.roles?.items?.examples?.length ?? 0;
  const n = suggestionsFor(rolesPtr);
  ok(documented ? n === documented : n === 0,
    documented ? `asset roles offer all ${n} suggestions from the schema's examples`
      : 'this schema documents no asset roles, so none are suggested');
  ok(!rolesField.querySelector('.tag.bad'),
    'and a value outside them is allowed — examples suggest, only an enum constrains');
}
form.clear();
await wait();

// ── 3. the ask: typing an invalid geography reports it on that field ──────────────
const geoField = mount.querySelector('[data-path="#/spatial/geography"]');
const geoInput = geoField.querySelector('input.tag-input');
geoInput.value = 'G';
geoInput.dispatchEvent(new dom.window.Event('change'));
await wait();
ok(geoField.classList.contains('bad'), 'geography field flagged after entering "G"');
const geoGroup = geoField.querySelector('[role=group]') || geoField.querySelector('input');
ok(geoGroup.getAttribute('aria-invalid') === 'true', 'and marked aria-invalid');
ok(geoField.querySelector('.field-err[role=alert]'), 'the message is an alert, announced when it appears');
ok(geoGroup.getAttribute('aria-describedby')?.includes(geoField.querySelector('.field-err').id),
  'and is linked from the control via aria-describedby');
ok(/not a valid Geography/.test(geoField.querySelector('.field-err')?.textContent || ''),
  `message: "${geoField.querySelector('.field-err')?.textContent}"`);
ok(geoField.querySelector('.tag.bad')?.textContent.startsWith('G'), 'the offending tag itself is marked');

geoInput.value = 'ethiopia';
geoInput.dispatchEvent(new dom.window.Event('change'));
await wait();
ok(geoField.classList.contains('bad'), 'still flagged while the bad tag is present');
ok(JSON.stringify(last.rec.spatial.geography) === '["G","ethiopia"]', `record: ${JSON.stringify(last.rec.spatial.geography)}`);
geoField.querySelector('.tag.bad .tag-rm').onclick();
await wait();
ok(!geoField.classList.contains('bad'), 'clears once the bad tag is removed');
ok(JSON.stringify(last.rec.spatial.geography) === '["ethiopia"]', `record after remove: ${JSON.stringify(last.rec.spatial.geography)}`);

// ── 4. pattern fields (id) ───────────────────────────────────────────────────────
const idField = mount.querySelector('[data-path="#/id"]');
const idInput = idField.querySelector('input');
idInput.value = 'Not Valid';
idInput.dispatchEvent(new dom.window.Event('input'));
await wait();
ok(idField.classList.contains('bad'), `id "Not Valid" flagged: "${idField.querySelector('.field-err')?.textContent}"`);
idInput.value = 'crop-suitability';
idInput.dispatchEvent(new dom.window.Event('input'));
await wait();
ok(!idField.classList.contains('bad'), 'id clears when it matches the pattern');

// ── 5. required errors stay quiet until touched ───────────────────────────────────
ok(mount.querySelectorAll('.field.bad').length === 0, 'no red on untouched required fields');
const p = form.validate();
await wait();
ok(mount.querySelectorAll('.field.bad').length > 3,
  `"Validate all" surfaces ${mount.querySelectorAll('.field.bad').length} missing/invalid fields`);

// ── 6. round-trip the kitchen-sink example (all 5 extensions) ─────────────────────
const yaml = { default: (await import('node:module')).createRequire(import.meta.url)('js-yaml') };
if (fs.existsSync(`${SPEC}/examples`)) {
  const raw = fs.readFileSync(`${SPEC}/examples/kitchen-sink/example-crop-suitability.yaml`, 'utf8');
  const rec = yaml.default.load(raw);
  delete rec.$schema;
  form.setData(rec);
  await wait();
  ok(last.p.valid, `kitchen-sink example round-trips valid${last.p.valid ? '' : ': ' + JSON.stringify([...last.p.perField].slice(0, 6)) + ' ' + JSON.stringify(last.p.record.slice(0, 6))}`);
  const out = form.record();
  ok(JSON.stringify(out.extensions.sort()) === JSON.stringify(rec.extensions.sort()),
    `derived extensions[] match the example's ${rec.extensions.length}`);
  ok(mount.querySelectorAll('.card').length > 8, `${mount.querySelectorAll('.card').length} cards rebuilt from the loaded record`);
  const kw = mount.querySelector('[data-path="#/keywords"]');
  ok(kw.querySelector('input.tag-input'), 'keywords stays a tag input despite the string|object union');
  ok(!kw.querySelector('.add-row'), 'keywords is not a card list (cards over strings throw on edit)');
  const linked = [...kw.querySelectorAll('.tag')].filter(t => /linked/.test(t.textContent));
  ok(linked.length === rec.keywords.filter(k => typeof k === 'object').length,
    `${linked.length} linked keyword(s) shown by term, preserved verbatim`);
  ok(JSON.stringify(form.record().keywords) === JSON.stringify(rec.keywords), 'keywords round-trip byte-identical');
} else {
  console.log('  skip  kitchen-sink round-trip and keywords checks (spec repo not checked out)');
}

// ── 6b. an added-but-empty card must not invalidate an optional section ──────────
form.clear();
await wait();
const nrField = mount.querySelector('[data-path="#/cdh/not_recommended_for"]');
nrField.querySelector('.add-row').onclick();
await wait();
ok(nrField.querySelectorAll('.card').length === 1, 'clicking add shows a card');
ok(last.rec.cdh?.not_recommended_for === undefined,
  `an untouched card stays out of the record: ${JSON.stringify(last.rec.cdh ?? null)}`);
ok(!nrField.querySelector('.field.bad'), 'and reports no required-field errors');
const useInput = nrField.querySelector('[data-path="#/cdh/not_recommended_for/0/use"] input');
useInput.value = 'field-scale planning';
useInput.dispatchEvent(new dom.window.Event('input'));
await wait();
ok(last.rec.cdh.not_recommended_for[0].use === 'field-scale planning', 'typing puts it in the record');
useInput.value = '';
useInput.dispatchEvent(new dom.window.Event('input'));
await wait();
ok(last.rec.cdh?.not_recommended_for === undefined, 'clearing it takes the blank card back out');
// Filling the 2nd card before the 1st must not produce a null hole.
nrField.querySelector('.add-row').onclick();
await wait();
const second = nrField.querySelectorAll('.card')[1]?.querySelector('input');
if (second) {
  second.value = 'x';
  second.dispatchEvent(new dom.window.Event('input'));
  await wait();
  const arr = last.rec.cdh.not_recommended_for;
  ok(arr.length === 2 && arr.every(e => e && typeof e === 'object'),
    `no sparse holes: ${JSON.stringify(arr)}`);
}

// ── 6c. bbox: one box, several boxes, and 3D ─────────────────────────────────────
const bboxOf = () => mount.querySelector('[data-path="#/spatial/bbox"]');
const rows = () => bboxOf().querySelectorAll('.card');
const inputsIn = i => [...rows()[i].querySelectorAll('input')];

form.setData({ spatial: { bbox: [-20, -35, 55, 38] } });
await wait();
ok(rows().length === 1 && inputsIn(0).length === 4, 'a single 2D box loads as one 4-slot row');
ok(inputsIn(0).map(i => i.value).join(',') === '-20,-35,55,38', 'values shown in the right slots');

form.setData({ spatial: { bbox: [-20, -35, 0, 55, 38, 4000] } });
await wait();
ok(inputsIn(0).length === 6, `a 3D box keeps its elevation slots (${inputsIn(0).length} inputs)`);
ok(JSON.stringify(form.record().spatial.bbox) === '[-20,-35,0,55,38,4000]', 'and round-trips without truncation');

form.setData({ spatial: { bbox: [[-20, -35, 55, 38], [60, 5, 95, 30]] } });
await wait();
ok(rows().length === 2, `a list of boxes loads as ${rows().length} rows`);
ok(JSON.stringify(form.record().spatial.bbox) === '[[-20,-35,55,38],[60,5,95,30]]', 'and stays a list');

// Adding a row turns one box into a list; removing it back collapses to flat again.
bboxOf().querySelector('.add-row').onclick();
await wait();
inputsIn(2).forEach((inp, j) => { inp.value = [100, 10, 120, 20][j]; inp.dispatchEvent(new dom.window.Event('input')); });
await wait();
ok(form.record().spatial.bbox.length === 3, `adding a row adds a box (${form.record().spatial.bbox.length})`);
rows()[2].querySelector('.card-rm').onclick();
rows()[1].querySelector('.card-rm').onclick();
await wait();
ok(JSON.stringify(form.record().spatial.bbox) === '[-20,-35,55,38]',
  `down to one box it serialises flat again: ${JSON.stringify(form.record().spatial.bbox)}`);
ok(form.validate().perField.get('#/spatial/bbox') === undefined, 'every one of those shapes validates');

// ── 7. an unannounced schema change still renders ────────────────────────────────
const next = structuredClone(schema);
const core = next.allOf[0];
delete core.properties.series;                                    // field removed upstream
core.properties.quality_flags = { type: 'array', items: { type: 'string' }, description: 'Never seen by the app.' };
core.properties.grid_size = { type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }] };
const m2 = document.createElement('div');
document.body.append(m2);
createForm({ schema: next, mount: m2, onChange: () => { } });
await wait();
ok(m2.querySelector('[data-path="#/quality_flags"] input.tag-input'), 'a brand-new array field renders with no app change');
ok([...m2.querySelectorAll('.sec-title')].some(t => t.textContent.includes('More fields')), 'ungrouped new fields land in "More fields"');
ok(!m2.querySelector('[data-path="#/series"]'), 'a removed field disappears with no app change');
const gs = m2.querySelector('[data-path="#/grid_size"]');
ok(gs.querySelectorAll('input').length === 2, 'an untitled tuple still renders positionally');
ok(/position 0/.test(gs.textContent), 'untitled slots fall back to their index');

// ── 7a. data from outside does not match the schema's shapes ─────────────────────
// An AI fill sends keywords as "a, b" and contact as one object. This used to throw
// (vals.map is not a function) or, worse, render no cards at all.
const loose = {
  keywords: 'population, worldpop, nigeria',
  cdh: { domain: 'socioeconomic' },
  contact: { organization: 'WorldPop', roles: 'licensor' },
  spatial: { geography: 'nigeria' },
};
form.setData(loose);
await wait();
ok(JSON.stringify(last.rec.keywords) === '["population","worldpop","nigeria"]', 'a comma string becomes a list');
ok(JSON.stringify(last.rec.cdh.domain) === '["socioeconomic"]', 'a bare enum value becomes a one-item list');
ok(last.rec.contact.length === 1 && last.rec.contact[0].roles[0] === 'licensor', 'a lone object becomes a list, nested too');
ok(mount.querySelectorAll('[data-path="#/contact"] > div > .dyn-list > .card').length === 1,
  'and it renders — it used to silently show no cards');
// Positional tuples must NOT be coerced: wrapping a number would corrupt a bbox.
for (const shape of [[2.6, 4.2, 14.7, 13.9], [[2.6, 4.2, 14.7, 13.9], [0, 0, 1, 1]]]) {
  form.setData({ spatial: { bbox: shape } });
  await wait();
  ok(JSON.stringify(form.record().spatial.bbox) === JSON.stringify(shape),
    `bbox survives coercion untouched: ${JSON.stringify(shape)}`);
}
form.clear();
await wait();

// ── 7b. injected cross-field checks are as binding as the schema ─────────────────
const m4 = document.createElement('div');
document.body.append(m4);
let checked = null;
const f4 = createForm({
  schema, mount: m4,
  // `note` is optional, so the schema has nothing to say about it and the injected
  // message is the only one competing for that field.
  extraChecks: rec => { checked = rec; return ['/note: reserved wording is not allowed here']; },
  onChange: () => { },
});
await wait();
let p4 = f4.validate();
await wait();
ok(p4.valid === false, 'a schema-clean record is still invalid if an injected check fails');
ok(p4.perField.get('#/note') === 'reserved wording is not allowed here',
  'the finding lands on the field its pointer names');
ok(m4.querySelector('[data-path="#/note"]')?.classList.contains('bad'), 'and the field is marked');
ok(checked.$schema && checked.cdh_schema_version, 'checks see the derived record, as CI does');

const f5 = createForm({ schema, mount: document.createElement('div'), onChange: () => { },
  extraChecks: () => ['/nope/0/gone: orphaned pointer', 'no pointer at all'] });
await wait();
const p5 = f5.validate();
await wait();
ok(p5.record.includes('nope/0/gone: orphaned pointer') && p5.record.includes('no pointer at all'),
  'findings with no matching field become record-level');

const f6 = createForm({ schema, mount: document.createElement('div'), onChange: () => { },
  extraChecks: () => { throw new Error('boom'); } });
await wait();
const p6 = f6.validate();
await wait();
ok(p6.record.some(r => /could not run: boom/.test(r)), 'a throwing check is reported, not fatal');

// ── 8. a foreign schema, no CDH bookkeeping ──────────────────────────────────────
const foreign = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['slug', 'stage'],
  properties: {
    slug: { type: 'string', pattern: '^[a-z-]+$', examples: ['maize-trial'] },
    stage: { enum: ['draft', 'review', 'published'] },
    replicates: { type: 'integer', minimum: 1, maximum: 8 },
    open_access: { type: 'boolean' },
    sites: { type: 'array', items: { enum: ['kiboko', 'kakamega', 'embu'] } },
    plots: {
      type: 'array',
      items: { type: 'object', required: ['code'], properties: { code: { type: 'string' }, area_m2: { type: 'number' } } },
    },
  },
};
const m3 = document.createElement('div');
document.body.append(m3);
let foreignOut;
const ff = createForm({
  schema: foreign, mount: m3,
  bookkeeping: () => () => ({}),                     // no CDH keys injected
  sections: [{ title: 'Trial', keys: ['slug', 'stage', 'replicates', 'open_access'] }],
  onChange: (rec, pr) => { foreignOut = { rec, pr } },
});
await wait();
ok(m3.querySelector('[data-path="#/stage"] select')?.children.length === 4, 'enum -> select');
ok(m3.querySelector('[data-path="#/replicates"] input')?.type === 'number', 'integer -> number input');
ok(m3.querySelector('[data-path="#/replicates"] input')?.max === '8', 'min/max carried from the schema');
ok(m3.querySelector('[data-path="#/open_access"] input')?.type === 'checkbox', 'boolean -> checkbox');
ok(m3.querySelectorAll('[data-path="#/sites"] .chip').length === 3, 'small enum array -> chips');
ok(m3.querySelector('[data-path="#/plots"] .add-row'), 'array of object -> card list');
ok([...m3.querySelectorAll('.sec-title')].map(t => t.textContent.trim().split('\n')[0]).join(',') === 'Trial,More fields',
  'declared section first, the rest under "More fields"');
ok(JSON.stringify(foreignOut.rec) === '{}', `no CDH keys injected: ${JSON.stringify(foreignOut.rec)}`);
const slug = m3.querySelector('[data-path="#/slug"] input');
slug.value = 'Bad Slug';
slug.dispatchEvent(new dom.window.Event('input'));
await wait();
ok(/maize-trial/.test(m3.querySelector('[data-path="#/slug"] .field-err')?.textContent || ''),
  `foreign schema validates too: "${m3.querySelector('[data-path="#/slug"] .field-err')?.textContent}"`);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
