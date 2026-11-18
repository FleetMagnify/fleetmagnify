/**
 * Search and AI-answer basics: public page tags, sitemap, robots, noindex.
 * Reads files as text. No browser and no network.
 *
 *   node scripts/test-seo-basics.js
 */
var fs = require('fs');
var path = require('path');
var assert = require('assert');

var pass = true;
function check(label, fn) {
  try {
    fn();
    console.log('[PASS] ' + label);
  } catch (err) {
    pass = false;
    console.log('[FAIL] ' + label + ' — ' + err.message);
  }
}

var root = path.join(__dirname, '..');
var HOST = 'https://www.fleetmagnify.com';
var PUBLIC = [
  'index.html',
  'features.html',
  'pricing.html',
  'supported-platforms.html',
  'platform-guide.html',
  'sample-reports.html',
  'glossary.html',
  'machine-operating-cost-per-hour.html',
  'fleet-utilisation-rate-formula.html',
  'free-calculators.html',
  'contact.html',
  'privacy-policy.html',
  'terms-of-service.html',
  'signup.html'
];
var NAMED_PRIVATE = ['admin.html', 'login.html', 'accept-invite.html', 'upgrade.html'];
// bulk-import.html is an admin tool. It has no sidebar placeholder and no sidebar markup.
var EXTRA_PRIVATE = ['bulk-import.html'];

var EXPECTED_SIDEBAR = [
  'asset-overview.html',
  'assets.html',
  'cost-per-km-analyst.html',
  'divisions.html',
  'emissions-intelligence.html',
  'fuel-analyst.html',
  'home.html',
  'idle-cost-analyst.html',
  'integrations.html',
  'job-cost-analyst.html',
  'orion-fuel-report.html',
  'reports.html',
  'settings.html',
  'trip-report.html',
  'truck-emissions-analyst.html',
  'truck-fuel-analyst.html',
  'truck-idle-monitor.html',
  'upload.html',
  'utilisation-analyst.html'
];

var EXPECTED_VERCEL_ROUTING = {
  functions: {
    'api/*.js': { maxDuration: 60 }
  },
  crons: [
    { path: '/api/sync-subscription-quantities', schedule: '0 16 * * *' },
    { path: '/api/check-missing-reports', schedule: '30 16 * * *' }
  ],
  redirects: [
    {
      source: '/data-partners.html',
      destination: '/supported-platforms.html',
      statusCode: 301
    }
  ],
  rewrites: [
    { source: '/api/invite-account-member', destination: '/api/team?action=invite' },
    { source: '/api/remove-account-member', destination: '/api/team?action=remove' },
    { source: '/api/list-account-members', destination: '/api/team?action=list' },
    { source: '/api/create-division', destination: '/api/team?action=create-division' },
    { source: '/api/rename-division', destination: '/api/team?action=rename-division' },
    { source: '/api/delete-division', destination: '/api/team?action=delete-division' },
    { source: '/api/set-division-managers', destination: '/api/team?action=set-division-managers' }
  ]
};

