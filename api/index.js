const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const fs      = require('fs');
const path    = require('path');

const app = express();
const cache = new NodeCache({ stdTTL: 60 });

app.use(cors());

// ── DATA STORE ─────────────────────────────────────────────────────────────
let _players = [];
let _teams = [];
let _tournaments = [];
let _dataLoadedAt = 0;

function loadData() {
    try {
        const dataDir = path.join(__dirname, '..', 'data');
        if (fs.existsSync(path.join(dataDir, 'players.json'))) {
            _players = JSON.parse(fs.readFileSync(path.join(dataDir, 'players.json'), 'utf8'));
        }
        if (fs.existsSync(path.join(dataDir, 'teams.json'))) {
            _teams = JSON.parse(fs.readFileSync(path.join(dataDir, 'teams.json'), 'utf8'));
        }
        if (fs.existsSync(path.join(dataDir, 'tournaments.json'))) {
            _tournaments = JSON.parse(fs.readFileSync(path.join(dataDir, 'tournaments.json'), 'utf8'));
        }
        _dataLoadedAt = Date.now();
        console.log(`Loaded ${_players.length} players, ${_teams.length} teams, ${_tournaments.length} tournaments.`);
    } catch (e) {
        console.warn('Could not load data:', e.message);
    }
}

loadData();

// ── MATCH NORMALIZER ─────────────────────────────────────────────────────────
function normalizeScrapedMatch(raw) {
    const t1 = raw.team1 || 'Team A';
    const t2 = raw.team2 || 'Team B';
    const hay = `${raw.title} ${t1} ${t2}`.toLowerCase();
    const gender = /\bwomen'?s?\b/.test(hay) ? 'women' : 'men';
    return {
        id: Buffer.from(`${t1}-${t2}-${raw.title}`).toString('base64'),
        name: `${t1} vs ${t2}`,
        matchType: (raw.type || 'MATCH').toUpperCase(),
        statusText: raw.status || (raw.isLive ? 'Live' : 'Upcoming'),
        isLive: raw.isLive,
        isUpcoming: !raw.isLive && !raw.isCompleted,
        isCompleted: raw.isCompleted,
        venue: raw.venue || '',
        dateGMT: raw.date || new Date().toISOString(),
        team1: { name: t1, logo: null, score: raw.score1 || '', overs: raw.overs1 || null },
        team2: { name: t2, logo: null, score: raw.score2 || '', overs: raw.overs2 || null },
        gender,
        source: 'Bails Custom API'
    };
}

// ── CRICBUZZ SCRAPER ─────────────────────────────────────────────────────────
async function scrapeCricbuzzMatches(url) {
    try {
        const { data } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
        });
        const $ = cheerio.load(data);
        const matches = [];

        $('a.w-full.bg-cbWhite.flex.flex-col.p-3.gap-1').each((i, el) => {
            const mUrl = $(el).attr('href');
            if (!mUrl) return;
            const headerDiv = $(el).children('div').eq(0);
            const title = headerDiv.find('span').first().text().trim();
            const stateSpan = $(el).children('span').last();
            const state = stateSpan.text().trim();
            const isLive = stateSpan.hasClass('text-cbLive') || mUrl.includes('live-cricket-scores');
            const isCompleted = stateSpan.hasClass('text-cbSuccess') || (mUrl.includes('live-cricket-scores') && (state.includes('won by') || state.includes('Stumps')));
            const teamsDiv = $(el).children('div').eq(1);
            const teamRows = teamsDiv.children('div');
            let team1 = '', score1 = '', overs1 = '', team2 = '', score2 = '', overs2 = '';
            if (teamRows.length >= 1) {
                const r1 = $(teamRows[0]);
                team1 = r1.find('span.hidden.wb\\:block').text().trim() || r1.find('span.block.wb\\:hidden').text().trim();
                const m1 = r1.children('span.font-medium').text().trim().match(/([\d\/\-]+)(?:\s*\(([\d\.]+)\))?/);
                if (m1) { score1 = m1[1]; overs1 = m1[2] || ''; }
            }
            if (teamRows.length >= 2) {
                const r2 = $(teamRows[1]);
                team2 = r2.find('span.hidden.wb\\:block').text().trim() || r2.find('span.block.wb\\:hidden').text().trim();
                const m2 = r2.children('span.font-medium').text().trim().match(/([\d\/\-]+)(?:\s*\(([\d\.]+)\))?/);
                if (m2) { score2 = m2[1]; overs2 = m2[2] || ''; }
            }
            if (!team1 || !team2) return;
            matches.push(normalizeScrapedMatch({ title, team1, team2, score1, score2, overs1, overs2, status: state, isLive, isCompleted, url: mUrl }));
        });
        return matches;
    } catch (e) {
        console.error('Scraping error:', e.message);
        return [];
    }
}

// ── ROUTES ───────────────────────────────────────────────────────────────────

// Live cricket matches
app.get('/api/currentMatches', async (req, res) => {
    let matches = cache.get('liveMatches');
    if (!matches) {
        matches = await scrapeCricbuzzMatches('https://www.cricbuzz.com/cricket-match/live-scores');
        if (matches.length > 0) cache.set('liveMatches', matches);
    }
    res.json({ status: 'success', data: matches });
});

// Match scorecard stub
app.get('/api/match_scorecard', async (req, res) => {
    res.json({ status: 'success', data: { id: req.query.id, scorecard: [] } });
});

