// Generates the CDH metadata form from the JSON Schema, with per-field live validation.
// The data model IS the record: getData() returns something ready for jsyaml.dump().
// ponytail: no framework, no build step — emits the same classes app.css already styles.
import { Validator } from './vendor/json-schema.mjs';

// ── Schema plumbing ─────────────────────────────────────────────────────────────
// The profile spreads the record across allOf[] branches (core + one per extension),
// so the root `properties` is nearly empty. Merge them into one object.
export function flatten(schema) {
  const props = {}, required = new Set(), origin = {}, about = {};
  for (const b of [schema, ...(schema.allOf || [])]) {
    // Each extension is its own allOf branch with a title and a description; remember
    // both, so a new extension groups under its real name and keeps its blurb.
    for (const k of Object.keys(b.properties || {})) {
      props[k] = b.properties[k];
      if (b.title && b !== schema.allOf?.[0]) {
        origin[k] = b.title;
        if (b.description) about[b.title] = b.description;
      }
    }
    for (const k of b.required || []) required.add(k);
  }
  return { props, required, origin, about };
}

// The `extensions[]` URLs are dictated by the schema's own if/then rules, so derive
// them from the record instead of hardcoding — a new extension needs no app change.
export function extensionRules(schema) {
  const ver = (schema.$id || '').match(/\/(v\d+\.\d+\.\d+)\//)?.[1] || 'v0.0.0';
  const url = p => p.replace(/^\^|\$$/g, '')
    .replace(/v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+/, ver)
    .replace(/\\\./g, '.');
  const always = schema.properties?.extensions?.contains?.pattern;
  return {
    always: always ? [url(always)] : [],
    conditional: (schema.allOf || [])
      .filter(b => b.if && b.then?.properties?.extensions?.contains?.pattern)
      .map(b => ({
        keys: b.if.required || (b.if.anyOf || []).flatMap(x => x.required || []),
        url: url(b.then.properties.extensions.contains.pattern),
      })),
  };
}

// The keys cdhBookkeeping() produces: derived, never rendered, never sent to the AI.
// Exported so app.js and chat.js name them once rather than three times.
export const DERIVED = ['$schema', 'cdh_schema_version', 'extensions', 'created', 'updated'];
export const HIDDEN = new Set(DERIVED);

// Section grouping. Anything not listed lands in "More fields", so a property added
// to the schema shows up in the form the day it lands — just ungrouped.
export const SECTIONS = [
  { title: 'Identity',        keys: ['id', 'title', 'version', 'series', 'description', 'resource_type', 'keywords', 'note'] },
  { title: 'Access & rights', keys: ['license', 'access', 'access_note', 'deprecated', 'previous_version'] },
  { title: 'Contacts',        keys: ['contact'] },
  { title: 'Citation',        keys: ['doi', 'citation', 'related_publications', 'funding'] },
  { title: 'Coverage',        keys: ['spatial', 'temporal'] },
  { title: 'Data assets',     keys: ['data', 'additional_assets', 'additional_links', 'processing'] },
  // Extension sections are not listed: their titles come from the schema's own
  // allOf branches, so a new extension needs no entry here.
];

export const TEXTAREA = new Set(['description', 'note', 'access_note', 'reason', 'citation']);

// Chips show a closed set at a glance; a datalist is the only sane way to offer
// hundreds. The exact cut barely matters: this schema's enum arrays are 5 and 7
// (roles, domain) versus 59 and 278 (commodities, geography), so anything from 8
// to 58 renders identically. Not an option — nothing has ever needed to override it.
export const CHIP_MAX = 12;

// ── JSON-pointer get/set on the record ──────────────────────────────────────────
const parts = p => p.replace(/^#\//, '').split('/').map(s => /^\d+$/.test(s) ? +s : s);

function setIn(root, path, value) {
  const ks = parts(path);
  let o = root;
  for (let i = 0; i < ks.length - 1; i++) {
    if (o[ks[i]] == null) o[ks[i]] = typeof ks[i + 1] === 'number' ? [] : {};
    o = o[ks[i]];
    // Filling the 3rd card before the 1st must not leave sparse holes, which
    // serialise as nulls; blanks ahead of it are real blanks and get flagged.
    if (Array.isArray(o) && typeof ks[i + 1] === 'number') while (o.length < ks[i + 1]) o.push({});
  }
  const last = ks[ks.length - 1];
  const empty = value === '' || value === undefined || value === false ||
    (Array.isArray(value) && !value.length);
  if (empty) delete o[last]; else o[last] = value;
  prune(root);
}
const getIn = (root, path) => parts(path).reduce((o, k) => (o == null ? undefined : o[k]), root);

// Keep the record free of things the user never filled: empty objects (an untouched
// optional group would emit `spatial: {}`) and trailing blank array entries (a card
// that was added but never typed into). Interior blanks stay — those are real gaps.
const blank = v => v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length;
function prune(o) {
  for (const [k, v] of Object.entries(o)) {
    if (!v || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      v.forEach(e => { if (e && typeof e === 'object') prune(e); });
      while (v.length && blank(v[v.length - 1])) v.pop();
      if (!v.length) delete o[k];
    } else {
      prune(v);
      if (blank(v)) delete o[k];
    }
  }
}

// ── Schema node inspection ──────────────────────────────────────────────────────
// Collapse anyOf/oneOf unions of scalars (string|number, the four date precisions)
// down to one branch, keeping the parent's prose and examples.
export function scalarize(def) {
  const branches = def.anyOf || def.oneOf;
  if (!branches) return def;
  const objs = branches.filter(b => b.properties || b.type === 'object');
  const scalars = branches.filter(b => !b.properties && b.type !== 'object' && b.type !== 'array');
  // A union mixing scalars and objects (keywords: a bare term OR a linked-vocabulary
  // entry) edits as the simple form; object entries are preserved but not editable.
  const mixed = objs.length && scalars.length;
  const pick = mixed ? scalars[0]
    : objs[0] || branches.find(b => b.type === 'array') || branches[0];
  return {
    ...pick,
    description: def.description ?? pick.description,
    examples: def.examples ?? pick.examples,
  };
}
// Collect every positional-tuple shape a node allows, and note whether a list of them
// is allowed as well. bbox is oneOf(oneOf(2D|3D) | array of those), so this yields the
// 4- and 6-slot forms with repeatable: true.
function tupleForms(def) {
  const forms = [];
  let repeatable = false;
  (function visit(n, inArray) {
    if (!n || typeof n !== 'object') return;
    if (n.prefixItems) {
      if (!forms.some(f => f.length === n.prefixItems.length)) forms.push(n.prefixItems);
      if (inArray) repeatable = true;
      return;
    }
    for (const b of [...(n.oneOf || []), ...(n.anyOf || [])]) visit(b, inArray);
    if (n.items) visit(n.items, true);
  })(def, false);
  forms.sort((a, b) => a.length - b.length);
  return { forms, repeatable };
}

export function enumOf(def) {
  const d = scalarize(def);
  return d.enum || (d.items && scalarize(d.items).enum) || null;
}
// Data from outside — an AI fill, a loaded file — will not always match the schema's
// shapes: a model sends keywords as "a, b" and contact as one object rather than a
// list. Coerce what is unambiguous so it shows up in the form, and leave anything
// genuinely wrong for the validator to report.
function coerce(value, def) {
  if (value == null || !def) return value;
  // Tuples are positional; wrapping a number in an array would corrupt a bbox.
  if (tupleForms(def).forms.length) return value;
  const d = scalarize(def);
  if (d.type === 'array') {
    const items = scalarize(d.items || {});
    const many = Array.isArray(value) ? value
      : typeof value === 'string' && !items.properties
        ? value.split(',').map(v => v.trim()).filter(Boolean)
        : [value];
    return many.map(v => coerce(v, d.items));
  }
  if (d.properties && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, coerce(v, d.properties[k])]));
  }
  return value;
}