function read(name) {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

function htmlFiles() {
  return fs.readdirSync(root).filter(function (name) {
    return name.slice(-5) === '.html';
  }).sort();
}

function decode(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function parseAttrs(raw) {
  var attrs = {};
  var re = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  var match;
  while ((match = re.exec(raw))) {
    var value = match[2];
    if (value == null) value = match[3];
    if (value == null) value = match[4];
    if (value == null) value = '';
    attrs[match[1].toLowerCase()] = decode(value);
  }
  return attrs;
}

function findTags(html, tagName) {
  var re = new RegExp('<' + tagName + '\\b([^>]*)>', 'gi');
  var found = [];
  var match;
  while ((match = re.exec(html))) found.push(parseAttrs(match[1]));
  return found;
}

function titles(html) {
  var found = [];
  var re = /<title>([\s\S]*?)<\/title>/gi;
  var match;
  while ((match = re.exec(html))) found.push(decode(match[1]).trim());
  return found;
}

function canonicalFor(filename) {
  if (filename === 'index.html') return HOST + '/';
  return HOST + '/' + filename;
}

function isSidebarPage(html) {
  return html.indexOf('id="sidebar-placeholder"') !== -1 ||
    html.indexOf("id='sidebar-placeholder'") !== -1 ||
    html.indexOf('css/sidebar.css') !== -1 ||
    html.indexOf('js/sidebar-nav.js') !== -1;
}

function sourceMatches(source, pathname) {
  var named = /^\/:([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)\.html$/.exec(source);
  if (named) {
    var names = named[2].split('|');
    var file = /^\/([^/]+)\.html$/.exec(pathname);
    if (!file) return false;
    return names.indexOf(file[1]) !== -1;
  }
  return source === pathname;
}

function noindexRules(config) {
  return (config.headers || []).filter(function (rule) {
    return (rule.headers || []).some(function (header) {
      return String(header.key).toLowerCase() === 'x-robots-tag' &&
        header.value === 'noindex, nofollow';
    });
  });
}

function hasNoindex(config, pathname) {
  return noindexRules(config).some(function (rule) {
    return sourceMatches(rule.source, pathname);
  });
}

function jsonLdBlocks(html) {
  var found = [];
  var re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  var match;
  while ((match = re.exec(html))) found.push(match[1]);
  return found;
}

function visibleText(html) {
  return decode(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

function jpegSize(buf) {
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) throw new Error('hero.jpg is not a JPEG');
  var i = 2;
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xFF) {
      i += 1;
      continue;
    }
    var marker = buf[i + 1];
    if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xD8 || marker === 0xD9 || marker === 0x01) {
      i += 2;
      continue;
    }
    var len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  throw new Error('hero.jpg has no size marker');
}

check('every public page has one title, one description, one canonical, and the share tags', function () {
  var hero = jpegSize(fs.readFileSync(path.join(root, 'images', 'hero.jpg')));
  assert.ok(hero.width >= 1200, 'hero.jpg is ' + hero.width + 'px wide');
  var descriptions = {};
  PUBLIC.forEach(function (filename) {
    var html = read(filename);
    var pageTitles = titles(html);
    assert.strictEqual(pageTitles.length, 1, filename + ' title count');
    var descriptionsOnPage = findTags(html, 'meta').filter(function (attrs) {
      return attrs.name === 'description';
    });
    assert.strictEqual(descriptionsOnPage.length, 1, filename + ' description count');
    var description = descriptionsOnPage[0].content;
    assert.ok(description.length >= 120 && description.length <= 160, filename + ' description is ' + description.length + ' characters');
    assert.ok(!descriptions[description], filename + ' repeats a description');
    descriptions[description] = filename;
    assert.ok(description.toLowerCase().indexOf('john deere') === -1, filename + ' description mentions John Deere');

    var canonicals = findTags(html, 'link').filter(function (attrs) {
      return attrs.rel === 'canonical';
    });
    assert.strictEqual(canonicals.length, 1, filename + ' canonical count');
    assert.strictEqual(canonicals[0].href, canonicalFor(filename), filename + ' canonical');

    var meta = findTags(html, 'meta');
    function prop(name) {
      return meta.filter(function (attrs) { return attrs.property === name; });
    }
    ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:image'].forEach(function (name) {
      assert.strictEqual(prop(name).length, 1, filename + ' ' + name);
    });
    assert.strictEqual(prop('og:type')[0].content, 'website', filename + ' og:type');
    assert.strictEqual(prop('og:site_name')[0].content, 'FleetMagnify', filename + ' og:site_name');
    assert.strictEqual(prop('og:title')[0].content, pageTitles[0], filename + ' og:title');
    assert.strictEqual(prop('og:description')[0].content, description, filename + ' og:description');
    assert.strictEqual(prop('og:url')[0].content, canonicalFor(filename), filename + ' og:url');
    assert.strictEqual(prop('og:image')[0].content, HOST + '/images/hero.jpg', filename + ' og:image');

    var card = meta.filter(function (attrs) { return attrs.name === 'twitter:card'; });
    var image = meta.filter(function (attrs) { return attrs.name === 'twitter:image'; });
    assert.strictEqual(card.length, 1, filename + ' twitter:card');
    assert.strictEqual(card[0].content, 'summary_large_image', filename + ' twitter card');
    assert.strictEqual(image.length, 1, filename + ' twitter:image');
    assert.strictEqual(image[0].content, HOST + '/images/hero.jpg', filename + ' twitter image');
    assert.ok(!isSidebarPage(html), filename + ' is a public page with sidebar markup');
  });
  assert.strictEqual(Object.keys(descriptions).length, PUBLIC.length);
  console.log('       hero.jpg ' + hero.width + 'x' + hero.height + ', share card summary_large_image');
});

