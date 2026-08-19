// A COPY of spec/checks/cross-field.js from the CDH metadata standard, kept here only
// until a release publishes it. Verbatim — no local edits. The migration steps are in
// app.js beside the CHECKS_URL it replaces; this file is deleted as part of that change.
// check-schema.mjs fails if this copy and the source diverge.

// Cross-field checks for a CDH metadata record - the rules from standard.md
// that JSON Schema cannot state, kept beside the schema and published with it.
//
// Dependency-free ESM, so the same source runs in Node and in a browser:
//
//   import check from "https://cgiar-climate-data-hub.github.io/cdh-metadata-standard/vX.Y.Z/checks/cross-field.js";
//   const errors = check(record);                       // messages, empty when the record passes
//   const errors = check(record, { isSpdx });           // with an SPDX expression validator
//
// `isSpdx` is injected because SPDX validation is the only rule needing a
// library. Omit it and license expressions are accepted unchecked; the rest of
// the rules are unaffected. In Node, pass `spdx-expression-validate`.
//
// This file carries no schema rules. Anything a schema keyword can state lives
// in the schema, where every validator enforces it.

// Matches CDH-hosted, version-tagged schema URLs; captures the version segment.
export const CDH_VERSIONED_URL =
  /^(https:\/\/cgiar-climate-data-hub\.github\.io\/cdh-metadata-standard)\/(v\d+\.\d+\.\d+)\//;

export const list = (v) => (Array.isArray(v) ? v : []);

// Cross-field rules documented in standard.md that the schema cannot express:
// value-to-value comparisons (dates, lengths), name cross-references between
// arrays, per-property uniqueness, and the SPDX expression grammar. Anything a
// schema keyword can state belongs in the schema, not here.
export default function checkCrossFieldRules(doc, { isSpdx = () => true } = {}) {
  const validateSpdxExpression = isSpdx;
  const out = [];
  if (typeof doc?.cdh_schema_version === "string") {
    const refs = [
      ["$schema", doc?.["$schema"]],
      ...list(doc?.extensions).map((url, i) => [`extensions/${i}`, url]),
    ];
    for (const [path, url] of refs) {
      if (typeof url !== "string") continue;
      const urlVersion = url.match(CDH_VERSIONED_URL)?.[2];
      if (urlVersion && urlVersion !== doc.cdh_schema_version) {
        out.push(
          `/${path}: URL targets ${urlVersion} but cdh_schema_version is ${doc.cdh_schema_version} - a record must reference one release throughout`,
        );
      }
    }
  }
  if (typeof doc?.license === "string" && !validateSpdxExpression(doc.license)) {
    out.push(`/license: must be a valid SPDX license expression`);
  }
  const dims = new Map(list(doc?.dimensions).map((d) => [d?.name, list(d?.values).length]));
  const namedVariables = list(doc?.variables).filter((v) => typeof v?.name === "string").length;
  list(doc?.data).forEach((asset, i) => {
    const tpl = asset?.href_template;
    if (typeof tpl !== "string" || tpl === "") return;
    for (const [, token] of tpl.matchAll(/\{([^}]+)\}/g)) {
      if (token === "variable") {
        if (namedVariables === 0) {
          out.push(
            `/data/${i}/href_template: token {variable} expands over variables[].name, but no named variables are declared (requires the datacube extension)`,
          );
        }
      } else if (!dims.has(token)) {
        out.push(
          `/data/${i}/href_template: token {${token}} has no matching dimensions[].name (requires the datacube extension)`,
        );
      } else if (dims.get(token) === 0) {
        out.push(`/data/${i}/href_template: dimension "${token}" must list its values`);
      }
    }
  });
  const { created, updated } = doc;
  if (typeof created === "string" && typeof updated === "string") {
    if (new Date(updated) < new Date(created)) {
      out.push(`/updated: must be >= created (${created})`);
    }
  }
  const steps = list(doc?.processing);
  const stepIds = new Set();
  steps.forEach((step, i) => {
    if (step?.id == null) return;
    if (stepIds.has(step.id)) out.push(`/processing/${i}/id: duplicate id "${step.id}"`);
    stepIds.add(step.id);
  });
  list(doc?.data).forEach((asset, i) => {
    for (const ref of list(asset?.processing_steps)) {
      if (!stepIds.has(ref)) {
        out.push(`/data/${i}/processing_steps: "${ref}" does not match any processing[].id`);
      }
    }
  });
  const varNames = new Set(list(doc?.variables).map((v) => v?.name));
  list(doc?.classes).forEach((cls, i) => {
    if (cls?.variable != null && !varNames.has(cls.variable)) {
      out.push(`/classes/${i}/variable: "${cls.variable}" does not match any variables[].name`);
    }
  });
  const assetNames = new Set();
  for (const [field, assets] of [
    ["data", doc?.data],
    ["additional_assets", doc?.additional_assets],
  ]) {
    list(assets).forEach((asset, i) => {
      if (asset?.name == null) return;
      if (assetNames.has(asset.name)) {
        out.push(
          `/${field}/${i}/name: duplicate asset name "${asset.name}" - names become asset keys and must be unique across data[] and additional_assets[]`,
        );
      }
      assetNames.add(asset.name);
    });
  }
  const columnNames = new Set(
    [...list(doc?.dimensions), ...list(doc?.variables)]
      .map((c) => c?.name)
      .filter((n) => typeof n === "string"),
  );
  list(doc?.joins).forEach((join, i) => {
    const left = list(join?.left_fields);
    const right = list(join?.right_fields);
    if (left.length && right.length && left.length !== right.length) {
      out.push(
        `/joins/${i}: left_fields (${left.length}) and right_fields (${right.length}) must have the same length`,
      );
    }
    left.forEach((f, k) => {
      if (typeof f === "string" && !columnNames.has(f)) {
        out.push(
          `/joins/${i}/left_fields/${k}: "${f}" does not match any declared dimensions[]/variables[] name`,
        );
      }
    });
  });
  return out;
}
