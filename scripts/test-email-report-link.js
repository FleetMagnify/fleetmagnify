/**
 * VisionLink email download links.
 * Run: node scripts/test-email-report-link.js
 *
 * Uses a fake token and a mocked fetch. No real link is requested.
 */
var assert = require('assert');
var links = require('../parsers/email-report-link');
var inbound = require('../api/email-inbound');
var utils = require('../parsers/parser-utils');

var TOKEN = 'FAKETOKEN';
var LINK = 'https://vl.cat.com/downloadreport?token=' + TOKEN;
var ONE_DAY_NAME = 'Fleet_Utilization_27-10-2026_27-10-2026_27-10-2026.csv';
var MULTI_DAY_NAME = 'Fleet_Utilization_08-17-2026_08-23-2026_08-24-2026.csv';
var S3_HOST = 'example-bucket.s3.us-east-2.amazonaws.com';
var S3_URL = 'https://' + S3_HOST + '/FAKEKEY/Fleet%20Fuel%202026-10-28.csv?response-content-disposition=attachment%3B%20filename%3DFleet%2520Fuel%25202026-10-28.csv&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=FAKE';
var SPACED_NAME = 'Fleet Utilization 27-10-2026 27-10-2026 27-10-2026.csv';
var SPACED_DISPOSITION = 'attachment; filename="Fleet%20Utilization%2027-10-2026%2027-10-2026%2027-10-2026.csv"';
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
  var blob = String(text);
  assert.strictEqual(blob.indexOf(TOKEN) === -1, true, 'logged or stored the token');
  assert.strictEqual(blob.indexOf('https://vl.cat.com') === -1, true, 'logged the full download URL');
  assert.strictEqual(blob.indexOf('token=') === -1, true, 'logged a token query');
  assert.strictEqual(blob.indexOf('X-Amz') === -1, true, 'logged an S3 signature parameter');
  assert.strictEqual(blob.indexOf('x-amz') === -1, true, 'logged an S3 signature parameter');
  assert.strictEqual(blob.indexOf(S3_URL) === -1, true, 'logged the download URL');
  assert.strictEqual(blob.indexOf('FAKEKEY') === -1, true, 'logged the S3 key');
}

function csvResponse(body, headers, status) {
  return new Response(body, {
    status: status || 200,
    headers: headers || { 'content-type': 'text/csv' },
  });
}

function jsonResponse(obj, status, contentType) {
  return new Response(JSON.stringify(obj), {
    status: status == null ? 200 : status,
    headers: { 'content-type': contentType || 'application/json' },
  });
}

function hang(opts) {
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
}

