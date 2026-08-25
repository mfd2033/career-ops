#!/usr/bin/env node
// parse-inbound.mjs — parse saved Chinese job-board search-result HTML into the
// pipeline.
//
// WHY THIS EXISTS
// Chinese boards (liepin / zhaopin / 51job / zhipin / lagou) block headless
// browsers AND logged-out browsers with captcha / anti-bot walls, so scan.mjs's
// search_queries lane returns ~0 results for them. The workaround for the 郑州
// channel: you open a 郑州 search in YOUR OWN logged-in browser, save the page
// (Ctrl/Cmd+S → "Webpage, HTML only") into data/inbound/, then run this. The
// tool extracts the job cards and feeds them through the same title/location
// filters and dedup that scan.mjs uses.
//
// USAGE
//   node parse-inbound.mjs            # parse every *.html in data/inbound/
//   node parse-inbound.mjs --dry-run  # parse + filter, print, write nothing
//
// The tool is best-effort on company/location extraction (board DOMs differ and
// drift); the URL + title are always extracted reliably, and the downstream
// `pipeline` mode re-fetches each URL to evaluate the real JD.

import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import * as yaml from 'js-yaml';
import {
  buildTitleFilter,
  buildLocationFilter,
  normalizeUrlForDedup,
  appendToPipeline,
  appendToScanHistory,
} from './scan.mjs';

const INBOUND_DIR = 'data/inbound';
const PORTALS_PATH = 'portals.yml';

// ── Extraction (pure, exported for tests) ──────────────────────────────

// Known-host job-detail URL patterns. Combined with a CJK-title length check
// below, this keeps nav/footer links out of the results.
const BOARD_JOB_URL_RE = [
  /liepin\.com\/job\/\d+/i,
  /zhaopin\.com\/(?:jobdetail|zpdetail|job)\//i,
  /51job\.com\/job\//i,
  /jobs?\.51job\.com/i,
  /zhipin\.com\/job_detail/i,
  /lagou\.com\/(?:jobs|jobdetail)\/\d+/i,
  /\/job\/\d+/i,
  /\/jobs?\/\d+\.html/i,
  /\/position\/\d+/i,
  /[?&]jobid=/i,
  /[?&]jobId=/i,
];

// Major Chinese cities for location hinting. 郑州 is the user's target but we
// extract whatever the card says so the location filter can decide.
const CITY_HINTS = [
  '北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '西安', '南京', '苏州',
  '天津', '重庆', '长沙', '青岛', '宁波', '东莞', '无锡', '佛山', '合肥', '福州',
  '厦门', '济南', '昆明', '沈阳', '大连', '哈尔滨', '长春', '石家庄', '太原',
  '郑州', '南昌', '贵阳', '南宁', '海口', '兰州', '银川', '西宁', '乌鲁木齐',
  '呼和浩特', '烟台', '常州', '徐州', '潍坊', '泉州', '绍兴', '嘉兴', '台州',
  '珠海', '中山', '惠州', '江门', '保定', '廊坊', '唐山', '洛阳', '南阳', '开封',
  '新乡', '许昌', '信阳', '周口', '驻马店', '焦作', '濮阳', '商丘', '安阳', '鹤壁',
  '漯河', '三门峡',
];

function cleanText(s) {
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isJobUrl(href) {
  return BOARD_JOB_URL_RE.some((re) => re.test(href));
}

function boardFromUrl(url) {
  try {
    const h = new URL(url).hostname;
    if (/liepin/.test(h)) return '猎聘';
    if (/zhaopin/.test(h)) return '智联招聘';
    if (/51job/.test(h)) return '前程无忧';
    if (/zhipin|kanzhun/.test(h)) return 'BOSS直聘';
    if (/lagou/.test(h)) return '拉勾';
    return h.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Slice a window of HTML ending just after `idx` so we can read the enclosing
// card (company span, location text) without a full DOM parser.
function cardWindow(html, idx, span = 2200) {
  const start = Math.max(0, idx - span);
  return html.slice(start, idx + 400);
}

// A "location" is a short CJK string that names a city (optionally with a
// district/street), and is NOT a company name or a board navigation label.
function looksLikeLocation(text) {
  if (!text || !/[一-鿿]/.test(text)) return false;
  // Company names (郑州鸿贝科技股份有限公司) and nav labels (郑州招聘网) contain
  // these tokens — reject them so they never masquerade as a place.
  if (/招聘|人才|网|信息|职位|公司|股份|科技|集团|有限|企业|工厂|大学|学院|医院|学校|局|所/.test(text)) return false;
  return CITY_HINTS.some((c) => text.includes(c));
}

// Collect every location span in the document once. Boards encode location
// differently — a `class="*location*"` element (liepin/51job/lagou) or a
// `title="郑州 金水 祭城路"` attribute (智联). We keep only spans that
// looksLikeLocation so a company name is never mistaken for a place.
function collectLocationSpans(html) {
  const spans = [];
  const push = (index, text) => {
    const t = cleanText(text);
    if (looksLikeLocation(t)) spans.push({ index, text: t });
  };
  const clsRe = /<(span|div|p|a|li)[^>]*class="[^"]*(?:location|city|area|addr|region|place|loc|address)[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = clsRe.exec(html)) !== null) push(m.index, m[2]);
  const titleRe = /<(span|div|p|a|li)[^>]*\btitle="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/gi;
  while ((m = titleRe.exec(html)) !== null) {
    if (looksLikeLocation(m[2])) push(m.index, m[2]);
    else if (looksLikeLocation(m[3])) push(m.index, m[3]);
  }
  const seenIdx = new Set();
  return spans.filter((s) => (seenIdx.has(s.index) ? false : seenIdx.add(s.index)));
}

// 猎聘 (and some boards) embed the location INSIDE the job title as a bracket,
// e.g. "项目经理/ Project Manager 【鄂州-鄂城】急聘 18-30k". There is no separate
// location element, so when the span-based collector finds nothing we fall back
// to scanning the title text for a 【城市-区】 / （城市） token.
function extractInlineLocation(title) {
  if (!title) return '';
  const re = /[【\[（(]([^】\]）\n]*?)[】\]）)]/g;
  let m;
  while ((m = re.exec(title)) !== null) {
    const inner = cleanText(m[1]);
    if (inner && CITY_HINTS.some((c) => inner.includes(c))) return inner;
  }
  return '';
}