check('sitemap lists exactly the 14 public pages and no app page', function () {
  var xml = read('sitemap.xml');
  assert.ok(!/<lastmod\b/i.test(xml), 'sitemap has lastmod');
  assert.ok(!/<priority\b/i.test(xml), 'sitemap has priority');
  var locs = [];
  var re = /<loc>\s*([^<]+?)\s*<\/loc>/g;
  var match;
  while ((match = re.exec(xml))) locs.push(match[1]);
  var expected = PUBLIC.map(canonicalFor);
  assert.deepStrictEqual(locs.slice().sort(), expected.slice().sort());
  assert.strictEqual(locs.length, 14);
  locs.forEach(function (loc) {
    assert.ok(loc.indexOf(HOST) === 0, loc);
    if (loc === HOST + '/') {
      assert.ok(fs.existsSync(path.join(root, 'index.html')));
      return;
    }
    var filename = loc.slice((HOST + '/').length);
    assert.ok(fs.existsSync(path.join(root, filename)), filename + ' missing');
    assert.ok(PUBLIC.indexOf(filename) !== -1, filename + ' is not a public page');
  });
  assert.ok(locs.indexOf(HOST + '/index.html') === -1);
});

check('robots.txt allows the site, disallows /api/, and points at the sitemap', function () {
  var text = read('robots.txt');
  var lines = text.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
  assert.ok(lines.indexOf('Sitemap: ' + HOST + '/sitemap.xml') !== -1);
  var disallows = lines.filter(function (line) { return /^disallow:/i.test(line); });
  assert.deepStrictEqual(disallows, ['Disallow: /api/']);
  assert.ok(lines.some(function (line) { return /^allow:\s*\/$/i.test(line); }));
});

check('noindex covers sidebar pages, admin, login, accept-invite, upgrade, and bulk-import only', function () {
  var config = JSON.parse(read('vercel.json'));
  var sidebar = [];
  htmlFiles().forEach(function (filename) {
    if (isSidebarPage(read(filename))) sidebar.push(filename);
  });
  sidebar.sort();
  assert.deepStrictEqual(sidebar, EXPECTED_SIDEBAR);
  console.log('       sidebar pages (' + sidebar.length + '): ' + sidebar.join(', '));
  console.log('       bulk-import.html has no sidebar placeholder or sidebar markup; noindexed as an admin page');

  var must = sidebar.concat(NAMED_PRIVATE).concat(EXTRA_PRIVATE);
  must.forEach(function (filename) {
    assert.ok(hasNoindex(config, '/' + filename), filename + ' is not noindex');
    assert.ok(PUBLIC.indexOf(filename) === -1, filename + ' is both public and private');
  });
  PUBLIC.forEach(function (filename) {
    assert.ok(!hasNoindex(config, '/' + filename), filename + ' is noindex');
  });
  ['/robots.txt', '/sitemap.xml', '/llms.txt', '/', '/index.html'].forEach(function (pathname) {
    assert.ok(!hasNoindex(config, pathname), pathname + ' is noindex');
  });
  htmlFiles().forEach(function (filename) {
    var privatePage = must.indexOf(filename) !== -1;
    var publicPage = PUBLIC.indexOf(filename) !== -1;
    assert.ok(privatePage !== publicPage, filename + ' is neither public nor noindex');
  });
});

check('vercel.json keeps the same functions, crons, redirects, and rewrites', function () {
  var config = JSON.parse(read('vercel.json'));
  assert.deepStrictEqual(config.functions, EXPECTED_VERCEL_ROUTING.functions);
  assert.deepStrictEqual(config.crons, EXPECTED_VERCEL_ROUTING.crons);
  assert.deepStrictEqual(config.redirects, EXPECTED_VERCEL_ROUTING.redirects);
  assert.deepStrictEqual(config.rewrites, EXPECTED_VERCEL_ROUTING.rewrites);
});

