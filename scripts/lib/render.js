// The card is a monospace grid, so rows get measured in characters and turned
// into pixels at the end. Every row's dots stretch it out to the same width,
// which is what lines all the values up on the right.

const BULLET = '. ';
const MIN_DOTS = 3;        // shortest leader allowed, even on the longest row
const EDGE_PADDING = 2;    // spare columns past the longest row
const TOWER_SEP = ' | ';   // divider between the two halves of a paired row
const RULE = '━';    // the line in the section headers

// Box-drawing chars are the shadows and frames in the ascii art — dim them so
// the letters and text pop instead.
const BOX = /[\u2500-\u257f]/;

function drawArt(line, t) {
  const shadow = t.art_shadow ?? t.rule;
  const runs = [];
  for (const ch of line) {
    const fill = BOX.test(ch) ? shadow : t.art;
    if (runs.length && runs[runs.length - 1].fill === fill) runs[runs.length - 1].text += ch;
    else runs.push({ fill, text: ch });
  }
  return runs.map((r) => `<tspan fill="${r.fill}">${esc(r.text)}</tspan>`).join('');
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function ageBreakdown(birthISO) {
  const birth = new Date(`${birthISO}T00:00:00Z`);
  const now = new Date();
  let years = now.getUTCFullYear() - birth.getUTCFullYear();
  let months = now.getUTCMonth() - birth.getUTCMonth();
  let days = now.getUTCDate() - birth.getUTCDate();
  if (days < 0) {
    months -= 1;
    days += new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return `${plural(years, 'year')}, ${plural(months, 'month')}, ${plural(days, 'day')}`;
}

// {{token}} gets swapped out; single braces stay put, so something like
// "{{repos}} {Contributed: {{contributed}}}" keeps its braces.
function expand(value, tokens) {
  return String(value).replace(/\{\{(\w+)\}\}/g, (match, key) =>
    key in tokens ? String(tokens[key]) : match
  );
}

// Flattens the config sections into a plain list of lines to draw.
function buildLines(config, tokens) {
  const lines = [{ kind: 'header', text: config.header }];

  config.sections.forEach((section, index) => {
    if (index > 0 || section.title) lines.push({ kind: 'blank' });
    if (section.title) lines.push({ kind: 'section', title: section.title });

    for (const row of section.rows) {
      if (!row || row.length === 0) {
        lines.push({ kind: 'blank' });
      } else if (row.length >= 4) {
        lines.push({
          kind: 'dual',
          label: row[0], value: expand(row[1], tokens),
          label2: row[2], value2: expand(row[3], tokens),
        });
      } else if (String(row[1]).trim() === '{{loc}}') {
        lines.push({ kind: 'rich', label: row[0], ...tokens.locRich });
      } else {
        lines.push({ kind: 'field', label: row[0], value: expand(row[1], tokens) });
      }
    }
  });

  return lines;
}

const fieldMin = (label, value) =>
  BULLET.length + label.length + 2 + MIN_DOTS + 1 + value.length;

function measure(lines, header) {
  // paired rows share a left width so the "|" towers stay stacked
  const duals = lines.filter((l) => l.kind === 'dual');
  const leftColWidth = duals.length
    ? Math.max(...duals.map((l) => fieldMin(l.label, String(l.value))))
    : 0;

  const widths = [header.length + 6];
  for (const line of lines) {
    if (line.kind === 'field') widths.push(fieldMin(line.label, line.value));
    else if (line.kind === 'rich') widths.push(fieldMin(line.label, ' '.repeat(line.plainLen)));
    else if (line.kind === 'section') widths.push(line.title.length + 6);
    else if (line.kind === 'dual') {
      widths.push(
        leftColWidth + TOWER_SEP.length +
        line.label2.length + 2 + MIN_DOTS + 1 + String(line.value2).length
      );
    }
  }

  return { targetWidth: Math.max(...widths) + EDGE_PADDING, leftColWidth };
}

function leader(width, used, c) {
  return c.repeat(Math.max(MIN_DOTS, width - used));
}

function drawField(line, width, t) {
  const used = BULLET.length + line.label.length + 2 + 1 + line.value.length;
  return (
    `<tspan fill="${t.label}">${esc(BULLET + line.label)}: </tspan>` +
    `<tspan fill="${t.leader}">${leader(width, used, '.')}</tspan>` +
    `<tspan fill="${t.value}"> ${esc(line.value)}</tspan>`
  );
}

// Same as drawField, but the value is already-coloured markup (the ++/-- row),
// so the width has to come from plainLen.
function drawRich(line, width, t) {
  const used = BULLET.length + line.label.length + 2 + 1 + line.plainLen;
  return (
    `<tspan fill="${t.label}">${esc(BULLET + line.label)}: </tspan>` +
    `<tspan fill="${t.leader}">${leader(width, used, '.')}</tspan>` +
    line.markup
  );
}

function drawDual(line, width, leftColWidth, t) {
  const leftUsed = BULLET.length + line.label.length + 2 + 1 + String(line.value).length;
  const rightUsed =
    leftColWidth + TOWER_SEP.length + line.label2.length + 2 + 1 + String(line.value2).length;
  return (
    `<tspan fill="${t.label}">${esc(BULLET + line.label)}: </tspan>` +
    `<tspan fill="${t.leader}">${leader(leftColWidth, leftUsed, '.')}</tspan>` +
    `<tspan fill="${t.value}"> ${esc(line.value)}</tspan>` +
    `<tspan fill="${t.leader}">${esc(TOWER_SEP)}</tspan>` +
    `<tspan fill="${t.label}">${esc(line.label2)}: </tspan>` +
    `<tspan fill="${t.leader}">${leader(width, rightUsed, '.')}</tspan>` +
    `<tspan fill="${t.value}"> ${esc(line.value2)}</tspan>`
  );
}

// "Contact ━━━━━━" — title, then rule out to the full width.
function drawRule(text, width, t) {
  return (
    `<tspan fill="${t.accent}" font-weight="bold">${esc(text)}</tspan>` +
    `<tspan fill="${t.rule}" font-weight="bold">${RULE.repeat(Math.max(4, width - text.length))}</tspan>`
  );
}

function buildSVG(config, tokens) {
  const t = config.theme;
  const fontSize = t.font_size ?? 12;
  const lineHeight = t.line_height ?? 15;
  const charW = fontSize * 0.6;
  const font = 'ui-monospace, SFMono-Regular, Menlo, DejaVu Sans Mono, monospace';

  const lines = buildLines(config, tokens);
  const { targetWidth, leftColWidth } = measure(lines, config.header);

  const artLines = tokens.art ? tokens.art.split('\n') : [];
  const artWidth = artLines.length ? Math.max(...artLines.map((l) => l.length)) : 0;

  const padX = 24;
  const topPad = 30;
  const rightColX = artLines.length ? padX + artWidth * charW + 40 : padX;
  const width = Math.ceil(rightColX + targetWidth * charW + padX);
  const height = Math.ceil(
    Math.max(artLines.length, lines.length) * lineHeight + topPad + 20
  );

  const text = (x, y, body) =>
    `  <text x="${x}" y="${y}" font-family="${font}" font-size="${fontSize}" xml:space="preserve">${body}</text>`;

  const art = artLines.map((l, i) => text(padX, topPad + i * lineHeight, drawArt(l, t)));

  const body = lines.flatMap((line, i) => {
    const y = topPad + i * lineHeight;
    if (line.kind === 'blank') return [];
    if (line.kind === 'header') return text(rightColX, y, drawRule(`${line.text} `, targetWidth, t));
    if (line.kind === 'section') return text(rightColX, y, drawRule(`- ${line.title} `, targetWidth, t));
    if (line.kind === 'dual') return text(rightColX, y, drawDual(line, targetWidth, leftColWidth, t));
    if (line.kind === 'rich') return text(rightColX, y, drawRich(line, targetWidth, t));
    return text(rightColX, y, drawField(line, targetWidth, t));
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(config.header)} profile card">`,
    `  <rect width="100%" height="100%" rx="10" fill="${t.background}" stroke="${t.border}" stroke-width="1"/>`,
    ...art,
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

module.exports = { buildSVG, ageBreakdown, esc };
