/**
 * build-players.js
 * One-time (and cron-driven) script to fetch all international + domestic
 * cricketers from two free, open-license sources:
 *   1. Wikidata SPARQL  — international players with country, role, gender
 *   2. Cricsheet people.csv — ~30k player registrations (names + IDs)
 * Merges both, deduplicates, writes to ../data/players.json
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const OUT_PATH = path.join(__dirname, '..', 'data', 'players.json');

// ── 1. Wikidata SPARQL — international cricketers ─────────────────────────
// Returns all humans whose occupation is "cricketer" (Q11513337) with
// country, batting hand, bowling style, gender. Capped at 10k per query
// so we run two: men's then women's.
const WIKIDATA_URL = 'https://query.wikidata.org/sparql';

const SPARQL = (genderQid) => `
SELECT DISTINCT ?name ?countryLabel ?roleLabel ?batStyleLabel ?bowlStyleLabel ?genderLabel WHERE {
  ?player wdt:P31 wd:Q5;
          wdt:P106 wd:Q11513337;
          wdt:P21  wd:${genderQid};
          rdfs:label ?name.
  FILTER(LANG(?name) = "en")
  OPTIONAL { ?player wdt:P27 ?country. }
  OPTIONAL { ?player wdt:P647 ?role. }      # playing position
  OPTIONAL { ?player wdt:P4656 ?batStyle. } # batting style
  OPTIONAL { ?player wdt:P4657 ?bowlStyle.} # bowling style
  SERVICE wikibase:label {
    bd:serviceParam wikibase:language "en".
  }
}
LIMIT 8000
`;

async function fetchWikidata(genderQid, gender) {
    console.log(`  Fetching Wikidata ${gender}…`);
    try {
        const res = await axios.get(WIKIDATA_URL, {
            params: { query: SPARQL(genderQid), format: 'json' },
            headers: { 'Accept': 'application/sparql-results+json', 'User-Agent': 'BailsCricketApp/1.0' },
            timeout: 30000
        });
        const bindings = res.data.results.bindings;
        console.log(`    → ${bindings.length} results from Wikidata (${gender})`);

        return bindings.map(b => ({
            name:      b.name?.value || '',
            country:   b.countryLabel?.value || '',
            role:      normalizeRole(b.roleLabel?.value || ''),
            batStyle:  b.batStyleLabel?.value || '',
            bowlStyle: b.bowlStyleLabel?.value || '',
            gender,
            source: 'wikidata'
        })).filter(p => p.name && p.name.length > 2 && p.name.length < 60);
    } catch (e) {
        console.warn(`  Wikidata ${gender} failed:`, e.message);
        return [];
    }
}

// ── 2. Cricsheet people.csv — comprehensive player register ───────────────
// Free CC-licensed player register. Columns include: identifier, name,
// unique_name, key_cricinfo, key_cricbuzz etc. No country/role here —
// we use this to supplement names that Wikidata misses.
const CRICSHEET_CSV = 'https://cricsheet.org/register/people.csv';

async function fetchCricsheet() {
    console.log('  Fetching Cricsheet people.csv…');
    try {
        const res = await axios.get(CRICSHEET_CSV, { timeout: 30000 });
        const lines = res.data.split('\n');
        const header = lines[0].split(',');
        const nameIdx   = header.indexOf('name');
        const uNameIdx  = header.indexOf('unique_name');

        const players = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            if (!cols[nameIdx]) continue;
            const name = cols[nameIdx].trim().replace(/^"+|"+$/g, '');
            if (!name || name.length < 3) continue;
            players.push({ name, country: '', role: '', gender: 'men', source: 'cricsheet' });
        }
        console.log(`    → ${players.length} entries from Cricsheet`);
        return players;
    } catch (e) {
        console.warn('  Cricsheet fetch failed:', e.message);
        return [];
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function normalizeRole(raw) {
    if (!raw) return '';
    const r = raw.toLowerCase();
    if (r.includes('wicket') || r.includes('keeper')) return 'Wicket-keeper';
    if (r.includes('all-round') || r.includes('allround')) return 'All-rounder';
    if (r.includes('bowl')) return 'Bowler';
    if (r.includes('bat')) return 'Batter';
    return '';
}

function dedup(players) {
    const seen = new Map();
    for (const p of players) {
        const key = p.name.toLowerCase().trim();
        if (!seen.has(key)) {
            seen.set(key, p);
        } else {
            // Prefer the entry with more info (country, role)
            const existing = seen.get(key);
            if (!existing.country && p.country) seen.set(key, { ...existing, ...p });
            if (!existing.role    && p.role)    seen.set(key, { ...seen.get(key), role: p.role });
        }
    }
    return Array.from(seen.values());
}

// ── Main ──────────────────────────────────────────────────────────────────
async function build() {
    console.log('Building players.json…');
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

    const [menWiki, womenWiki, cricsheet] = await Promise.all([
        fetchWikidata('Q6581097', 'men'),
        fetchWikidata('Q6581072', 'women'),
        fetchCricsheet()
    ]);

    // Priority: Wikidata (has country+role) over Cricsheet (name only)
    const merged = dedup([...menWiki, ...womenWiki, ...cricsheet]);

    // Sort alphabetically
    merged.sort((a, b) => a.name.localeCompare(b.name));

    fs.writeFileSync(OUT_PATH, JSON.stringify(merged, null, 0));
    console.log(`✅ Written ${merged.length} players to ${OUT_PATH}`);
    return merged.length;
}

// Allow requiring as module (for the cron endpoint) or running directly
if (require.main === module) {
    build().then(n => {
        console.log(`Done. Total: ${n} players.`);
        process.exit(0);
    }).catch(e => {
        console.error('Build failed:', e);
        process.exit(1);
    });
}

module.exports = { build };
