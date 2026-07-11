/**
 * build-teams-tournaments.js
 * Builds data/teams.json and data/tournaments.json from:
 *   - Wikidata SPARQL (cricket teams + competitions)
 *   - Hard-coded fallback lists for reliability
 */
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const WIKIDATA = 'https://query.wikidata.org/sparql';
const DATA_DIR = path.join(__dirname, '..', 'data');

// ── TEAMS ─────────────────────────────────────────────────────────────────
const TEAMS_SPARQL = `
SELECT DISTINCT ?teamLabel ?countryLabel ?leagueLabel ?typeLabel WHERE {
  ?team wdt:P31 ?type.
  ?type wdt:P279* wd:Q12973014.
  ?team rdfs:label ?teamLabel.
  FILTER(LANG(?teamLabel) = "en")
  FILTER(!REGEX(?teamLabel, "^Q[0-9]+$"))
  OPTIONAL { ?team wdt:P17 ?country. }
  OPTIONAL { ?team wdt:P118 ?league. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 3000
`;

// ── TOURNAMENTS ───────────────────────────────────────────────────────────
const TOURN_SPARQL = `
SELECT DISTINCT ?nameLabel ?countryLabel ?inceptionLabel WHERE {
  {
    ?t wdt:P31/wdt:P279* wd:Q27020041.
  } UNION {
    ?t wdt:P31/wdt:P279* wd:Q15091377.
  } UNION {
    ?t wdt:P31 wd:Q57733494.
  }
  ?t rdfs:label ?nameLabel.
  FILTER(LANG(?nameLabel) = "en")
  FILTER(!REGEX(?nameLabel, "^Q[0-9]+$"))
  OPTIONAL { ?t wdt:P17 ?country. }
  OPTIONAL { ?t wdt:P571 ?inception. BIND(YEAR(?inception) AS ?inceptionLabel) }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 3000
`;

