// Rendering tests (docs/assets/view.js): escaping, link safety, brief-mandated copy and
// day-one empty states. view.js is DOM-free, so these run in plain Node.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../../docs/assets/model.js';
import * as V from '../../docs/assets/view.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const NOW = new Date('2026-10-02T15:00:00-04:00');
const BASE = 'https://emergingtechrisk.com/Readiness-Signal/';
const data = M.prepare(fixture('archive.json'), fixture('runs.json'));
const empty = M.prepare({ items: [] }, { runs: [] });
const ui = (patch = {}) => ({ ...M.defaultUi(NOW), ...patch });
// app.js collapses inter-tag whitespace before parsing; do the same here.
const render = (u, d = data, extra = {}) => V.renderApp({ ui: ui(u), data: d, now: NOW, error: null, loading: false, ...extra }).replace(/>\s+</g, '><');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const EVIL = '<img src=x onerror="alert(1)">';
function hostile() {
  return M.prepare({
    items: [{
      id: 'RS-261002-1400-09',
      timestamp: '2026-10-02T14:00:00-04:00',
      section: 'executive_visibility',
      claim: `Claim ${EVIL} & "quotes" 'single'`,
      domains: ['cyber', '__proto__', 'constructor'],
      source_class: 'news',
      mechanism: 'candidate_issue',
      interpretation: [{ domain: 'cyber', text: `<script>alert(2)</script>` }],
      validation_question: `Q ${EVIL}?`,
      candidate_issue_statement: `Where ${EVIL}, harm follows.`,
      awareness_rationale: null,
      sources: [
        { publication: `Pub ${EVIL}`, url: 'javascript:alert(3)', headline: `Head ${EVIL}` },
        { publication: 'Ok', url: 'https://example.com/"onmouseover="alert(4)', headline: 'Fine' },
        { publication: 'Data', url: 'data:text/html,<script>alert(5)</script>', headline: 'Data URL' },
      ],
      backfilled: false,
      update_of: '"><img src=x>',
    }],
  }, { runs: [] });
}

describe('escaping and link safety', () => {
  test('esc covers the five HTML-significant characters', () => {
    assert.equal(V.esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    assert.equal(V.esc(null), '');
  });

  test('hostile data renders inert in every page and in the expanded item', () => {
    const d = hostile();
    const id = 'RS-261002-1400-09';
    for (const page of ['dashboard', 'report', 'archive']) {
      const html = render({ page, open: { [id]: true } }, d);
      assert.ok(!html.includes('<img'), `${page}: raw <img>`);
      assert.ok(!html.includes('<script'), `${page}: raw <script>`);
      assert.ok(!/href="(javascript|data):/i.test(html), `${page}: unsafe href`);
      assert.ok(!html.includes('onmouseover="'), `${page}: attribute break-out`);
    }
    const html = render({ page: 'report', open: { [id]: true } }, d);
    assert.ok(html.includes('Claim &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quotes&quot; &#39;single&#39;'));
    assert.ok(html.includes('<span class="src-link nolink">Head &lt;img'), 'javascript: source has no link');
    assert.ok(html.includes('href="https://example.com/%22onmouseover=%22alert(4)"'), 'https link is normalised');
    assert.ok(html.includes('<span class="src-link nolink">Data URL</span>'));
    assert.ok(!html.includes('class="upd"'), 'unsafe update_of dropped');
    // unknown domains are dropped, not echoed
    assert.ok(!html.includes('__proto__') && !html.includes('>constructor<'));
  });

  test('email link is a real mailto anchor with an escaped, encoded body', () => {
    const id = 'RS-261002-1400-01';
    const html = render({ page: 'report', open: { [id]: true } });
    const m = /<a class="email-btn" href="(mailto:[^"]+)">Email this item<\/a>/.exec(html);
    assert.ok(m);
    const href = m[1].replace(/&amp;/g, '&');
    assert.equal(href, M.mailtoHref(data.byId.get(id)));
    const body = decodeURIComponent(href.split('&body=')[1]);
    assert.ok(body.endsWith(`Full item, validation question, candidate issue statement and sources:\r\n${BASE}#${id}`));
    // Outside the row that toggles the item, and no click handler of its own: following the
    // link never expands or collapses the item.
    const art = html.slice(html.indexOf(`<article id="${id}"`));
    const row = art.slice(0, art.indexOf('</div><div class="body">'));
    assert.ok(!row.includes('email-btn'));
    assert.ok(!/<a class="email-btn"[^>]*data-act/.test(html));
  });
});

