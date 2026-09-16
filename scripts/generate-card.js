#!/usr/bin/env node
// Turns config.json into the card SVG.
//   node scripts/generate-card.js            # real stats, needs GH_TOKEN
//   node scripts/generate-card.js --offline  # fake stats, no network
const fs = require('fs');
const path = require('path');

const {
  fetchRepos,
  fetchCommitCount,
  fetchCommitCountByEmails,
  countLinesOfCode,
} = require('./lib/github');
const { buildSVG, ageBreakdown, esc } = require('./lib/render');

const ROOT = path.resolve(__dirname, '..');
const OFFLINE = process.argv.includes('--offline');

// Node won't read .env by itself and this only needs one key, so no dotenv.
// Anything already in the environment wins.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const value = match[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}

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
  loadEnv(path.join(ROOT, '.env'));

  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
  const {
    username,
    count_forks: countForks = false,
    include_private: includePrivate = false,
    exclude_repos: excludeRepos = [],
    exclude_paths: excludePaths = [],
    commit_emails: commitEmails = [],
    commit_offset: commitOffset = 0,
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
    if (!token) {
      throw new Error('GH_TOKEN is not set — put it in .env or export it (PAT with repo + read:user)');
    }

    console.log(`fetching ${includePrivate ? 'public + private' : 'public'} repos for ${username}...`);
    const overview = await fetchRepos(token, username, { countForks, excludeRepos, includePrivate });

    let commitCount;
    if (commitEmails.length) {
      console.log(`counting commits by ${commitEmails.length} author email(s)...`);
      commitCount = await fetchCommitCountByEmails(token, username, overview.repos, commitEmails);
    } else {
      console.log('counting commits...');
      const { commits, restricted } = await fetchCommitCount(token, username, overview.createdAt);

      // If the token could see private repos, private commits are already in
      // `commits`. If it couldn't, `restricted` is the only signal there is —
      // it's a blend of commits/PRs/repos, but beats reporting public-only.
      const sawPrivate = overview.privateCount > 0;
      commitCount = sawPrivate ? commits : commits + restricted;
      if (!sawPrivate && restricted) {
        console.log(`  no private repos visible, adding ${restricted} restricted contributions`);
      }
    }

    // Older commits authored from an address that isn't on the account, so
    // nothing in the API can see them. Counted once, added back here.
    if (commitOffset) {
      console.log(`  + ${commitOffset} unattributed commits`);
      commitCount += commitOffset;
    }

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
