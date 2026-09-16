const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const API = 'https://api.github.com/graphql';

async function graphql(token, query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// All your repos, paginated. The HEAD sha is what the line counter caches against.
async function fetchRepos(token, login, { countForks, excludeRepos, includePrivate }) {
  // null privacy means no filter, so private repos come through too
  const query = `
    query($login: String!, $cursor: String, $privacy: RepositoryPrivacy) {
      user(login: $login) {
        createdAt
        followers { totalCount }
        repositoriesContributedTo(
          first: 1
          contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]
        ) { totalCount }
        repositories(
          first: 100
          after: $cursor
          ownerAffiliations: OWNER
          privacy: $privacy
          orderBy: { field: PUSHED_AT, direction: DESC }
        ) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            name
            isFork
            isPrivate
            stargazerCount
            defaultBranchRef { target { ... on Commit { oid } } }
          }
        }
      }
    }
  `;

  const excluded = new Set(excludeRepos.map((r) => r.replace(/^.*\//, '').toLowerCase()));
  let cursor = null;
  let user = null;
  const repos = [];

  for (;;) {
    const data = await graphql(token, query, {
      login,
      cursor,
      privacy: includePrivate ? null : 'PUBLIC',
    });
    user = data.user;
    for (const node of user.repositories.nodes) {
      if (!countForks && node.isFork) continue;
      if (excluded.has(node.name.toLowerCase())) continue;
      repos.push({
        name: node.name,
        isPrivate: node.isPrivate,
        stars: node.stargazerCount,
        head: node.defaultBranchRef?.target?.oid ?? null,
      });
    }
    if (!user.repositories.pageInfo.hasNextPage) break;
    cursor = user.repositories.pageInfo.endCursor;
  }

  return {
    repos,
    repoCount: repos.length,
    contributedCount: user.repositoriesContributedTo.totalCount,
    followerCount: user.followers.totalCount,
    createdAt: user.createdAt,
    starCount: repos.reduce((sum, r) => sum + r.stars, 0),
    privateCount: repos.filter((r) => r.isPrivate).length,
  };
}

// GitHub only hands out commit totals a year at a time, so walk them all.
// restrictedContributionsCount is the private stuff.
async function fetchCommitCount(token, login, createdAt) {
  const startYear = new Date(createdAt).getUTCFullYear();
  const currentYear = new Date().getUTCFullYear();
  const query = `
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          restrictedContributionsCount
        }
      }
    }
  `;

  let total = 0;
  for (let year = startYear; year <= currentYear; year++) {
    const data = await graphql(token, query, {
      login,
      from: `${year}-01-01T00:00:00Z`,
      to: `${year}-12-31T23:59:59Z`,
    });
    const c = data.user.contributionsCollection;
    total += c.totalCommitContributions + c.restrictedContributionsCount;
  }
  return total;
}

// This cache gets committed to a public repo, so hash the names — no reason to
// advertise which private repos exist.
const cacheKey = (name) => crypto.createHash('sha256').update(name).digest('hex').slice(0, 16);

// Counts only mean anything for the exclude list that produced them, so keep a
// fingerprint of it and recount if it changes.
const specKey = (paths) => crypto.createHash('sha256').update(paths.join('\0')).digest('hex').slice(0, 16);

// Same deal for the Actions log, which is public.
const logName = (repo) => (repo.isPrivate ? '<private repo>' : repo.name);

function readCache(cachePath) {
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch {
    return {};
  }
}

// Lines added/removed across every repo's full history. Cloning all of them
// daily would get slow fast, so anything you haven't pushed to since last run
// comes from the cache. --bare since git log doesn't need a working tree.
function countLinesOfCode(repos, { token, login, cachePath, excludePaths = [] }) {
  const stored = readCache(cachePath);
  const spec = specKey(excludePaths);
  const cache = stored.spec === spec ? stored.repos ?? {} : {};
  if (stored.spec && stored.spec !== spec) {
    console.log('  exclude_paths changed, recounting every repo');
  }
  const next = {};
  let additions = 0;
  let deletions = 0;
  let cloned = 0;

  for (const repo of repos) {
    const key = cacheKey(repo.name);
    const cached = cache[key];
    if (repo.head && cached && cached.head === repo.head) {
      next[key] = cached;
      additions += cached.additions;
      deletions += cached.deletions;
      continue;
    }
    if (!repo.head) continue; // empty repo, nothing to count

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loc-${repo.name}-`));
    try {
      execFileSync('git', [
        'clone', '--bare', '--quiet',
        `https://x-access-token:${token}@github.com/${login}/${repo.name}.git`,
        dir,
      ], { stdio: 'ignore' });

      // the pathspecs drop node_modules and friends before they're ever counted
      const log = execFileSync(
        'git',
        ['-C', dir, 'log', '--pretty=tformat:', '--numstat', '--', '.', ...excludePaths],
        { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 }
      );

      let add = 0;
      let del = 0;
      for (const line of log.split('\n')) {
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        if (parts[0] === '-' || parts[1] === '-') continue; // binary file
        add += parseInt(parts[0], 10) || 0;
        del += parseInt(parts[1], 10) || 0;
      }

      next[key] = { head: repo.head, additions: add, deletions: del };
      additions += add;
      deletions += del;
      cloned++;
    } catch (err) {
      console.error(`  ! skipping ${logName(repo)}: ${err.message.split('\n')[0]}`);
      if (cached) {
        next[key] = cached; // stale beats losing the repo entirely
        additions += cached.additions;
        deletions += cached.deletions;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ spec, repos: next }, null, 2) + '\n');
  console.log(`  cloned ${cloned}, cached ${repos.length - cloned}`);

  return { additions, deletions };
}

module.exports = { fetchRepos, fetchCommitCount, countLinesOfCode };