describe('brief overrides of the design', () => {
  const html = render({ page: 'report', repTime: 'month', open: Object.fromEntries(data.items.map((i) => [i.id, true])) });

  test('owner line and "If asked" are gone; footer reads "Paste-ready"', () => {
    assert.ok(!/If asked/i.test(html));
    assert.ok(!html.includes('Paste-ready ·'));
    assert.ok(html.includes('<span class="panel-f">Paste-ready</span>'));
  });

  test('awareness-only items render the rationale as a resolution panel', () => {
    const it = data.byId.get('RS-261002-1400-03');
    const one = render({ page: 'report', open: { [it.id]: true } });
    const art = one.slice(one.indexOf(`<article id="${it.id}"`));
    const body = art.slice(0, art.indexOf('</article>'));
    // Design's own resolution panel: full weight, its own 8px gap and 15.5px rationale.
    assert.ok(body.includes(`<div class="panel aware"><span class="panel-k">Why this resolves as awareness only</span><p class="panel-why">${V.esc(it.awareness_rationale)}</p></div>`));
    assert.ok(!body.includes('If asked'));
    assert.ok(!body.includes('Validation question'));
    assert.ok(!body.includes('Conditional candidate issue'));
  });

  test('update_of link to the earlier item', () => {
    const one = render({ page: 'report', open: { 'RS-261002-1400-02': true } });
    assert.ok(one.includes(`<p class="upd">Update to: <a class="upd-link" href="#RS-260921-1000-01">${V.esc(data.byId.get('RS-260921-1000-01').claim)}</a></p>`));
  });

  test('update_of to an item not in the archive renders the id as plain text', () => {
    const d = M.prepare({ items: [{ ...fixture('archive.json').items.find((i) => i.id === 'RS-261002-1400-02') }] }, { runs: [] });
    const one = render({ page: 'report', open: { 'RS-261002-1400-02': true } }, d);
    assert.ok(one.includes('<p class="upd">Update to: <span class="upd-id">RS-260921-1000-01</span></p>'));
    assert.ok(!one.includes('class="upd-link'));
  });

  test('copy buttons carry distinct accessible names; dashboard rows read sensibly', () => {
    const one = render({ page: 'report', open: { 'RS-261002-1400-01': true } });
    assert.ok(one.includes('>Copy<span class="sr-only"> validation question</span></button>'));
    assert.ok(one.includes('>Copy<span class="sr-only"> issue language</span></button>'));
    assert.ok(one.includes('>Copy link<span class="sr-only"> to this item</span></button>'));
    assert.ok(one.includes('<section class="fbar" data-k="fbar" aria-label="Filters">'));
    assert.ok(one.includes('<main id="main" tabindex="-1" class="main list"'));
    assert.ok(one.includes('<a class="skip" href="#main" data-act="skip" data-k="skip">Skip to content</a>'));
    const dash = render({ page: 'dashboard' });
    assert.ok(dash.includes('<h2 class="sr-only" id="brief-h">At a glance</h2>'));
    assert.ok(dash.includes('<span class="badge badge-22 badge-solid" aria-hidden="true">1</span><span class="secs-t">Executive Visibility</span>'), 'section badge digit is hidden from the name');
  });

  test('backfilled label and note', () => {
    const one = render({ page: 'archive', open: { 'RS-260115-1000-01': true } });
    assert.ok(one.includes('<span class="meta-bf">Backfilled</span>'));
    assert.ok(one.includes('Added by the historical backfill pass, not by a live edition.'));
    const live = render({ page: 'archive', open: { 'RS-261002-1400-01': true } });
    const art = live.slice(live.indexOf('<article id="RS-261002-1400-01"'));
    assert.ok(!art.slice(0, art.indexOf('</article>')).includes('Backfilled'));
  });

  test('section entry tests and mechanism asks', () => {
    const t = text(html);
    for (const S of M.SECTIONS) assert.ok(t.includes(V.esc(S.test)), S.key);
    assert.ok(t.includes('Confirm the risk assessment framework represents this risk at all. If it does not, the issue language applies.'));
  });

  test('footer replaces the design-review disclaimer', () => {
    assert.ok(html.includes('Public sources only: headlines and leads are referenced, never republished. Nothing here describes any institution’s control position; validation questions and issue language are generic starting points.'));
    assert.ok(!/Illustrative content/i.test(html));
  });

  test('About copy follows the institution-neutral rewrite', () => {
    const t = text(render({ page: 'about' }, null));
    assert.ok(t.includes('Readiness Signal is a triage digest for technology risk professionals. It reads widely so you don’t have to, and publishes only what changes what you should check, measure, cover, or be ready to answer.'));
    assert.ok(!t.includes('Why it exists') && !t.includes('An earlier version failed'), 'section removed (owner change 2026-10-05)');
    assert.ok(t.includes('Most candidates fail this test, so the section is often empty.'));
    assert.ok(t.includes('Confirm the risk assessment framework represents this risk at all.'));
    assert.ok(t.includes('a validation question you can paste to a program owner'));
    assert.ok(t.includes('It is not a threat feed or a news service, and it says nothing about any institution’s control position. The validation question is where that record starts, inside your own organisation.'));
    assert.ok(!t.includes('personal triage digest'), 'design lead replaced');
    assert.ok(!t.includes('the bank’s control position'), 'design "what it is not" replaced');
    const unquoted = t.replace('‘what are we doing about this?’', '');
    assert.ok(!/\b(we|our|ours|my|me)\b/i.test(unquoted) && !/\b(I|us|Us)\b/.test(unquoted), 'no first person outside the quoted test');
    assert.ok(!/06:30|11:00|15:30|20:00/.test(t), 'old slot times gone');
    // Colour is categorical: the page says so next to the red/amber/green promise.
    assert.ok(t.includes('It is not a risk rating. Nothing here is red, amber or green; the green mark is emphasis only and never means safe. Colours mark what an item asks of you, never how serious it is.'));
  });
});

