/**
 * VisionLink email download links.
 * Run: node scripts/test-email-report-link.js
 *
 * Uses a fake token and a mocked fetch. No real link is requested.
 */
var assert = require('assert');
var links = require('../parsers/email-report-link');
var inbound = require('../api/email-inbound');

var TOKEN = 'FAKETOKEN';
var LINK = 'https://vl.cat.com/downloadreport?token=' + TOKEN;
var ONE_DAY_NAME = 'Fleet_Utilization_27-10-2026_27-10-2026_27-10-2026.csv';
var MULTI_DAY_NAME = 'Fleet_Utilization_08-17-2026_08-23-2026_08-24-2026.csv';
var USER = '00000000-0000-4000-8000-0000000000a1';

var UTIL_HEADER = [
  'Callouts', 'Asset ID', 'Asset Serial Number', 'Make', 'Model',
  'Hour Meter (Hours)', 'Hour Meter Last Reported Time', 'Latest Utilization Report',
  'Timezone Offset', 'Time Zone', 'Timezone Display Name',
  'Runtime (Hours)', 'Idle Time (Hours)', 'Working Time (Hours)', 'Idle %',
  'Total Fuel Burned (L)', 'Total Fuel Burn Rate (L/Hour)',
].join(',');

// Row timestamps are 28 Oct. A one-day filename of 27 Oct must win.
var UTIL_CSV = [
  UTIL_HEADER,
  ',EQ000001,AAA00001,CAT,320,100,2026-10-28T10:00:00Z,2026-10-28T10:00:00Z,+13:00,Pacific/Auckland,NZDT,4,1,3,25,10,2.5',
].join('\n');