check('no HTML file contains aggregateRating, and every JSON-LD block parses', function () {
  htmlFiles().forEach(function (filename) {
    var html = read(filename);
    assert.ok(html.indexOf('aggregateRating') === -1, filename + ' contains aggregateRating');
    jsonLdBlocks(html).forEach(function (block, index) {
      var parsed;
      try {
        parsed = JSON.parse(block);
      } catch (err) {
        throw new Error(filename + ' JSON-LD block ' + index + ' does not parse: ' + err.message);
      }
      assert.ok(parsed && typeof parsed === 'object', filename + ' JSON-LD ' + index);
    });
  });
  var app = jsonLdBlocks(read('index.html')).map(JSON.parse).filter(function (block) {
    return block['@type'] === 'SoftwareApplication';
  });
  assert.strictEqual(app.length, 1);
  assert.strictEqual(app[0].aggregateRating, undefined);
  assert.deepStrictEqual(app[0].offers.map(function (offer) {
    return { name: offer.name, price: offer.price, priceCurrency: offer.priceCurrency };
  }), [
    { name: 'Platform Fee', price: '49.00', priceCurrency: 'NZD' },
    { name: 'Truck Module', price: '8.00', priceCurrency: 'NZD' },
    { name: 'Machine Module', price: '15.00', priceCurrency: 'NZD' }
  ]);
});

check('machine cost FAQ JSON-LD questions and answers are on the page', function () {
  var html = read('machine-operating-cost-per-hour.html');
  var visible = visibleText(html);
  var faqs = jsonLdBlocks(html).map(JSON.parse).filter(function (block) {
    return block['@type'] === 'FAQPage';
  });
  assert.strictEqual(faqs.length, 1);
  var questions = faqs[0].mainEntity;
  assert.strictEqual(questions.length, 4);
  questions.forEach(function (question) {
    assert.ok(visible.indexOf(question.name) !== -1, 'missing question: ' + question.name);
    assert.ok(visible.indexOf(question.acceptedAnswer.text) !== -1, 'missing answer: ' + question.name);
  });
});

check('utilisation FAQ JSON-LD questions and answers are on the page', function () {
  var html = read('fleet-utilisation-rate-formula.html');
  var visible = visibleText(html);
  var faqs = jsonLdBlocks(html).map(JSON.parse).filter(function (block) {
    return block['@type'] === 'FAQPage';
  });
  assert.strictEqual(faqs.length, 1);
  var questions = faqs[0].mainEntity;
  assert.strictEqual(questions.length, 4);
  questions.forEach(function (question) {
    assert.ok(visible.indexOf(question.name) !== -1, 'missing question: ' + question.name);
    assert.ok(visible.indexOf(question.acceptedAnswer.text) !== -1, 'missing answer: ' + question.name);
  });
});

check('pricing FAQ JSON-LD questions and answers are on the page', function () {
  var html = read('pricing.html');
  var visible = visibleText(html);
  var faqs = jsonLdBlocks(html).map(JSON.parse).filter(function (block) {
    return block['@type'] === 'FAQPage';
  });
  assert.strictEqual(faqs.length, 1);
  var questions = faqs[0].mainEntity;
  assert.ok(questions.length >= 6, 'expected the visible pricing questions');
  questions.forEach(function (question) {
    assert.ok(visible.indexOf(question.name) !== -1, 'missing question: ' + question.name);
    assert.ok(visible.indexOf(question.acceptedAnswer.text) !== -1, 'missing answer: ' + question.name);
  });
});

