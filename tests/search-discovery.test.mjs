// tests/search-discovery.test.mjs — coverage for lib/search-discovery.mjs
// (the web-search discovery lane used by scan.mjs's search_queries phase).
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

console.log('\nSearch discovery — parseSearchResults + discoverFromSearch');

const { parseSearchResults, discoverFromSearch, hostFromUrl } =
  await import(pathToFileURL(join(ROOT, 'lib/search-discovery.mjs')).href);

const fixture = readFileSync(join(ROOT, 'tests/fixtures/bing-search.html'), 'utf-8');

// parseSearchResults: extracts b_algo blocks, keeps http(s) links, dedups by URL.
{
  const results = parseSearchResults(fixture);
  // 5 b_algo blocks: 2 unique liepin (one is a dup), 1 zhaopin, 1 relative (dropped),
  // 1 ftp (dropped). Expected unique http links = liepin + zhaopin = 2.
  if (results.length === 2) pass(`parseSearchResults returns ${results.length} unique http results`);
  else fail(`parseSearchResults should return 2 unique http results, got ${results.length}`);

  const urls = results.map(r => r.url).sort();
  if (urls[0] === 'https://www.liepin.com/job/123456.shtml' &&
      urls[1] === 'https://www.zhaopin.com/jobdetail/789012.htm') {
    pass('parseSearchResults extracts correct urls (liepin + zhaopin)');
  } else {
    fail(`parseSearchResults urls wrong: ${JSON.stringify(urls)}`);
  }

  const titles = results.map(r => r.title).sort();
  if (titles.includes('郑州 项目经理（软件方向）') && titles.includes('郑州 高级软件项目经理')) {
    pass('parseSearchResults extracts titles from <h2><a>');
  } else {
    fail(`parseSearchResults titles wrong: ${JSON.stringify(titles)}`);
  }
}

// dedup: the second liepin block (same URL) must not appear twice.
{
  const results = parseSearchResults(fixture);
  const liepin = results.filter(r => r.url.includes('liepin.com/job/123456'));
  if (liepin.length === 1) pass('parseSearchResults dedups identical URLs across blocks');
  else fail(`expected 1 liepin result after dedup, got ${liepin.length}`);
}

// non-string / empty input is safe.
{
  if (Array.isArray(parseSearchResults('')) && parseSearchResults('').length === 0) {
    pass('parseSearchResults("") returns []');
  } else fail('parseSearchResults("") should return []');
  if (Array.isArray(parseSearchResults(null)) && parseSearchResults(null).length === 0) {
    pass('parseSearchResults(null) returns []');
  } else fail('parseSearchResults(null) should return []');
}

// hostFromUrl
{
  if (hostFromUrl('https://www.liepin.com/job/1.shtml') === 'liepin.com') pass('hostFromUrl strips www.');
  else fail(`hostFromUrl wrong: ${hostFromUrl('https://www.liepin.com/job/1.shtml')}`);
  if (hostFromUrl('not a url') === '') pass('hostFromUrl returns "" on unparseable input');
  else fail('hostFromUrl should return "" on unparseable input');
}

// discoverFromSearch: wraps fetchText + parse, honors empty/whitespace queries.
{
  let fetched = null;
  const ctx = {
    fetchText: async (url) => { fetched = url; return fixture; },
  };
  const results = await discoverFromSearch('site:liepin.com 郑州 项目经理', ctx);
  const decodedFetch = decodeURIComponent(fetched || '');
  if (fetched && fetched.includes('bing.com/search') && decodedFetch.includes('郑州') && decodedFetch.includes('site:liepin.com')) {
    pass('discoverFromSearch fetches Bing with the encoded query');
  } else fail(`discoverFromSearch fetch URL wrong: ${fetched}`);
  if (results.length === 2) pass('discoverFromSearch returns parsed results');
  else fail(`discoverFromSearch should return 2, got ${results.length}`);

  const empty = await discoverFromSearch('   ', ctx);
  if (empty.length === 0) pass('discoverFromSearch("   ") returns [] without fetching');
  else fail('discoverFromSearch should short-circuit empty query');
}
