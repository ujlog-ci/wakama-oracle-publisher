const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const CSV = `runs/devnet_${new Date().toISOString().slice(0,10)}.csv`;
if (!fs.existsSync(CSV)) {
  console.log(JSON.stringify({ ok:false, reason:'no_csv_today', csv:CSV }));
  process.exit(0);
}
const lines = fs.readFileSync(CSV,'utf8').trim().split('\n');
if (lines.length < 2) {
  console.log(JSON.stringify({ ok:false, reason:'csv_empty', csv:CSV }));
  process.exit(1);
}
const last = lines[lines.length-1];
const [file,cid,shaCsv,tx] = last.split(',');
if (!file || !cid || !shaCsv || !tx) {
  console.log(JSON.stringify({ ok:false, reason:'csv_malformed', line:last }));
  process.exit(1);
}

const GATEWAYS = [
  'https://gateway.pinata.cloud/ipfs',
  'https://ipfs.io/ipfs',
  'https://cloudflare-ipfs.com/ipfs'
];

function fetchBuf(url, attempt=1, max=4) {
  return new Promise((resolve,reject)=>{
    https.get(url, res=>{
      if (res.statusCode !== 200) {
        res.resume();
        if (attempt < max) {
          const backoff = 250 * Math.pow(2, attempt-1);
          return setTimeout(()=>fetchBuf(url, attempt+1, max).then(resolve, reject), backoff);
        }
        return reject(new Error(`HTTP_${res.statusCode}`));
      }
      const chunks=[];
      res.on('data',d=>chunks.push(d));
      res.on('end',()=>resolve(Buffer.concat(chunks)));
    }).on('error',err=>{
      if (attempt < max) {
        const backoff = 250 * Math.pow(2, attempt-1);
        return setTimeout(()=>fetchBuf(url, attempt+1, max).then(resolve, reject), backoff);
      }
      reject(err);
    });
  });
}

(async ()=>{
  let buf=null, gwUsed=null, errors=[];
  for (const gw of GATEWAYS) {
    const url = `${gw}/${cid}`;
    try {
      const b = await fetchBuf(url);
      // stop si taille aberrante (< 2KB)
      if (b.length < 2000) { errors.push(`too_small@${gw}`); continue; }
      buf = b; gwUsed = gw; break;
    } catch(e){ errors.push(`${gw}:${e.message}`); }
  }
  if (!buf) {
    console.log(JSON.stringify({ ok:false, reason:'download_failed', cid, errors }));
    process.exit(1);
  }
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const ok = sha.toLowerCase() === shaCsv.toLowerCase();
  console.log(JSON.stringify({
    ok,
    file, cid, sha256: sha, tx, gw: gwUsed,
    csv_sha: shaCsv
  }));
  process.exit(ok?0:1);
})().catch(e=>{
  console.log(JSON.stringify({ ok:false, reason:'exception', error:e.message }));
  process.exit(1);
});