// Hard-coded comprehensive fallbacks (these will always be in the dataset
// even if Wikidata is slow or returns partial results)
const FALLBACK_TEAMS = [
  // International Men's (Full ICC)
  {name:'India', country:'India', gender:'men', type:'International'},
  {name:'Australia', country:'Australia', gender:'men', type:'International'},
  {name:'England', country:'England', gender:'men', type:'International'},
  {name:'Pakistan', country:'Pakistan', gender:'men', type:'International'},
  {name:'South Africa', country:'South Africa', gender:'men', type:'International'},
  {name:'New Zealand', country:'New Zealand', gender:'men', type:'International'},
  {name:'West Indies', country:'West Indies', gender:'men', type:'International'},
  {name:'Sri Lanka', country:'Sri Lanka', gender:'men', type:'International'},
  {name:'Bangladesh', country:'Bangladesh', gender:'men', type:'International'},
  {name:'Afghanistan', country:'Afghanistan', gender:'men', type:'International'},
  {name:'Zimbabwe', country:'Zimbabwe', gender:'men', type:'International'},
  {name:'Ireland', country:'Ireland', gender:'men', type:'International'},
  // International Women's (Full ICC)
  {name:'India Women', country:'India', gender:'women', type:'International'},
  {name:'Australia Women', country:'Australia', gender:'women', type:'International'},
  {name:'England Women', country:'England', gender:'women', type:'International'},
  {name:'South Africa Women', country:'South Africa', gender:'women', type:'International'},
  {name:'New Zealand Women', country:'New Zealand', gender:'women', type:'International'},
  {name:'West Indies Women', country:'West Indies', gender:'women', type:'International'},
  {name:'Sri Lanka Women', country:'Sri Lanka', gender:'women', type:'International'},
  {name:'Bangladesh Women', country:'Bangladesh', gender:'women', type:'International'},
  {name:'Pakistan Women', country:'Pakistan', gender:'women', type:'International'},
  // IPL (Current)
  {name:'Mumbai Indians', country:'India', gender:'men', type:'IPL'},
  {name:'Chennai Super Kings', country:'India', gender:'men', type:'IPL'},
  {name:'Royal Challengers Bengaluru', country:'India', gender:'men', type:'IPL'},
  {name:'Kolkata Knight Riders', country:'India', gender:'men', type:'IPL'},
  {name:'Delhi Capitals', country:'India', gender:'men', type:'IPL'},
  {name:'Rajasthan Royals', country:'India', gender:'men', type:'IPL'},
  {name:'Punjab Kings', country:'India', gender:'men', type:'IPL'},
  {name:'Sunrisers Hyderabad', country:'India', gender:'men', type:'IPL'},
  {name:'Lucknow Super Giants', country:'India', gender:'men', type:'IPL'},
  {name:'Gujarat Titans', country:'India', gender:'men', type:'IPL'},
  // IPL Historical
  {name:'Deccan Chargers', country:'India', gender:'men', type:'IPL'},
  {name:'Pune Warriors India', country:'India', gender:'men', type:'IPL'},
  {name:'Kochi Tuskers Kerala', country:'India', gender:'men', type:'IPL'},
  {name:'Rising Pune Supergiant', country:'India', gender:'men', type:'IPL'},
  {name:'Gujarat Lions', country:'India', gender:'men', type:'IPL'},
  {name:'Delhi Daredevils', country:'India', gender:'men', type:'IPL'},
  {name:'Royal Challengers Bangalore', country:'India', gender:'men', type:'IPL'},
  // WPL (Women's Premier League)
  {name:'Mumbai Indians Women', country:'India', gender:'women', type:'WPL'},
  {name:'Delhi Capitals Women', country:'India', gender:'women', type:'WPL'},
  {name:'Royal Challengers Bengaluru Women', country:'India', gender:'women', type:'WPL'},
  {name:'Gujarat Giants Women', country:'India', gender:'women', type:'WPL'},
  {name:'UP Warriorz Women', country:'India', gender:'women', type:'WPL'},
  // BBL
  {name:'Sydney Sixers', country:'Australia', gender:'men', type:'BBL'},
  {name:'Sydney Thunder', country:'Australia', gender:'men', type:'BBL'},
  {name:'Melbourne Stars', country:'Australia', gender:'men', type:'BBL'},
  {name:'Melbourne Renegades', country:'Australia', gender:'men', type:'BBL'},
  {name:'Brisbane Heat', country:'Australia', gender:'men', type:'BBL'},
  {name:'Perth Scorchers', country:'Australia', gender:'men', type:'BBL'},
  {name:'Adelaide Strikers', country:'Australia', gender:'men', type:'BBL'},
  {name:'Hobart Hurricanes', country:'Australia', gender:'men', type:'BBL'},
  // PSL
  {name:'Karachi Kings', country:'Pakistan', gender:'men', type:'PSL'},
  {name:'Lahore Qalandars', country:'Pakistan', gender:'men', type:'PSL'},
  {name:'Peshawar Zalmi', country:'Pakistan', gender:'men', type:'PSL'},
  {name:'Quetta Gladiators', country:'Pakistan', gender:'men', type:'PSL'},
  {name:'Islamabad United', country:'Pakistan', gender:'men', type:'PSL'},
  {name:'Multan Sultans', country:'Pakistan', gender:'men', type:'PSL'},
  // CPL
  {name:'Trinbago Knight Riders', country:'West Indies', gender:'men', type:'CPL'},
  {name:'Barbados Royals', country:'West Indies', gender:'men', type:'CPL'},
  {name:'Jamaica Tallawahs', country:'West Indies', gender:'men', type:'CPL'},
  {name:'Guyana Amazon Warriors', country:'West Indies', gender:'men', type:'CPL'},
  {name:'St Kitts and Nevis Patriots', country:'West Indies', gender:'men', type:'CPL'},
  {name:'Saint Lucia Kings', country:'West Indies', gender:'men', type:'CPL'},
  // SA20
  {name:'Joburg Super Kings', country:'South Africa', gender:'men', type:'SA20'},
  {name:'MI Cape Town', country:'South Africa', gender:'men', type:'SA20'},
  {name:'Paarl Royals', country:'South Africa', gender:'men', type:'SA20'},
  {name:'Pretoria Capitals', country:'South Africa', gender:'men', type:'SA20'},
  {name:'Sunrisers Eastern Cape', country:'South Africa', gender:'men', type:'SA20'},
  {name:'Durban Super Giants', country:'South Africa', gender:'men', type:'SA20'},
  // ILT20
  {name:'Dubai Capitals', country:'UAE', gender:'men', type:'ILT20'},
  {name:'Abu Dhabi Knight Riders', country:'UAE', gender:'men', type:'ILT20'},
  {name:'MI Emirates', country:'UAE', gender:'men', type:'ILT20'},
  {name:'Gulf Giants', country:'UAE', gender:'men', type:'ILT20'},
  {name:'Desert Vipers', country:'UAE', gender:'men', type:'ILT20'},
  {name:'Sharjah Warriors', country:'UAE', gender:'men', type:'ILT20'},
  // MLC (USA)
  {name:'MI New York', country:'United States', gender:'men', type:'MLC'},
  {name:'Los Angeles Knight Riders', country:'United States', gender:'men', type:'MLC'},
  {name:'Seattle Orcas', country:'United States', gender:'men', type:'MLC'},
  {name:'San Francisco Unicorns', country:'United States', gender:'men', type:'MLC'},
  {name:'Texas Super Kings', country:'United States', gender:'men', type:'MLC'},
  {name:'Washington Freedom', country:'United States', gender:'men', type:'MLC'},
  // The Hundred (England)
  {name:'Oval Invincibles', country:'England', gender:'men', type:'The Hundred'},
  {name:'London Spirit', country:'England', gender:'men', type:'The Hundred'},
  {name:'Southern Brave', country:'England', gender:'men', type:'The Hundred'},
  {name:'Manchester Originals', country:'England', gender:'men', type:'The Hundred'},
  {name:'Birmingham Phoenix', country:'England', gender:'men', type:'The Hundred'},
  {name:'Welsh Fire', country:'England', gender:'men', type:'The Hundred'},
  {name:'Northern Superchargers', country:'England', gender:'men', type:'The Hundred'},
  {name:'Trent Rockets', country:'England', gender:'men', type:'The Hundred'},
  // Ranji Trophy (all teams)
  ...['Andhra','Arunachal Pradesh','Assam','Baroda','Bengal','Bihar','Chandigarh',
      'Chhattisgarh','Delhi','Goa','Gujarat','Haryana','Himachal Pradesh','Hyderabad',
      'Jammu & Kashmir','Jharkhand','Karnataka','Kerala','Madhya Pradesh','Maharashtra',
      'Manipur','Meghalaya','Mizoram','Mumbai','Nagaland','Odisha','Punjab',
      'Railways','Rajasthan','Saurashtra','Services','Sikkim','Tamil Nadu','Tripura',
      'Uttarakhand','Uttar Pradesh','Vidarbha','Puducherry'
    ].map(n => ({name: n, country:'India', gender:'men', type:'Ranji Trophy'})),
  // English County teams
  ...['Durham','Essex','Glamorgan','Gloucestershire','Hampshire','Kent','Lancashire',
      'Leicestershire','Middlesex','Northamptonshire','Nottinghamshire','Somerset',
      'Surrey','Sussex','Warwickshire','Worcestershire','Yorkshire'
    ].map(n => ({name: n, country:'England', gender:'men', type:'County Cricket'})),
  // Australian State teams
  ...['New South Wales','Victoria','Queensland','South Australia','Western Australia',
      'Tasmania','Australian Capital Territory'
    ].map(n => ({name: n, country:'Australia', gender:'men', type:'Sheffield Shield'})),
  // Associate / ICC Members
  ...['Afghanistan','Ireland','Scotland','Netherlands','UAE','Oman','Nepal','Papua New Guinea',
      'Namibia','Uganda','Canada','USA','Hong Kong','Singapore','Kenya','Tanzania',
      'Malaysia','Botswana','Nigeria','Ghana'
    ].map(n => ({name: n, country: n, gender:'men', type:'Associate'})),
];