// Belt to the coercion's braces: a value the schema does not describe must still not
// throw while painting.
const asArray = v => Array.isArray(v) ? v : v == null ? [] : [v];
// Shapes the dispatch table has no branch for. Falling through to a text input renders
// something plausible and silently loses whatever the field really holds, so the field
// says so instead. check-schema.mjs walks the whole schema with this before a version bump.
export function unsupportedReason(def) {
  if (!def || typeof def !== 'object') return null;
  const branches = def.anyOf || def.oneOf || [];
  if (branches.filter(b => b.properties || b.type === 'object').length > 1) return 'oneOf of objects';
  if (def.patternProperties) return 'patternProperties (map)';
  if (def.additionalProperties && typeof def.additionalProperties === 'object') return 'open map';
  if (def.$ref) return `unresolved $ref ${def.$ref}`;
  return null;
}

const label = k => k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Markup that is safe by construction: every interpolated value is escaped, so a record
// value can only ever become text. Returns a fragment for replaceChildren/append.
// raw() marks a string we wrote ourselves -- the inline icons -- as already-markup; it
// takes no argument that came from a record, and grep finds every use.
export const raw = markup => ({ __raw: String(markup) });
export const html = (parts, ...values) => {
  const markup = parts.reduce((out, part, i) => {
    if (i === parts.length - 1) return out + part;
    const v = values[i];
    return out + part + (v?.__raw ?? esc(v));
  }, '');
  const t = document.createElement('template');
  t.innerHTML = markup;
  return t.content;
};

