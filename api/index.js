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
        id: Buffer.from(`${t1}-${t2}-${raw.title}`).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''),
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
// Cricbuzz uses Tailwind CSS utility classes that change frequently.
// This scraper uses multiple fallback strategies to extract match data.
function _extractTeamName($, row) {
    // Try several selectors in order of specificity
    const selectors = [
        'span.hidden.wb\\:block',
        'span.wb\\:block',
        '[class*="hidden"][class*="wb"]',
        'span[class*="block"]',
        'span[class*="team"]',
        'span[class*="name"]',
    ];
    for (const sel of selectors) {
        try {
            const text = row.find(sel).first().text().trim();
            if (text && text.length > 1 && !text.match(/^[\d\/\-\.]+$/)) return text;
        } catch (_) {}
    }
    // Last resort: find any non-numeric, non-empty span text
    let found = '';
    row.find('span').each((_, s) => {
        if (found) return;
        const t = $(s).text().trim();
        if (t && t.length > 1 && !t.match(/^[\d\/\-\.\(\)\s]+$/) && !t.includes(':')) found = t;
    });
    return found;
}

function _extractScore($, row) {
    // Try to find score pattern like "123/4" or "123/4 (12.3)"
    const scoreSelectors = [
        'span.font-medium',
        'span[class*="score"]',
        'span[class*="runs"]',
        'span.font-bold',
    ];
    for (const sel of scoreSelectors) {
        try {
            const text = row.find(sel).text().trim();
            const m = text.match(/([\d]+\/[\d]+|[\d]+\-[\d]+)(?:\s*\(([\d\.]+)\))?/);
            if (m) return { score: m[1], overs: m[2] || '' };
        } catch (_) {}
    }
    // Scan all spans for score pattern
    let result = { score: '', overs: '' };
    row.find('span').each((_, s) => {
        if (result.score) return;
        const t = $(s).text().trim();
        const m = t.match(/^([\d]+\/[\d]+)(?:\s*\(([\d\.]+)\))?$/);
        if (m) { result = { score: m[1], overs: m[2] || '' }; }
    });
    return result;
}

async function scrapeCricbuzzMatches(url) {
    try {
        const { data } = await axios.get(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Cache-Control': 'no-cache'
            },
            timeout: 15000
        });
        const $ = cheerio.load(data);
        const matches = [];

        // Strategy 1: Modern Cricbuzz layout (anchor cards)
        const cardSelectors = [
            'a.w-full.bg-cbWhite.flex',
            'a[href*="live-cricket-scores"]',
            'a[href*="cricket-scores"]',
            'div.cb-mtch-lst a',
            '.cb-col.cb-col-100 a[href*="scorecard"]',
            'div[class*="match"] a',
        ];

        let foundCards = false;
        for (const cardSel of cardSelectors) {
            const cards = $(cardSel);
            if (cards.length === 0) continue;
            
            cards.each((i, el) => {
                const mUrl = $(el).attr('href');
                if (!mUrl || (!mUrl.includes('scores') && !mUrl.includes('scorecard'))) return;

                // Extract title/series
                const title = $(el).find('[class*="series"], [class*="title"], [class*="header"] span').first().text().trim() ||
                              $(el).children('div').first().find('span').first().text().trim() ||
                              $(el).attr('title') || '';

                // State/status
                const stateEl = $(el).find('[class*="live"], [class*="status"], [class*="result"]').last();
                const state = stateEl.text().trim() || $(el).children('span').last().text().trim();
                const isLive = stateEl.hasClass('text-cbLive') || mUrl.includes('live-cricket-scores') || state.toLowerCase().includes('live');
                const isCompleted = stateEl.hasClass('text-cbSuccess') ||
                    (state.includes('won by') || state.includes('Stumps') || state.includes('rain') ||
                     state.toLowerCase().includes('abandoned'));

                // Find team rows — look for the container with two team rows
                let teamRows = $(el).find('div').filter((_, d) => {
                    const kids = $(d).children('div');
                    return kids.length >= 2;
                }).first().children('div');

                if (!teamRows || teamRows.length < 2) {
                    teamRows = $(el).children('div').eq(1).children('div');
                }

                let team1 = '', score1 = '', overs1 = '', team2 = '', score2 = '', overs2 = '';

                if (teamRows && teamRows.length >= 1) {
                    const r1 = $(teamRows[0]);
                    team1 = _extractTeamName($, r1);
                    const s1 = _extractScore($, r1);
                    score1 = s1.score; overs1 = s1.overs;
                }
                if (teamRows && teamRows.length >= 2) {
                    const r2 = $(teamRows[1]);
                    team2 = _extractTeamName($, r2);
                    const s2 = _extractScore($, r2);
                    score2 = s2.score; overs2 = s2.overs;
                }

                // Validate: both team names must be non-empty strings
                if (!team1 || !team2 || team1 === team2) return;
                // Ensure they are strings (never objects)
                team1 = String(team1).trim();
                team2 = String(team2).trim();
                score1 = String(score1 || '').trim();
                score2 = String(score2 || '').trim();
                overs1 = String(overs1 || '').trim();
                overs2 = String(overs2 || '').trim();

                matches.push(normalizeScrapedMatch({ title, team1, team2, score1, score2, overs1, overs2, status: state, isLive, isCompleted, url: mUrl }));
            });
            
            if (matches.length > 0) { foundCards = true; break; }
        }

        if (!foundCards) {
            console.warn('Cricbuzz: no match cards found with any known selector at', url);
        }
        
        return matches;
    } catch (e) {
        console.error('Scraping error:', e.message);
        return [];
    }
}

// ── ROUTES ───────────────────────────────────────────────────────────────────

// Live, recent, and upcoming matches
app.get('/api/currentMatches', async (req, res) => {
    let matches = cache.get('liveMatches');
    if (!matches) {
        const [live, recent, upcoming] = await Promise.all([
            scrapeCricbuzzMatches('https://www.cricbuzz.com/cricket-match/live-scores'),
            scrapeCricbuzzMatches('https://www.cricbuzz.com/cricket-match/live-scores/recent-matches'),
            scrapeCricbuzzMatches('https://www.cricbuzz.com/cricket-match/live-scores/upcoming-matches')
        ]);
        matches = [...live, ...recent, ...upcoming];
        const seen = new Set();
        matches = matches.filter(m => {
            if (seen.has(m.id)) return false;
            seen.add(m.id);
            return true;
        });
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
            const ghHeaders = { Authorization: `token ${token}`, 'User-Agent': 'BailsApp' };
            
            const files = ['players.json', 'teams.json', 'tournaments.json'];
            for (const file of files) {
                const filePath = path.join(__dirname, '..', 'data', file);
                if (!fs.existsSync(filePath)) continue;
                
                const b64 = fs.readFileSync(filePath).toString('base64');
                const infoRes = await axios.get(
                    `https://api.github.com/repos/mark816p/bails-cricket-api/contents/data/${file}`,
                    { headers: ghHeaders }
                ).catch(() => null);
                const sha = infoRes?.data?.sha;

                await axios.put(
                    `https://api.github.com/repos/mark816p/bails-cricket-api/contents/data/${file}`,
                    {
                        message: `chore: refresh ${file} (${new Date().toISOString().slice(0,10)})`,
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
