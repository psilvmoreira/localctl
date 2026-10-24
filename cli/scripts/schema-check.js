#!/usr/bin/env node
// Fails when schema/app.schema.json (editor autocomplete) and the zod schema the CLI really
// enforces list different fields. Compares field names at every object level; run by `npm test`.
const fs = require('fs');
const path = require('path');
const { appConfigSchema } = require('../src/lib/configSchema');

const jsonSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schema', 'app.schema.json'), 'utf8'));

function unwrapZod(node) {
  for (;;) {
    const def = node._def;
    if (def.innerType) node = def.innerType;
    else if (def.schema) node = def.schema;
    else if (def.typeName === 'ZodArray') node = def.type;
    else return node;
  }
}

const problems = [];
function compare(zodNode, jsonNode, where) {
  const z = unwrapZod(zodNode);
  const j = jsonNode.items && !jsonNode.properties ? jsonNode.items : jsonNode;
  if (z.shape) {
    const zKeys = Object.keys(z.shape);
    const jKeys = Object.keys(j.properties || {});
    for (const k of zKeys.filter((k) => !jKeys.includes(k))) problems.push(`${where}.${k}: in the CLI schema, missing from app.schema.json`);
    for (const k of jKeys.filter((k) => !zKeys.includes(k))) problems.push(`${where}.${k}: in app.schema.json, not accepted by the CLI`);
    for (const k of zKeys.filter((k) => jKeys.includes(k))) compare(z.shape[k], j.properties[k], `${where}.${k}`);
  }
}
compare(appConfigSchema, jsonSchema, '(root)');

if (problems.length) {
  console.error(`schema-check: schema/app.schema.json is out of sync with configSchema.js:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('schema-check: ok');