describe('colour hooks and palette', () => {
  const css = readFileSync(new URL('../../docs/assets/app.css', import.meta.url), 'utf8');
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = (h) => {
    const [r, g, b] = hex(h).map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const hue = (h) => {
    const [r, g, b] = hex(h).map((c) => c / 255);
    const max = Math.max(r, g, b); const d = max - Math.min(r, g, b);
    if (!d) return null;
    const x = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (x * 60 + 360) % 360;
  };
  const tokens = (key) => {
    const m = new RegExp(`\\[data-mech="${key}"\\]\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(m, `no hue block for ${key}`);
    return Object.fromEntries([...m[1].matchAll(/--m-(\w+):\s*(#[0-9A-Fa-f]{6})/g)].map((x) => [x[1], x[2]]));
  };

  test('every mechanism has a full hue set whose text passes AA on white, its tint and its wash', () => {
    for (const { key } of M.MECHANISMS) {
      const t = tokens(key);
      for (const k of ['text', 'fill', 'tint', 'edge', 'line', 'wash']) assert.ok(t[k], `${key} --m-${k}`);
      for (const bg of ['#FFFFFF', t.tint, t.wash]) assert.ok(contrast(t.text, bg) >= 4.5, `${key} text on ${bg}`);
    }
  });

  test('no mechanism hue is red, amber or green', () => {
    for (const { key } of M.MECHANISMS) {
      const h = hue(tokens(key).fill);
      assert.ok(h !== null && !(h >= 330 || h < 20) && !(h >= 20 && h < 65) && !(h >= 65 && h < 170), `${key} fill hue ${h}`);
    }
  });

  test('the four mechanism fills stay distinct, including under red-green colour-vision deficiency', () => {
    // OKLab distance (x100) between fills, for typical vision and Machado (2009) deuteranopia and
    // protanopia simulations. PRAF violet and awareness indigo once sat at 7.5 / 2.6 / 1.3; the
    // candidate issue moved from fuchsia to a deep teal (2026-10-03), held about 13 apart from the KRI cyan by lightness as well as hue. The tag labels carry
    // the meaning regardless (WCAG 1.4.1); this guards against hues drifting back together.
    const lin = (h) => hex(h).map((c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    const lab = ([r, g, b]) => {
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
    };
    const sims = {
      typical: null,
      deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
      protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    };
    const see = (h, mx) => { const c = lin(h); return mx ? mx.map((row) => Math.min(1, Math.max(0, row[0] * c[0] + row[1] * c[1] + row[2] * c[2]))) : c; };
    const dist = (a, b, mx) => { const p = lab(see(a, mx)); const q = lab(see(b, mx)); return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
    const fills = M.MECHANISMS.map(({ key }) => [key, tokens(key).fill]);
    for (const [name, mx] of Object.entries(sims)) {
      const floor = mx ? 4 : 10;
      for (let i = 0; i < fills.length; i++) {
        for (let j = i + 1; j < fills.length; j++) {
          const d = dist(fills[i][1], fills[j][1], mx);
          assert.ok(d >= floor, `${name}: ${fills[i][0]} vs ${fills[j][0]} only ${d.toFixed(1)} apart`);
        }
      }
    }
  });

  test('mechanism labels wrap rather than clip; focus rings clear the item bar', () => {
    const rule = (sel) => { const m = new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css); return m ? m[1] : null; };
    const label = rule('.mech-label');
    assert.ok(label && !/text-overflow|overflow:\s*hidden|white-space:\s*nowrap/.test(label), 'WCAG 1.4.12: no clipped mechanism label');
    assert.ok(/outline-offset:\s*-6px/.test(rule('.item > .row:focus-visible') || ''), 'item row ring sits inside the 4px bar');
  });

  test('every mechanism-bearing element carries data-mech for its own mechanism', () => {
    const html = render({ page: 'report', repTime: 'month', open: Object.fromEntries(data.items.map((i) => [i.id, true])) });
    for (const m of html.matchAll(/<article id="([^"]+)" class="item[^"]*" data-mech="([^"]+)">/g)) {
      assert.equal(m[2], data.byId.get(m[1]).mechanism, m[1]);
    }
    assert.equal((html.match(/<article /g) || []).length, (html.match(/<article id="[^"]+" class="item[^"]*" data-mech="/g) || []).length);
    const tags = (html.match(/class="mech(?: row-mech)?"/g) || []).length;
    assert.ok(tags > 0);
    assert.equal(tags, (html.match(/class="mech(?: row-mech)?" data-mech="(candidate_issue|kri_kpi|praf_coverage|awareness_only)"/g) || []).length);
    assert.ok(html.includes('<section class="card brief" aria-labelledby="rb-h">'), 'the report opens with its brief, not mechanism counts');
    const dash = render({ page: 'dashboard' });
    const dashTags = (dash.match(/class="mech"/g) || []).length;
    assert.ok(dashTags > 0);
    assert.equal(dashTags, (dash.match(/class="mech" data-mech="(candidate_issue|kri_kpi|praf_coverage|awareness_only)"/g) || []).length);
    const about = render({ page: 'about' }, null);
    for (const { key } of M.MECHANISMS) assert.ok(about.includes(`<div class="mech-cell" data-mech="${key}">`), `about ${key}`);
  });

  test('empty states carry the decorative quiet-signal line, hidden from assistive tech', () => {
    const svg = /<svg class="quiet-sig" viewBox="0 0 104 22" aria-hidden="true" focusable="false">/;
    assert.ok(svg.test(render({ page: 'dashboard' }, empty)));
    assert.ok(svg.test(render({ page: 'archive' }, empty)));
    assert.ok(svg.test(render({ page: 'report' }, empty)));
    assert.ok(svg.test(render({ page: 'archive', q: 'zzzz-no-match' })));
    // One line per empty section, none elsewhere (the fixture's 24-hour report has items in some sections only).
    const rep = render({ page: 'report' });
    assert.equal((rep.match(/class="quiet-sig"/g) || []).length, (rep.match(/<div class="empty">/g) || []).length);
    assert.ok(!render({ page: 'dashboard' }).includes('class="quiet-sig"'), 'no quiet line on a populated dashboard');
  });

  test('motion respects reduced-motion', () => {
    assert.ok(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*animation: none !important; transition: none !important;/.test(css));
  });

  test('the brand green is emphasis only: link underlines, the logo\'s cap, the active nav mark, the masthead bars\' crossings', () => {
    const rules = css.replace(/\/\*[^]*?\*\//g, '').split('}');
    for (const r of rules) {
      const [sel, body = ''] = r.split('{').slice(-2);
      for (const decl of body.split(';')) {
        // The brand green, and the light tint (#65E287) the old masthead wave used, which nothing may now.
        if (!/var\(--green\)|#1FD16A|rgba\(31, 209, 106|#65E287|rgba\(101, 226, 135/i.test(decl) || /--green:/.test(decl)) continue;
        const prop = decl.split(':')[0].trim();
        const ok = prop === 'text-decoration-color'
          || (prop === 'fill' && /^\s*\.bm-cap\s*$/.test(sel))
          || /^\s*\.nav a\.on::after\s*$/.test(sel)
          || (prop === 'stroke' && /^\s*\.mw-hot\s*$/.test(sel));
        assert.ok(ok, `green used by "${sel.trim()}" ${prop}`);
      }
    }
  });

  test('masthead logo: the mark, wordmark and tagline from the owner\'s brand set (2026-10-06)', () => {
    const html = render({ page: 'dashboard' });
    const at = html.indexOf('<a class="brand"');
    const brand = html.slice(at, html.indexOf('</a>', at));
    assert.ok(brand.includes('<svg class="brand-mark" viewBox="0 0 284 94" aria-hidden="true" focusable="false">'));
    assert.ok(text(brand).includes('Readiness Signal Amplify the signal. Reduce the risk.'));
    // The static page shows the same logo before the script runs.
    const index = readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8');
    assert.ok(index.includes(brand.slice(brand.indexOf('<svg'))));
    // Its two faces load only the letters the logo uses (so nothing else may ask for them).
    const subset = decodeURIComponent(index.match(/text=([^&"]+)/)[1]);
    assert.deepEqual([...new Set(subset)].sort(), [...new Set('Readiness Signal Amplify the signal. Reduce the risk.')].sort());
    // The favicon is the same mark, white with its green cap, on the navy square.
    const fav = readFileSync(new URL('../../docs/favicon.svg', import.meta.url), 'utf8');
    assert.ok(fav.includes('<rect width="32" height="32" fill="#0B1F44"/>') && fav.includes('fill="#fff"') && fav.includes('fill="#1FD16A"'));
  });

  test('masthead bars: decorative, tiled, unlabelled, left out of print and off phones', () => {
    const html = render({ page: 'dashboard' });
    const mast = html.slice(0, html.indexOf('</header>'));
    assert.ok(mast.includes('<header class="mast" data-k="mast">'));
    assert.ok(mast.includes('<div class="mast-wave" aria-hidden="true"><svg focusable="false">'), 'hidden from assistive tech');
    assert.equal((mast.match(/<use href="#mw-bars"/g) || []).length, 10, 'dim and lit copies, five tiles each');
    assert.ok(mast.includes('<line class="mw-bar" x1="0" y1="22" x2="100%" y2="22"></line>'), 'the bar sits on the nav row rule');
    // In the content column (owner, 2026-10-06): it ends where the cards end and starts over their
    // right-hand column, half the 20px grid gap past the middle, clear of the nav links.
    assert.ok(mast.includes('<div class="mast-in"><div class="mast-wave"'));
    assert.ok(/\.mast-wave \{[^}]*left: max\(440px, 50% \+ 10px\); right: var\(--hpad\);/.test(css));
    assert.ok(/\.dash-grid \{[^}]*gap: 20px;/.test(css), 'the offset is half this gap');
    // A period is 80 bars rising from the masthead's foot (y 66); two of them cross the bar (y 22).
    const bars = [...mast.match(/<path id="mw-bars" d="([^"]+)"/)[1].matchAll(/M(\d+) 66V(\d+)/g)].map((m) => 66 - Number(m[2]));
    assert.equal(bars.length, 80);
    assert.equal(bars.filter((h) => h > 44).length, 2);
    assert.ok(!mast.includes('mw-label') && !mast.includes('Materiality bar'), 'no label (owner: noise, 2026-10-06)');
    assert.ok(!mast.includes('<button'), 'no pause control: the owner chose continuous motion (2026-10-06)');
    assert.ok(!mast.includes('class="dot'), 'no live dot');
    const print = render({ page: 'report', printMode: 'collapsed' });
    assert.ok(!print.includes('mast-wave'), 'print mode leaves the bars out');
    // Reduced motion stills them (the global motion rule), and phones, where the nav fills the row, never get them.
    assert.ok(/@media \(max-width: 639\.98px\) \{ \.mast-wave \{ display: none; \} \}/.test(css));
  });

  test('mechanism tags show the label alone, with no four-square rail', () => {
    const html = render({ page: 'report', repTime: 'month' });
    assert.ok(!html.includes('class="rail"'));
    assert.ok(/<span class="mech(?: row-mech)?" data-mech="[a-z_]+"><span class="mech-label">/.test(html));
  });
});

describe('states', () => {
  test('day one: masthead, dashboard, report and archive look intentional', () => {
    const dash = text(render({ page: 'dashboard' }, empty));
    assert.ok(dash.includes('Next update 18:00 ET') && !dash.includes('Updated '), 'no run yet: only the schedule');
    // Day one: every panel says plainly that there is nothing yet; nothing claims a run applied the test.
    assert.ok(dash.includes('No scheduled run has been recorded yet.'));
    assert.ok(dash.includes('Nothing published yet. Runs at 06:00, 10:00, 14:00 and 18:00 ET publish only what clears the bar; a silent run is a result.'));
    assert.ok(dash.includes('No developing thread yet.'));
    assert.ok(dash.includes('No item asks for action yet.'));
    assert.ok(dash.includes('No regulatory or executive signal has cleared the bar yet.'));
    assert.ok(!dash.includes('cleared the bar.') && !dash.includes('did not run'));
    assert.ok(!dash.includes('As of'));
    const repHtml = render({ page: 'report' }, empty);
    const rep = text(repHtml);
    assert.ok(rep.includes('Nothing published in the last 24 hours.'));
    assert.ok(!repHtml.includes('data-act="toggleall"'), 'nothing to expand');
    assert.ok(repHtml.includes('class="export-btn"'), 'an empty report still exports');
    const arcHtml = render({ page: 'archive' }, empty);
    const arc = text(arcHtml);
    assert.ok(arc.includes('Nothing published yet.'));
    assert.ok(!arc.includes('Nothing in the archive matches.'));
    assert.ok(!arcHtml.includes('data-act="toggleall"') && !arcHtml.includes('class="export-btn"'));
  });

  test('masthead: one status line, updated from runs.json, the next slot from the schedule (owner change 2026-10-06)', () => {
    const mastOf = (html) => text(html.slice(0, html.indexOf('</header>')));
    const mast = mastOf(render({ page: 'report' }));
    assert.ok(mast.includes('Updated Fri 14:21 · Next 18:00 ET'));
    assert.ok(!mast.includes('Last edition') && !mast.includes('Last checked'));
    // A silent run moves "Updated"; after the day's last slot, the next is the morning's.
    const runs = fixture('runs.json');
    runs.runs.push({ run_id: '2026-10-02-1800', slot: '2026-10-02T18:00:00-04:00', started_at: '2026-10-02T18:05:00-04:00', finished_at: '2026-10-02T18:31:00-04:00', status: 'silent', items: [] });
    const later = mastOf(render({ page: 'report' }, M.prepare(fixture('archive.json'), runs), { now: new Date('2026-10-02T18:40:00-04:00') }));
    assert.ok(later.includes('Updated Fri 18:31 · Next Sat 06:00 ET'));
    // Paper carries the full time of its data, and no schedule.
    const paper = mastOf(render({ page: 'report', printMode: 'collapsed' }));
    assert.ok(paper.includes('Updated Fri 2 Oct 2026, 14:21 ET') && !paper.includes('Next'));
    // While loading, no time is guessed.
    const loadingMast = text(V.renderApp({ ui: ui({ page: 'report' }), data: null, now: NOW, error: null, loading: true }));
    assert.ok(!/\d{2}:\d{2}/.test(loadingMast));
  });

  test('the dashboard opens with the brief, then its panels in reading order (owner change 2026-10-06)', () => {
    const html = render({ page: 'dashboard' });
    const order = ['class="card brief"', ...['latest', 'adds', 'threads', 'asks', 'reg', 'doms', 'bar'].map((k) => `class="card dcard d-${k}"`), 'class="arch-link"']
      .map((k) => html.indexOf(k));
    assert.ok(order.every((at) => at > html.indexOf('class="h1"')), 'everything after the title');
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.ok(!/last 7 days, by what each item asks|Sections, last 7 days|Domains, last 7 days/i.test(html), 'the 7-day count panels are gone');
    const t = text(html);
    for (const b of M.dashboard(data, NOW).brief) assert.ok(t.includes(V.esc(b.text)), b.key);
  });

  test('dashboard charts: one mark per item, tables for assistive tech, links only to item ids', () => {
    const html = render({ page: 'dashboard' });
    const d = M.dashboard(data, NOW);
    assert.equal((html.match(/<a class="u( aw)?" href="#RS-/g) || []).length, data.items.length, 'a square per item');
    assert.equal((html.match(/<a class="u aw"/g) || []).length, data.items.filter((i) => i.mechanism === 'awareness_only').length);
    assert.equal((html.match(/<line class="th-dot"/g) || []).length, d.threads.reduce((n, t) => n + t.dots.length, 0));
    // Chart marks are pointer shortcuts; keyboard and screen-reader users get the tables and lists.
    assert.ok(/<div class="uc" aria-hidden="true">/.test(html) && /<svg class="th-svg"[^>]*aria-hidden="true"/.test(html));
    for (const m of html.matchAll(/<a class="u[^"]*"[^>]*>/g)) assert.ok(m[0].includes('tabindex="-1"'), m[0]);
    assert.ok(html.includes('<caption>Items added by month</caption>'));
    assert.ok(/<table class="dm">\s*<caption class="sr-only">Items by domain and month/.test(html));
    assert.ok(html.includes('<caption class="sr-only">Scheduled runs by day and slot (ET)</caption>'));
    for (const m of html.slice(html.indexOf('<main')).matchAll(/href="([^"]+)"/g)) {
      assert.ok(/^#(RS-\d{6}-\d{4}-\d{2}|archive|report|dashboard)$/.test(m[1]), m[1]);
    }
  });

  test('report opens with a brief of its window (owner change 2026-10-06)', () => {
    const html = render({ page: 'report', repTime: 'week' });
    assert.ok(html.includes('<h2 class="sr-only" id="rb-h">At a glance: last 7 days</h2>'));
    assert.ok(html.indexOf('class="card brief"') < html.indexOf('class="card group"'));
    const t = text(html);
    for (const b of M.windowBrief(data, ui({ page: 'report', repTime: 'week' }), NOW)) assert.ok(t.includes(V.esc(b.text)), b.key);
    assert.ok(!/class="mix/.test(html));
    assert.ok(render({ page: 'report' }, empty).includes('<div class="brief-grid n2">'), 'an empty window keeps to two cells');
  });

  test('archive opens with the month navigator: squares fade outside the selection; months are buttons', () => {
    const html = render({ page: 'archive', q: 'cloud' });
    assert.ok(html.indexOf('class="card arch-chart"') < html.indexOf('class="card group"'));
    const lm = M.listModel(data, ui({ page: 'archive', q: 'cloud' }), NOW);
    assert.equal((html.match(/<a class="u( aw)?( out)?" href="#RS-/g) || []).length, data.items.length);
    assert.equal((html.match(/<a class="u( aw)?" href="#RS-/g) || []).length, lm.shown.length, 'only the matches stay solid');
    assert.ok(html.includes('<span class="u out"></span>Outside your selection'));
    assert.ok(html.includes('<button type="button" class="mx-m mx-btn" data-act="pick" data-f="time" data-v="m-2026-10" aria-pressed="false">'));
    const oct = render({ page: 'archive', archTime: 'm-2026-10' });
    assert.ok(oct.includes('data-v="all" aria-pressed="true"'), 'the chosen month picks all time again');
    assert.ok(!render({ page: 'archive' }, empty).includes('arch-chart'));
  });

  test('an expanded item in a thread shows the thread and steps along it; rows mark it', () => {
    const html = render({ page: 'report', open: { 'RS-261002-1400-02': true } });
    const art = html.slice(html.indexOf('<article id="RS-261002-1400-02"'));
    const one = art.slice(0, art.indexOf('</article>'));
    assert.ok(one.includes('<div class="body has-thr">'));
    assert.ok(one.includes('<span class="thr-meta">Development 2 of 2 · 21 Sep 2026 to 2 Oct 2026</span>'));
    assert.ok(/<button type="button" class="thr-step" data-act="reveal" data-id="RS-260921-1000-01"><span class="thr-step-k">Earlier · 21 Sep 2026/.test(one));
    assert.ok(!one.includes('>Later ·'));
    assert.equal((one.match(/class="th-halo"/g) || []).length, 1, 'this development is haloed');
    assert.ok(html.includes('<span class="meta-thr">Thread · 2</span>'));
    const lone = render({ page: 'report', open: { 'RS-261002-1400-01': true } });
    const a2 = lone.slice(lone.indexOf('<article id="RS-261002-1400-01"'));
    assert.ok(!a2.slice(0, a2.indexOf('</article>')).includes('b-thr'));
  });

  test('About keys the charts', () => {
    const about = render({ page: 'about' }, null);
    assert.ok(about.includes('<h2 class="h-19">How the charts read</h2>'));
    for (const s of ['One square per item', 'A thread:', 'Each scheduled run:', 'Counts and sizes mean volume, never severity.']) assert.ok(text(about).includes(s), s);
  });

  test('dashboard tooltips and labels are escaped data', () => {
    const d = hostile();
    const html = render({ page: 'dashboard' }, d);
    assert.ok(!html.includes('<img') && !html.includes('<script'));
    assert.ok(/data-tip="[^"]*Claim &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/.test(html));
  });

  test('print: the permalink prints in full', () => {
    const html = render({ page: 'report', printMode: 'expanded' });
    assert.ok(html.includes(`<a class="perma-link" href="#RS-261002-1400-01">${M.permalinkUrl('RS-261002-1400-01')}</a>`));
    const css = readFileSync(new URL('../../docs/assets/app.css', import.meta.url), 'utf8');
    assert.ok(/a\.src-link\[href\^="https:"\]::after\s*\{[^}]*content: " " attr\(href\)/.test(css));
  });

  test('filtered-out archive says nothing matches', () => {
    assert.ok(text(render({ page: 'archive', q: 'zzzz-no-match' })).includes('Nothing in the archive matches.'));
  });

  test('load failure shows a plain message; About still renders', () => {
    for (const page of ['dashboard', 'report', 'archive']) {
      const t = text(V.renderApp({ ui: ui({ page }), data: null, now: NOW, error: new Error('x'), loading: false }));
      assert.ok(t.includes('The archive could not be loaded.'), page);
      assert.ok(t.includes('Next update 18:00 ET') && !t.includes('Updated '), 'nothing claims when the data changed');
    }
    const about = text(V.renderApp({ ui: ui({ page: 'about' }), data: null, now: NOW, error: new Error('x'), loading: false }));
    assert.ok(about.includes('A filter, not a feed.'));
  });

  test('print mode hides chrome and adds the export meta line', () => {
    const html = render({ page: 'report', printMode: 'expanded' });
    assert.ok(!html.includes('class="fbar"'));
    assert.ok(!html.includes('class="nav"'));
    assert.ok(!html.includes('class="copy-btn'));
    assert.ok(!html.includes('class="email-btn"'));
    assert.ok(html.includes('<div class="print-meta">Readiness Signal report export · Fully expanded · Last 24 hours · All sections · All domains · All sources · 7 items · Exported Fri 2 Oct 2026, 15:00 ET</div>'));
    assert.equal((html.match(/<article [^>]*class="item open/g) || []).length, 7);
  });

  test('copy buttons show the Copied state for the copied key only', () => {
    const html = render({ page: 'report', open: { 'RS-261002-1400-01': true }, copied: 'RS-261002-1400-01:q' });
    assert.equal((html.match(/copy-btn on/g) || []).length, 1);
    assert.ok(html.includes('<span class="copy-mark" aria-hidden="true"></span>Copied'));
  });

  test('item rows are keyboard-operable buttons with expanded state', () => {
    const html = render({ page: 'report', open: { 'RS-261002-1400-01': true } });
    assert.ok(html.includes('<div class="row" role="button" tabindex="0" aria-expanded="true" data-act="toggle" data-id="RS-261002-1400-01">'));
    assert.ok(html.includes('aria-expanded="false" data-act="toggle" data-id="RS-261002-1400-03"'));
  });

  test('no monospace anywhere in the stylesheet or markup', () => {
    const css = readFileSync(new URL('../../docs/assets/app.css', import.meta.url), 'utf8');
    const index = readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8');
    assert.ok(!/monospace|ui-monospace|Courier|Consolas|Menlo|<code|<pre|<kbd|<tt/i.test(css + index + render({ page: 'report' })));
    assert.ok(/font-variant-numeric:\s*tabular-nums/.test(css));
  });

  test('site uses no storage APIs and only relative URLs', () => {
    const files = ['app.js', 'model.js', 'view.js'].map((f) => readFileSync(new URL(`../../docs/assets/${f}`, import.meta.url), 'utf8')).join('\n');
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(files));
    assert.ok(files.includes("fetchJson('data/archive.json')") && files.includes("fetchJson('data/runs.json')"));
    assert.ok(files.includes("cache: 'no-cache'"));
    const index = readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8');
    for (const m of index.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const u = m[1];
      assert.ok(!u.startsWith('/'), `root-absolute URL breaks the sub-path: ${u}`);
      if (/^https?:/.test(u)) assert.ok(/^https:\/\/fonts\.(googleapis|gstatic)\.com(\/|$)/.test(u), `external: ${u}`);
    }
    assert.ok(!/<script[^>]+src="https?:/i.test(index), 'no external scripts');
  });
});
