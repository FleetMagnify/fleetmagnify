/**
 * Quiet-feed alert rules. Invented accounts and addresses only. No network.
 *
 *   node scripts/test-missing-feed-alert.js
 */
var assert = require('assert');
var alert = require('../lib/missing-feed-alert');
var handler = require('../api/check-missing-reports');

var ACTIVE = '11111111-1111-4111-8111-111111111111';
var CANCELLED = '22222222-2222-4222-8222-222222222222';
var DELETED = '33333333-3333-4333-8333-333333333333';
var BLANK = '44444444-4444-4444-8444-444444444444';
var NOISY = '55555555-5555-4555-8555-555555555555';
var SENDER = 'reports@plant.example';
var MANUAL = 'person@workshop.example';
var TODAY = '2026-11-04';
var COMPANY = 'North <b>Quarry</b> & Sons';
var UPLOAD = 'quarry-k4m8@uploads.fleetmagnify.com';
var LINK = 'https://files.example.com/r?token=secret-token-abc';

function nowFor(nzDate) {
  return new Date(nzDate + 'T02:00:00.000Z');
}

function row(userId, from, nzDate, status, extra) {
  var record = {
    user_id: userId,
    from_email: from,
    received_at: nzDate + 'T02:00:00.000Z',
    status: status || 'processed'
  };
  if (extra) {
    Object.keys(extra).forEach(function (key) { record[key] = extra[key]; });
  }
  return record;
}

function eachDate(start, end, fn) {
  var cursor = start;
  var guard = 0;
  while (cursor <= end) {
    fn(cursor);
    cursor = alert.addCalendarDays(cursor, 1);
    guard += 1;
    if (guard > 60) throw new Error('date loop');
  }
}

function daily(userId, from, start, end, status) {
  var rows = [];
  eachDate(start, end, function (iso) {
    rows.push(row(userId, from, iso, status || 'processed'));
  });
  return rows;
}

function weekdaysOnly(userId, from, start, end) {
  var rows = [];
  eachDate(start, end, function (iso) {
    if (!alert.isWeekend(iso)) rows.push(row(userId, from, iso, 'processed'));
  });
  return rows;
}

function accountMap(entries) {
  var map = {};
  entries.forEach(function (entry) {
    map[entry.id] = entry;
  });
  return map;
}

function activeAccount(id, company) {
  return { id: id, subscription_status: 'active', company_name: company || 'Harbour Civil Ltd' };
}

function createSupabase(imports, profiles) {
  var calls = { imports: [], profiles: [], selects: [], gte: [], emails: [] };
  var supabase = {
    from: function (table) {
      var state = { inVals: null };
      var chain = {
        select: function (cols) {
          calls.selects.push({ table: table, cols: cols });
          return chain;
        },
        gte: function (col, val) {
          calls.gte.push(val);
          return chain;
        },
        in: function (col, vals) {
          state.inVals = vals;
          return chain;
        },
        order: function () { return chain; },
        range: function (from, to) {
          if (table === 'email_imports') {
            calls.imports.push([from, to]);
            return Promise.resolve({ data: imports.slice(from, to + 1), error: null });
          }
          calls.profiles.push([from, to]);
          var filtered = profiles.filter(function (profile) {
            if (!state.inVals) return true;
            return state.inVals.indexOf(profile.subscription_status) !== -1;
          });
          return Promise.resolve({ data: filtered.slice(from, to + 1), error: null });
        }
      };
      return chain;
    },
    auth: {
      admin: {
        getUserById: function (id) {
          calls.emails.push(id);
          var profile = null;
          profiles.forEach(function (item) {
            if (item.id === id) profile = item;
          });
          if (!profile || !profile.login_email) {
            return Promise.resolve({ data: { user: null }, error: { message: 'not found' } });
          }
          return Promise.resolve({ data: { user: { id: id, email: profile.login_email } }, error: null });
        }
      }
    }
  };
  return { supabase: supabase, calls: calls };
}

