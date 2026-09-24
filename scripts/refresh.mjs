// refresh.mjs — Régénère le bloc `let deals=[...]` de index.html depuis Notion.
// Node 20+. Query + schéma via l'endpoint REST data source (API Notion 2025-09-03).
// Env : NOTION_TOKEN (secret), DATABASE_ID (défaut ci-dessous), DATA_SOURCE_ID (optionnel)

import { readFileSync, writeFileSync } from "node:fs";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.DATABASE_ID || "3ae2ffba49b183cabc5d0189ec945309";
const DATA_SOURCE_ID = process.env.DATA_SOURCE_ID || null;
const NOTION_VERSION = "2025-09-03";
const INDEX_PATH = "index.html";

const STATUT_PROP = "STATUT ‼️";
const STATUTS_EXCLUS = ["1/ INVESTI", "3/ DEAD"];

const INSTRUMENT_MAP = {
  "EQUITY": "EQ", "BRIDGE SENIOR": "BR", "BRIDGE MEZZ": "BR",
  "DEMEURES": "DE", "PATRIMONIAL": "DE", "BROKER": "BK", "AUTRE": "AU",
};

if (!NOTION_TOKEN) { console.error("NOTION_TOKEN manquant."); process.exit(1); }

const P = (pg, n) => pg.properties[n];
const getTitle = (p) => (p?.title || []).map((x) => x.plain_text).join("").trim();
const getSelect = (p) => p?.select?.name || null;
const getNumber = (p) => (typeof p?.number === "number" ? p.number : null);
const getDateStart = (p) => p?.date?.start || null;
const getDateEnd = (p) => p?.date?.end || null;
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const esc = (s) => (s || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const norm = (s) => (s || "").normalize("NFC").trim();

function makeId(nom, i) {
  const base = (nom || "deal").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "").slice(0, 8);
  return (base || "d") + i;
}

async function notionGet(path) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${NOTION_TOKEN}`, "Notion-Version": NOTION_VERSION },
  });
  if (!res.ok) throw new Error(`Notion GET ${path} ${res.status} : ${await res.text()}`);
  return res.json();
}

async function notionPost(path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`Notion POST ${path} ${res.status} : ${await res.text()}`);
  return res.json();
}

async function resolveSourceAndCheck() {
  const db = await notionGet(`/databases/${DATABASE_ID}`);
  let dsId = DATA_SOURCE_ID;
  if (!dsId) {
    const sources = db.data_sources || [];
    if (sources.length === 0) { console.error("Aucune data source."); process.exit(1); }
    if (sources.length > 1) {
      console.error(`Plusieurs data sources : ${sources.map((s) => `${s.name} (${s.id})`).join(" | ")}`);
      process.exit(1);
    }
    dsId = sources[0].id;
  }
  const dsObj = await notionGet(`/data_sources/${dsId}`);
  const props = dsObj.properties || {};
  if (!props[STATUT_PROP]) {
    console.error(`Propriété "${STATUT_PROP}" introuvable dans la data source.`);
    console.error(`Propriétés disponibles : ${Object.keys(props).join(" | ")}`);
    process.exit(1);
  }
  console.log(`Schema OK — statut "${STATUT_PROP}", exclusions : ${STATUTS_EXCLUS.join(" | ")}`);
  console.log(`Data source : ${dsId}`);
  return dsId;
}

async function fetchDeals(dsId) {
  const pages = [];
  let cursor;
  do {
    const res = await notionPost(`/data_sources/${dsId}/query`, {
      start_cursor: cursor, page_size: 100,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  console.log(`Pages brutes recuperees (avant filtre) : ${pages.length}`);

  // --- DIAGNOSTIC : noms de propriétés + champ statut des 3 premières pages ---
  if (pages.length > 0) {
    console.log(`Noms de proprietes page 1 : ${Object.keys(pages[0].properties).join(" | ")}`);
  }
  for (const pg of pages.slice(0, 3)) {
    console.log(`STATUT brut : ${JSON.stringify(P(pg, STATUT_PROP))}`);
  }
  // --- FIN DIAGNOSTIC ---

  const exclus = STATUTS_EXCLUS.map(norm);
  return pages.filter((pg) => {
    const s = norm(getSelect(P(pg, STATUT_PROP)));
    if (s === "") return false;
    return !exclus.includes(s);
  });
}

function pageToDeal(pg, i) {
  const nom = getTitle(P(pg, "Nom du projet"));
  const instrRaw = getSelect(P(pg, "Instrument"));
  const statut = getSelect(P(pg, STATUT_PROP));
  const sponsor = clean(getSelect(P(pg, "Sponsor / GP")));
  const montant = getNumber(P(pg, "Montant à lever"));
  const proba = getNumber(P(pg, "Probabilité"));
  const tri = getNumber(P(pg, "TRI Post Promote"));
  const upfront = getNumber(P(pg, "Upfront"));
  const promote = getNumber(P(pg, "Promote embarqué"));
  const ds = getDateStart(P(pg, "Timing Décaissement"));
  const de = getDateEnd(P(pg, "Timing Décaissement"));
  const sz = montant != null ? Math.round((montant / 1000) * 1000) / 1000 : 0;
  return {
    id: makeId(nom, i), n: nom, sh: nom.slice(0, 14), sp: sponsor,
    i: INSTRUMENT_MAP[instrRaw] || "AU", pr: statut, ds, de,
    p: proba != null ? proba : 0, sz,
    t: tri != null ? Math.round(tri * 1000) / 10 : 0,
    uf: upfront != null ? Math.round(upfront) : 0,
    pm: promote != null ? Math.round(promote) : 0,
  };
}

function serialize(deals) {
  const lines = deals.map((d) => {
    const dsv = d.ds ? `'${d.ds}'` : "null";
    const dev = d.de ? `'${d.de}'` : "null";
    return `  {id:'${esc(d.id)}',n:'${esc(d.n)}',sh:'${esc(d.sh)}',sp:'${esc(d.sp)}',i:'${d.i}',pr:'${esc(d.pr)}',ds:${dsv},de:${dev},p:${d.p},sz:${d.sz},t:${d.t},uf:${d.uf},pm:${d.pm}}`;
  });
  return "let deals=[\n" + lines.join(",\n") + "\n];";
}

function replaceBlock(html, block) {
  const re = /(?:let|const|var)\s+deals\s*=\s*\[[\s\S]*?\]\s*;/;
  if (!re.test(html)) throw new Error("Bloc 'let deals=[...]' introuvable dans index.html");
  return html.replace(re, block);
}

async function main() {
  const dsId = await resolveSourceAndCheck();
  const pages = await fetchDeals(dsId);
  const deals = pages.map(pageToDeal).filter((d) => d.n);
  console.log(`Deals recuperes : ${deals.length}`);
  const html = readFileSync(INDEX_PATH, "utf8");
  writeFileSync(INDEX_PATH, replaceBlock(html, serialize(deals)), "utf8");
  console.log("index.html mis a jour.");
}

main().catch((e) => { console.error(e); process.exit(1); });
