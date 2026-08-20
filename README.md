# CDH Metadata Generator

A browser form for authoring [CDH metadata](https://github.com/CGIAR-Climate-Data-Hub/cdh-metadata-standard)
records. The form is **generated from the JSON Schema** — fields, labels, hints, controlled
vocabularies and validation all come from the published profile, so a schema release usually
needs no code change here.

No build step, no framework, no dependencies.

```sh
python3 -m http.server 8000     # then http://localhost:8000
```

It has to be served, not opened as a file — the app is ES modules and browsers block
module imports over `file://`, so double-clicking `index.html` gives you a blank page.
GitHub Pages serves `main` as-is.

(The old `server.py` and `proxy.py` are gone: both proxied the OpenCode Zen API, which
the chat stopped using when it moved to OpenRouter and started calling it from the
browser. Their remaining half was static file serving, which the line above does.)

```
index.html        shell only — header, panels, modals (no logic, no inline handlers)
app.css           all styles
app.js            boot: fetch schema → build form → YAML preview → validation panel
schema-form.js    the generator: schema → DOM, with per-field live validation
chat.js           AI assistant (OpenRouter); fills the form by emitting a partial record
prompt.md         the AI's form-specific instructions — plain prose, edit without touching JS
submit.js         triggers the catalog repo's workflow_dispatch, which opens the PR
vendor/           @cfworker/json-schema (validator) and cross-field.js (the spec repo's
                  rules, copied until it publishes them — see that file's header)
check-schema.mjs  reports what a spec release owes the app (not shipped to the site)
```

Buttons carry `data-act="name"`; one delegated listener in `app.js` dispatches them. Modules
register their own actions via `act(name, fn)`.

## Bumping the schema version

One line, `VERSION` in `app.js`. The schema URL, the checks URL, the draft key and the
version shown in the header, the AI pill and the YAML dialog all come from it or from the
`$id` of the schema that actually loaded — so a stale label is not possible, and a
mismatch between the pin and the schema's own version is reported in the console.

## When the schema changes

Run `node check-schema.mjs` after a spec release. No dependencies, nothing to install.
It exits non-zero only when a code change is genuinely needed, and tells you which:

- **New/removed properties** — nothing to do. A new *core* field renders under "More fields"
  until you add its key to a `SECTIONS` entry in `schema-form.js`; a new *extension* groups
  under its own `allOf` branch title automatically.
- **New enum values, descriptions, examples** — nothing to do. `examples` become both the
  placeholder and the error message ("must look like: …"), so wording belongs in the schema,
  not here.
- **`BUMP`** — a release happened; update the pinned `/vX.Y.Z/` in `SCHEMA_URL`.
- **`WIDGET`** — a shape with no generic renderer (a `oneOf` of objects, an open map). Add a
  branch to `widget()` in `schema-form.js`. Nothing in the current schema needs one.

`SCHEMA_URL` pins an immutable release, so a `WIDGET` can only appear when someone bumps
the pin — which is when they run this. In the browser such a field renders as a placeholder
naming the shape, rather than a text box that silently drops the value.