// ── SEARCH ENDPOINTS ─────────────────────────────────────────────────────────

app.get('/api/searchPlayers', (req, res) => {
    const q      = (req.query.q || '').trim().toLowerCase();
    const limit  = Math.min(parseInt(req.query.limit) || 20, 50);
    if (!q || q.length < 2) return res.json({ status: 'success', data: [] });

    const scored = [];
    for (const p of _players) {
        const nameLow = p.name.toLowerCase();
        const hay = `${nameLow} ${(p.country || '').toLowerCase()} ${(p.role || '').toLowerCase()}`;
        if (!hay.includes(q)) continue;
        let score = 1;
        if (nameLow.startsWith(q)) score = 3;
        else if (nameLow.includes(` ${q}`) || nameLow.includes(`-${q}`)) score = 2;
        scored.push({ score, player: p });
    }
    scored.sort((a, b) => b.score - a.score || a.player.name.localeCompare(b.player.name));
    res.json({ status: 'success', data: scored.slice(0, limit).map(x => x.player), total: scored.length });
});

app.get('/api/searchTeams', (req, res) => {
    const q = (req.query.q || '').trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit) || 20, 10000); // 9999 allows fetching all
    if (!q) return res.json({ status: 'success', data: [] });

    const results = q === '.' ? _teams : _teams.filter(t => 
        t.name.toLowerCase().includes(q) || (t.country||'').toLowerCase().includes(q)
    );
    res.json({ status: 'success', data: results.slice(0, limit) });
});

app.get('/api/searchTournaments', (req, res) => {
    const q = (req.query.q || '').trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit) || 20, 10000);
    if (!q) return res.json({ status: 'success', data: [] });

    const results = q === '.' ? _tournaments : _tournaments.filter(t => 
        t.name.toLowerCase().includes(q) || (t.country||'').toLowerCase().includes(q)
    );
    res.json({ status: 'success', data: results.slice(0, limit) });
});

app.get('/api/searchMatches', async (req, res) => {
    const t1 = (req.query.team1 || '').toLowerCase();
    const t2 = (req.query.team2 || '').toLowerCase();
    
    // We scrape live, recent, and upcoming matches since full historical search isn't available
    let allMatches = cache.get('allMatches');
    if (!allMatches) {
        const [live, recent, upcoming] = await Promise.all([
            scrapeCricbuzzMatches('https://www.cricbuzz.com/cricket-match/live-scores'),
            scrapeCricbuzzMatches('https://www.cricbuzz.com/cricket-match/live-scores/recent-matches'),
            scrapeCricbuzzMatches('https://www.cricbuzz.com/cricket-match/live-scores/upcoming-matches')
        ]);
        allMatches = [...live, ...recent, ...upcoming];
        // deduplicate by id
        const seen = new Set();
        allMatches = allMatches.filter(m => {
            if (seen.has(m.id)) return false;
            seen.add(m.id);
            return true;
        });
        if (allMatches.length > 0) cache.set('allMatches', allMatches, 120); // cache for 2 mins
    }

    const results = allMatches.filter(m => {
        const mt1 = (m.team1.name || '').toLowerCase();
        const mt2 = (m.team2.name || '').toLowerCase();
        if (t1 && !mt1.includes(t1) && !mt2.includes(t1)) return false;
        if (t2 && !mt1.includes(t2) && !mt2.includes(t2)) return false;
        return true;
    });

    res.json({ status: 'success', data: results });
});


// ── CRON: REFRESH ALL DATA ────────────────────────────────────────────────
app.get('/api/refresh-data', async (req, res) => {
    const secret = req.headers['x-cron-secret'] || req.query.secret;
    if (secret !== (process.env.CRON_SECRET || 'bails-cron-2024')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log('Cron: Starting data refresh...');
    try {
        const { build: buildPlayers } = require('../scripts/build-players');
        const { build: buildTeamsTournaments } = require('../scripts/build-teams-tournaments');
        
        await buildPlayers();
        await buildTeamsTournaments();

        const token = process.env.GITHUB_TOKEN;
        if (token) {
            const ghHeaders = { Authorization: \`token \${token}\`, 'User-Agent': 'BailsApp' };
            
            const files = ['players.json', 'teams.json', 'tournaments.json'];
            for (const file of files) {
                const filePath = path.join(__dirname, '..', 'data', file);
                if (!fs.existsSync(filePath)) continue;
                
                const b64 = fs.readFileSync(filePath).toString('base64');
                const infoRes = await axios.get(
                    \`https://api.github.com/repos/mark816p/bails-cricket-api/contents/data/\${file}\`,
                    { headers: ghHeaders }
                ).catch(() => null);
                const sha = infoRes?.data?.sha;

                await axios.put(
                    \`https://api.github.com/repos/mark816p/bails-cricket-api/contents/data/\${file}\`,
                    {
                        message: \`chore: refresh \${file} (\${new Date().toISOString().slice(0,10)})\`,
                        content: b64,
                        ...(sha ? { sha } : {})
                    },
                    { headers: ghHeaders }
                );
            }
            console.log('Cron: Committed data updates to GitHub.');
        }

        loadData(); 
        res.json({ status: 'success', refreshedAt: new Date().toISOString() });
    } catch (e) {
        console.error('Cron refresh failed:', e.message);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

module.exports = app;
