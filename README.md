# CDH Metadata Generator

A browser form for authoring [CDH metadata](https://github.com/CGIAR-Climate-Data-Hub/cdh-metadata-standard)
records. The form is **generated from the JSON Schema** — fields, labels, hints, controlled
vocabularies and validation all come from the published profile, so a schema release usually
needs no code change here.

No build step, no framework. Open `index.html` from any static server; GitHub Pages serves
`main` as-is.

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
