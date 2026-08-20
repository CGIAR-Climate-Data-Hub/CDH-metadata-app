// What changed in the schema, and what (if anything) the app owes it.
// Run after every spec release:  node check-schema.mjs
// No dependencies — nothing to install.
//   CDH_SPEC=/path/to/metadata   local spec repo (default ../metadata)
//   CDH_SCHEMA=<url|path>        check against a specific bundle instead
import fs from 'node:fs';

const APP = new URL('.', import.meta.url).pathname;
const SPEC = process.env.CDH_SPEC || new URL('../metadata', import.meta.url).pathname;

const { flatten, extensionRules, unsupportedReason, SECTIONS, HIDDEN, TEXTAREA } =
  await import(`${APP}/schema-form.js`);

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
const ver = schema.$id?.match(/\/(v\d+\.\d+\.\d+)\//)?.[1];
for (const f of fs.readdirSync(APP).filter(f => /\.(html|js)$/.test(f))) {
  const text = fs.readFileSync(`${APP}/${f}`, 'utf8');
  const pinned = [...new Set([...text.matchAll(/\/(v\d+\.\d+\.\d+)\//g)].map(m => m[1]))];
  const stale = pinned.filter(v => v !== ver);
  if (stale.length) { say('BUMP  ', `${f} still points at ${stale.join(', ')} — schema is ${ver}`); todo++; }
}

// ── 2. Properties the app has no opinion about ────────────────────────────────────
// Extension properties group under their allOf branch title on their own; only core
// properties with no SECTIONS entry end up in "More fields".
const ungrouped = Object.keys(props).filter(k => !HIDDEN.has(k) && !grouped.has(k) && !origin[k]);
if (ungrouped.length) {
  say('NEW   ', `renders under "More fields" — add to a SECTIONS entry to place it:\n         ${ungrouped.join(', ')}`);
  notes++;
}
const byBranch = Object.keys(props).filter(k => !HIDDEN.has(k) && !grouped.has(k) && origin[k]);
if (byBranch.length) console.log(`\nsections titled by the schema's own allOf branches:` +
  [...new Set(byBranch.map(k => origin[k]))].map(t => `\n  ${t}  →  ${byBranch.filter(k => origin[k] === t).join(', ')}`).join(''));

// ── 3. Config that no longer matches anything (dead weight) ───────────────────────
const known = new Set(Object.keys(props));
const dead = [
  ...[...grouped.keys()].filter(k => !known.has(k)).map(k => `SECTIONS "${grouped.get(k)}" → ${k}`),
  ...[...HIDDEN].filter(k => !known.has(k) && k !== '$schema').map(k => `HIDDEN → ${k}`),
  ...[...TEXTAREA].filter(k => !nested.has(k)).map(k => `TEXTAREA → ${k}`),
];
if (dead.length) { say('DEAD  ', `config points at properties the schema no longer has:\n         ${dead.join('\n         ')}`); todo++; }

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

// ── 4b. The vendored cross-field rules vs the spec repo's copy ────────────────────
// vendor/cross-field.js is a verbatim copy of spec/checks/cross-field.js until a release
// publishes it, so this is a whole-file comparison rather than a parse.
const strip = t => t.split('\n').filter(l => l.trim() && !l.trim().startsWith('//')).join('\n');
const vendored = fs.readFileSync(`${APP}/vendor/cross-field.js`, 'utf8');
const source = (() => {
  try { return fs.readFileSync(`${SPEC}/spec/checks/cross-field.js`, 'utf8') } catch { return null }
})();
if (!source) {
  console.log('\nvendored cross-field rules: spec repo not reachable, cannot compare');
} else if (strip(vendored) === strip(source)) {
  console.log('\nvendored cross-field rules: identical to spec/checks/cross-field.js');
} else {
  say('COPY  ', 'vendor/cross-field.js has drifted from spec/checks/cross-field.js — re-copy it');
  todo++;
}

// ── 5. Enums that crossed the chips/datalist threshold ────────────────────────────
const enums = [];
(function walk(def, ptr, name) {
  if (!def || typeof def !== 'object') return;
  const en = def.enum || def.items?.enum;
  if (en) enums.push([ptr, name, en.length]);
  for (const [k, v] of Object.entries(def.properties || {})) walk(v, `${ptr}/${k}`, k);
  for (const b of [...(def.anyOf || []), ...(def.oneOf || []), ...(def.allOf || [])]) walk(b, ptr, name);
  if (def.items && !def.items.enum) walk(def.items, `${ptr}/*`, name);   // the array already reported it
})({ properties: props }, '#', '');
console.log(`\ncontrolled vocabularies (inlined in the bundle — no app change needed):`);
for (const [ptr, , n] of enums.sort((a, b) => b[2] - a[2]))
  console.log(`  ${String(n).padStart(4)}  ${ptr}  → ${n > CHIP_MAX ? 'datalist' : 'chips'}`);

// ── 6. Extension wiring ───────────────────────────────────────────────────────────
const rules = extensionRules(schema);
console.log(`\nextensions[] derived from the schema's if/then rules:`);
console.log(`  always      ${rules.always.join(', ') || '(none)'}`);
for (const r of rules.conditional) console.log(`  when ${r.keys.join('/')}  →  ${r.url.split('/extensions/')[1]}`);
const unsectioned = rules.conditional.flatMap(r => r.keys).filter(k => !grouped.has(k) && !origin[k]);
if (unsectioned.length) { say('\nNEW   ', `extension triggers with no section: ${unsectioned.join(', ')}`); notes++; }

console.log(todo
  ? `\n${todo} thing(s) need a code change; ${notes} cosmetic.`
  : `\nNothing to do${notes ? ` (${notes} cosmetic note${notes > 1 ? 's' : ''})` : ''} — the form already covers this schema.`);
process.exit(todo ? 1 : 0);
