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

        $('.cb-mtch-lst.cb-col.cb-col-100.cb-tms-itm').each((i, el) => {
            const titleElement = $(el).find('h3.cb-lv-scr-mtch-hdr a');
            if (!titleElement.length) return;
            
            const title = titleElement.text().trim();
            const url = titleElement.attr('href');
            
            const state = $(el).find('.cb-text-live, .cb-text-complete, .cb-text-preview').text().trim();
            const isLive = $(el).find('.cb-text-live').length > 0;
            const isCompleted = $(el).find('.cb-text-complete').length > 0;
            
            // Score parsing
            const teamsDiv = $(el).find('.cb-scr-wll-chvrn.cb-lv-scrs-col');
            const teamRows = teamsDiv.find('.cb-hmscg-bat-txt, .cb-hmscg-bwl-txt');
            
            let team1 = '', score1 = '', overs1 = '';
            let team2 = '', score2 = '', overs2 = '';

            if (teamRows.length >= 1) {
                const row1 = $(teamRows[0]);
                team1 = row1.find('.cb-hmscg-tm-nm').text().trim();
                const fullScore1 = row1.find('div:nth-child(2)').text().trim();
                const match1 = fullScore1.match(/([\d\/]+)(?:\s+\(([\d\.]+)\s*Ovs\))?/);
                if (match1) {
                    score1 = match1[1];
                    overs1 = match1[2] || '';
                }
            }

            if (teamRows.length >= 2) {
                const row2 = $(teamRows[1]);
                team2 = row2.find('.cb-hmscg-tm-nm').text().trim();
                const fullScore2 = row2.find('div:nth-child(2)').text().trim();
                const match2 = fullScore2.match(/([\d\/]+)(?:\s+\(([\d\.]+)\s*Ovs\))?/);
                if (match2) {
                    score2 = match2[1];
                    overs2 = match2[2] || '';
                }
            }

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
