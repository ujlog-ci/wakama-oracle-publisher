#!/usr/bin/env node
// Compat: conserve l'usage "node tools/export-now.cjs /abs/path/now.json"
// et délègue à build-now.cjs en s'appuyant sur les receipts.

const { spawnSync } = require('child_process');
const path = require('path');

const out = process.argv[2];
if (!out) {
  console.error('usage: node tools/export-now.cjs /abs/path/now.json');
  process.exit(1);
}

// Dir des reçus (projet/receipts). Utilise un chemin explicite pour éviter les cwd surprises.
const receiptsDir = path.join(__dirname, '..', 'receipts');

// build-now.cjs attend: <receiptsDir> <outPath>
const args = [path.join(__dirname, 'build-now.cjs'), receiptsDir, out];
const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(r.status ?? 0);
