require('dotenv').config({ path: __dirname + '/../.env' });

// CommonJS, Node >=18
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const path = require('path');

// ---- Config retry/backoff ----
const MAX_RETRY = parseInt(process.env.PUBLISH_RETRY_MAX || '5', 10);
const BASE_MS   = parseInt(process.env.PUBLISH_BACKOFF_MS || '800', 10);

// ---- Inputs ----
const { PINATA_API_KEY, PINATA_API_SECRET } = process.env;
const RPC        = process.env.ANCHOR_PROVIDER_URL || 'https://api.devnet.solana.com';
const WALLET     = process.env.ANCHOR_WALLET || (process.env.HOME + '/.config/solana/id.json');
const GW         = (process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs').replace(/\/+$/, '');
const SELF       = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(WALLET, 'utf8'));
    if (Array.isArray(j) && j[0]?.pubkey) return j[0].pubkey;
  } catch {}
  return execSync('solana address').toString().trim();
})();

// ---- Modes ----
// 1) Ingest (par défaut) : charge le dernier JSON depuis ~/dev/wakama/wakama-oracle-ingest/batches/*.json
//    ou un chemin passé en argument: `node src/publish.cjs /path/to/batch.json`
// 2) Simulé (--sim) : génère un lot JSON capteurs et le publie (source=simulated)