function sequencedDownload(fileResponse) {
  var n = 0;
  return function(url, opts) {
    n += 1;
    var host = new URL(String(url)).hostname;
    if (host === 'vl.cat.com') throw new Error('fetched the web app page');
    if (n === 1) {
      if (host !== 'api.cat.com') throw new Error('first request host was ' + host);
      if (!opts || opts.method !== 'POST') throw new Error('API request must be POST');
      if (opts.body) throw new Error('API request body must be empty');
      return Promise.resolve(jsonResponse({ downloadUrl: S3_URL }));
    }
    if (!opts || opts.method !== 'GET') throw new Error('S3 request must be GET');
    if (opts.headers && (opts.headers.Origin || opts.headers.Referer)) {
      throw new Error('S3 request must not send Origin or Referer');
    }
    if (opts.headers) throw new Error('S3 request must not send extra headers');
    return Promise.resolve(fileResponse);
  };
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

async function rejected(needle, options) {
  try {
    await links.fetchReportFromLink(LINK, options);
  } catch (err) {
    assert.ok(err.message.indexOf(needle) !== -1, err.message + ' (expected ' + needle + ')');
    assertNoSecret(err.message);
    return err;
  }
  throw new Error('expected rejection containing ' + needle);
}

function bigStream(size) {
  var ReadableStream = require('stream/web').ReadableStream;
  var big = new Uint8Array(size);
  big.fill(97);
  return new ReadableStream({
    start: function(controller) {
      controller.enqueue(big);
      controller.close();
    },
  });
}

async function testFilenameAndFetch() {
  console.log('\n=== Download fetch ===');
  var original = global.fetch;
  var cap = captureConsole();
  try {
    assert.strictEqual(links.isS3Host('example-bucket.s3.us-east-2.amazonaws.com'), true);
    assert.strictEqual(links.isS3Host('pfm-storage-service-s3-prod.s3.us-east-2.amazonaws.com'), true);
    assert.strictEqual(links.isS3Host('bucket.s3.amazonaws.com'), true);
    assert.strictEqual(links.isS3Host('ec2.amazonaws.com'), false);
    assert.strictEqual(links.isS3Host('s3.amazonaws.com'), false);
    assert.strictEqual(links.isS3Host('s3.us-east-2.amazonaws.com'), false);

    var scrubbed = links.scrubLinkError(
      'failed X-Amz-Signature=FAKESIG and ' + 'C'.repeat(80) + ' kept ' + MULTI_DAY_NAME
    );
    assert.strictEqual(scrubbed.indexOf('X-Amz'), -1);
    assert.strictEqual(scrubbed.indexOf('C'.repeat(80)), -1);
    assert.ok(scrubbed.indexOf('[redacted]') !== -1);
    assert.ok(scrubbed.indexOf(MULTI_DAY_NAME) !== -1, 'filename was redacted');

    var seen = [];
    var plusLink = 'https://vl.cat.com/downloadreport?lang=en&token=ab%2Bcd%2Fef';
    global.fetch = function(url, opts) {
      seen.push({ url: String(url), opts: opts });
      var host = new URL(String(url)).hostname;
      if (host === 'vl.cat.com') throw new Error('fetched the web app page');
      if (seen.length === 1) return Promise.resolve(jsonResponse({ downloadUrl: S3_URL }));
      return Promise.resolve(csvResponse('asset,hours\nEQ000001,1\n', {
        'content-type': 'text/csv',
        'content-disposition': SPACED_DISPOSITION,
      }));
    };
    var result = await links.fetchReportFromLink(plusLink);
    assert.strictEqual(seen.length, 2);
    var api = new URL(seen[0].url);
    assert.strictEqual(api.hostname, 'api.cat.com');
    assert.strictEqual(api.pathname, '/catDigital/reportDownloads/v1/download');
    assert.strictEqual(api.searchParams.get('source'), 'schedule');
    assert.strictEqual(api.searchParams.get('lang'), null);
    assert.strictEqual(api.searchParams.get('token'), 'ab+cd/ef');
    assert.ok(seen[0].url.indexOf('token=ab%2Bcd%2Fef') !== -1);
    assert.strictEqual(seen[0].url.indexOf('token=ab+') === -1, true);
    assert.strictEqual(seen[0].url.indexOf('lang') === -1, true);
    assert.strictEqual(seen[0].opts.method, 'POST');
    assert.strictEqual(seen[0].opts.body, '');
    assert.strictEqual(seen[0].opts.headers['Content-Length'], '0');
    assert.strictEqual(seen[0].opts.redirect, 'manual');
    assert.strictEqual(seen[0].opts.headers.Accept, 'application/json, text/plain, */*');
    assert.strictEqual(seen[0].opts.headers.Origin, 'https://vl.cat.com');
    assert.strictEqual(seen[0].opts.headers.Referer, 'https://vl.cat.com/');
    assert.ok(seen[0].opts.headers['User-Agent'].indexOf('Mozilla') !== -1);
    assert.strictEqual(seen[0].opts.headers.Authorization, undefined);
    assert.strictEqual(seen[1].opts.redirect, 'manual');
    assert.strictEqual(seen[1].opts.method, 'GET');
    assert.strictEqual(seen[1].opts.body, undefined);
    assert.strictEqual(seen[1].opts.headers, undefined);
    assert.ok(!seen[1].opts.headers || !seen[1].opts.headers.Origin);
    assert.ok(!seen[1].opts.headers || !seen[1].opts.headers.Referer);
    assert.strictEqual(new URL(seen[1].url).hostname, S3_HOST);
    assert.strictEqual(result.filename, SPACED_NAME);
    assert.strictEqual(result.mimeType, 'text/csv');
    assert.strictEqual(result.finalHost, S3_HOST);
    assert.ok(result.buffer.toString('utf8').indexOf('EQ000001') !== -1);
    var range = utils.parseVisionLinkFilenameRange(result.filename);
    assert.ok(range, 'spaced filename did not parse');
    assert.strictEqual(range.start, range.end);
    assert.strictEqual(range.start, '2026-10-27');
    assert.strictEqual(cap.text().indexOf('ab%2B') === -1, true);
    assert.strictEqual(cap.text().indexOf('ab+cd') === -1, true);
    assert.ok(cap.text().indexOf('api.cat.com') !== -1);
    assert.ok(cap.text().indexOf(S3_HOST) !== -1);
    assert.strictEqual(cap.text().indexOf('catDigital') === -1, true);
    assertNoSecret(cap.text());
    console.log('✓ API then S3, token re-encoded, spaced filename is one day');

    global.fetch = sequencedDownload(csvResponse('a,b\n', {
      'content-type': 'text/csv',
      'content-disposition': "attachment; filename=\"other.csv\"; filename*=UTF-8''Fleet%5FUtilization%5F27-10-2026%5F27-10-2026%5F27-10-2026.csv",
    }));
    result = await links.fetchReportFromLink(LINK);
    assert.strictEqual(result.filename, ONE_DAY_NAME);

    global.fetch = sequencedDownload(csvResponse('a,b\n1,2\n', { 'content-type': 'text/csv' }));
    result = await links.fetchReportFromLink(LINK);
    assert.strictEqual(result.filename, 'Fleet Fuel 2026-10-28.csv');

    global.fetch = function(url, opts) {
      var host = new URL(String(url)).hostname;
      if (host === 'api.cat.com') {
        return Promise.resolve(jsonResponse({
          downloadUrl: 'https://' + S3_HOST + '/',
        }));
      }
      if (opts.headers) throw new Error('S3 request must not send extra headers');
      return Promise.resolve(csvResponse('a,b\n1,2\n', { 'content-type': 'text/csv' }));
    };
    result = await links.fetchReportFromLink(LINK);
    assert.strictEqual(result.filename, null);

    global.fetch = sequencedDownload(csvResponse('a,b\n', {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="reports/Fleet%20Utilization%2027-10-2026%2027-10-2026%2027-10-2026.csv"',
    }));
    result = await links.fetchReportFromLink(LINK);
    assert.strictEqual(result.filename, SPACED_NAME);

    global.fetch = sequencedDownload(csvResponse('a,b\n', {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="100%done.csv"',
    }));
    result = await links.fetchReportFromLink(LINK);
    assert.strictEqual(result.filename, '100%done.csv');
    console.log('✓ filename*, S3 key fallback, path strip, malformed percent');

    var hops = 0;
    global.fetch = function(url, opts) {
      hops += 1;
      var host = new URL(String(url)).hostname;
      if (hops === 1) {
        assert.strictEqual(host, 'api.cat.com');
        return Promise.resolve(jsonResponse({ downloadUrl: S3_URL }));
      }
      if (hops === 2) {
        assert.strictEqual(host, S3_HOST);
        assert.strictEqual(opts.headers, undefined);
        return Promise.resolve(redirectResponse('https://files.cat.com/reports/' + ONE_DAY_NAME));
      }
      assert.strictEqual(host, 'files.cat.com');
      return Promise.resolve(csvResponse('asset,hours\n', {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="' + ONE_DAY_NAME + '"',
      }));
    };
    result = await links.fetchReportFromLink(LINK);
    assert.strictEqual(result.finalHost, 'files.cat.com');
    assert.strictEqual(result.filename, ONE_DAY_NAME);

    hops = 0;
    global.fetch = function(url, opts) {
      hops += 1;
      if (hops === 1) {
        return Promise.resolve(jsonResponse({
          downloadUrl: 'https://bucket.s3.amazonaws.com/FAKEKEY/report.csv?X-Amz-Signature=FAKE',
        }));
      }
      assert.strictEqual(opts.headers, undefined);
      assert.strictEqual(new URL(String(url)).hostname, 'bucket.s3.amazonaws.com');
      return Promise.resolve(csvResponse('a,b\n', { 'content-type': 'text/csv' }));
    };
    result = await links.fetchReportFromLink(LINK);
    assert.strictEqual(result.finalHost, 'bucket.s3.amazonaws.com');
    assert.strictEqual(result.filename, 'report.csv');
    console.log('✓ file redirect stays on cat.com or an S3 bucket host');

    var apiCalls = 0;
    global.fetch = function(url, opts) {
      apiCalls += 1;
      assert.strictEqual(opts.method, 'POST');
      assert.strictEqual(opts.body, '');
      return Promise.resolve(new Response(
        '<html><head><title>Cat Sign In</title></head><body>HIDDENBODY ' +
        '<a href="' + S3_URL + '">file</a> token=' + TOKEN + ' X-Amz-Signature=FAKE</body></html>',
        {
          status: 302,
          headers: {
            location: S3_URL,
            'content-type': 'text/html; charset=utf-8',
            server: 'cloudfront',
            'x-cache': 'Error from cloudfront',
          },
        }
      ));
    };
    var err = await rejected('HTTP 302');
    assert.strictEqual(apiCalls, 1);
    assert.ok(err.message.indexOf('Cat Sign In') !== -1);
    assert.ok(err.message.indexOf('cloudfront') !== -1);
    assert.ok(err.message.indexOf('text/html') !== -1);
    assert.ok(err.message.indexOf('Error from cloudfront') !== -1);
    assert.strictEqual(err.message.indexOf('HIDDENBODY') === -1, true);
    assertNoSecret(err.message);

    global.fetch = function(url, opts) {
      assert.strictEqual(opts.method, 'POST');
      return Promise.resolve(new Response('<html><body><p>Sign-in <b>required</b></p></body></html>', {
        status: 200,
        headers: {
          'content-type': 'text/html',
          server: 'cloudfront',
        },
      }));
    };
    err = await rejected('not JSON');
    assert.ok(err.message.indexOf('Sign-in required') !== -1);
    assert.ok(err.message.indexOf('server: cloudfront') !== -1);
    assert.ok(err.message.indexOf('content-type: text/html') !== -1);
    assert.ok(err.message.indexOf('x-cache: (none)') !== -1);
    assert.strictEqual(err.message.indexOf('<b>') === -1, true);

    var filler = 'padding ';
    global.fetch = function() {
      return Promise.resolve(new Response('<html><body>' + filler.repeat(80) + '</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html', server: 'edge', 'x-cache': 'Miss' },
      }));
    };
    err = await rejected('padding');
    assert.strictEqual(err.message.indexOf(filler.repeat(26)) === -1, true);
    assert.ok(err.message.indexOf('x-cache: Miss') !== -1);

    global.fetch = sequencedDownload(redirectResponse('https://evil.example/report.csv'));
    err = await rejected('evil.example');
    assert.strictEqual(err.message.indexOf('/report.csv'), -1);

    global.fetch = sequencedDownload(redirectResponse('https://203.0.113.10/report.csv'));
    await rejected('203.0.113.10');

    global.fetch = sequencedDownload(redirectResponse('https://localhost/report.csv'));
    await rejected('localhost');

    global.fetch = sequencedDownload(redirectResponse('http://files.cat.com/report.csv'));
    await rejected('redirect was not https');

    global.fetch = sequencedDownload(redirectResponse('https://data.caterpillar.com/report.csv'));
    await rejected('data.caterpillar.com');

    var n = 0;
    global.fetch = function(url, opts) {
      n += 1;
      var host = new URL(String(url)).hostname;
      if (host === 'api.cat.com') {
        assert.strictEqual(opts.method, 'POST');
        assert.strictEqual(opts.body, '');
        return Promise.resolve(jsonResponse({
          downloadUrl: 'https://bucket.s3.amazonaws.com/report.csv',
        }));
      }
      if (n > 5) throw new Error('followed a fourth redirect');
      assert.strictEqual(opts.method, 'GET');
      assert.strictEqual(opts.headers, undefined);
      return Promise.resolve(redirectResponse('https://bucket.s3.amazonaws.com/step'));
    };
    await rejected('too many redirects');
    assert.strictEqual(n, 5);
    console.log('✓ API redirects are not followed; file redirects stay on allowed hosts');

    function apiReturning(downloadUrl) {
      var calls = 0;
      global.fetch = function() {
        calls += 1;
        if (calls > 1) throw new Error('file fetch should not run');
        return Promise.resolve(jsonResponse({ downloadUrl: downloadUrl }));
      };
    }

    apiReturning('http://' + S3_HOST + '/file.csv?X-Amz-Signature=FAKE');
    err = await rejected('not https');
    assert.ok(err.message.indexOf(S3_HOST) !== -1);
    assert.strictEqual(err.message.indexOf('/file.csv'), -1);

    apiReturning('https://evil.example/file.csv');
    err = await rejected('evil.example');
    assert.strictEqual(err.message.indexOf('/file.csv'), -1);

    apiReturning('https://ec2.amazonaws.com/file.csv');
    err = await rejected('ec2.amazonaws.com');
    assert.strictEqual(err.message.indexOf('/file.csv'), -1);

    apiReturning('https://203.0.113.50/secret.csv');
    err = await rejected('203.0.113.50');
    assert.strictEqual(err.message.indexOf('secret.csv'), -1);

    apiReturning('https://user:pass@' + S3_HOST + '/file.csv');
    err = await rejected(S3_HOST);
    assert.strictEqual(err.message.indexOf('user'), -1);
    assert.strictEqual(err.message.indexOf('pass'), -1);

    apiReturning('https://' + S3_HOST + ':8443/file.csv');
    err = await rejected(S3_HOST);
    assert.strictEqual(err.message.indexOf('8443'), -1);

    global.fetch = function() {
      return Promise.resolve(jsonResponse({
        message: 'schedule denied',
        code: 'DENIED',
        downloadUrl: S3_URL,
      }, 403));
    };
    err = await rejected('HTTP 403');
    assert.ok(err.message.indexOf('application/json') !== -1);
    assert.ok(err.message.indexOf('message') !== -1);
    assert.ok(err.message.indexOf('code') !== -1);
    assert.ok(err.message.indexOf('downloadUrl') !== -1);
    assert.ok(err.message.indexOf('schedule denied') !== -1);
    assert.strictEqual(err.message.indexOf('DENIED'), -1);

    global.fetch = function(url, opts) {
      assert.strictEqual(opts.method, 'POST');
      assert.strictEqual(opts.body, '');
      return Promise.resolve(new Response(
        '<html><head><title>Page shell</title></head><body>NOTAREALPAGE token=' + TOKEN +
        ' <a href="https://evil.example/secret?X-Amz-Signature=FAKE">x</a></body></html>',
        {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            server: 'cloudfront',
            'x-cache': 'RefreshHit from cloudfront',
          },
        }
      ));
    };
    err = await rejected('HTTP 200');
    assert.ok(err.message.indexOf('text/html') !== -1);
    assert.ok(err.message.indexOf('not JSON') !== -1);
    assert.ok(err.message.indexOf('Page shell') !== -1);
    assert.ok(err.message.indexOf('server: cloudfront') !== -1);
    assert.ok(err.message.indexOf('x-cache: RefreshHit from cloudfront') !== -1);
    assert.strictEqual(err.message.indexOf('NOTAREALPAGE') === -1, true);
    assertNoSecret(err.message);

    global.fetch = function() {
      return Promise.resolve(jsonResponse({ reportName: 'Utilization Summary', ok: true }));
    };
    err = await rejected('no downloadUrl');
    assert.ok(err.message.indexOf('reportName') !== -1);
    assert.ok(err.message.indexOf('ok') !== -1);
    assert.strictEqual(err.message.indexOf('Utilization'), -1);
    assert.strictEqual(err.message.indexOf('Summary'), -1);

    global.fetch = function() {
      return Promise.resolve(jsonResponse({
        message: 'expired https://evil.example/secret?token=' + TOKEN + '&X-Amz-Signature=FAKESIG',
      }, 401));
    };
    err = await rejected('HTTP 401');
    assert.ok(err.message.indexOf('expired') !== -1);
    assert.ok(err.message.indexOf('[link]') !== -1);

    global.fetch = function() {
      return Promise.resolve(jsonResponse({ error: 'C'.repeat(90) }, 400));
    };
    err = await rejected('HTTP 400');
    assert.strictEqual(err.message.indexOf('C'.repeat(64)), -1);
    assert.ok(err.message.indexOf('[redacted]') !== -1);

    global.fetch = function() {
      return Promise.resolve(new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(links.API_MAX_BYTES + 1),
        },
      }));
    };
    err = await rejected('64 KB');
    assert.ok(err.message.indexOf('HTTP 200') !== -1);

    global.fetch = sequencedDownload(csvResponse('<html>NOTAREALPAGE</html>', {
      'content-type': 'text/html; charset=utf-8',
    }));
    err = await rejected('HTML page');
    assert.strictEqual(err.message.indexOf('NOTAREALPAGE'), -1);

    global.fetch = sequencedDownload(csvResponse('<!DOCTYPE html><html></html>', {
      'content-type': 'text/plain',
    }));
    await rejected('HTML page');

    global.fetch = sequencedDownload(csvResponse('x', {
      'content-type': 'text/csv',
      'content-length': String(links.MAX_BYTES + 1),
    }));
    await rejected('exceeded 5 MB');

    global.fetch = function(url) {
      var host = new URL(String(url)).hostname;
      if (host === 'api.cat.com') return Promise.resolve(jsonResponse({ downloadUrl: S3_URL }));
      return Promise.resolve(new Response(bigStream(links.MAX_BYTES + 1), {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      }));
    };
    await rejected('exceeded 5 MB');

    global.fetch = sequencedDownload(csvResponse('nope', { 'content-type': 'text/plain' }, 403));
    await rejected('HTTP 403');

    global.fetch = function(url, opts) { return hang(opts); };
    await rejected('timed out', { timeoutMs: 40 });

    var step = 0;
    global.fetch = function(url, opts) {
      step += 1;
      if (step === 1) return Promise.resolve(jsonResponse({ downloadUrl: S3_URL }));
      return hang(opts);
    };
    await rejected('timed out', { timeoutMs: 40 });

    global.fetch = sequencedDownload(csvResponse('PK', {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="Fleet_Fuel_2026-10-28.xlsx"',
    }));
    try {
      await links.fetchReportFromLink(LINK);
      throw new Error('xlsx should have failed');
    } catch (xlsxErr) {
      if (xlsxErr.message === 'xlsx should have failed') throw xlsxErr;
      assert.strictEqual(
        xlsxErr.message,
        'link served an Excel file; only CSV is supported for link downloads'
      );
      assert.strictEqual(xlsxErr.reportFilename, 'Fleet_Fuel_2026-10-28.xlsx');
      assertNoSecret(xlsxErr.message);
    }

    assert.strictEqual(cap.text().indexOf('catDigital') === -1, true);
    assertNoSecret(cap.text());
    console.log('✓ html, size, status, timeout, and xlsx rejected');
  } finally {
    cap.restore();
    global.fetch = original;
  }
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
  installFetch(sequencedDownload(csvResponse(UTIL_CSV, {
    'content-type': 'text/csv',
    'content-disposition': 'attachment; filename="' + ONE_DAY_NAME + '"',
  })));

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
    installFetch(sequencedDownload(csvResponse(UTIL_CSV, {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="' + MULTI_DAY_NAME + '"',
    })));
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
