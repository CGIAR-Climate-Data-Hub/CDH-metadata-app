# CDH Metadata Generator

A browser form for authoring [CDH metadata](https://github.com/CGIAR-Climate-Data-Hub/cdh-metadata-standard)
records. The form is **generated from the JSON Schema** — fields, labels, hints, controlled
vocabularies and validation all come from the published profile, so a schema release usually
needs no code change here.

No build step, no framework. Open `index.html` from any static server; GitHub Pages serves
`main` as-is.

```
package.json      test dependencies and scripts; the app ships no dependencies
index.html        shell only — header, panels, modals (no logic, no inline handlers)
app.css           all styles
app.js            boot: fetch schema → build form → YAML preview → validation panel
schema-form.js    the generator: schema → DOM, with per-field live validation
chat.js           AI assistant (OpenRouter); fills the form by emitting a partial record
prompt.md         the AI's form-specific instructions — plain prose, edit without touching JS
submit.js         triggers the catalog repo's workflow_dispatch, which opens the PR
vendor/           @cfworker/json-schema (validator) and cross-field.js (the spec repo's
                  rules, copied until it publishes them — see that file's header)
test/             headless checks (jsdom); see below
```

Buttons carry `data-act="name"`; one delegated listener in `app.js` dispatches them. Modules
register their own actions via `act(name, fn)`.

## Running the tests

```sh
npm install     # jsdom + js-yaml, for the tests only — the app itself has no dependencies
npm test        # the generator, then the whole app booted in jsdom
npm run drift   # what a schema release owes the app (needs the spec repo checked out)
```
`npm test` runs in CI on every push. The suites prefer a sibling `../metadata` checkout
and fall back to the published schema and example over the network, so they pass either
way — override the location with `CDH_SPEC=/path/to/metadata`. Assertions that depend on
unreleased annotations check the loaded schema rather than assuming, so a local run and a
CI run make the same claims about different inputs.

`npm run drift` can only compare `vendor/cross-field.js` against the spec repo when that
repo is present; without it, it says so instead of passing silently.

## Validation

Two layers, both surfaced in the same panel and both counted in `form.validate()`:

1. **The JSON Schema**, fetched at load and evaluated by the vendored validator. This
   covers everything a schema keyword can state.
2. **The cross-field rules** — value comparisons, name cross-references between arrays,
   per-property uniqueness, the SPDX grammar. `vendor/cross-field.js` is a copy of
   `checkCrossFieldRules` from the spec repo, which is what the catalog's CI runs.
   Its header has the migration steps for when the spec repo publishes it; until then
   `node test/schema-drift.mjs` fails if the copy and the source disagree.

Together they catch 18 of the spec repo's 20 `tests/invalid` fixtures. The other two
(`schema-version-mismatch`, `undeclared-extension`) cannot occur here because the form
derives `$schema`, `cdh_schema_version` and `extensions[]` rather than accepting them.

## The GitHub token

Submission calls `workflow_dispatch` on the catalog repo, which needs a token in the
browser. There is no way around that in a static app — Sveltia CMS and Decap CMS both end
up storing a GitHub token in the browser too. So the goal is to limit what it can do and
how long it lasts, not to hide it:

- **Kept in `sessionStorage` by default**, so it is forgotten when the tab closes.
  "Remember this token in this browser" moves it to `localStorage` as an explicit choice,
  and the note under the checkbox states the consequence as you tick it — anyone using the
  device, or any script that reaches the page, can then read it. **Forget stored token**
  removes it from the browser; revoking it in GitHub settings is what removes it properly.
- **A fine-grained token scoped to the catalog repo with `Actions: read and write` is
  enough.** A classic token carries `repo`, which grants write access to every repository
  you can reach — a far worse thing to leave in a browser.
- **Values from a record are escaped before reaching `innerHTML`.** That path was a real
  XSS: an enum error quotes the offending value, so opening someone's `.yaml` could have
  executed script and read the token. `test/app.test.mjs` asserts it stays inert.

The strongest version — a GitHub App plus a small serverless function holding its private
key, so the browser never holds a repo-writing credential — needs infrastructure this repo
deliberately does not have. That is the Sveltia/Decap pattern if you ever want it.

## What submitting does

**It opens a pull request. It never commits to `main`.** The app calls
`workflow_dispatch` on the catalog repo — `ref: 'main'` there selects which copy of the
workflow definition runs, not where anything lands. `submit-record.yml` then writes
`records/{id}/{id}.yaml`, formats it with Prettier and uses `peter-evans/create-pull-request`
to open a PR from `submit/{record_id}`, labelled `submission`, where CI validates it.

Two consequences of that branch name being deterministic: resubmitting the same record id
updates the existing branch and PR rather than opening a second one (usually what you
want when iterating), and two people submitting the same id would overwrite each other.

It also means **your token never needs write access to the repository contents** — the
commit is made inside the workflow by `secrets.GITHUB_TOKEN`. A fine-grained token with
`Actions: read and write` on the catalog repo is genuinely sufficient.

## Editing an existing record

**Load YAML** in the header opens a `.yaml`/`.yml` record into the form. `created` is kept;
`$schema`, `cdh_schema_version`, `extensions` and `updated` are re-derived, so a record
authored against an older release comes back pinned to this app's version. Keys the current
schema has no property for are reported in the status bar rather than dropped silently — the
validator then rejects them as unevaluated.

## Editing the AI's instructions

`prompt.md` is prepended to the CDH skill to form the system prompt. Edit it as prose; it
is fetched at page load, so a change needs no code edit and no release. `{{FIELD_REFERENCE}}`
is replaced at runtime with the field list generated from the schema — leave it in place.

## When the schema changes

Run `node test/schema-drift.mjs`. It exits non-zero only when a code change is genuinely
needed, and tells you which:

- **New/removed properties** — nothing to do. A new *core* field renders under "More fields"
  until you add its key to a `SECTIONS` entry in `schema-form.js`; a new *extension* groups
  under its own `allOf` branch title automatically.
- **New enum values, descriptions, examples** — nothing to do. `examples` become both the
  placeholder and the error message ("must look like: …"), so wording belongs in the schema,
  not here.
- **`BUMP`** — a release happened; update the pinned `/vX.Y.Z/` in `SCHEMA_URL`.
- **`WIDGET`** — a shape with no generic renderer (a `oneOf` of objects, an open map). Add a
  branch to `widget()` in `schema-form.js`. Nothing in the current schema needs one.