function newestBatch() {
  const ingestDir = process.env.INGEST_DIR || path.join(process.env.HOME, 'dev/wakama/wakama-oracle-ingest');
  const dir = path.join(ingestDir, 'batches');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  if (!files.length) throw new Error('no batch json in ' + dir);
  return path.join(dir, files[files.length - 1]);
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}
function sha256Str(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function jitter(ms){ return Math.floor(ms * (0.8 + Math.random()*0.4)); }
function curlJson(cmd) {
  const out = execSync(cmd, {stdio:['ignore','pipe','pipe'], shell:'/bin/bash'}).toString();
  return JSON.parse(out);
}
function shaFromGateway(cid, gw) {
  const cmd = `curl -sL "${gw}/${cid}" | sha256sum | awk '{print $1}'`;
  return execSync(cmd, {shell:'/bin/bash'}).toString().trim();
}

// ---- Retry wrappers ----
async function withRetry(name, fn) {
  let err;
  for (let i=0;i<MAX_RETRY;i++){
    try { return await fn(); } catch(e){
      err = e;
      const wait = jitter(BASE_MS * Math.pow(2, i));
      console.error(`${name}: attempt ${i+1}/${MAX_RETRY} failed: ${e.message || e}. backoff ${wait}ms`);
      await sleep(wait);
    }
  }
  throw new Error(`${name}: failed after ${MAX_RETRY} attempts: ${err && err.message || err}`);
}

// ---- Upload to Pinata (file) ----
async function uploadPinataFile(filePath, fname) {
  if (!PINATA_API_KEY || !PINATA_API_SECRET) throw new Error("PINATA_API_KEY/SECRET missing");
  return withRetry('pinFileToIPFS', () => {
    const cmd = [
      'curl -sS -X POST "https://api.pinata.cloud/pinning/pinFileToIPFS"',
      `-H "pinata_api_key: ${PINATA_API_KEY}"`,
      `-H "pinata_secret_api_key: ${PINATA_API_SECRET}"`,
      `-F "file=@${filePath};filename=${fname}"`
    ].join(' ');
    const j = curlJson(cmd);
    if (!j.IpfsHash) throw new Error('Pinata response missing CID');
    return j.IpfsHash;
  });
}

// ---- Emit tx with retry (Memo) ----
async function emitTxMemo(memo) {
  const cmd = `solana transfer "${SELF}" 0 --url ${RPC} --with-memo '${memo}' --allow-unfunded-recipient --no-wait`;
  return withRetry('solana-memo', () => {
    const out = execSync(cmd, {stdio:['ignore','pipe','pipe'], shell:'/bin/bash'}).toString().trim();
    return out.split(/\s+/).pop(); // tx sig
  });
}

// ---- Générateur capteurs simulés ----
function randn() { // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function genSeries({ kind, n = 60, base, driftPerMin = 0.01, noise = 0.5, bounds }) {
  const points = [];
  const now = Date.now();
  let val = base;
  for (let i = 0; i < n; i++) {
    val += driftPerMin + noise * randn();
    val = clamp(val, bounds[0], bounds[1]);
    points.push({ t: now - (n - 1 - i) * 60_000, v: Number(val.toFixed(2)) });
  }
  return { kind, points };
}
function buildSimulatedBatch() {
  const ts = new Date().toISOString();
  const site = { zone: 'raviart', field: 'bouake', device: 'esp32-001' };

  const dhtTemp = genSeries({ kind: 'DHT22.tempC', n: 60, base: 28.5, driftPerMin: 0.005, noise: 0.30, bounds: [18, 45] });
  const dhtHum  = genSeries({ kind: 'DHT22.humidity', n: 60, base: 62.0, driftPerMin: 0.010, noise: 1.20, bounds: [15, 98] });
  const dsSoilT = genSeries({ kind: 'DS18B20.soilTempC', n: 60, base: 24.0, driftPerMin: 0.003, noise: 0.25, bounds: [10, 40] });
  const soilPct = genSeries({ kind: 'Soil.moisturePct', n: 60, base: 38.0, driftPerMin: 0.008, noise: 1.00, bounds: [5, 95] });

  const batch = {
    type: 'wakama.sensor.batch',
    version: 1,
    source: 'simulated',
    site,
    ts,
    readings: [dhtTemp, dhtHum, dsSoilT, soilPct],
    meta: { note: 'Simulated sensor data for demo', unitTime: 'ms since epoch' }
  };

  // champs d’intégrité pour le mémo
  const flatCount = dhtTemp.points.length + dhtHum.points.length + dsSoilT.points.length + soilPct.points.length;
  const ts_min = Math.min(...[dhtTemp, dhtHum, dsSoilT, soilPct].flatMap(s => s.points.map(p => p.t)));
  const ts_max = Math.max(...[dhtTemp, dhtHum, dsSoilT, soilPct].flatMap(s => s.points.map(p => p.t)));

  const jsonStr = JSON.stringify({ ...batch, count: flatCount, ts_min, ts_max });
  const sha = sha256Str(jsonStr);

  // écrit dans tmp/ pour réutiliser le pipeline file→Pinata
  const tmpDir = path.join(process.cwd(), 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const fname = `wakama-batch-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const tmpPath = path.join(tmpDir, fname);
  fs.writeFileSync(tmpPath, jsonStr, 'utf8');

  return { filePath: tmpPath, fileName: fname, shaLocal: sha, memoPayload: { cid: null, sha256: sha, count: flatCount, ts_min, ts_max }, source: 'simulated' };
}

// ---- Confirm Devnet tx (slot + status) ----
function confirmTx(sig) {
  if (!sig) return null;
  try {
    // sortie JSON stable
    const out = execSync(`solana confirm ${sig} --url ${RPC} --output json`, { stdio: ['ignore','pipe','pipe'], shell: '/bin/bash' })
      .toString();
    const j = JSON.parse(out);
    // formats possibles selon versions CLI
    const status = j?.value?.confirmationStatus || j?.result?.value?.confirmationStatus || 'unknown';
    const slot   = j?.value?.slot || j?.result?.context?.slot || null;
    return { status, slot };
  } catch {
    return { status: 'unknown', slot: null };
  }
}

// ---- Main ----
(async () => {
  if (!PINATA_API_KEY || !PINATA_API_SECRET) throw new Error("PINATA_API_KEY/SECRET missing");

  const isSim = process.argv.includes('--sim');
  let PATH_JSON, FNAME, SOURCE, shaLocal, memoPayload;

  if (isSim) {
    const sim = buildSimulatedBatch();
    PATH_JSON   = sim.filePath;
    FNAME       = sim.fileName;
    SOURCE      = sim.source;
    shaLocal    = sim.shaLocal;
    memoPayload = sim.memoPayload; // cid rempli après upload
  } else {
    // Mode ingest inchangé
    PATH_JSON = process.argv[2] || newestBatch();
    FNAME     = path.basename(PATH_JSON);
    SOURCE    = 'ingest';
    shaLocal  = sha256File(PATH_JSON);

    const batch = JSON.parse(fs.readFileSync(PATH_JSON, 'utf8'));
    memoPayload = {
      cid: null,
      sha256: shaLocal,
      count: batch.count || (batch.measures ? batch.measures.length : undefined),
      ts_min: batch.ts_min,
      ts_max: batch.ts_max
    };
  }

  // 1) Upload fichier (JSON) → Pinata
  const cid = await uploadPinataFile(PATH_JSON, FNAME);

  // 2) Integrity: byte-for-byte via gateway
  const shaGw = shaFromGateway(cid, GW);
  if (shaGw !== shaLocal) throw new Error('sha mismatch gateway vs local');

  // 3) Emit tx with memo {cid,sha256,count,ts_min,ts_max}
  memoPayload.cid = cid;
  const memo = JSON.stringify(memoPayload);
  const tx = await emitTxMemo(memo);

  // 3b) Confirm tx (slot + status)
  const txInfo = confirmTx(tx); // { status, slot } ou null

  // 4) Logs + receipt JSON (utilisé par build-now.cjs)
  const day = new Date().toISOString().slice(0,10);
  fs.mkdirSync('runs', {recursive: true});
  fs.appendFileSync(`runs/devnet_${day}.csv`,
    `${FNAME},${cid},${shaLocal},${tx},${new Date().toISOString()}\n`
  );

  const receiptsDir = path.join(process.cwd(), 'receipts');
  fs.mkdirSync(receiptsDir, { recursive: true });
  const rPath = path.join(receiptsDir, `${Date.now()}-receipt.json`);
  const receipt = {
    cid,
    sha256: shaLocal,
    tx,
    file: FNAME,
    gw: GW,
    source: SOURCE,             // 'simulated' ou 'ingest'
    ts: new Date().toISOString(),
    // nouveaux champs
    status: txInfo?.status || (tx ? 'submitted' : 'n/a'),
    slot: txInfo?.slot || null
  };
  fs.writeFileSync(rPath, JSON.stringify(receipt, null, 2), 'utf8');

  console.log(JSON.stringify({ok:true, mode: SOURCE, file:FNAME, cid, sha256:shaLocal, tx, gw: GW, receipt: rPath}));
})().catch(e=>{
  console.error(e.message || e);
  process.exit(1);
});
