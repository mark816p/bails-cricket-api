const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const app = express();

// Cache data for 60 seconds to avoid getting blocked
const cache = new NodeCache({ stdTTL: 60 });

app.use(cors());

// A utility to standardize the match shape for Bails
function normalizeScrapedMatch(raw) {
    const t1 = raw.team1 || 'Team A';
    const t2 = raw.team2 || 'Team B';
    const s1 = raw.score1 || '';
    const s2 = raw.score2 || '';
    
    // Guess gender
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
        team1: { name: t1, logo: null, score: s1, overs: raw.overs1 || null },
        team2: { name: t2, logo: null, score: s2, overs: raw.overs2 || null },
        gender: gender,
        source: 'Bails Custom API'
    };
}

// Scrape live matches
async function scrapeCricbuzzLive() {
    try {
        const { data } = await axios.get('https://www.cricbuzz.com/cricket-match/live-scores', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        const $ = cheerio.load(data);
        const matches = [];

        $('a.w-full.bg-cbWhite.flex.flex-col.p-3.gap-1').each((i, el) => {
            const url = $(el).attr('href');
            if (!url) return;
            
            // Extract title / subtitle
            const headerDiv = $(el).children('div').eq(0);
            const title = headerDiv.find('span').first().text().trim();
            
            // Extract state message (bottom span)
            const stateSpan = $(el).children('span').last();
            const state = stateSpan.text().trim();
            
            const isLive = stateSpan.hasClass('text-cbLive') || url.includes('live-cricket-scores');
            const isCompleted = stateSpan.hasClass('text-cbSuccess') || url.includes('live-cricket-scores') && (state.includes('won by') || state.includes('Stumps'));

            // Team block
            const teamsDiv = $(el).children('div').eq(1);
            const teamRows = teamsDiv.children('div');

            let team1 = '', score1 = '', overs1 = '';
            let team2 = '', score2 = '', overs2 = '';

            if (teamRows.length >= 1) {
                const row1 = $(teamRows[0]);
                team1 = row1.find('span.hidden.wb\\:block').text().trim() || row1.find('span.block.wb\\:hidden').text().trim();
                const fullScore1 = row1.children('span.font-medium').text().trim();
                const match1 = fullScore1.match(/([\d\/\-]+)(?:\s*\(([\d\.]+)\))?/);
                if (match1) {
                    score1 = match1[1];
                    overs1 = match1[2] || '';
                }
            }

            if (teamRows.length >= 2) {
                const row2 = $(teamRows[1]);
                team2 = row2.find('span.hidden.wb\\:block').text().trim() || row2.find('span.block.wb\\:hidden').text().trim();
                const fullScore2 = row2.children('span.font-medium').text().trim();
                const match2 = fullScore2.match(/([\d\/\-]+)(?:\s*\(([\d\.]+)\))?/);
                if (match2) {
                    score2 = match2[1];
                    overs2 = match2[2] || '';
                }
            }

            // Skip invalid ones (sometimes they are ad slots or empty)
            if (!team1 || !team2) return;

            matches.push(normalizeScrapedMatch({
                title, team1, team2, score1, score2, overs1, overs2, status: state, isLive, isCompleted, url
            }));
        });

        return matches;
    } catch (e) {
        console.error("Scraping error:", e.message);
        return [];
    }
}

app.get('/api/currentMatches', async (req, res) => {
    let matches = cache.get('liveMatches');
    if (!matches) {
        matches = await scrapeCricbuzzLive();
        if (matches.length > 0) {
            cache.set('liveMatches', matches);
        }
    }
    
    res.json({
        status: 'success',
        data: matches
    });
});

app.get('/api/match_scorecard', async (req, res) => {
    const matchId = req.query.id;
    res.json({
        status: 'success',
        data: {
            id: matchId,
            scorecard: [] 
        }
    });
});

module.exports = app;