check('middleware matcher excludes robots.txt, sitemap.xml, and llms.txt and nothing else changed', function () {
  var src = read('middleware.mjs');
  var added = '|robots.txt|sitemap.xml|llms.txt';
  assert.strictEqual(src.split(added).length, 2);
  var restored = src.replace(added, '');
  var original = [
    'export const config = {',
    "  matcher: '/((?!api|_next|css|js|images|favicon.ico).*)',",
    "  runtime: 'edge',",
    '};',
    '',
    'export default function middleware(request) {',
    '  var url = new URL(request.url);',
    "  fetch('https://ntfy.sh/fleetmagnify-pings-x7k2p9', {",
    "    method: 'POST',",
    "    body: 'Page view: ' + url.pathname,",
    '  }).catch(function() {});',
    '}',
    ''
  ].join('\n');
  assert.strictEqual(restored, original);
  var look = src.match(/matcher:\s*'\/\(\(\?!([^)]*)\)\.\*\)'/);
  assert.ok(look, 'matcher shape');
  ['robots.txt', 'sitemap.xml', 'llms.txt', 'api'].forEach(function (part) {
    assert.ok(look[1].split('|').indexOf(part) !== -1, part);
  });
});

check('llms.txt links the public pages, states the prices, and does not add John Deere', function () {
  var text = read('llms.txt');
  PUBLIC.forEach(function (filename) {
    assert.ok(text.indexOf(canonicalFor(filename)) !== -1, filename);
  });
  ['$49', '$8', '$15', '$10'].forEach(function (price) {
    assert.ok(text.indexOf(price) !== -1, price);
  });
  assert.ok(text.toLowerCase().indexOf('john deere') === -1);
  assert.ok(text.indexOf('aggregateRating') === -1);
});

function workedPriceExamples(text) {
  var found = [];
  var truckOnly = /(\d+)\s+trucks\s+costs\s+\$(\d+)\/month/gi;
  var match;
  while ((match = truckOnly.exec(text))) {
    found.push({
      trucks: Number(match[1]),
      machines: 0,
      total: Number(match[2]),
      raw: match[0]
    });
  }
  // "10 trucks costs $129" is not the start of a mixed example.
  var mixed = /(\d+)\s+trucks(?!\s+costs)([\s\S]{0,80}?)(\d+)\s+machines([\s\S]{0,40}?)\$(\d+)\/month/gi;
  while ((match = mixed.exec(text))) {
    found.push({
      trucks: Number(match[1]),
      machines: Number(match[3]),
      total: Number(match[5]),
      raw: match[0].replace(/\s+/g, ' ')
    });
  }
  return found;
}

function expectedSubscription(example) {
  return 49 + (8 * example.trucks) + (15 * example.machines);
}

check('worked fleet totals equal $49 plus $8 per truck plus $15 per machine', function () {
  var files = ['index.html', 'pricing.html', 'llms.txt'];
  var all = [];
  files.forEach(function (filename) {
    workedPriceExamples(read(filename)).forEach(function (example) {
      example.file = filename;
      all.push(example);
      assert.strictEqual(
        example.total,
        expectedSubscription(example),
        filename + ' "' + example.raw + '" is $' + example.total +
          ', expected $' + expectedSubscription(example)
      );
    });
  });
  var indexExamples = all.filter(function (example) { return example.file === 'index.html'; });
  assert.deepStrictEqual(indexExamples.map(function (example) {
    return { trucks: example.trucks, machines: example.machines, total: example.total };
  }), [
    { trucks: 10, machines: 0, total: 129 },
    { trucks: 10, machines: 10, total: 279 }
  ]);
  assert.ok(read('index.html').indexOf('$249/month') === -1, 'old $249 mixed-fleet total is still present');
  console.log('       examples: ' + all.map(function (example) {
    return example.file + ' ' + example.trucks + ' trucks + ' + example.machines + ' machines = $' + example.total;
  }).join('; '));
});

check('index.html links the cost calculator from the Resources section', function () {
  var html = read('index.html');
  var start = html.indexOf('<section class="resources" id="resources">');
  var end = html.indexOf('</section>', start);
  assert.ok(start !== -1 && end > start, 'Resources section');
  var section = html.slice(start, end);
  assert.ok(section.indexOf('id="resources"') !== -1, 'resources anchor');
  assert.ok(section.indexOf('href="machine-operating-cost-per-hour.html"') !== -1, 'Resources link');
  assert.ok(section.indexOf('href="fleet-utilisation-rate-formula.html"') !== -1, 'utilisation calculator link');
  assert.ok(html.slice(end).indexOf('href="machine-operating-cost-per-hour.html"') !== -1, 'footer link still present');
});

