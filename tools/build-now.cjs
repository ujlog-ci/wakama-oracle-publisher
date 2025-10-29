#!/usr/bin/env node
// CJS, Node >=18
const fs = require('fs');
const path = require('path');

// Args compatibles (ne rien casser)
const receiptsDir = process.argv[2] || 'receipts';
const outPath = process.argv[3] || path.join(__dirname, '..', '..', 'wakama-dashboard', 'public', 'now.json');

// Utils
const readJsonSafe = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};
const uniq = (arr) => Array.from(new Set(arr));

// Collecte
const files = (fs.existsSync(receiptsDir) ? fs.readdirSync(receiptsDir) : [])
  .filter(f => f.endsWith('.json'))
  .sort(); // tri alpha; on triera par ts plus bas

const items = [];
for (const f of files) {
  const p = path.join(receiptsDir, f);
  const j = readJsonSafe(p);
  if (!j) continue;

  // Compat: certains reçus peuvent avoir IpfsHash au lieu de cid
  const cid = j.cid || j.IpfsHash || null;
  const tx = j.tx || '';
  const sha256 = j.sha256 || '';
  // ts prioritaire côté reçu, sinon fallback sur nom de fichier (sans .json)
  const ts = (j.ts && String(j.ts)) || f.replace(/\.json$/, '');

  if (!cid) continue; // ignorer reçus incomplets

  items.push({
    cid,
    tx,
    file: j.file || f,          // garder le nom “logique” si présent
    sha256,
    ts,
    // nouveaux champs (optionnels)
    status: j.status || (tx ? 'submitted' : 'n/a'),
    slot: (typeof j.slot === 'number' ? j.slot : null),
    source: j.source || ''      // 'simulated' / 'ingest' si renseigné
  });
}

// Tri: plus récent en premier par ts (string compare OK sur ISO)
items.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

const totals = {
  files: items.length,
  cids: uniq(items.map(it => it.cid)).length,
  onchainTx: items.filter(it => it.tx && String(it.tx).length > 0).length,
  lastTs: items.length ? items[0].ts : '—'
};

// Sortie: ne pas tronquer ici; le dashboard tranche déjà à 50
const out = { totals, items };

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
console.log(`Wrote snapshot: ${outPath}`);
