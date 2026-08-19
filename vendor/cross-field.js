// The CDH cross-field rules: the checks no JSON Schema keyword can express --
// value-to-value comparisons, name cross-references between arrays, per-property
// uniqueness, and the SPDX expression grammar.
//
// THIS IS A COPY. The original lives in the spec repo at
// scripts/validate-yaml.js (checkCrossFieldRules), which is what the catalog's CI
// runs. Copied because the spec repo does not publish it yet.
//
// TO MIGRATE, once the spec repo publishes it: the steps are in app.js, next to the
// CHECKS_URL it replaces. This file is deleted as part of that change.
//
// TO REFRESH THIS COPY while it is still a copy, re-extract from the spec repo;
// test/schema-drift.mjs fails when this file and that function disagree.
//
// The one edit made during extraction: validateSpdxExpression is injected rather
// than imported, so the same source runs in a browser and in Node.

const list = (v) => (Array.isArray(v) ? v : []);
const CDH_VERSIONED_URL =
  /^(https:\/\/cgiar-climate-data-hub\.github\.io\/cdh-metadata-standard)\/(v\d+\.\d+\.\d+)\//;

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
