# wakama-oracle-publisher
Pins JSON batches to IPFS (Pinata). Posts a Solana Memo on devnet with `{cid, sha256, count, ts_min, ts_max}`. Writes a daily CSV manifest in `runs/`.

## How it works
1) Reads `../wakama-oracle-ingest/batches/*.json`
2) Computes SHA-256 of file bytes
3) Pinata pin (CID v1)
4) Solana Memo tx on devnet with payload
5) Append `{file,cid,sha256,tx,ts}` to `runs/devnet_YYYY-MM-DD.csv`

## Verify
- `solana confirm <tx>` on devnet
- Open IPFS CID via a public gateway

**Signature:** CREATED BY WAKAMA.farm & Supported by Solana foundation

## Example (devnet proof)
```json
{ "file": "2025-10-27T13-15-06-951Z_1f38e64f-6231-46af-bc94-f16871f8ffce.json", "cid": "bafkreihvotrcahuedloaiaqxkeuxndn3kien6awe2tj2l5m4oipijzekrq", "sha256": "1137defc1c8d5053c0c6a0c617c74e07a3af0a5ba24d9b17d38d8e0410b0184b", "tx": "3363UUoT3U3T6dnWvXYWg2r698iL14MAtkHMQ78UjkCwQ3ryMRT5ovZfZMG6zsAiKp4UjVQBZzX1b4DefqWccULd" }
```

## Intégrité des données
Le hash `sha256` enregistré dans le CSV est calculé sur les *octets exacts* du fichier batch local **avant** upload.  
La vérification retélécharge via passerelles IPFS et recalcule le hash pour garantir l’invariance des octets.

## Intégrité des lots
Le SHA-256 enregistré dans `runs/devnet_YYYY-MM-DD.csv` est calculé sur **les octets exacts** envoyés à IPFS.  
La vérification retélécharge le contenu depuis la gateway et recalcule le hash. Si différent ⇒ échec.

## Intégrité et robustesse
- Hash d’intégrité = SHA-256 des *octets envoyés*.
- Upload IPFS via Pinata avec **retry/backoff** exponentiel.
- Vérification byte-par-byte via gateway Pinata, fallback géré côté outil `verify`.
- Journal CSV: `runs/devnet_YYYY-MM-DD.csv` → `file,cid,sha256,tx,ts`.

### Variables utiles
- `PINATA_JWT` (obligatoire)
- `ANCHOR_PROVIDER_URL` (par défaut: devnet)
- `ANCHOR_WALLET` (clé locale Solana)
- `PUBLISH_RETRY_MAX` (défaut 5)
- `PUBLISH_BACKOFF_MS` (défaut 800)

## Intégrité & Fiabilité
- Hash = SHA-256 des **octets uploadés** (vérifié via gateway Pinata).
- Fallback gateways: Pinata → ipfs.io → Cloudflare.
- Retry/backoff exponentiel sur upload IPFS et émission tx.
- Journal CSV `runs/devnet_YYYY-MM-DD.csv` avec `{file,cid,sha256,tx,ts}`.
- Commande sûre: `npm run publish_safe`.
