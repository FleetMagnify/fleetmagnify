/**
 * Contact us box: widget submissions, the unchanged full contact form,
 * and which public pages load the script.
 *
 *   node scripts/test-contact-widget.js
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
var handler = require('../api/contact-form');
var HOUR = 60 * 60 * 1000;
var DAY = 24 * HOUR;
var IP = '203.0.113.55';
var OTHER_IP = '198.51.100.20';
var TAG = '<script defer src="js/contact-widget.js"></script>';
var WIDGET_PAGES = [
  'index.html',
  'features.html',
  'pricing.html',
  'supported-platforms.html',
  'platform-guide.html',
  'sample-reports.html',
  'glossary.html',
  'free-calculators.html',
  'machine-operating-cost-per-hour.html',
  'fleet-utilisation-rate-formula.html',
  'privacy-policy.html',
  'terms-of-service.html'
];

var previousKey = process.env.RESEND_API_KEY;
process.env.RESEND_API_KEY = 'test-resend-key';

function read(name) {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

function htmlFiles() {
  return fs.readdirSync(root).filter(function (name) {
    return name.endsWith('.html');
  }).sort();
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status: function (code) { this.statusCode = code; return this; },
    json: function (body) { this.body = body; return this; }
  };
}

function begin() {
  handler.resetRateLimit();
  handler.setNow(function () { return 1700000000000; });
}

function widgetBody(extra) {
  var body = {
    source: 'widget',
    email: 'ada@example.com',
    message: 'Hello from the widget',
    name: '',
    page: '/pricing.html',
    elapsed: 5000,
    website: ''
  };
  if (!extra) return body;
  Object.keys(extra).forEach(function (key) {
    if (extra[key] === undefined) delete body[key];
    else body[key] = extra[key];
  });
  return body;
}

function fullForm(extra) {
  var body = {
    name: 'Ada',
    company: 'North Haul',
    email: 'ada@example.com',
    fleetSize: '10 to 50',
    message: 'We run a mixed fleet.'
  };
  if (!extra) return body;
  Object.keys(extra).forEach(function (key) {
    if (extra[key] === undefined) delete body[key];
    else body[key] = extra[key];
  });
  return body;
}

function run(body, headers, fetchImpl) {
  var logs = [];
  var fetches = [];
  var origLog = console.log;
  var origErr = console.error;
  var origFetch = global.fetch;
  console.log = function () { logs.push([].join.call(arguments, ' ')); };
  console.error = function () { logs.push([].join.call(arguments, ' ')); };
  global.fetch = function (url, opts) {
    fetches.push({ url: url, opts: opts });
    if (fetchImpl) return fetchImpl(url, opts);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () { return Promise.resolve({ id: 'email_test_1' }); }
    });
  };
  var res = mockRes();
  return handler({
    method: 'POST',
    headers: headers || { 'user-agent': 'widget-test', 'x-forwarded-for': IP },
    body: body
  }, res).then(function () {
    console.log = origLog;
    console.error = origErr;
    global.fetch = origFetch;
    return { res: res, logs: logs.join('\n'), fetches: fetches };
  }, function (err) {
    console.log = origLog;
    console.error = origErr;
    global.fetch = origFetch;
    throw err;
  });
}

function emailOf(result) {
  assert.strictEqual(result.fetches.length, 1);
  assert.strictEqual(result.fetches[0].url, 'https://api.resend.com/emails');
  var payload = JSON.parse(result.fetches[0].opts.body);
  assert.strictEqual(payload.from, 'alerts@fleetmagnify.com');
  assert.strictEqual(payload.to, 'support@fleetmagnify.com');
  assert.strictEqual(result.fetches[0].opts.headers.Authorization, 'Bearer test-resend-key');
  return payload;
}

function assertNoAddress(text, label) {
  assert.ok(String(text).indexOf(IP) === -1, label + ' contains the client address');
  assert.ok(String(text).indexOf(OTHER_IP) === -1, label + ' contains the forwarded address');
}

var steps = [];
function check(label, fn) {
  steps.push({ label: label, fn: fn });
}

check('widget accepts email and message with no name or company', function () {
  begin();
  return run(widgetBody({ name: undefined, company: undefined, fleetSize: undefined })).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200);
    assert.strictEqual(result.res.body.ok, true);
    assert.strictEqual(result.res.body.id, 'email_test_1');
    var email = emailOf(result);
    assert.strictEqual(email.reply_to, 'ada@example.com');
    assert.strictEqual(email.subject, 'Website message: example.com');
    assert.ok(email.html.indexOf('<strong>Name:</strong> (not given)') !== -1);
    assert.ok(email.html.indexOf('<strong>Company:</strong> (not given)') !== -1);
    assert.ok(email.html.indexOf('<strong>Fleet size:</strong> (not given)') !== -1);
    assert.ok(email.html.indexOf('<strong>Page:</strong> /pricing.html') !== -1);
    assert.ok(email.html.indexOf('Hello from the widget') !== -1);
    assertNoAddress(email.html, 'email');
    assertNoAddress(email.subject, 'subject');
    assertNoAddress(result.logs, 'logs');
  });
});

check('widget uses the name in the subject when it is given', function () {
  begin();
  return run(widgetBody({ name: 'Alex', company: 'Haul Co' })).then(function (result) {
    var email = emailOf(result);
    assert.strictEqual(email.subject, 'Website message: Alex');
    assert.ok(email.html.indexOf('<strong>Name:</strong> Alex') !== -1);
    assert.ok(email.html.indexOf('<strong>Company:</strong> Haul Co') !== -1);
    assert.ok(email.html.indexOf('(not given)') !== -1);
  });
});

check('widget rejects an invalid email and an empty message', function () {
  begin();
  return run(widgetBody({ email: 'not-an-email' })).then(function (result) {
    assert.strictEqual(result.res.statusCode, 400);
    assert.strictEqual(result.res.body.error, 'A valid email address is required');
    assert.strictEqual(result.fetches.length, 0);
    return run(widgetBody({ message: '   ' }));
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 400);
    assert.strictEqual(result.res.body.error, 'A valid email address and a message are required');
    assert.strictEqual(result.fetches.length, 0);
  });
});

check('widget rejects a message over 2000 characters and a name over 200', function () {
  begin();
  return run(widgetBody({ message: new Array(2002).join('a') })).then(function (result) {
    assert.strictEqual(result.res.statusCode, 400);
    assert.strictEqual(result.res.body.error, 'One or more fields exceed the maximum length');
    assert.strictEqual(result.fetches.length, 0);
    return run(widgetBody({ message: 'Hello from the widget', name: new Array(202).join('n') }));
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 400);
    assert.strictEqual(result.fetches.length, 0);
    return run(widgetBody({ message: new Array(2001).join('c'), name: new Array(201).join('n') }));
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200);
    assert.strictEqual(emailOf(result).html.indexOf(new Array(2001).join('c')) !== -1, true);
  });
});

check('honeypot, fast elapsed, and missing elapsed are dropped with no email', function () {
  begin();
  return run(widgetBody({ website: 'https://spam.example' })).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200);
    assert.deepStrictEqual(result.res.body, { ok: true });
    assert.strictEqual(result.fetches.length, 0);
    assert.ok(result.logs.indexOf('dropped honeypot submission') !== -1);
    return run(widgetBody({ elapsed: 1999 }));
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200);
    assert.deepStrictEqual(result.res.body, { ok: true });
    assert.strictEqual(result.fetches.length, 0);
    assert.ok(result.logs.indexOf('dropped widget submission') !== -1);
    return run(widgetBody({ elapsed: undefined }));
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200);
    assert.strictEqual(result.fetches.length, 0);
    return run(widgetBody({ elapsed: '5000' }));
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200);
    assert.strictEqual(result.fetches.length, 0);
    return run(widgetBody({ elapsed: 2000 }));
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200);
    assert.strictEqual(result.fetches.length, 1);
  });
});

check('more than three links is dropped and three links are delivered', function () {
  begin();
  var three = 'See http://a.example https://b.example and WWW.c.example';
  var four = three + ' plus http://d.example';
  return run(widgetBody({ message: four })).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200);
    assert.deepStrictEqual(result.res.body, { ok: true });
    assert.strictEqual(result.fetches.length, 0);
    return run(widgetBody({ message: three }));
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200);
    assert.ok(emailOf(result).html.indexOf('WWW.c.example') !== -1);
  });
});

check('widget rate limits return 429 and old entries expire', function () {
  begin();
  var headers = { 'user-agent': 'rate-a', 'x-forwarded-for': IP + ', ' + OTHER_IP };
  function once() {
    return run(widgetBody(), headers);
  }
  return once().then(function (result) {
    assert.strictEqual(result.res.statusCode, 200);
    assertNoAddress(result.logs, 'logs');
    assertNoAddress(emailOf(result).html, 'email');
    return once();
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200);
    return once();
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200);
    return once();
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 429);
    assert.deepStrictEqual(result.res.body, {
      error: 'Too many messages. Please email support@fleetmagnify.com.'
    });
    assert.strictEqual(result.fetches.length, 0);
    assertNoAddress(result.logs, '429 logs');
    return run(widgetBody(), { 'user-agent': 'rate-b', 'x-forwarded-for': IP });
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200, 'a different browser is a different key');
    handler.setNow(function () { return 1700000000000 + HOUR + 1; });
    return once();
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200, 'hour window expired');
    var clock = { t: 1700000000000 };
    handler.resetRateLimit();
    handler.setNow(function () { return clock.t; });
    var chain = Promise.resolve();
    [3, 3, 3, 1].forEach(function (count, index) {
      chain = chain.then(function () {
        clock.t = 1700000000000 + index * (HOUR + 1);
        var inner = Promise.resolve();
        for (var n = 0; n < count; n++) {
          inner = inner.then(once).then(function (sent) {
            assert.strictEqual(sent.res.statusCode, 200);
          });
        }
        return inner;
      });
    });
    return chain.then(once).then(function (result) {
      assert.strictEqual(result.res.statusCode, 429, 'day cap');
      clock.t = 1700000000000 + 3 * (HOUR + 1) + HOUR;
      return once();
    }).then(function (result) {
      assert.strictEqual(result.res.statusCode, 429, 'day cap holds after the hour clears');
      clock.t = 1700000000000 + DAY + 1;
      return once();
    }).then(function (result) {
      assert.strictEqual(result.res.statusCode, 200, 'day window expired');
    });
  });
});

check('global cap is 40 widget messages an hour and then expires', function () {
  begin();
  var chain = Promise.resolve();
  for (var i = 0; i < 40; i++) {
    (function (n) {
      chain = chain.then(function () {
        return run(widgetBody(), {
          'user-agent': 'global-' + n,
          'x-forwarded-for': '198.51.100.' + (n + 1)
        });
      }).then(function (result) {
        assert.strictEqual(result.res.statusCode, 200, 'global send ' + n);
      });
    })(i);
  }
  return chain.then(function () {
    return run(widgetBody(), { 'user-agent': 'global-extra', 'x-forwarded-for': '198.51.100.250' });
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 429);
    assert.strictEqual(result.fetches.length, 0);
    handler.setNow(function () { return 1700000000000 + HOUR + 1; });
    return run(widgetBody(), { 'user-agent': 'global-extra', 'x-forwarded-for': '198.51.100.250' });
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200);
  });
});

check('old rate-limit entries are pruned', function () {
  begin();
  return run(widgetBody(), { 'user-agent': 'old-browser', 'x-forwarded-for': IP }).then(function () {
    handler.setNow(function () { return 1700000000000 + DAY + HOUR; });
    return run(widgetBody(), { 'user-agent': 'new-browser', 'x-forwarded-for': OTHER_IP });
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200);
    assert.deepStrictEqual(handler.rateLimitSize(), { keys: 1, global: 1 });
    assertNoAddress(result.logs, 'logs');
  });
});

check('unsafe page paths are replaced and safe paths are escaped', function () {
  begin();
  var bad = ['https://evil.example', '//evil.example', '/bad path', '/say"hi"', 'pricing.html'];
  var chain = Promise.resolve();
  bad.forEach(function (page) {
    chain = chain.then(function () {
      handler.resetRateLimit();
      return run(widgetBody({ page: page })).then(function (result) {
        var html = emailOf(result).html;
        assert.ok(html.indexOf('<strong>Page:</strong> (unknown)') !== -1, page);
        assert.ok(html.indexOf('evil.example') === -1, page);
        assert.ok(html.indexOf('bad path') === -1, page);
        assert.ok(html.indexOf('say"hi"') === -1, page);
      });
    });
  });
  return chain.then(function () {
    handler.resetRateLimit();
    return run(widgetBody({
      name: 'Ann <b>& "O\'Reilly"',
      message: 'Line 1 <script>\nLine 2',
      page: '/a&b'
    }));
  }).then(function (result) {
    var email = emailOf(result);
    assert.strictEqual(email.subject, 'Website message: Ann <b>& "O\'Reilly"');
    assert.ok(email.html.indexOf('Ann &lt;b&gt;&amp; &quot;O&#39;Reilly&quot;') !== -1, email.html);
    assert.ok(email.html.indexOf('<b>') === -1, email.html);
    assert.ok(email.html.indexOf('Line 1 &lt;script&gt;<br>Line 2') !== -1, email.html);
    assert.ok(email.html.indexOf('<script>') === -1, email.html);
    assert.ok(email.html.indexOf('/a&amp;b') !== -1, email.html);
  });
});

check('a Resend failure returns the existing message', function () {
  begin();
  return run(widgetBody(), null, function () {
    return Promise.resolve({
      ok: false,
      status: 422,
      json: function () { return Promise.resolve({ message: 'rejected' }); }
    });
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 500);
    assert.strictEqual(result.res.body.error, 'Could not send your message. Please email support@fleetmagnify.com.');
    return run(widgetBody(), null, function () {
      return Promise.reject(new Error('network down'));
    });
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 500);
    assert.strictEqual(result.res.body.error, 'Could not send your message. Please email support@fleetmagnify.com.');
    delete process.env.RESEND_API_KEY;
    return run(widgetBody());
  }).then(function (result) {
    process.env.RESEND_API_KEY = 'test-resend-key';
    assert.strictEqual(result.res.statusCode, 500);
    assert.strictEqual(result.res.body.error, 'Could not send your message. Please email support@fleetmagnify.com.');
    assert.strictEqual(result.fetches.length, 0);
  });
});

check('the original contact form still requires every field and sends as before', function () {
  begin();
  return run(fullForm()).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200);
    assert.strictEqual(result.res.body.id, 'email_test_1');
    var email = emailOf(result);
    assert.strictEqual(email.subject, 'Contact form: Ada / North Haul');
    assert.strictEqual(email.reply_to, 'ada@example.com');
    assert.ok(email.html.indexOf('<strong>New contact form submission</strong>') !== -1);
    assert.ok(email.html.indexOf('<strong>Name:</strong> Ada') !== -1);
    assert.ok(email.html.indexOf('<strong>Company:</strong> North Haul') !== -1);
    assert.ok(email.html.indexOf('<strong>Fleet size:</strong> 10 to 50') !== -1);
    assert.ok(email.html.indexOf('We run a mixed fleet.') !== -1);
    assert.ok(email.html.indexOf('Page:') === -1);
    assert.ok(email.html.indexOf('(not given)') === -1);
    return run(fullForm({ fleetSize: undefined }));
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 400);
    assert.strictEqual(result.res.body.error, 'Name, company, email, fleet size, and message are required');
    assert.strictEqual(result.fetches.length, 0);
    return run(fullForm({ email: 'ada@' }));
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 400);
    assert.strictEqual(result.res.body.error, 'A valid email address is required');
    return run(fullForm({ fleetSize: 'About 12' }));
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 400);
    assert.strictEqual(result.res.body.error, 'Please select a valid fleet size');
    return run(fullForm({ message: new Array(5002).join('m') }));
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 400);
    assert.strictEqual(result.res.body.error, 'One or more fields exceed the maximum length');
    return run(fullForm({ message: new Array(5001).join('m'), website: '' }));
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200);
    assert.strictEqual(result.fetches.length, 1, 'a 5000 character contact-form message still sends');
    return run(fullForm({ website: 'filled-by-a-bot' }));
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200);
    assert.deepStrictEqual(result.res.body, { ok: true });
    assert.strictEqual(result.fetches.length, 0);
    return run(fullForm({ company_website: 'also-a-bot' }));
  }).then(function (result) {
    assert.strictEqual(result.fetches.length, 0);
    var chain = Promise.resolve();
    for (var i = 0; i < 11; i++) chain = chain.then(function () { return run(fullForm()); });
    return chain;
  }).then(function (result) {
    assert.strictEqual(result.res.statusCode, 200, 'the full form is not rate limited');
    assert.strictEqual(result.fetches.length, 1);
  });
});

check('the widget script is on the public pages and nowhere else', function () {
  var seen = {};
  htmlFiles().forEach(function (filename) {
    var html = read(filename);
    var count = html.split(TAG).length - 1;
    if (WIDGET_PAGES.indexOf(filename) !== -1) {
      assert.strictEqual(count, 1, filename);
      assert.ok(new RegExp(TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*</body>').test(html), filename + ' script is just before </body>');
      seen[filename] = true;
    } else {
      assert.strictEqual(count, 0, filename + ' should not load the widget');
    }
  });
  WIDGET_PAGES.forEach(function (filename) {
    assert.ok(seen[filename], filename + ' is missing');
  });
  assert.ok(read('contact.html').indexOf('id="contact-form"') !== -1);
});

check('the widget script stays small and does not collect storage or call other origins', function () {
  var source = read('js/contact-widget.js');
  assert.ok(source.length < 8192, 'widget is ' + source.length + ' bytes');
  assert.ok(source.indexOf('http://') === -1);
  assert.ok(source.indexOf('https://') === -1);
  assert.ok(source.indexOf('privacy-policy.html') !== -1);
  assert.ok(source.indexOf('mailto:support@fleetmagnify.com') !== -1);
  assert.ok(source.indexOf("fetch('/api/contact-form'") !== -1);
  assert.ok(source.indexOf('localStorage') === -1);
  assert.ok(source.indexOf('sessionStorage') === -1);
  assert.ok(source.indexOf('document.cookie') === -1);
  assert.ok(source.indexOf('XMLHttpRequest') === -1);
  assert.ok(source.indexOf('sendBeacon') === -1);
  assert.ok(source.indexOf('WebSocket') === -1);
  assert.ok(!/\bchat\b/i.test(source));
  var pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts.test.indexOf('node scripts/test-contact-widget.js') !== -1);
});

steps.reduce(function (chain, step) {
  return chain.then(function () {
    return Promise.resolve().then(step.fn).then(function () {
      console.log('[PASS] ' + step.label);
    });
  });
}, Promise.resolve()).then(function () {
  if (previousKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = previousKey;
  console.log('\nAll contact widget tests passed.');
}).catch(function (err) {
  if (previousKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = previousKey;
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