function captureConsole() {
  var lines = [];
  var origLog = console.log;
  var origWarn = console.warn;
  var origError = console.error;
  function push(args) { lines.push(Array.prototype.slice.call(args).join(' ')); }
  console.log = function() { push(arguments); origLog.apply(console, arguments); };
  console.warn = function() { push(arguments); origWarn.apply(console, arguments); };
  console.error = function() { push(arguments); origError.apply(console, arguments); };
  return {
    lines: lines,
    text: function() { return lines.join('\n'); },
    restore: function() {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

function assertNoSecret(text) {
  assert.strictEqual(text.indexOf(TOKEN) === -1, true, 'logged or stored the token');
  assert.strictEqual(text.indexOf('https://vl.cat.com') === -1, true, 'logged the full download URL');
  assert.strictEqual(text.indexOf('token=') === -1, true, 'logged a token query');
}

function csvResponse(body, headers, status) {
  return new Response(body, {
    status: status || 200,
    headers: headers || { 'content-type': 'text/csv' },
  });
}

function redirectResponse(location) {
  return new Response(null, {
    status: 302,
    headers: { location: location },
  });
}

async function expectReject(promise, needle) {
  var failed = false;
  try {
    await promise;
  } catch (err) {
    failed = true;
    assert.ok(err.message.indexOf(needle) !== -1, err.message + ' (expected ' + needle + ')');
    assertNoSecret(err.message);
  }
  assert.strictEqual(failed, true, 'expected rejection containing ' + needle);
}

function testExtraction() {
  console.log('\n=== Link extraction ===');
  var html = '<p><a href="https://vl.cat.com/downloadreport?token=' + TOKEN + '&amp;lang=en">Download Report</a></p>';
  var fromHtml = links.extractVisionLinkReportLinks(html, '');
  assert.strictEqual(fromHtml.length, 1);
  var parsed = new URL(fromHtml[0]);
  assert.strictEqual(parsed.hostname, 'vl.cat.com');
  assert.strictEqual(parsed.pathname, '/downloadreport');
  assert.strictEqual(parsed.searchParams.get('token'), TOKEN);
  assert.strictEqual(parsed.searchParams.get('lang'), 'en');

  var fromText = links.extractVisionLinkReportLinks('', 'Download Report ' + LINK + ' active for 30 days.');
  assert.strictEqual(fromText.length, 1);
  assert.strictEqual(new URL(fromText[0]).searchParams.get('token'), TOKEN);

  var both = links.extractVisionLinkReportLinks(html, LINK + '&lang=en');
  assert.strictEqual(both.length, 1, 'html and text copies of the same link dedupe');

  var noise = [
    'http://vl.cat.com/downloadreport?token=' + TOKEN,
    'https://evil.example/downloadreport?token=' + TOKEN,
    'https://vl.cat.com.evil.com/downloadreport?token=' + TOKEN,
    'https://vl.cat.com@evil.com/downloadreport?token=' + TOKEN,
    'https://user:pass@vl.cat.com/downloadreport?token=' + TOKEN,
    'https://vl.cat.com/other?token=' + TOKEN,
    'https://vl.cat.com/downloadreport',
    'https://vl.cat.com/downloadreport?token=',
    'https://vl.cat.com:8443/downloadreport?token=' + TOKEN,
    LINK,
  ].join('\n');
  var kept = links.extractVisionLinkReportLinks(noise, '');
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(new URL(kept[0]).searchParams.get('token'), TOKEN);

  var many = [1, 2, 3, 4].map(function(n) {
    return '<a href="https://vl.cat.com/downloadreport?token=TOKEN' + n + '">Download Report</a>';
  }).join('');
  var capped = links.extractVisionLinkReportLinks(many, '');
  assert.strictEqual(capped.length, 3);
  assert.strictEqual(new URL(capped[2]).searchParams.get('token'), 'TOKEN3');
  console.log('✓ html entity, plain text, dedupe, rejects, and cap of 3');
}

function testFilenameAndFetch() {
  console.log('\n=== Download fetch ===');
  var original = global.fetch;
  var cap = captureConsole();
  var calls = [];
  global.fetch = function(url, opts) {
    calls.push({ url: String(url), opts: opts });
    return Promise.resolve(csvResponse('asset,hours\nEQ000001,1\n', {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="' + ONE_DAY_NAME + '"',
    }));
  };
  return links.fetchReportFromLink(LINK).then(function(result) {
    assert.strictEqual(calls[0].opts.redirect, 'manual');
    assert.strictEqual(calls[0].opts.method, 'GET');
    assert.strictEqual(result.filename, ONE_DAY_NAME);
    assert.strictEqual(result.mimeType, 'text/csv');
    assert.strictEqual(result.finalHost, 'vl.cat.com');
    assert.strictEqual(result.buffer.toString('utf8').indexOf('EQ000001') !== -1, true);
    assertNoSecret(cap.text());
    assert.ok(cap.text().indexOf('vl.cat.com/downloadreport') !== -1);
    assert.ok(cap.text().indexOf('final host vl.cat.com') !== -1);

    global.fetch = function() {
      return Promise.resolve(csvResponse('a,b\n', {
        'content-type': 'text/csv',
        'content-disposition': "attachment; filename=\"other.csv\"; filename*=UTF-8''Fleet%5FUtilization%5F27-10-2026%5F27-10-2026%5F27-10-2026.csv",
      }));
    };
    return links.fetchReportFromLink(LINK);
  }).then(function(result) {
    assert.strictEqual(result.filename, ONE_DAY_NAME);

    global.fetch = function() {
      return Promise.resolve(csvResponse('a,b\n1,2\n', { 'content-type': 'text/csv' }));
    };
    return links.fetchReportFromLink(LINK);
  }).then(function(result) {
    assert.strictEqual(result.filename, null);
    assert.strictEqual(result.buffer.toString('utf8'), 'a,b\n1,2\n');

    global.fetch = function() {
      return Promise.resolve(csvResponse('a,b\n', {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="reports/' + ONE_DAY_NAME + '"',
      }));
    };
    return links.fetchReportFromLink(LINK);
  }).then(function(result) {
    assert.strictEqual(result.filename, ONE_DAY_NAME);
    console.log('✓ filename, filename*, missing filename, path stripped');

    var hops = 0;
    global.fetch = function(url) {
      hops += 1;
      if (hops === 1) return Promise.resolve(redirectResponse('https://files.cat.com/reports/' + ONE_DAY_NAME));
      assert.strictEqual(new URL(String(url)).hostname, 'files.cat.com');
      return Promise.resolve(csvResponse('asset,hours\n', {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="' + ONE_DAY_NAME + '"',
      }));
    };
    return links.fetchReportFromLink(LINK);
  }).then(function(result) {
    assert.strictEqual(result.finalHost, 'files.cat.com');
    assert.strictEqual(result.filename, ONE_DAY_NAME);
    console.log('✓ redirect to an allowed host is followed');

    return expectReject(
      (global.fetch = function() {
        return Promise.resolve(redirectResponse('https://evil.example/report.csv'));
      }, links.fetchReportFromLink(LINK)),
      'redirect host not allowed'
    );
  }).then(function() {
    return expectReject(
      (global.fetch = function() {
        return Promise.resolve(redirectResponse('https://203.0.113.10/report.csv'));
      }, links.fetchReportFromLink(LINK)),
      'redirect host not allowed'
    );
  }).then(function() {
    return expectReject(
      (global.fetch = function() {
        return Promise.resolve(redirectResponse('https://localhost/report.csv'));
      }, links.fetchReportFromLink(LINK)),
      'redirect host not allowed'
    );
  }).then(function() {
    return expectReject(
      (global.fetch = function() {
        return Promise.resolve(redirectResponse('http://files.cat.com/report.csv'));
      }, links.fetchReportFromLink(LINK)),
      'redirect was not https'
    );
  }).then(function() {
    var n = 0;
    global.fetch = function() {
      n += 1;
      if (n > 4) throw new Error('followed a fourth redirect');
      return Promise.resolve(redirectResponse('https://downloads.cat.com/step' + n));
    };
    return expectReject(links.fetchReportFromLink(LINK), 'too many redirects').then(function() {
      assert.strictEqual(n, 4);
    });
  }).then(function() {
    var step = 0;
    global.fetch = function() {
      step += 1;
      if (step === 1) return Promise.resolve(redirectResponse('https://data.caterpillar.com/report.csv'));
      return Promise.resolve(csvResponse('a,b\n', { 'content-type': 'text/csv' }));
    };
    return links.fetchReportFromLink(LINK);
  }).then(function(result) {
    assert.strictEqual(result.finalHost, 'data.caterpillar.com');
    var step = 0;
    global.fetch = function() {
      step += 1;
      if (step === 1) return Promise.resolve(redirectResponse('https://bucket.s3.amazonaws.com/report.csv'));
      return Promise.resolve(csvResponse('a,b\n', { 'content-type': 'text/csv' }));
    };
    return links.fetchReportFromLink(LINK);
  }).then(function(result) {
    assert.strictEqual(result.finalHost, 'bucket.s3.amazonaws.com');
    console.log('✓ refused evil, IP, localhost, http, and a 4th redirect');

    global.fetch = function() {
      return Promise.resolve(csvResponse('<html>login</html>', {
        'content-type': 'text/html; charset=utf-8',
      }));
    };
    return expectReject(links.fetchReportFromLink(LINK), 'HTML page');
  }).then(function() {
    global.fetch = function() {
      return Promise.resolve(csvResponse('<!DOCTYPE html><html></html>', {
        'content-type': 'text/plain',
      }));
    };
    return expectReject(links.fetchReportFromLink(LINK), 'HTML page');
  }).then(function() {
    global.fetch = function() {
      return Promise.resolve(csvResponse('x', {
        'content-type': 'text/csv',
        'content-length': String(links.MAX_BYTES + 1),
      }));
    };
    return expectReject(links.fetchReportFromLink(LINK), 'exceeded 5 MB');
  }).then(function() {
    var { ReadableStream } = require('stream/web');
    var big = new Uint8Array(links.MAX_BYTES + 1);
    big.fill(97);
    global.fetch = function() {
      var stream = new ReadableStream({
        start: function(controller) {
          controller.enqueue(big);
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      }));
    };
    return expectReject(links.fetchReportFromLink(LINK), 'exceeded 5 MB');
  }).then(function() {
    global.fetch = function() {
      return Promise.resolve(csvResponse('nope', { 'content-type': 'text/plain' }, 502));
    };
    return expectReject(links.fetchReportFromLink(LINK), 'HTTP 502');
  }).then(function() {
    global.fetch = function(url, opts) {
      return new Promise(function(resolve, reject) {
        var signal = opts && opts.signal;
        function abort() {
          var err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        }
        if (signal && signal.aborted) return abort();
        if (signal) signal.addEventListener('abort', abort);
      });
    };
    return expectReject(links.fetchReportFromLink(LINK, { timeoutMs: 30 }), 'timed out');
  }).then(function() {
    global.fetch = function() {
      return Promise.resolve(csvResponse('PK', {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="Fleet_Fuel_2026-10-28.xlsx"',
      }));
    };
    return links.fetchReportFromLink(LINK).then(function() {
      throw new Error('xlsx should have failed');
    }, function(err) {
      assert.strictEqual(err.message, 'link served an Excel file; only CSV is supported for link downloads');
      assert.strictEqual(err.reportFilename, 'Fleet_Fuel_2026-10-28.xlsx');
      assertNoSecret(cap.text());
      console.log('✓ html, size, status, timeout, and xlsx rejected');
    });
  }).then(function() {
    cap.restore();
    global.fetch = original;
  }, function(err) {
    cap.restore();
    global.fetch = original;
    throw err;
  });
}

function createInboundMock() {
  var state = { inserts: [], updates: [], upserts: [] };
  var nextId = 1;
  function supabaseFrom(table) {
    return {
      select: function() {
        var chain = {
          eq: function() { return chain; },
          in: function() { return chain; },
          order: function() { return chain; },
          limit: function() { return chain; },
          maybeSingle: function() {
            return Promise.resolve(read(table));
          },
          single: function() {
            return Promise.resolve(read(table));
          },
          then: function(resolve) { resolve(read(table)); },
        };
        return chain;
      },
      insert: function(row) {
        state.inserts.push({ table: table, row: row });
        return {
          select: function() {
            return {
              single: function() {
                return Promise.resolve({ data: { id: nextId++ }, error: null });
              },
            };
          },
        };
      },
      update: function(payload) {
        var filters = [];
        var chain = {
          eq: function(col, val) {
            filters.push({ col: col, val: val });
            return chain;
          },
          then: function(resolve) {
            state.updates.push({ table: table, payload: payload, filters: filters.slice() });
            resolve({ error: null });
          },
        };
        return chain;
      },
      upsert: function(rows, opts) {
        state.upserts.push({ table: table, rows: rows, opts: opts });
        return Promise.resolve({ error: null });
      },
    };
  }
  function read(table) {
    if (table === 'user_settings') {
      return { data: { user_id: USER, upload_email: 'yard-a3x9' }, error: null };
    }
    if (table === 'assets') {
      return {
        data: [{ id: 1, asset_name: 'CAT 320 (EQ000001)', visionlink_serial: 'AAA00001', current_hours: 10 }],
        error: null,
      };
    }
    return { data: [], error: null };
  }
  return { supabase: { from: supabaseFrom }, state: state };
}

function mailInput(extra) {
  var input = {
    receivedAt: '2026-10-28T18:00:00.000Z',
    fields: {
      to: 'yard-a3x9@uploads.fleetmagnify.com',
      from: 'reports@vl.cat.com',
      html: '<a href="' + LINK.replace(/&/g, '&amp;') + '">Download Report</a>',
      text: '',
    },
    files: [],
  };
  if (extra) {
    Object.keys(extra).forEach(function(key) { input[key] = extra[key]; });
  }
  return input;
}

function testHandler() {
  console.log('\n=== Inbound handler ===');
  var original = global.fetch;
  var previousKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-resend-key';
  var alerts = [];
  var failed = null;
  var multi = null;
  var cap = captureConsole();

  function installFetch(download) {
    global.fetch = function(url, opts) {
      var href = String(url);
      if (href.indexOf('api.resend.com') !== -1) {
        alerts.push(JSON.parse(opts.body));
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return download(url, opts);
    };
  }

  var mock = createInboundMock();
  installFetch(function(url, opts) {
    assert.strictEqual(opts.redirect, 'manual');
    assert.strictEqual(new URL(String(url)).hostname, 'vl.cat.com');
    return Promise.resolve(csvResponse(UTIL_CSV, {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="' + ONE_DAY_NAME + '"',
    }));
  });

  return inbound.processInboundEmail(mock.supabase, mailInput()).then(function(result) {
    assert.strictEqual(result.ok, true);
    assert.strictEqual(mock.state.inserts.length, 1);
    assert.strictEqual(mock.state.inserts[0].table, 'email_imports');
    assert.strictEqual(mock.state.inserts[0].row.filename, ONE_DAY_NAME);
    assert.strictEqual(mock.state.inserts[0].row.user_id, USER);
    var tel = mock.state.upserts.filter(function(u) { return u.table === 'telematics_records'; });
    assert.strictEqual(tel.length, 1);
    assert.strictEqual(tel[0].rows[0].record_date, '2026-10-27');
    assert.strictEqual(tel[0].rows[0].asset_id, 1);
    assert.strictEqual(alerts.length, 0);
    assertNoSecret(cap.text());
    assertNoSecret(JSON.stringify(mock.state.inserts));
    console.log('✓ link with no attachment imports Utilization under the downloaded filename');

    var fetchCalls = 0;
    global.fetch = function() {
      fetchCalls += 1;
      throw new Error('fetch should not run when an attachment is present');
    };
    var attached = createInboundMock();
    return inbound.processInboundEmail(attached.supabase, mailInput({
      files: [{ filename: 'notes.csv', mimeType: 'text/csv', buffer: Buffer.from('hello,world\n') }],
    })).then(function() {
      assert.strictEqual(fetchCalls, 0);
      assert.strictEqual(attached.state.inserts.length, 1);
      assert.strictEqual(attached.state.inserts[0].row.filename, 'notes.csv');
      console.log('✓ an attachment suppresses the download link');
    });
  }).then(function() {
    alerts.length = 0;
    failed = createInboundMock();
    installFetch(function() {
      return Promise.resolve(csvResponse('nope', { 'content-type': 'text/plain' }, 502));
    });
    return inbound.processInboundEmail(failed.supabase, mailInput());
  }).then(function(result) {
    assert.strictEqual(result.saved.length, 0);
    assert.strictEqual(failed.state.inserts.length, 1);
    var row = failed.state.inserts[0].row;
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.filename, 'VisionLink report link');
    assert.strictEqual(row.raw_csv, '');
    assert.ok(row.error_message.indexOf('VisionLink download link could not be fetched:') === 0);
    assert.ok(row.error_message.indexOf('HTTP 502') !== -1);
    assert.ok(row.error_message.indexOf('try Download Report manually and email the file') !== -1);
    assert.strictEqual(failed.state.upserts.length, 0);
    assert.strictEqual(alerts.length, 1);
    assert.ok(alerts[0].html.indexOf('HTTP 502') !== -1);
    assertNoSecret(row.error_message);
    assertNoSecret(alerts[0].html);
    assertNoSecret(cap.text());
    console.log('✓ a failed fetch records a failed import and sends the alert');

    alerts.length = 0;
    multi = createInboundMock();
    installFetch(function() {
      return Promise.resolve(csvResponse(UTIL_CSV, {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="' + MULTI_DAY_NAME + '"',
      }));
    });
    return inbound.processInboundEmail(multi.supabase, mailInput());
  }).then(function() {
    assert.strictEqual(multi.state.inserts.length, 1);
    assert.strictEqual(multi.state.inserts[0].row.filename, MULTI_DAY_NAME);
    var failedUpdate = multi.state.updates.filter(function(u) {
      return u.table === 'email_imports' && u.payload.status === 'failed';
    });
    assert.strictEqual(failedUpdate.length, 1);
    assert.ok(failedUpdate[0].payload.error_message.indexOf('needs a one-day report') !== -1);
    var staged = multi.state.upserts.filter(function(u) { return u.table === 'pending_assets'; });
    var tel = multi.state.upserts.filter(function(u) { return u.table === 'telematics_records'; });
    assert.strictEqual(staged.length, 0);
    assert.strictEqual(tel.length, 0);
    assert.strictEqual(alerts.length, 1);
    assert.ok(alerts[0].html.indexOf('needs a one-day report') !== -1);
    assertNoSecret(alerts[0].html);
    assertNoSecret(cap.text());
    console.log('✓ multi-day link filename fails the one-day guard and stages nothing');
  }).then(function() {
    cap.restore();
    global.fetch = original;
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
  }, function(err) {
    cap.restore();
    global.fetch = original;
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
    throw err;
  });
}

testExtraction();
testFilenameAndFetch().then(function() {
  return testHandler();
}).then(function() {
  console.log('\nAll VisionLink email download-link tests passed.');
}).catch(function(err) {
  console.error('\nFAILED:', err);
  process.exit(1);
});
