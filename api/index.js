const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const fs      = require('fs');
const path    = require('path');

const app = express();

// Cache live match data for 60 seconds
const cache = new NodeCache({ stdTTL: 60 });

app.use(cors());

// ── PLAYER DATA ─────────────────────────────────────────────────────────────
// Loaded from data/players.json at startup; rebuilt weekly by the cron job.
let _players = [];
let _playersLoadedAt = 0;

function loadPlayers() {
    try {
        const filePath = path.join(__dirname, '..', 'data', 'players.json');
        if (fs.existsSync(filePath)) {
            _players = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            _playersLoadedAt = Date.now();
            console.log(`Loaded ${_players.length} players from players.json`);
        }
    } catch (e) {
        console.warn('Could not load players.json:', e.message);
        _players = [];
    }
}

loadPlayers();

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
async function scrapeCricbuzzLive() {
    try {
        const { data } = await axios.get('https://www.cricbuzz.com/cricket-match/live-scores', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
        });
        const $ = cheerio.load(data);
        const matches = [];

        $('a.w-full.bg-cbWhite.flex.flex-col.p-3.gap-1').each((i, el) => {
            const url = $(el).attr('href');
            if (!url) return;
            const headerDiv = $(el).children('div').eq(0);
            const title = headerDiv.find('span').first().text().trim();
            const stateSpan = $(el).children('span').last();
            const state = stateSpan.text().trim();
            const isLive = stateSpan.hasClass('text-cbLive') || url.includes('live-cricket-scores');
            const isCompleted = stateSpan.hasClass('text-cbSuccess') || (url.includes('live-cricket-scores') && (state.includes('won by') || state.includes('Stumps')));
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
            matches.push(normalizeScrapedMatch({ title, team1, team2, score1, score2, overs1, overs2, status: state, isLive, isCompleted, url }));
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
        matches = await scrapeCricbuzzLive();
        if (matches.length > 0) cache.set('liveMatches', matches);
    }
    res.json({ status: 'success', data: matches });
});

// Match scorecard stub
app.get('/api/match_scorecard', async (req, res) => {
    res.json({ status: 'success', data: { id: req.query.id, scorecard: [] } });
});

// ── PLAYER SEARCH ────────────────────────────────────────────────────────────
// Fuzzy search across 32k+ players. No external calls — instant.
app.get('/api/searchPlayers', (req, res) => {
    const q      = (req.query.q || '').trim().toLowerCase();
    const gender = (req.query.gender || 'all').toLowerCase();
    const limit  = Math.min(parseInt(req.query.limit) || 20, 50);

    if (!q || q.length < 2) {
        return res.json({ status: 'success', data: [] });
    }

    // Three-tier relevance scoring
    const scored = [];
    for (const p of _players) {
        if (gender !== 'all' && p.gender && p.gender !== gender) continue;
        const nameLow = p.name.toLowerCase();
        const hay = `${nameLow} ${(p.country || '').toLowerCase()} ${(p.role || '').toLowerCase()}`;
        if (!hay.includes(q)) continue;
        let score = 1;
        if (nameLow.startsWith(q)) score = 3;
        else if (nameLow.includes(` ${q}`) || nameLow.includes(`-${q}`)) score = 2;
        scored.push({ score, player: p });
    }

    scored.sort((a, b) => b.score - a.score || a.player.name.localeCompare(b.player.name));
    const results = scored.slice(0, limit).map(x => x.player);

    res.json({ status: 'success', data: results, total: scored.length, loadedAt: _playersLoadedAt });
});

// ── CRON: REFRESH PLAYER DATA ────────────────────────────────────────────────
// Called by Vercel cron every Sunday at midnight UTC.
// Rebuilds players.json from Wikidata + Cricsheet and commits to GitHub,
// which triggers a Vercel auto-redeploy with fresh player data.
app.get('/api/refresh-players', async (req, res) => {
    const secret = req.headers['x-cron-secret'] || req.query.secret;
    if (secret !== (process.env.CRON_SECRET || 'bails-cron-2024')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log('Cron: Starting player data refresh...');
    try {
        const { build } = require('../scripts/build-players');
        const count = await build();

        // Commit the updated players.json to GitHub so Vercel redeploys
        const token = process.env.GITHUB_TOKEN;
        if (token) {
            const filePath = path.join(__dirname, '..', 'data', 'players.json');
            const b64 = fs.readFileSync(filePath).toString('base64');
            const ghHeaders = { Authorization: `token ${token}`, 'User-Agent': 'BailsApp' };

            const infoRes = await axios.get(
                'https://api.github.com/repos/mark816p/bails-cricket-api/contents/data/players.json',
                { headers: ghHeaders }
            ).catch(() => null);
            const sha = infoRes?.data?.sha;

            await axios.put(
                'https://api.github.com/repos/mark816p/bails-cricket-api/contents/data/players.json',
                {
                    message: `chore: refresh player data (${new Date().toISOString().slice(0,10)})`,
                    content: b64,
                    ...(sha ? { sha } : {})
                },
                { headers: ghHeaders }
            );
            console.log('Cron: Committed players.json to GitHub.');
        }

        loadPlayers(); // hot-reload in current instance
        res.json({ status: 'success', players: count, refreshedAt: new Date().toISOString() });
    } catch (e) {
        console.error('Cron refresh failed:', e.message);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

module.exports = app;
