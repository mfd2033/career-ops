// tests/parse-inbound.test.mjs — coverage for parseBoardHtml() in parse-inbound.mjs.
// parseBoardHtml is the pure parser behind the 郑州 channel (user saves a
// logged-in search-results page into data/inbound/, the tool extracts cards).
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

console.log('\nParse inbound — parseBoardHtml (Chinese job-board HTML)');

const { parseBoardHtml } =
  await import(pathToFileURL(join(ROOT, 'parse-inbound.mjs')).href);

const html = readFileSync(join(ROOT, 'tests/fixtures/liepin-results.html'), 'utf-8');

// Parse: 3 unique job cards (liepin /job/N.shtml), homepage + duplicate dropped.
{
  const jobs = parseBoardHtml(html);
  // 4 <a> with job URLs: 100001, 100002, 100003, then a repeat of 100001
  // (relative homepage link has no /job/ pattern so it's excluded). Dedup on
  // URL leaves 3.
  if (jobs.length === 3) pass(`parseBoardHtml returns ${jobs.length} unique jobs`);
  else fail(`parseBoardHtml should return 3 unique jobs, got ${jobs.length}`);

  const urls = jobs.map(j => j.url).sort();
  const expect = [
    'https://www.liepin.com/job/100001.shtml',
    'https://www.liepin.com/job/100002.shtml',
    'https://www.liepin.com/job/100003.shtml',
  ].sort();
  if (JSON.stringify(urls) === JSON.stringify(expect)) {
    pass('parseBoardHtml extracts the 3 unique liepin job URLs');
  } else fail(`parseBoardHtml urls wrong: ${JSON.stringify(urls)}`);

  const titles = jobs.map(j => j.title).sort();
  if (titles.includes('软件项目经理') && titles.includes('高级项目经理（软件交付）') &&
      titles.includes('IT项目经理（驻场）')) {
    pass('parseBoardHtml extracts CJK titles');
  } else fail(`parseBoardHtml titles wrong: ${JSON.stringify(titles)}`);
}

// Company + location extraction (best-effort, board-specific DOM).
{
  const jobs = parseBoardHtml(html);
  const first = jobs.find(j => j.url.includes('100001'));
  if (first && first.company === '郑州云图科技有限公司') pass('parseBoardHtml extracts company from class="company-name"');
  else fail(`company extraction wrong: ${first && first.company}`);
  if (first && first.location === '郑州') pass('parseBoardHtml extracts location (郑州)');
  else fail(`location extraction wrong: ${first && first.location}`);

  const second = jobs.find(j => j.url.includes('100002'));
  if (second && second.location === '郑州-金水区') pass('parseBoardHtml keeps district suffix (郑州-金水区)');
  else fail(`district location wrong: ${second && second.location}`);
}

// board detection
{
  const jobs = parseBoardHtml(html);
  if (jobs.every(j => j.board === '猎聘')) pass('parseBoardHtml maps liepin → 猎聘');
  else fail(`board detection wrong: ${jobs.map(j => j.board).join(',')}`);
}

// empty / non-string input is safe
{
  if (Array.isArray(parseBoardHtml('')) && parseBoardHtml('').length === 0) pass('parseBoardHtml("") returns []');
  else fail('parseBoardHtml("") should return []');
  if (Array.isArray(parseBoardHtml(null)) && parseBoardHtml(null).length === 0) pass('parseBoardHtml(null) returns []');
  else fail('parseBoardHtml(null) should return []');
}