// Everything CDH-specific about the *output* lives here: keys the profile requires
// but nobody should type.
function cdhBookkeeping(schema) {
  const rules = extensionRules(schema);
  const version = (schema.$id || '').match(/\/(v\d+\.\d+\.\d+)\//)?.[1] || 'v0.0.0';
  const profile = (schema.$id || '').replace('.bundled', '');
  return data => {
    const today = new Date().toISOString().slice(0, 10);
    return {
      $schema: profile,
      cdh_schema_version: version,
      extensions: [...rules.always,
        ...rules.conditional.filter(r => r.keys.some(k => data[k] != null)).map(r => r.url)],
      created: today,
      updated: today,
    };
  };
}

// ── Form ────────────────────────────────────────────────────────────────────────
export function createForm({
  schema, mount, onChange = () => { },
  // Rules no schema keyword can state (value cross-references, the SPDX grammar).
  // Sync, record in, ["/pointer: message"] out — the shape the spec repo already uses.
  extraChecks = null,
}) {
  const { props, required, origin, about } = flatten(schema);
  const validator = new Validator(schema, '2020-12', false);   // shortCircuit off = every field reports
  const derive = cdhBookkeeping(schema);

  let data = {};
  let fields = new Map();          // '#/pointer' -> { el, d }
  let touched = new Set();
  let showAll = false;

  // Third argument is TEXT, never markup — assigned to textContent, so nothing a record
  // holds can be parsed as HTML. Where text and elements genuinely mix, use html`` (it
  // escapes every interpolated value) rather than assembling nodes by hand.
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  // `option` elements come from the platform: new Option(text, value) escapes nothing
  // because it never builds a string. A datalist option carries the value only — a
  // browser renders a differing label beside it, so keep them empty.
  const options = (values, dflt) => values.map(v => new Option(v, v, v === dflt, v === dflt));
  const listOptions = values => values.map(v => new Option('', v));

  // The record as the schema wants to see it: user data over derived bookkeeping.
  const record = () => ({ ...derive(data), ...data });

  // ── Widgets ───────────────────────────────────────────────────────────────────
  function field(key, def, path, req) {
    const d = scalarize(def);
    const wrap = el('div', 'field');
    wrap.dataset.path = path;
    const fid = 'f' + path.replace(/\W+/g, '-');
    const lab = el('label', req ? 'req' : '', label(key));
    lab.id = `${fid}-l`;
    const w = widget(key, d, path, def, req);
    wrap.append(lab, w);

    // Associate the label with what it labels. A single control takes for/id; a group
    // of them (chips, tuple slots, cards) is labelled as a group instead.
    const controls = w.matches?.('input, select, textarea') ? [w] : [...w.querySelectorAll('input, select, textarea')];
    const single = controls.length === 1 ? controls[0] : null;
    const target = single ?? w;
    if (single) {
      single.id = fid;
      lab.htmlFor = fid;
    } else {
      w.setAttribute('role', 'group');
      w.setAttribute('aria-labelledby', lab.id);
    }
    if (req) target.setAttribute('aria-required', 'true');

    // A free-text field with examples gets them as a datalist: the same typeahead the
    // enum fields use, so the schema's examples are pickable instead of just readable.
    if (single?.tagName === 'INPUT' && !single.getAttribute('list') && d.examples?.length > 1) {
      const dl = el('datalist');
      dl.append(...listOptions(d.examples));
      dl.id = `${fid}-dl`;
      single.setAttribute('list', dl.id);
      wrap.append(dl);
    }

    let describedBy = '';
    if (d.description) {
      const hint = el('div', 'hint', d.description);
      hint.id = `${fid}-h`;
      wrap.append(hint);
      describedBy = hint.id;
    }
    fields.set(path, { el: wrap, d, name: label(key), target, fid, describedBy });
    return wrap;
  }

  // How a widget gets chosen. First match wins, top to bottom.
  //
  //   enum                          <select>
  //   boolean                       checkbox
  //   number | integer              <input type=number> (min/max from the schema)
  //   array + prefixItems           one labelled input per position (titles from the schema)
  //   array of enum, <= CHIP_MAX    .chip toggles
  //   array of enum, >  CHIP_MAX    tag input + <datalist>  (filter-as-you-type)
  //   array of scalar               tag input, free text
  //   array of object               .card list with add/remove
  //   object with properties        nested .grp (.grid2 when every child is scalar)
  //   string                        <input>; type from `format`, <textarea> if in `textarea`
  //
  // anyOf/oneOf unions of scalars collapse to their first branch (see scalarize).
  function widget(key, d, path, raw = d, req = false) {
    // Checked on the raw node: scalarize() would have collapsed a oneOf of objects to
    // its first branch, rendering one shape and dropping the others without a word.
    const why = unsupportedReason(raw);
    if (why) return el('div', 'hint', `${why} — needs a branch in widget()`);
    if (d.enum) return select(d.enum, path, d.default);
    if (d.type === 'boolean') return checkbox(path);
    if (d.type === 'number' || d.type === 'integer') return scalar(key, d, path, 'number');
    if (d.type === 'array') return array(key, d, path, raw, req);
    if (d.properties) return group(key, d, path);
    return scalar(key, d, path, 'text');
  }

  function scalar(key, d, path, type) {
    const n = el(TEXTAREA.has(key) ? 'textarea' : 'input');
    if (n.tagName === 'TEXTAREA') n.rows = 3;
    else n.type = d.format === 'email' ? 'email' : d.format === 'uri' ? 'url' : type;
    if (d.examples?.length) n.placeholder = d.examples[0];
    if (d.minimum != null) n.min = d.minimum;
    if (d.maximum != null) n.max = d.maximum;
    const have = getIn(data, path) ?? d.default;
    if (have != null) { n.value = have; n.classList.add('filled'); if (d.default != null) setIn(data, path, have); }
    n.addEventListener('input', () => {
      const v = n.value.trim();
      set(path, type === 'number' && v !== '' ? Number(v) : v);
      n.classList.toggle('filled', !!v);
    });
    n.addEventListener('blur', () => { touched.add(path); revalidate(); });
    return n;
  }

  function select(en, path, dflt) {
    const n = el('select');
    n.append(new Option('—', ''), ...options(en, dflt));
    const have = getIn(data, path);
    if (have != null) { n.value = have; n.classList.add('filled'); }
    else if (dflt) setIn(data, path, dflt);
    n.addEventListener('change', () => {
      touched.add(path);
      n.classList.toggle('filled', !!n.value);
      set(path, n.value);
    });
    return n;
  }

  function checkbox(path) {
    const n = el('input');
    n.type = 'checkbox';   // width comes from .field input[type=checkbox]
    n.checked = !!getIn(data, path);
    n.addEventListener('change', () => { touched.add(path); set(path, n.checked); });
    return n;
  }

  // array<scalar> → tag input. Enum items get a native <datalist>, which is the
  // filter-as-you-type dropdown — 278 geographies, zero JS.
  function tagInput(key, d, path) {
    const en = enumOf(d);
    // An enum is a constraint; `examples` are only suggestions. Both are worth offering
    // as a datalist, but only an enum makes a value that is not in the list wrong.
    // `examples` on the array are whole-array examples ([["a","b"]]), so flatten one
    // level and keep the scalars — otherwise the whole list becomes one option.
    const items = scalarize(d.items || {});
    const suggest = en ?? items.examples
      ?? d.examples?.flat().filter(v => v != null && typeof v !== 'object');
    const box = el('div');
    const tags = el('div', 'tags');
    const row = el('input', 'tag-input');
    row.placeholder = en ? `type to filter ${en.length} options…`
      : suggest ? `type, then Enter — e.g. ${suggest[0]}`
        : 'type, then Enter';
    if (suggest?.length) {
      const id = `dl-${path.replace(/\W+/g, '-')}`;
      const dl = el('datalist');
      dl.append(...listOptions(suggest));
      dl.id = id;
      row.setAttribute('list', id);
      box.append(dl);
    }
    const paint = () => {
      const vals = asArray(getIn(data, path));
      tags.replaceChildren(...vals.map((v, i) => {
        // Objects in a mixed array (a linked keyword) show their label and survive
        // untouched; only the plain-string form is editable here.
        const obj = v && typeof v === 'object';
        const text = obj ? (v.term ?? v.name ?? JSON.stringify(v)) : v;
        const bad = !obj && en && !en.includes(v);
        const t = el('span', 'tag' + (bad ? ' bad' : ''));
        t.append(html`${text}${obj ? raw(' <span class="hint" style="font-size:10px">linked</span>') : ''}<button class="tag-rm" title="Remove">×</button>`);
        if (obj) t.title = JSON.stringify(v, null, 1);
        t.querySelector('button').onclick = () => {
          set(path, (getIn(data, path) || []).filter((_, j) => j !== i));
          paint();
        };
        return t;
      }));
    };
    const add = () => {
      const v = row.value.trim();
      if (!v) return;
      const vals = getIn(data, path) || [];
      touched.add(path);
      if (!vals.includes(v)) set(path, [...vals, v]);
      row.value = '';
      paint();
    };
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } });
    row.addEventListener('change', add);        // fires when a datalist option is picked
    row.addEventListener('blur', add);
    box.append(tags, row);
    paint();
    return box;
  }

  // Small enum arrays reuse the existing .chip toggles.
  function chips(d, path) {
    const box = el('div', 'chips');
    const chosen = new Set(asArray(getIn(data, path)));
    for (const v of enumOf(d)) {
      const c = el('label', 'chip' + (chosen.has(v) ? ' on' : ''));
      c.append(html`<input type="checkbox"${raw(chosen.has(v) ? ' checked' : '')}>${v}`);
      c.querySelector('input').addEventListener('change', e => {
        const vals = new Set(getIn(data, path) || []);
        e.target.checked ? vals.add(v) : vals.delete(v);
        c.classList.toggle('on', e.target.checked);
        touched.add(path);
        set(path, [...vals]);
      });
      box.append(c);
    }
    return box;
  }

  function array(key, d, path, raw = d, req = false) {
    const tuples = tupleForms(raw);
    if (tuples.forms.length) return positional(tuples, path);   // labels/bounds from the slots
    const en = enumOf(d);
    if (en) return en.length <= CHIP_MAX ? chips(d, path) : tagInput(key, d, path);
    const items = scalarize(d.items || {});
    if (!items.properties) return tagInput(key, d, path);

    const box = el('div');
    const list = el('div', 'dyn-list');
    const add = el('button', 'add-row');
    add.textContent = `+ Add ${label(key).replace(/s$/, '').toLowerCase()}`;
    // A required list opens with one card ready to fill; an empty card costs nothing
    // since it stays out of the record until typed into.
    let shown = req ? 1 : 0;
    const paint = () => {
      const vals = asArray(getIn(data, path));
      shown = Math.max(shown, vals.length);
      // Card fields re-register their pointers on every paint, so drop the stale ones.
      for (const p of [...fields.keys()]) if (p.startsWith(path + '/')) fields.delete(p);
      list.replaceChildren(...Array.from({ length: shown }, (_, i) => card(items, `${path}/${i}`, () => {
        const next = (getIn(data, path) || []).filter((_, j) => j !== i);
        shown = Math.max(0, shown - 1);
        set(path, next);
        paint();
      })));
    };
    add.onclick = () => { shown = Math.max(shown, (getIn(data, path) || []).length) + 1; paint(); revalidate(); };
    box.append(list, add);
    paint();
    return box;
  }

  // prefixItems: one labelled input per position. Labels, types and bounds come from the
  // slot schemas. When the schema also allows a list of these (bbox: one box or several),
  // rows are repeatable and a single row still serialises flat, as the standard prefers.
  function positional({ forms, repeatable }, path) {
    const box = el('div');
    const list = el('div', 'dyn-list');
    const read = () => {
      const v = getIn(data, path);
      return Array.isArray(v?.[0]) ? v : (Array.isArray(v) && v.length ? [v] : []);
    };
    let shown = Math.max(1, read().length);

    const write = () => {
      const rows = [...list.children].map(r => [...r.querySelectorAll('input')].map(i => i.value.trim()));
      const done = rows.filter(r => r.length && r.every(x => x !== '')).map(r => r.map(Number));
      set(path, done.length === 0 ? '' : done.length === 1 ? done[0] : done);
    };

    const row = (vals, i) => {
      // Match the row width to the value so a loaded 3D box keeps its elevation slots.
      const slots = forms.find(f => f.length === vals?.length) ?? forms[0];
      const wrap = el('div', repeatable ? 'card' : '');
      const grid = el('div', slots.length > 4 ? 'grid3' : 'grid4');
      slots.forEach((slot, j) => {
        const cell = el('div');
        const inp = el('input');
        inp.type = slot.type === 'number' || slot.type === 'integer' ? 'number' : 'text';
        if (inp.type === 'number') inp.step = 'any';
        if (slot.minimum != null) inp.min = slot.minimum;
        if (slot.maximum != null) inp.max = slot.maximum;
        inp.placeholder = slot.title ?? `[${j}]`;
        if (vals?.[j] != null) inp.value = vals[j];
        inp.addEventListener('input', write);
        cell.append(inp, el('div', 'hint', slot.title ?? `position ${j}`));
        grid.append(cell);
      });
      wrap.append(grid);
      if (repeatable && shown > 1) {
        const rm = el('button', 'card-rm', '×');
        rm.onclick = () => { shown -= 1; const b = read().filter((_, k) => k !== i); set(path, b.length === 1 ? b[0] : b); paint(); };
        wrap.append(rm);
      }
      return wrap;
    };

    const paint = () => {
      const boxes = read();
      shown = Math.max(shown, boxes.length);
      list.replaceChildren(...Array.from({ length: shown }, (_, i) => row(boxes[i], i)));
    };

    box.append(list);
    if (repeatable) {
      const add = el('button', 'add-row', '+ Add another');
      add.onclick = () => { shown += 1; paint(); };
      box.append(add);
    }
    paint();
    return box;
  }

  function card(items, path, remove) {
    const c = el('div', 'card');
    const rm = el('button', 'card-rm', '×');
    rm.onclick = remove;
    c.append(rm);
    const req = new Set(items.required || []);
    for (const [k, v] of Object.entries(items.properties)) {
      if (HIDDEN.has(k)) continue;
      c.append(field(k, v, `${path}/${k}`, req.has(k)));
    }
    return c;
  }

  function group(key, d, path) {
    const box = el('div', 'grp');
    const req = new Set(d.required || []);
    const entries = Object.entries(d.properties).filter(([k]) => !HIDDEN.has(k));
    const allScalar = entries.every(([, v]) => {
      const s = scalarize(v);
      return !s.properties && s.type !== 'array';
    });
    if (allScalar && entries.length > 1) box.classList.add('grid2');
    for (const [k, v] of entries) box.append(field(k, v, `${path}/${k}`, req.has(k)));
    return box;
  }

  // ── Validation ────────────────────────────────────────────────────────────────
  // Drop the structural keywords: they only restate that a child failed, and the child
  // reports the constraint that actually broke. Everything else is a leaf assertion and
  // gets shown — a denylist, so a keyword the schema starts using shows up (noisily)
  // instead of being silently swallowed. additionalProperties is deliberately NOT here:
  // it names the offending key, so a record from before a rename says what is misplaced.
  const STRUCTURAL = new Set(['properties', 'items', 'prefixItems', 'allOf', 'anyOf',
    'oneOf', 'if', '$ref', 'patternProperties', 'additionalItems', 'unevaluatedItems',
    // cascades over every property once an allOf branch fails
    'unevaluatedProperties',
    // The child half of an `additionalProperties: false` rejection: the parent names the
    // offending key, this fires at the key itself — including keys that are perfectly
    // valid and failed for another reason. The parent's message is the honest one.
    'false']);

  // An error inside an array item (#/spatial/geography/0) belongs to the field that
  // renders the array, so walk up to the nearest registered pointer.
  function owner(path) {
    let p = path;
    while (p !== '#' && !fields.has(p)) p = p.replace(/\/[^/]+$/, '') || '#';
    return fields.has(p) ? p : null;
  }

  function problems() {
    const rec = record();
    const { valid, errors } = validator.validate(rec);
    const perField = new Map(), general = [];
    for (const e of errors) {
      if (STRUCTURAL.has(e.keyword)) continue;
      const alt = /\/(anyOf|oneOf)\//.test(e.keywordLocation);
      let path = e.instanceLocation;
      if (e.keyword === 'required') {
        const miss = quoted(e);
        if (!miss || alt) { general.push(clean(e)); continue; }  // "citation OR doi" is not one field's fault
        path = path === '#' ? `#/${miss}` : `${path}/${miss}`;
        if (!touched.has(path) && !showAll) continue;            // don't shout at an untouched form
      }
      if (e.keyword === 'additionalProperties') {
        const key = quoted(e);
        // When a sibling constraint fails the whole object is re-reported, naming
        // properties that are perfectly valid. Only a key with no field is unknown.
        if (!key || fields.has(`${path === '#' ? '#' : path}/${key}`)) continue;
      }
      const at = owner(path);
      if (!at) { general.push(clean(e)); continue; }
      if (perField.has(at)) continue;                           // first message wins
      perField.set(at, message(e, fields.get(at), path, rec));
    }

    // The injected checks are as binding as the schema's own; a record that fails
    // them is not valid, whatever the schema said.
    let extra = [];
    try { extra = extraChecks?.(rec) ?? []; }
    catch (err) { general.push(`cross-field checks could not run: ${err.message}`); }
    for (const item of extra) {
      const [, ptr, msg] = /^\s*(\S*?):\s*([\s\S]*)$/.exec(item) ?? [, '', String(item)];
      const at = ptr ? owner('#' + (ptr.startsWith('/') ? ptr : '/' + ptr)) : null;
      if (at && !perField.has(at)) perField.set(at, msg);
      else general.push(ptr ? `${ptr.replace(/^\//, '')}: ${msg}` : msg);
    }

    return { valid: valid && !extra.length, perField, record: [...new Set(general)] };
  }

  const clean = e => e.error.replace(/^Instance /, '').replace(/\.$/, '');

  // The validator hands back English, so the offending key has to be read out of the
  // message text: `Instance does not have required property "id".` A @cfworker upgrade
  // that rewords its messages breaks these two lines and nothing else.
  const quoted = e => /"([^"]+)"/.exec(e.error)?.[1];
  const listed = e => e.error.match(/\[(.*)\]/)?.[1].split(',') || [];

  // Phrasing only — the rules all come from the schema. Validators emit machine
  // strings ("String does not match pattern"), so lean on the schema's own
  // annotations (examples, title) to say something a human can act on.
  function message(e, f, path, rec) {
    if (e.keyword === 'additionalProperties') {
      const key = quoted(e);
      return key ? `"${key}" is not a field here — it may have moved or been renamed`
        : clean(e);
    }
    if (e.keyword === 'not') {
      const no = f.d.not ?? {};
      if (no.const != null) return `must not be "${no.const}"`;
      if (no.enum?.length) return `must not be one of ${no.enum.join(', ')}`;
    }
    if ((e.keyword === 'pattern' || e.keyword === 'format') && f.d.examples?.length)
      return `must look like: ${f.d.examples.slice(0, 3).join(', ')}`;
    if (e.keyword === 'enum') {
      const bad = getIn(rec, path);
      const opts = listed(e);
      return opts.length > 8
        ? `"${bad}" is not a valid ${f.name}`
        : `must be one of ${opts.join(', ')}`;
    }
    return clean(e);
  }

  let timer;
  function revalidate() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const p = problems();
      for (const { el: f, target, describedBy } of fields.values()) {
        f.classList.remove('bad');
        f.querySelector(':scope > .field-err')?.remove();
        target.removeAttribute('aria-invalid');
        describedBy ? target.setAttribute('aria-describedby', describedBy) : target.removeAttribute('aria-describedby');
      }
      for (const [path, msg] of p.perField) {
        const entry = fields.get(path);
        if (!entry) continue;
        entry.el.classList.add('bad');
        const err = el('div', 'field-err', msg);
        err.id = `${entry.fid}-e`;
        err.setAttribute('role', 'alert');
        entry.el.append(err);
        entry.target.setAttribute('aria-invalid', 'true');
        entry.target.setAttribute('aria-describedby', [entry.describedBy, err.id].filter(Boolean).join(' '));
      }
      onChange(record(), p);
    }, 100);
  }

  function set(path, value) {
    setIn(data, path, value);
    revalidate();
  }

  // ── Build ─────────────────────────────────────────────────────────────────────
  function build() {
    fields = new Map();
    const placed = new Set();
    const secs = SECTIONS
      .map(s => ({ ...s, keys: s.keys.filter(k => props[k] && !HIDDEN.has(k)) }))
      .filter(s => s.keys.length);
    secs.forEach(s => s.keys.forEach(k => placed.add(k)));
    // Whatever SECTIONS did not claim: grouped by the schema branch that declared
    // it, and only otherwise dumped into "More fields".
    const rest = Object.keys(props).filter(k => !placed.has(k) && !HIDDEN.has(k));
    for (const k of rest) {
      const title = origin[k] || 'More fields';
      const sec = secs.find(s => s.title === title) ?? (secs.push({ title, keys: [] }), secs.at(-1));
      sec.keys.push(k);
    }

    mount.replaceChildren(...secs.map((s, i) => {
      const sec = el('div', 'sec' + (i === 0 ? ' open' : ''));
      const nReq = s.keys.filter(k => required.has(k)).length;
      const hd = el('div', 'sec-hd');
      hd.append(html`<div class="sec-title">${s.title}<span class="badge ${nReq ? 'req' : 'opt'}">${nReq ? `${nReq} required` : 'optional'}</span></div>
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`);
      hd.onclick = () => sec.classList.toggle('open');
      const body = el('div', 'sec-body');
      // An extension branch's own description is section-level help; the schema has it.
      if (about[s.title]) body.append(el('div', 'hint', about[s.title]));
      for (const k of s.keys) body.append(field(k, props[k], `#/${k}`, required.has(k)));
      sec.append(hd, body);
      return sec;
    }));
    return secs;
  }

  const api = {
    get data() { return data; },
    record,
    validate() { showAll = true; const p = problems(); revalidate(); return p; },
    setData(rec) {
      const clean = structuredClone(rec);
      for (const [k, v] of Object.entries(clean)) if (props[k]) clean[k] = coerce(v, props[k]);
      data = clean; touched = new Set(Object.keys(rec).map(k => `#/${k}`)); sections = build(); revalidate(); },
    clear() { data = {}; touched = new Set(); showAll = false; sections = build(); revalidate(); },
    get sections() { return sections; },
  };
  let sections = build();
  revalidate();
  return api;
}