function extractCompany(block) {
  // Best-effort: a span/div whose class names a company field, holding short text.
  const re = /<[^>]*class="[^"]*(?:company|comp|employer|corp|firm)[^"]*"[^>]*>([^<]{1,40})</i;
  const m = block.match(re);
  if (m) {
    const c = cleanText(m[1]);
    if (c && c.length >= 2) return c;
  }
  return '';
}

/**
 * Parse a saved search-results HTML page into job rows.
 * @param {string} html
 * @returns {Array<{ url: string, title: string, company: string, location: string, board: string }>}
 */
export function parseBoardHtml(html) {
  if (typeof html !== 'string' || html.length === 0) return [];
  // 1) Collect job-title anchors (the reliable signal) as { url, title, index }.
  const anchors = [];
  const seen = new Set();
  const re = /<a\b([^>]*?)\bhref="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[2];
    const title = cleanText(m[4]);
    if (!title || title.length < 4 || title.length > 80) continue;
    if (!/[一-鿿]/.test(title)) continue;
    if (!isJobUrl(href)) continue;
    const url = href.startsWith('http') ? href : null;
    if (!url) continue; // skip relative-only links (rare; can't absolutize sans base)
    const key = normalizeUrlForDedup(url);
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push({ url, title, index: m.index });
  }
  // 2) Collect location spans once (board DOMs differ — see collectLocationSpans).
  const locSpans = collectLocationSpans(html);
  // 3) Map each job to the location span that belongs to its card: the first
  //    location span after the title anchor and before the next anchor.
  const jobs = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const nextIdx = i + 1 < anchors.length ? anchors[i + 1].index : Infinity;
    const loc = locSpans
      .filter((s) => s.index > a.index && s.index < nextIdx)
      .sort((x, y) => x.index - y.index)[0];
    const block = cardWindow(html, a.index);
    jobs.push({
      url: a.url,
      title: a.title,
      company: extractCompany(block),
      location: loc ? loc.text : extractInlineLocation(a.title),
      board: boardFromUrl(a.url),
    });
  }
  return jobs;
}

// ── CLI ────────────────────────────────────────────────────────────────

function loadConfig() {
  if (!existsSync(PORTALS_PATH)) return {};
  try {
    const raw = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function collectSeenUrls() {
  const seen = new Set();
  const files = [
    'data/scan-history.tsv',
    'data/pipeline.md',
  ];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const text = readFileSync(f, 'utf-8');
    for (const line of text.split('\n')) {
      for (const mm of line.matchAll(/https?:\/\/[^\s|)\]]+/g)) {
        seen.add(normalizeUrlForDedup(mm[0]));
      }
    }
  }
  return seen;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const config = loadConfig();
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);

  if (!existsSync(INBOUND_DIR)) {
    console.log(`No ${INBOUND_DIR}/ directory — create it and drop saved HTML pages there.`);
    return;
  }
  const files = readdirSync(INBOUND_DIR).filter((f) => f.toLowerCase().endsWith('.html'));
  if (files.length === 0) {
    console.log(`No *.html files in ${INBOUND_DIR}/ — nothing to parse.`);
    return;
  }

  const seen = collectSeenUrls();
  const date = new Date().toISOString().slice(0, 10);
  const newOffers = [];
  let totalFound = 0;
  let filteredTitle = 0;
  let filteredLocation = 0;
  let dupes = 0;

  for (const file of files) {
    const html = readFileSync(path.join(INBOUND_DIR, file), 'utf-8');
    const parsed = parseBoardHtml(html);
    totalFound += parsed.length;
    for (const j of parsed) {
      if (!titleFilter(j.title)) { filteredTitle++; continue; }
      if (!locationFilter(j.location, j.url, j.title)) { filteredLocation++; continue; }
      const key = normalizeUrlForDedup(j.url);
      if (seen.has(key) || newOffers.some((o) => normalizeUrlForDedup(o.url) === key)) {
        dupes++;
        continue;
      }
      seen.add(key);
      newOffers.push({
        title: j.title,
        url: j.url,
        company: j.company || j.board,
        location: j.location,
        description: '',
        postedAt: undefined,
        source: 'inbound',
        tracked: false,
        careersUrlDomain: null,
      });
    }
  }

  console.log(`Inbound HTML parsed:   ${totalFound} job cards from ${files.length} file(s)`);
  console.log(`Filtered by title:     ${filteredTitle} removed`);
  console.log(`Filtered by location:  ${filteredLocation} removed`);
  console.log(`Duplicates:            ${dupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (dryRun) {
    for (const o of newOffers) console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    console.log('\n(dry run — run without --dry-run to save results)');
    return;
  }

  if (newOffers.length > 0) {
    await appendToPipeline(newOffers);
    await appendToScanHistory(newOffers, date);
    console.log(`\nResults saved to data/pipeline.md and data/scan-history.tsv`);
  }
  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
