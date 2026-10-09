// What changed in the schema, and what (if anything) the app owes it.
// Run after every spec release:  node check-schema.mjs
// No dependencies — nothing to install.
//   CDH_SPEC=/path/to/metadata   local spec repo (default ../metadata)
//   CDH_SCHEMA=<url|path>        check against a specific bundle instead
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: on Windows the latter yields "/D:/My%20Folder",
// which fs cannot read — and any path containing a space breaks the same way.
const APP = fileURLToPath(new URL('.', import.meta.url));
const SPEC = process.env.CDH_SPEC || fileURLToPath(new URL('../metadata', import.meta.url));

const { flatten, extensionRules, schemaVersion, unsupportedReason, SECTIONS, HIDDEN, RETIRED, TEXTAREA, SOFT_ENUM } =
  await import(new URL('schema-form.js', import.meta.url));

const where = process.env.CDH_SCHEMA || `${SPEC}/spec/schemas/profiles/cdh.schema.bundled.json`;
const schema = JSON.parse(/^https?:/.test(where)
  ? await (await fetch(where)).text()
  : fs.readFileSync(where, 'utf8'));

const { props, required, origin } = flatten(schema);
const grouped = new Map(SECTIONS.flatMap(s => s.keys.map(k => [k, s.title])));
const say = (icon, msg) => console.log(`${icon} ${msg}`);
let todo = 0, notes = 0;

console.log(`\nschema  ${schema.$id}`);
console.log(`app     ${Object.keys(props).length} properties, ${required.size} required, ${SECTIONS.length} sections\n`);