check('home hero links to the Resources calculators', function () {
  var html = read('index.html');
  var sectionStart = html.indexOf('<section class="resources" id="resources">');
  assert.ok(sectionStart !== -1, 'id="resources" on the resources section');
  var heroLink = '<p class="hero-calc-link"><a href="#resources">Or try our free calculators →</a></p>';
  var heroAt = html.indexOf(heroLink);
  assert.ok(heroAt !== -1, 'link href="#resources" with text Or try our free calculators →');
  assert.ok(heroAt < sectionStart, 'hero link sits above the Resources section');
  var sectionEnd = html.indexOf('</section>', sectionStart);
  var section = html.slice(sectionStart, sectionEnd);
  assert.ok(section.indexOf('href="machine-operating-cost-per-hour.html"') !== -1, 'machine cost calculator link');
  assert.ok(section.indexOf('href="fleet-utilisation-rate-formula.html"') !== -1, 'utilisation calculator link');
});

function navBlocks(html) {
  var blocks = [];
  var re = /<div class="nav-links">([\s\S]*?)<\/div>/g;
  var match;
  while ((match = re.exec(html))) blocks.push(match[1]);
  return blocks;
}

function footerBlock(html) {
  var start = html.indexOf('<footer');
  if (start === -1) return '';
  var end = html.indexOf('</footer>', start);
  return html.slice(start, end === -1 ? html.length : end);
}

// Pages whose nav contained the Glossary link. Features, pricing, platform
// guide, login, signup, and accept-invite have a shorter nav that never
// linked Glossary, so they do not gain a nav item.
var NAV_CALCULATOR_PAGES = [
  'index.html',
  'supported-platforms.html',
  'sample-reports.html',
  'glossary.html',
  'machine-operating-cost-per-hour.html',
  'fleet-utilisation-rate-formula.html',
  'free-calculators.html',
  'contact.html'
];

var FOOTER_CALCULATOR_PAGES = [
  'index.html',
  'features.html',
  'pricing.html',
  'supported-platforms.html',
  'platform-guide.html',
  'sample-reports.html',
  'glossary.html',
  'machine-operating-cost-per-hour.html',
  'fleet-utilisation-rate-formula.html',
  'contact.html',
  'free-calculators.html'
];

check('nav no longer links Glossary and links Free calculators in its place', function () {
  htmlFiles().forEach(function (filename) {
    navBlocks(read(filename)).forEach(function (block) {
      assert.ok(block.indexOf('glossary.html') === -1, filename + ' nav still links glossary.html');
    });
  });
  NAV_CALCULATOR_PAGES.forEach(function (filename) {
    var blocks = navBlocks(read(filename));
    assert.ok(blocks.some(function (block) {
      return block.indexOf('href="free-calculators.html"') !== -1 &&
        block.indexOf('>Free calculators<') !== -1;
    }), filename + ' is missing the Free calculators nav link');
  });
  var freeNav = navBlocks(read('free-calculators.html')).join('\n');
  assert.ok(/href="free-calculators\.html"[^>]*class="active"/.test(freeNav), 'free calculators nav is not active');
});

check('public footers keep Glossary and link Free calculators', function () {
  FOOTER_CALCULATOR_PAGES.forEach(function (filename) {
    var footer = footerBlock(read(filename));
    assert.ok(footer.indexOf('href="glossary.html"') !== -1, filename + ' footer does not link glossary.html');
    assert.ok(footer.indexOf('href="free-calculators.html"') !== -1, filename + ' footer does not link free-calculators.html');
    if (footer.indexOf('Machine cost per hour') !== -1) {
      assert.ok(
        footer.indexOf('href="fleet-utilisation-rate-formula.html"') !== -1,
        filename + ' footer has Machine cost per hour without the utilisation calculator'
      );
    }
  });
});

