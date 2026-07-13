// refresh.mjs — Régénère le bloc `let deals=[...]` de index.html depuis Notion.
// Node 20+. Dépendance : @notionhq/client
// Env : NOTION_TOKEN (secret), DATABASE_ID (défaut ci-dessous)
// Règles d'unité validées : sz = Montant à lever / 1000 ; uf,pm en k€ ; t = TRI*100 ; p = 0..1

import { Client } from "@notionhq/client";
import { readFileSync, writeFileSync } from "node:fs";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.DATABASE_ID || "3ae2ffba49b183cabc5d0189ec945309";
const INDEX_PATH = "index.html";
const PRIORITES = ["En exec", "Urgent"];

const INSTRUMENT_MAP = {
  "EQUITY": "EQ", "BRIDGE SENIOR": "BR", "BRIDGE MEZZ": "BR",
  "DEMEURES": "DE", "PATRIMONIAL": "DE", "BROKER": "BK", "AUTRE": "AU",
};

if (!NOTION_TOKEN) { console.error("NOTION_TOKEN manquant."); process.exit(1); }
const notion = new Client({ auth: NOTION_TOKEN });

const P = (pg, n) => pg.properties[n];
const getTitle = (p) => (p?.title || []).map((x) => x.plain_text).join("").trim();
const getSelect = (p) => p?.select?.name || null;
const getNumber = (p) => (typeof p?.number === "number" ? p.number : null);
const getDateStart = (p) => p?.date?.start || null;
const getDateEnd = (p) => p?.date?.end || null;
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const esc = (s) => (s || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");

function makeId(nom, i) {
  const base = (nom || "deal").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "").slice(0, 8);
  return (base || "d") + i;
}

async function fetchDeals() {
  const pages = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
      filter: { or: PRIORITES.map((v) => ({ property: "Priorité", select: { equals: v } })) },
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

function pageToDeal(pg, i) {
  const nom = getTitle(P(pg, "Nom du projet"));
  const instrRaw = getSelect(P(pg, "Instrument"));
  const prio = getSelect(P(pg, "Priorité"));
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
    i: INSTRUMENT_MAP[instrRaw] || "AU", pr: prio, ds, de,
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
  const re = /let deals\s*=\s*\[[\s\S]*?\]\s*;/;
  if (!re.test(html)) throw new Error("Bloc 'let deals=[...]' introuvable dans index.html");
  return html.replace(re, block);
}

async function main() {
  const pages = await fetchDeals();
  const deals = pages.map(pageToDeal).filter((d) => d.n);
  console.log(`Deals recuperes : ${deals.length}`);
  const html = readFileSync(INDEX_PATH, "utf8");
  writeFileSync(INDEX_PATH, replaceBlock(html, serialize(deals)), "utf8");
  console.log("index.html mis a jour.");
}

main().catch((e) => { console.error(e); process.exit(1); });