// ── 1. Version pin ───────────────────────────────────────────────────────────────
// Schemas are only published under versioned dirs, so the app pins one on purpose.
const ver = schemaVersion(schema);
const versions = (text, re) => new Set([...text.matchAll(re)].map(m => m[1]));
for (const f of fs.readdirSync(APP).filter(f => /\.(html|js|md)$/.test(f))) {
  const text = fs.readFileSync(`${APP}/${f}`, 'utf8');
  // A version inside quotes or slashes is a pin — it builds a URL or sets the release.
  const pinned = versions(text, /['"\/](v\d+\.\d+\.\d+)['"\/]/g);
  // A bare one in prose is usually history ("removed in v0.4.0"), but index.html carried
  // a stale "validates against v0.3.0" for a whole release precisely because nothing
  // looked here. Report it without failing, and let a human read the sentence.
  const prose = [...versions(text, /\b(v\d+\.\d+\.\d+)\b/g)].filter(v => !pinned.has(v));
  // v0.0.0 is the "no version in the $id" sentinel, not a pin.
  const stale = [...pinned].filter(v => v !== ver && v !== 'v0.0.0');
  if (stale.length) { say('BUMP  ', `${f} still points at ${stale.join(', ')} — schema is ${ver}`); todo++; }
  const oldProse = prose.filter(v => v !== ver && v !== 'v0.0.0');
  if (oldProse.length) {
    say('TEXT  ', `${f} mentions ${oldProse.join(', ')} in prose — history, or a label nobody updated?`);
    notes++;
  }
}

// ── 2. Properties the app has no opinion about ────────────────────────────────────
// Extension properties group under their allOf branch title on their own; only core
// properties with no SECTIONS entry end up in "More fields".
const ungrouped = Object.keys(props).filter(k => !HIDDEN.has(k) && !grouped.has(k) && !origin[k]);
if (ungrouped.length) {
  say('NEW   ', `renders under "More fields" — add to a SECTIONS entry to place it:\n         ${ungrouped.join(', ')}`);
  notes++;
}
// visit(subschema, pointer) for the merged root and everything it reaches. Every
// structural question below is one pass of this.
function walk(def, visit, ptr = '#') {
  if (!def || typeof def !== 'object') return;
  visit(def, ptr);
  for (const [k, v] of Object.entries(def.properties || {})) walk(v, visit, `${ptr}/${k}`);
  for (const b of [...(def.anyOf || []), ...(def.oneOf || []), ...(def.allOf || [])]) walk(b, visit, ptr);
  if (def.items) walk(def.items, visit, `${ptr}/*`);
}

const nested = new Set();          // every property name at any depth
const untitled = [];               // tuple slots the form can only label by index
const unrenderable = [];           // shapes widget() has no branch for
walk({ properties: props }, (def, ptr) => {
  for (const k of Object.keys(def.properties || {})) nested.add(k);
  if (def.prefixItems?.some(sl => !sl.title)) untitled.push([ptr, def.prefixItems.length]);
  const why = unsupportedReason(def);
  if (why) unrenderable.push([ptr, why]);
});

// ── 3. Config that no longer matches anything (dead weight) ───────────────────────
const known = new Set(Object.keys(props));
const dead = [
  ...[...grouped.keys()].filter(k => !known.has(k)).map(k => `SECTIONS "${grouped.get(k)}" → ${k}`),
  // RETIRED keys are hidden precisely because the schema dropped them — being absent
  // is the point, not dead config.
  ...[...HIDDEN].filter(k => !known.has(k) && !RETIRED.includes(k)).map(k => `HIDDEN → ${k}`),
  ...[...TEXTAREA].filter(k => !nested.has(k)).map(k => `TEXTAREA → ${k}`),
  ...[...SOFT_ENUM].filter(k => !nested.has(k)).map(k => `SOFT_ENUM → ${k}`),
];
if (dead.length) { say('DEAD  ', `config points at properties the schema no longer has:\n         ${dead.join('\n         ')}`); todo++; }

// ── 3b. SOFT_ENUM keys that have nothing to offer ─────────────────────────────────
// Without examples the <select> would hold only "—" and "Other…", so say so rather than
// render a list of nothing.
// Judged per key, not per occurrence: SOFT_ENUM matches by name, and the same name can
// appear twice with different intent — contact.organization carries the CGIAR centre
// list, author.organization carries one illustration. The renderer falls back to a text
// input wherever the examples are thin, so only a key with no usable list anywhere is a
// problem worth reporting.
const seen = new Map();
walk({ properties: props }, def => {
  for (const [k, v] of Object.entries(def.properties || {})) {
    if (SOFT_ENUM.has(k)) seen.set(k, (seen.get(k) || false) || v.examples?.length > 1);
  }
});
const noExamples = [...seen].filter(([, ok]) => !ok).map(([k]) => k);
if (noExamples.length) {
  say('THIN  ', `SOFT_ENUM keys with no usable example list anywhere: ${noExamples.join(', ')}`);
  todo++;
}

// ── 4. Shapes the generator can't render ──────────────────────────────────────────
// Tuples render positionally; without slot titles the inputs are labelled by index.
if (untitled.length) {
  say('TITLE ', `tuple slots with no title — inputs fall back to "position N":\n         ${untitled.map(([p, n]) => `${p}  (${n} slots)`).join('\n         ')}`);
  notes++;
}
if (unrenderable.length) {
  say('WIDGET', `no generic renderer — add a branch to widget() in schema-form.js:\n         ${unrenderable.map(([p, w]) => `${p}  (${w})`).join('\n         ')}`);
  todo++;
}

// ── 5. Extension wiring ───────────────────────────────────────────────────────────
const rules = extensionRules(schema);
const unsectioned = rules.conditional.flatMap(r => r.keys).filter(k => !grouped.has(k) && !origin[k]);
if (unsectioned.length) { say('\nNEW   ', `extension triggers with no section: ${unsectioned.join(', ')}`); notes++; }

console.log(todo
  ? `\n${todo} thing(s) need a code change; ${notes} cosmetic.`
  : `\nNothing to do${notes ? ` (${notes} cosmetic note${notes > 1 ? 's' : ''})` : ''} — the form already covers this schema.`);
process.exit(todo ? 1 : 0);
