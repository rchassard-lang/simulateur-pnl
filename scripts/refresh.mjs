// refresh.mjs — Régénère le bloc `let deals=[...]` de index.html depuis Notion.
// Node 20+. Query + schéma via l'endpoint REST data source (API Notion 2025-09-03).
// Résolution des propriétés insensible aux emojis / espaces / accents.
// Env : NOTION_TOKEN (secret), DATABASE_ID (défaut), DATA_SOURCE_ID (optionnel)

import { readFileSync, writeFileSync } from "node:fs";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.DATABASE_ID || "3ae2ffba49b183cabc5d0189ec945309";
const DATA_SOURCE_ID = process.env.DATA_SOURCE_ID || null;
const NOTION_VERSION = "2025-09-03";
const INDEX_PATH = "index.html";

const STATUT_KEY = "statut";              // clé logique (voir résolution floue)
const STATUTS_EXCLUS = ["1/ INVESTI", "3/ DEAD"];

// Noms "logiques" attendus -> on les retrouvera par correspondance floue.
const FIELDS = {
  nom: "nom du projet",
  instrument: "instrument",
  statut: "statut",
  sponsor: "sponsor / gp",
  montant: "taille",                      // colonne "Taille 💰"
  proba: "probabilite",
  tri: "tri post promote",
  upfront: "upfront",
  promote: "promote embarque",
  timing: "timing decaissement",
};

const INSTRUMENT_MAP = {
  "EQUITY": "EQ", "BRIDGE SENIOR": "BR", "BRIDGE MEZZ": "BR",
  "DEMEURES": "DE", "PATRIMONIAL": "DE", "BROKER": "BK", "AUTRE": "AU",
};

if (!NOTION_TOKEN) { console.error("NOTION_TOKEN manquant."); process.exit(1); }

// --- Helpers de lecture ---
const getTitle = (p) => (p?.title || []).map((x) => x.plain_text).join("").trim();
const getSelect = (p) => p?.select?.name || null;
const getNumber = (p) => (typeof p?.number === "number" ? p.number : null);
const getDateStart = (p) => p?.date?.start || null;
const getDateEnd = (p) => p?.date?.end || null;
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const esc = (s) => (s || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const norm = (s) => (s || "").normalize("NFC").trim();

// Normalisation forte pour comparer des noms de propriétés :
// minuscules, sans accents, sans emojis / ponctuation, espaces compactés.
function slug(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // accents
    .replace(/[^a-z0-9/ ]+/g, " ")                       // emojis, ‼, *, etc.
    .replace(/\s+/g, " ")
    .trim();
}

function makeId(nom, i) {
  const base = (nom || "deal").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "").slice(0, 8);
  return (base || "d") + i;
}

// Construit une table { clé logique -> nom réel de la propriété } via slug().
function resolvePropMap(sampleProps) {
  const bySlug = {};
  for (const realName of Object.keys(sampleProps)) {
    bySlug[slug(realName)] = realName;
  }
  const map = {};
  const missing = [];
  for (const [key, wanted] of Object.entries(FIELDS)) {
    const hit = bySlug[slug(wanted)]
      || Object.keys(bySlug).find((s) => s.startsWith(slug(wanted)));
    if (hit) map[key] = bySlug[hit] || bySlug[slug(wanted)];
    else missing.push(`${key} (~"${wanted}")`);
  }
  if (missing.length) {
    console.error(`Propriétés introuvables : ${missing.join(" | ")}`);
    console.error(`Colonnes disponibles : ${Object.keys(sampleProps).join(" | ")}`);
    process.exit(1);
  }
  return map;
}

// --- Appels REST ---
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

async function resolveSource() {
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
  console.log(`Data source : ${dsId}`);
  return dsId;
}

async function fetchPages(dsId) {
  const pages = [];
  let cursor;
  do {
    const res = await notionPost(`/data_sources/${dsId}/query`, {
      start_cursor: cursor, page_size: 100,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  console.log(`Pages brutes recuperees : ${pages.length}`);
  return pages;
}

function pageToDeal(pg, i, map) {
  const g = (key) => pg.properties[map[key]];
  const nom = getTitle(g("nom"));
  const instrRaw = getSelect(g("instrument"));
  const statut = getSelect(g("statut"));
  const sponsor = clean(getSelect(g("sponsor")));
  const montant = getNumber(g("montant"));
  const proba = getNumber(g("proba"));
  const tri = getNumber(g("tri"));
  const upfront = getNumber(g("upfront"));
  const promote = getNumber(g("promote"));
  const ds = getDateStart(g("timing"));
  const de = getDateEnd(g("timing"));
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
  const dsId = await resolveSource();
  const pages = await fetchPages(dsId);
  if (pages.length === 0) { console.error("0 page recuperee — verifier l'acces."); process.exit(1); }

  const map = resolvePropMap(pages[0].properties);
  console.log(`Colonnes resolues : ${Object.entries(map).map(([k, v]) => `${k}→"${v}"`).join(" | ")}`);

  const exclus = STATUTS_EXCLUS.map(norm);
  const gardees = pages.filter((pg) => {
    const s = norm(getSelect(pg.properties[map[STATUT_KEY]]));
    if (s === "") return false;
    return !exclus.includes(s);
  });
  console.log(`Apres exclusion statuts : ${gardees.length}`);

  const deals = gardees.map((pg, i) => pageToDeal(pg, i, map)).filter((d) => d.n);
  console.log(`Deals recuperes : ${deals.length}`);

  const html = readFileSync(INDEX_PATH, "utf8");
  writeFileSync(INDEX_PATH, replaceBlock(html, serialize(deals)), "utf8");
  console.log("index.html mis a jour.");
}

main().catch((e) => { console.error(e); process.exit(1); });
