#!/usr/bin/env node
// Turns config.json into the card SVG.
//   node scripts/generate-card.js            # real stats, needs GH_TOKEN
//   node scripts/generate-card.js --offline  # fake stats, no network
const fs = require('fs');
const path = require('path');

const { fetchRepos, fetchCommitCount, countLinesOfCode } = require('./lib/github');
const { buildSVG, ageBreakdown, esc } = require('./lib/render');

const ROOT = path.resolve(__dirname, '..');
const OFFLINE = process.argv.includes('--offline');

const num = (n) => n.toLocaleString('en-US');

function locTokens(theme, additions, deletions) {
  const net = num(additions - deletions);
  const add = num(additions);
  const del = num(deletions);
  return {
    plainLen: `${net} ( ${add}++, ${del}-- )`.length,
    markup:
      `<tspan fill="${theme.value}"> ${net} (</tspan>` +
      `<tspan fill="${theme.addition}"> ${add}++,</tspan>` +
      `<tspan fill="${theme.deletion}"> ${del}--</tspan>` +
      `<tspan fill="${theme.value}"> )</tspan>`,
  };
}

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
  const {
    username,
    count_forks: countForks = false,
    include_private: includePrivate = false,
    exclude_repos: excludeRepos = [],
    exclude_paths: excludePaths = [],
  } = config.github;

  // git wants pathspecs, not bare globs
  const pathspecs = excludePaths.map((glob) => `:(exclude,glob)${glob}`);

  const artPath = path.join(ROOT, config.ascii_art);
  const art = fs.existsSync(artPath)
    ? fs.readFileSync(artPath, 'utf-8').replace(/\n+$/, '')
    : '';
  if (!art) console.warn(`! no ascii art at ${config.ascii_art}, rendering without it`);

  let stats;
  if (OFFLINE) {
    console.log('offline mode: using placeholder stats');
    stats = {
      repoCount: 12, contributedCount: 3, starCount: 7, followerCount: 21, privateCount: 4,
      commitCount: 486, loc: { additions: 128_400, deletions: 41_250 },
    };
  } else {
    const token = process.env.GH_TOKEN;
    if (!token) throw new Error('GH_TOKEN is not set (needs a PAT with repo + read:user)');

    console.log(`fetching ${includePrivate ? 'public + private' : 'public'} repos for ${username}...`);
    const overview = await fetchRepos(token, username, { countForks, excludeRepos, includePrivate });

    console.log('counting commits...');
    const commitCount = await fetchCommitCount(token, username, overview.createdAt);

    console.log(`counting lines across ${overview.repos.length} repos...`);
    const loc = countLinesOfCode(overview.repos, {
      token,
      login: username,
      cachePath: path.join(ROOT, 'generated', 'loc-cache.json'),
      excludePaths: pathspecs,
    });

    stats = { ...overview, commitCount, loc };
  }

  const tokens = {
    art,
    uptime: ageBreakdown(config.birthday),
    username,
    repos: num(stats.repoCount),
    private: num(stats.privateCount),
    contributed: num(stats.contributedCount),
    stars: num(stats.starCount),
    followers: num(stats.followerCount),
    commits: num(stats.commitCount),
    year: new Date().getUTCFullYear(),
    locRich: locTokens(config.theme, stats.loc.additions, stats.loc.deletions),
  };

  const outPath = path.join(ROOT, config.output);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buildSVG(config, tokens));
  console.log(`wrote ${config.output}`);
}

main().catch((err) => {
  console.error(`\nfailed: ${err.message}`);
  process.exit(1);
});