const FALLBACK_TOURNAMENTS = [
  // ICC Men's
  {name:'ICC Cricket World Cup', country:'International', type:'ICC', frequency:'4 years'},
  {name:'ICC T20 World Cup', country:'International', type:'ICC', frequency:'2 years'},
  {name:'ICC Champions Trophy', country:'International', type:'ICC', frequency:'4 years'},
  {name:'ICC World Test Championship', country:'International', type:'ICC', frequency:'2 years'},
  {name:'ICC Under-19 Cricket World Cup', country:'International', type:'ICC', frequency:'2 years'},
  // ICC Women's
  {name:'ICC Women\'s Cricket World Cup', country:'International', type:'ICC', frequency:'4 years'},
  {name:'ICC Women\'s T20 World Cup', country:'International', type:'ICC', frequency:'2 years'},
  {name:'ICC Women\'s Championship', country:'International', type:'ICC', frequency:'ongoing'},
  // Indian
  {name:'Indian Premier League', country:'India', type:'T20 League', frequency:'Annual'},
  {name:'Women\'s Premier League', country:'India', type:'T20 League', frequency:'Annual'},
  {name:'Ranji Trophy', country:'India', type:'Domestic', frequency:'Annual'},
  {name:'Vijay Hazare Trophy', country:'India', type:'Domestic', frequency:'Annual'},
  {name:'Syed Mushtaq Ali Trophy', country:'India', type:'Domestic', frequency:'Annual'},
  {name:'Duleep Trophy', country:'India', type:'Domestic', frequency:'Annual'},
  {name:'Irani Cup', country:'India', type:'Domestic', frequency:'Annual'},
  {name:'Deodhar Trophy', country:'India', type:'Domestic', frequency:'Annual'},
  {name:'India A tours', country:'India', type:'A-team', frequency:'Annual'},
  // Australian
  {name:'Big Bash League', country:'Australia', type:'T20 League', frequency:'Annual'},
  {name:'Women\'s Big Bash League', country:'Australia', type:'T20 League', frequency:'Annual'},
  {name:'Sheffield Shield', country:'Australia', type:'Domestic', frequency:'Annual'},
  {name:'Marsh Cup', country:'Australia', type:'Domestic', frequency:'Annual'},
  // English
  {name:'The Hundred', country:'England', type:'T20 League', frequency:'Annual'},
  {name:'T20 Blast', country:'England', type:'T20 League', frequency:'Annual'},
  {name:'County Championship', country:'England', type:'Domestic', frequency:'Annual'},
  {name:'One-Day Cup', country:'England', type:'Domestic', frequency:'Annual'},
  {name:'Royal London One-Day Cup', country:'England', type:'Domestic', frequency:'Annual'},
  // Pakistan
  {name:'Pakistan Super League', country:'Pakistan', type:'T20 League', frequency:'Annual'},
  {name:'Quaid-e-Azam Trophy', country:'Pakistan', type:'Domestic', frequency:'Annual'},
  // South Africa
  {name:'SA20', country:'South Africa', type:'T20 League', frequency:'Annual'},
  {name:'CSA T20 Challenge', country:'South Africa', type:'Domestic', frequency:'Annual'},
  {name:'CSA 4-Day Domestic Series', country:'South Africa', type:'Domestic', frequency:'Annual'},
  // West Indies
  {name:'Caribbean Premier League', country:'West Indies', type:'T20 League', frequency:'Annual'},
  // Sri Lanka
  {name:'Lanka Premier League', country:'Sri Lanka', type:'T20 League', frequency:'Annual'},
  // Bangladesh
  {name:'Bangladesh Premier League', country:'Bangladesh', type:'T20 League', frequency:'Annual'},
  {name:'Dhaka Premier League', country:'Bangladesh', type:'Domestic', frequency:'Annual'},
  // UAE
  {name:'International League T20', country:'UAE', type:'T20 League', frequency:'Annual'},
  // USA
  {name:'Major League Cricket', country:'USA', type:'T20 League', frequency:'Annual'},
  // Asia Cup
  {name:'Asia Cup', country:'Asia', type:'Regional', frequency:'2 years'},
  {name:'Asia Cup Women', country:'Asia', type:'Regional', frequency:'2 years'},
  // Historical
  {name:'Benson & Hedges World Series', country:'Australia', type:'Historical', frequency:''},
  {name:'Hero Cup', country:'India', type:'Historical', frequency:''},
  {name:'Sharjah Cup', country:'UAE', type:'Historical', frequency:''},
  {name:'Austral-Asia Cup', country:'International', type:'Historical', frequency:''},
  {name:'Champions League T20', country:'International', type:'Historical', frequency:''},
];