check('free calculators page lists both calculators and has no JSON-LD', function () {
  var html = read('free-calculators.html');
  assert.ok(html.indexOf('href="machine-operating-cost-per-hour.html"') !== -1, 'cost calculator link');
  assert.ok(html.indexOf('Open the cost per hour calculator') !== -1, 'cost calculator link text');
  assert.ok(html.indexOf('href="fleet-utilisation-rate-formula.html"') !== -1, 'utilisation calculator link');
  assert.ok(html.indexOf('Open the utilisation rate calculator') !== -1, 'utilisation calculator link text');
  assert.ok(html.indexOf('href="glossary.html"') !== -1, 'glossary link');
  assert.ok(html.indexOf('application/ld+json') === -1, 'JSON-LD present');
  assert.ok(html.indexOf('FAQPage') === -1, 'FAQ structured data present');
  assert.ok(html.indexOf('<h1>Free calculators</h1>') !== -1, 'h1');
  assert.ok(html.indexOf("Start a 30-day trial. We'll take a card now — you won't be charged until day 31, after you've set up your fleet.") !== -1, 'trial wording');
});

check('npm test runs this script', function () {
  var pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts.test.indexOf('node scripts/test-seo-basics.js') !== -1);
});

check('sample reports page does not overstate that figures are not estimated', function () {
  var html = read('sample-reports.html');
  assert.strictEqual(titles(html)[0], 'Sample fleet cost reports | FleetMagnify');
  assert.ok(html.indexOf('not estimated') === -1, 'sample-reports.html still says not estimated');
  assert.ok(
    html.indexOf('Figures are calculated from your telematics and fuel data plus the asset details you enter, such as purchase price and payload.') !== -1,
    'replacement sentence'
  );
  assert.ok(
    html.indexOf('2.680680605 kg CO2-e per litre') !== -1,
    'emission factor still present'
  );
  var withoutNav = html.replace(/<nav\b[\s\S]*?<\/nav>/gi, '');
  var body = withoutNav.replace(/<footer\b[\s\S]*?<\/footer>/gi, '');
  var paragraph = 'Want to try the numbers yourself first? Use the <a href="machine-operating-cost-per-hour.html">machine cost per hour calculator</a> or the <a href="fleet-utilisation-rate-formula.html">fleet utilisation rate calculator</a>. They are free and need no sign-in.';
  assert.ok(body.indexOf(paragraph) !== -1, 'calculator paragraph in the body');
  assert.ok(body.indexOf('href="machine-operating-cost-per-hour.html"') !== -1, 'cost calculator link outside nav and footer');
  assert.ok(body.indexOf('href="fleet-utilisation-rate-formula.html"') !== -1, 'utilisation calculator link outside nav and footer');
});

check('public pages do not claim ESG, regulatory or government-standard compliance', function () {
  var banned = [
    'suitable for ESG',
    'ESG disclosure',
    'regulatory obligations',
    'ESG ready',
    'ready for ESG',
    'ESG and',
    'NZ government standards',
    'compliance and ESG'
  ];
  ['index.html', 'features.html', 'platform-guide.html'].forEach(function (filename) {
    var html = read(filename);
    banned.forEach(function (phrase) {
      assert.ok(html.indexOf(phrase) === -1, filename + ' still contains ' + phrase);
    });
  });
  var faqs = jsonLdBlocks(read('index.html')).map(JSON.parse).filter(function (block) {
    return block['@type'] === 'FAQPage';
  });
  assert.strictEqual(faqs.length, 1, 'index FAQ JSON-LD');
  var emissions = faqs[0].mainEntity.filter(function (question) {
    return question.name === 'How are emissions calculated in FleetMagnify?';
  });
  assert.strictEqual(emissions.length, 1, 'emissions FAQ question');
  assert.ok(emissions[0].acceptedAnswer.text.indexOf('2.680680605') !== -1, 'emission factor in FAQ answer');
});

check('all page titles are unique', function () {
  var seen = {};
  htmlFiles().forEach(function (filename) {
    var pageTitles = titles(read(filename));
    assert.strictEqual(pageTitles.length, 1, filename + ' title count');
    var title = pageTitles[0];
    assert.ok(!seen[title], title + ' is used by ' + seen[title] + ' and ' + filename);
    seen[title] = filename;
  });
});

if (!pass) process.exit(1);
console.log('All SEO basics checks passed.');