function mockRes() {
  var res = { statusCode: 0, body: null };
  res.status = function (code) {
    res.statusCode = code;
    return res;
  };
  res.json = function (body) {
    res.body = body;
    return res;
  };
  return res;
}

function captureConsole() {
  var warnings = [];
  var errors = [];
  var origWarn = console.warn;
  var origError = console.error;
  console.warn = function () { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
  console.error = function () { errors.push(Array.prototype.slice.call(arguments).join(' ')); };
  return {
    warnings: warnings,
    errors: errors,
    restore: function () {
      console.warn = origWarn;
      console.error = origError;
    }
  };
}

function poison(record) {
  record.to_email = UPLOAD;
  record.filename = 'utilization.csv';
  record.raw_csv = LINK;
  record.error_message = 'token secret-token-abc';
  return record;
}

async function main() {
  assert.strictEqual(alert.nzDateISO('2026-11-01T23:30:00.000Z'), '2026-11-02');
  assert.strictEqual(alert.nzDateISO('2026-06-01T23:30:00.000Z'), '2026-06-02');
  assert.strictEqual(alert.nzDateISO(nowFor(TODAY)), TODAY);
  assert.strictEqual(alert.nzMidnightUtc('2026-11-02').toISOString(), '2026-11-01T11:00:00.000Z');
  assert.strictEqual(alert.nzMidnightUtc('2026-06-02').toISOString(), '2026-06-01T12:00:00.000Z');
  console.log('✓ daylight saving lands both sample instants on the right NZ date');

  var today = nowFor(TODAY);
  var accounts = accountMap([
    activeAccount(ACTIVE, COMPANY),
    { id: CANCELLED, subscription_status: 'cancelled', company_name: 'Closed Yard Ltd' },
    { id: BLANK, subscription_status: 'past_due', company_name: '' }
  ]);

  var quiet = daily(ACTIVE, SENDER, '2026-10-22', '2026-11-02');
  poison(quiet[0]);
  var quietFeeds = alert.findOverdueFeeds(quiet, today, accounts);
  assert.strictEqual(quietFeeds.length, 1);
  assert.strictEqual(quietFeeds[0].missedDays, 1);
  assert.strictEqual(quietFeeds[0].lastDate, '2026-11-02');
  assert.strictEqual(quietFeeds[0].fromEmail, SENDER);
  console.log('✓ a 7-day feed missing yesterday is overdue with missedDays 1');

  var caughtUp = quiet.concat([row(ACTIVE, SENDER, '2026-11-03', 'processed')]);
  assert.strictEqual(alert.findOverdueFeeds(caughtUp, today, accounts).length, 0);
  console.log('✓ the same feed delivered yesterday is not overdue');

  var deliveredToday = quiet.concat([row(ACTIVE, SENDER, TODAY, 'processed')]);
  assert.strictEqual(alert.findOverdueFeeds(deliveredToday, today, accounts).length, 0);
  console.log('✓ a delivery today is not counted as a miss');

  var weekdayRows = weekdaysOnly(ACTIVE, SENDER, '2026-10-20', '2026-10-30');
  var monday = alert.findOverdueFeeds(weekdayRows, nowFor('2026-11-02'), accounts);
  assert.strictEqual(monday.length, 0);
  assert.strictEqual(alert.isWeekdayOnly(
    weekdayRows.map(function (item) { return item.received_at.slice(0, 10); }),
    '2026-11-02'
  ), true);
  var tuesday = alert.findOverdueFeeds(weekdayRows, nowFor('2026-11-03'), accounts);
  assert.strictEqual(tuesday.length, 1);
  assert.strictEqual(tuesday[0].missedDays, 1);
  assert.strictEqual(tuesday[0].lastDate, '2026-10-30');
  console.log('✓ a weekday-only feed misses nothing on Monday and one day on Tuesday');

  var sevenDayWeekend = daily(ACTIVE, SENDER, '2026-10-20', '2026-10-30');
  assert.strictEqual(alert.findOverdueFeeds(sevenDayWeekend, nowFor('2026-11-02'), accounts).length, 0);
  assert.strictEqual(alert.countMissedDays('2026-10-30', '2026-11-02', false), 2);
  console.log('✓ the same Friday on a 7-day feed is two missed days, which is not an alert');

  var fourDates = daily(ACTIVE, SENDER, '2026-10-22', '2026-10-25');
  assert.strictEqual(alert.findOverdueFeeds(fourDates, today, accounts).length, 0);
  console.log('✓ four delivery dates in the last 14 days is not a regular feed');

  var oneOff = [row(ACTIVE, MANUAL, '2026-11-02', 'processed')];
  assert.strictEqual(alert.findOverdueFeeds(oneOff, today, accounts).length, 0);
  console.log('✓ a one-off manual sender is ignored');

  var ignoredStatuses = [];
  ['pending', 'no_attachment', 'unrecognized'].forEach(function (status) {
    ignoredStatuses = ignoredStatuses.concat(daily(ACTIVE, 'status-' + status + '@plant.example', '2026-10-22', '2026-11-02', status));
  });
  var almost = daily(ACTIVE, SENDER, '2026-10-22', '2026-10-25', 'processed')
    .concat(daily(ACTIVE, SENDER, '2026-10-26', '2026-11-02', 'pending'));
  assert.strictEqual(alert.findOverdueFeeds(ignoredStatuses.concat(almost), today, accounts).length, 0);
  var failedFeed = daily(ACTIVE, 'failed@plant.example', '2026-10-22', '2026-11-02', 'failed');
  var failedHit = alert.findOverdueFeeds(failedFeed, today, accounts);
  assert.strictEqual(failedHit.length, 1);
  assert.strictEqual(failedHit[0].missedDays, 1);
  console.log('✓ pending, no_attachment and unrecognized do not count; failed does');

  var mixedCase = daily(ACTIVE, 'reports@plant.example', '2026-10-22', '2026-10-25')
    .concat([row(ACTIVE, 'Reports@plant.example', '2026-10-26', 'processed')]);
  assert.strictEqual(alert.findOverdueFeeds(mixedCase, today, accounts).length, 0);
  assert.strictEqual(alert.isRegular(['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26'], TODAY), true);
  console.log('✓ sender case does not split one feed, and five dates is regular');

  [1, 2, 3, 4, 5, 6, 7, 8].forEach(function (missed) {
    var last = alert.addCalendarDays(TODAY, -(missed + 1));
    var rows = daily(ACTIVE, SENDER, '2026-10-22', last);
    var found = alert.findOverdueFeeds(rows, today, accounts);
    var expectAlert = missed === 1 || missed === 3 || missed === 7;
    assert.strictEqual(found.length, expectAlert ? 1 : 0, 'milestone ' + missed);
    if (expectAlert) assert.strictEqual(found[0].missedDays, missed);
  });
  var abandoned = daily(ACTIVE, SENDER, '2026-10-01', '2026-10-10');
  assert.strictEqual(alert.findOverdueFeeds(abandoned, today, accounts).length, 0);
  console.log('✓ milestones 1, 3 and 7 alert; 2, 4, 5, 6 and 8 or more do not');

  var cancelledRows = daily(CANCELLED, SENDER, '2026-10-22', '2026-11-02');
  var deletedRows = daily(DELETED, SENDER, '2026-10-22', '2026-11-02');
  assert.strictEqual(alert.findOverdueFeeds(cancelledRows.concat(deletedRows), today, accounts).length, 0);
  assert.strictEqual(alert.isBillableAccount({ subscription_status: 'trialing' }), true);
  assert.strictEqual(alert.isBillableAccount({ subscription_status: 'past_due' }), true);
  assert.strictEqual(alert.isBillableAccount({ subscription_status: 'cancelled' }), false);
  assert.deepStrictEqual(alert.BILLABLE_STATUSES, ['trialing', 'active', 'past_due']);
  console.log('✓ a cancelled or deleted account is skipped');

  var previousKey = process.env.RESEND_API_KEY;
  var previousCron = process.env.CRON_SECRET;
  var previousAdmin = process.env.ADMIN_SECRET;
  var previousFetch = global.fetch;
  process.env.CRON_SECRET = 'cron-test-secret';
  process.env.ADMIN_SECRET = 'admin-test-secret';
  var cap = captureConsole();
  var sent = [];

  function recordingFetch(url, opts) {
    sent.push({ url: String(url), body: JSON.parse(opts.body), authorization: opts.headers.Authorization });
    return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(''); } });
  }

  try {
    var profiles = [
      { id: ACTIVE, company_name: COMPANY, subscription_status: 'active', login_email: 'owner@quarry.example' },
      { id: CANCELLED, company_name: 'Closed Yard Ltd', subscription_status: 'cancelled', login_email: 'closed@yard.example' },
      { id: BLANK, company_name: '', subscription_status: 'active', login_email: 'owner<script>@harbour.example' },
      { id: NOISY, company_name: 'Noise Ltd', subscription_status: 'trialing', login_email: 'noise@example.com' }
    ];
    var quietRows = daily(ACTIVE, SENDER, '2026-10-22', '2026-11-02');
    poison(quietRows[3]);
    var otherQuiet = daily(CANCELLED, 'closed@sender.example', '2026-10-22', '2026-11-02');
    var db = createSupabase(quietRows.concat(otherQuiet), profiles);

    sent.length = 0;
    process.env.RESEND_API_KEY = 'test-resend-key';
    var live = await alert.runCheck({
      supabase: db.supabase,
      now: today,
      fetch: recordingFetch
    });
    assert.strictEqual(live.ok, true);
    assert.strictEqual(live.sent, true);
    assert.strictEqual(live.overdue, 1);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].url, 'https://api.resend.com/emails');
    assert.strictEqual(sent[0].authorization, 'Bearer test-resend-key');
    assert.strictEqual(sent[0].body.from, 'alerts@fleetmagnify.com');
    assert.strictEqual(sent[0].body.to, 'fleetmagnify@gmail.com');
    assert.strictEqual(sent[0].body.subject, 'FleetMagnify: 1 data feed(s) have gone quiet');
    var html = sent[0].body.html;
    assert.ok(html.indexOf('North &lt;b&gt;Quarry&lt;/b&gt; &amp; Sons') !== -1);
    assert.strictEqual(html.indexOf('<b>'), -1);
    assert.strictEqual(html.indexOf('uploads.fleetmagnify.com'), -1);
    assert.strictEqual(html.indexOf('secret-token'), -1);
    assert.strictEqual(html.indexOf('http'), -1);
    assert.strictEqual(html.indexOf(UPLOAD), -1);
    assert.strictEqual(html.indexOf('owner@quarry.example'), -1);
    assert.strictEqual(html.indexOf('closed@yard.example'), -1);
    assert.ok(html.indexOf(SENDER) !== -1);
    assert.ok(html.indexOf('2026-11-02') !== -1);
    assert.ok(html.indexOf('1 missed day(s)') !== -1);
    assert.ok(db.calls.selects.some(function (item) {
      return item.table === 'email_imports' && item.cols === 'user_id, from_email, received_at, status';
    }));
    assert.deepStrictEqual(db.calls.emails, []);
    assert.strictEqual(db.calls.gte[0], alert.nzMidnightUtc('2026-10-08').toISOString());
    console.log('✓ the owner email escapes HTML and leaves out upload addresses and links');

    sent.length = 0;
    var caughtDb = createSupabase(
      daily(ACTIVE, SENDER, '2026-10-22', '2026-11-03'),
      profiles
    );
    var empty = await alert.runCheck({ supabase: caughtDb.supabase, now: today, fetch: recordingFetch });
    assert.deepStrictEqual(empty, { ok: true, overdue: 0 });
    assert.strictEqual(sent.length, 0);
    console.log('✓ an empty overdue list sends nothing');

    var blankRows = daily(BLANK, SENDER, '2026-10-22', '2026-11-02');
    var blankDb = createSupabase(blankRows, profiles);
    sent.length = 0;
    var namedByEmail = await alert.runCheck({ supabase: blankDb.supabase, now: today, fetch: recordingFetch });
    assert.strictEqual(namedByEmail.overdue, 1);
    assert.ok(sent[0].body.html.indexOf('owner&lt;script&gt;@harbour.example') !== -1);
    assert.strictEqual(sent[0].body.html.indexOf('<script>'), -1);
    assert.deepStrictEqual(blankDb.calls.emails, [BLANK]);
    console.log('✓ a blank company name uses the escaped account email');

    var unknownDb = createSupabase(blankRows, [
      { id: BLANK, company_name: '   ', subscription_status: 'active' }
    ]);
    sent.length = 0;
    var unknown = await alert.runCheck({ supabase: unknownDb.supabase, now: today, fetch: recordingFetch });
    assert.strictEqual(unknown.sent, true);
    assert.ok(sent[0].body.html.indexOf('Unknown account') !== -1);
    console.log('✓ a missing company and email becomes Unknown account');

    delete process.env.RESEND_API_KEY;
    sent.length = 0;
    cap.warnings.length = 0;
    var missingKey = await alert.runCheck({ supabase: db.supabase, now: today, fetch: recordingFetch });
    assert.strictEqual(missingKey.ok, true);
    assert.strictEqual(missingKey.sent, false);
    assert.strictEqual(missingKey.reason, 'missing_key');
    assert.strictEqual(sent.length, 0);
    assert.ok(cap.warnings.some(function (line) { return line.indexOf('RESEND_API_KEY') !== -1; }));
    console.log('✓ a missing Resend key returns ok and sends nothing');

    process.env.RESEND_API_KEY = 'test-resend-key';
    var failingFetch = function () {
      return Promise.reject(new Error('network down'));
    };
    cap.errors.length = 0;
    var thrown = await alert.runCheck({ supabase: db.supabase, now: today, fetch: failingFetch });
    assert.strictEqual(thrown.ok, true);
    assert.strictEqual(thrown.reason, 'resend_failed');
    assert.strictEqual(thrown.error, 'network down');
    assert.ok(cap.errors.some(function (line) { return line.indexOf('network down') !== -1; }));

    var statusFetch = function () {
      return Promise.resolve({ ok: false, status: 502, text: function () { return Promise.resolve('upstream'); } });
    };
    var rejected = await alert.runCheck({ supabase: db.supabase, now: today, fetch: statusFetch });
    assert.strictEqual(rejected.ok, true);
    assert.strictEqual(rejected.sent, false);
    assert.strictEqual(rejected.reason, 'resend_failed');
    assert.strictEqual(rejected.status, 502);
    console.log('✓ a Resend failure is returned and does not throw');

    var filler = [];
    for (var i = 0; i < 1000; i++) {
      filler.push({
        user_id: NOISY,
        from_email: 'noise@example.com',
        received_at: '2026-10-22T02:00:00.000Z',
        status: 'pending',
        to_email: UPLOAD,
        raw_csv: LINK
      });
    }
    var pagedRows = filler.concat(daily(ACTIVE, SENDER, '2026-10-22', '2026-11-02'));
    var paged = createSupabase(pagedRows, profiles);
    var pagedResult = await alert.runCheck({
      supabase: paged.supabase,
      now: today,
      dryRun: true,
      fetch: recordingFetch
    });
    assert.deepStrictEqual(paged.calls.imports[0], [0, 999]);
    assert.deepStrictEqual(paged.calls.imports[1], [1000, 1999]);
    assert.strictEqual(paged.calls.imports.length, 2);
    assert.strictEqual(pagedResult.overdue, 1);
    assert.strictEqual(pagedResult.feeds[0].missedDays, 1);
    assert.strictEqual(pagedRows.length > 1000, true);
    console.log('✓ more than 1,000 import rows are read with range()');

    sent.length = 0;
    var dryDb = createSupabase(quietRows, profiles);
    var dryRes = mockRes();
    await handler({
      method: 'POST',
      headers: { 'x-admin-secret': 'admin-test-secret' },
      query: { dryRun: '1' },
      url: '/api/check-missing-reports?dryRun=1'
    }, dryRes, { supabase: dryDb.supabase, now: today, fetch: recordingFetch });
    assert.strictEqual(dryRes.statusCode, 200);
    assert.strictEqual(dryRes.body.ok, true);
    assert.strictEqual(dryRes.body.dryRun, true);
    assert.strictEqual(dryRes.body.overdue, 1);
    assert.strictEqual(dryRes.body.feeds[0].account, COMPANY);
    assert.strictEqual(dryRes.body.feeds[0].fromEmail, SENDER);
    assert.strictEqual(dryRes.body.feeds[0].lastDate, '2026-11-02');
    assert.strictEqual(dryRes.body.feeds[0].missedDays, 1);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(JSON.stringify(dryRes.body).indexOf('uploads.fleetmagnify.com'), -1);
    assert.strictEqual(JSON.stringify(dryRes.body).indexOf('secret-token'), -1);
    console.log('✓ admin POST dryRun=1 returns the list and sends nothing');

    sent.length = 0;
    var cronDry = mockRes();
    await handler({
      method: 'GET',
      headers: { authorization: 'Bearer cron-test-secret' },
      query: { dryRun: '1' },
      url: '/api/check-missing-reports?dryRun=1'
    }, cronDry, { supabase: createSupabase(quietRows, profiles).supabase, now: today, fetch: recordingFetch });
    assert.strictEqual(cronDry.statusCode, 200);
    assert.strictEqual(cronDry.body.sent, true);
    assert.strictEqual(sent.length, 1);
    console.log('✓ dryRun is ignored unless the request is an admin POST');

    sent.length = 0;
    var denied = mockRes();
    var deniedDb = createSupabase(quietRows, profiles);
    await handler({ method: 'GET', headers: {}, query: {} }, denied, { supabase: deniedDb.supabase, now: today, fetch: recordingFetch });
    assert.strictEqual(denied.statusCode, 401);
    assert.strictEqual(denied.body.error, 'Unauthorized');
    var wrong = mockRes();
    await handler({
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'x-admin-secret': 'nope' },
      query: {}
    }, wrong, { supabase: deniedDb.supabase, now: today, fetch: recordingFetch });
    assert.strictEqual(wrong.statusCode, 401);
    assert.strictEqual(deniedDb.calls.imports.length, 0);
    assert.strictEqual(sent.length, 0);
    console.log('✓ unauthorised requests return 401 and read nothing');

    var two = quietRows.concat(daily(NOISY, 'fuel@depot.example', '2026-10-22', '2026-11-02'));
    sent.length = 0;
    var both = await alert.runCheck({
      supabase: createSupabase(two, profiles).supabase,
      now: today,
      fetch: recordingFetch
    });
    assert.strictEqual(both.overdue, 2);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].body.subject, 'FleetMagnify: 2 data feed(s) have gone quiet');
    assert.strictEqual(sent[0].body.to, alert.ALERT_TO);
    assert.ok(sent[0].body.html.indexOf('fuel@depot.example') !== -1);
    assert.ok(sent[0].body.html.indexOf('Noise Ltd') !== -1);
    console.log('✓ two quiet feeds produce one email to the owner');

    console.log('ALL MISSING FEED ALERT TESTS PASSED');
  } finally {
    cap.restore();
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
    if (previousCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCron;
    if (previousAdmin === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = previousAdmin;
  }
}

main().catch(function (err) {
  console.error('\nFAILED:', err);
  process.exit(1);
});