async function sparqlQuery(query, label) {
  console.log(`  Querying Wikidata for ${label}…`);
  try {
    const res = await axios.get(WIKIDATA, {
      params: { query, format: 'json' },
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'BailsCricketApp/1.0' },
      timeout: 30000
    });
    console.log(`    → ${res.data.results.bindings.length} results`);
    return res.data.results.bindings;
  } catch (e) {
    console.warn(`  Wikidata ${label} failed:`, e.message);
    return [];
  }
}

function dedup(arr, keyFn) {
  const seen = new Set();
  return arr.filter(item => {
    const k = keyFn(item).toLowerCase().trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return k.length > 1;
  });
}

async function buildTeams() {
  const rows = await sparqlQuery(TEAMS_SPARQL, 'cricket teams');
  const wikiTeams = rows
    .map(b => ({
      name: b.teamLabel?.value || '',
      country: b.countryLabel?.value || '',
      league: b.leagueLabel?.value || '',
      gender: 'men',
      type: 'International'
    }))
    .filter(t => t.name && t.name.length > 1 && t.name.length < 80);

  const all = dedup([...FALLBACK_TEAMS, ...wikiTeams], t => t.name);
  all.sort((a, b) => a.name.localeCompare(b.name));

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'teams.json'), JSON.stringify(all));
  console.log(`✅ teams.json: ${all.length} teams`);
  return all.length;
}

async function buildTournaments() {
  const rows = await sparqlQuery(TOURN_SPARQL, 'cricket tournaments');
  const wikiTourneys = rows
    .map(b => ({
      name: b.nameLabel?.value || '',
      country: b.countryLabel?.value || '',
      type: 'Tournament',
      frequency: '',
      inception: b.inceptionLabel?.value || ''
    }))
    .filter(t => t.name && t.name.length > 2 && t.name.length < 100);

  const all = dedup([...FALLBACK_TOURNAMENTS, ...wikiTourneys], t => t.name);
  all.sort((a, b) => a.name.localeCompare(b.name));

  fs.writeFileSync(path.join(DATA_DIR, 'tournaments.json'), JSON.stringify(all));
  console.log(`✅ tournaments.json: ${all.length} tournaments`);
  return all.length;
}

async function build() {
  console.log('Building teams + tournaments datasets…');
  const [t, to] = await Promise.all([buildTeams(), buildTournaments()]);
  console.log(`Done: ${t} teams, ${to} tournaments`);
  return { teams: t, tournaments: to };
}

if (require.main === module) {
  build().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { build };
