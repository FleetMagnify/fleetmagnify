/**
 * John Deere Utilization report: detection, one-day window, and the CSV link.
 * Invented serials, names, and URLs only. No network.
 *
 *   node scripts/test-john-deere-utilization.js
 */
var assert = require('assert');
var deere = require('../parsers/john-deere-utilization');
var visionlink = require('../parsers/visionlink');
var visionFuel = require('../parsers/visionlink-fuel');
var navman = require('../parsers/navman');
var mileage = require('../parsers/navman-mileage');
var idle = require('../parsers/navman-idle');
var bp = require('../parsers/bp');
var bpTx = require('../parsers/bp-transaction');
var mobil = require('../parsers/mobil');
var eroad = require('../parsers/eroad');
var links = require('../parsers/email-report-link');
var inbound = require('../api/email-inbound');
var idleRates = require('../parsers/visionlink-idle-rate');
var FCM = require('../js/fleet-cost-model');

var USER = '00000000-0000-4000-8000-0000000000d2';
var TO = 'yard-a3x9@uploads.fleetmagnify.com';
var HANDLE = '00000000-0000-4000-8000-0000000000d1';
var TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
var CF = 'https://dexample1234.cloudfront.net/?handle=' + HANDLE + '&token=' + TOKEN;
var S3 = 'https://' + deere.JOHN_DEERE_REPORT_S3_HOST +
  '/export/files/' + HANDLE + '.csv?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=EXAMPLE&X-Amz-Date=20261101T000000Z&X-Amz-Expires=86400&X-Amz-Security-Token=EXAMPLE&X-Amz-Signature=EXAMPLE&X-Amz-SignedHeaders=host&x-id=GetObject';
var MACHINE_REPORTS = 'https://machinereports.deere.com/org/example-logging';
var VL = 'https://vl.cat.com/downloadreport?token=FAKEVISIONTOKEN';

var COLS = [
  'Organization', 'Nickname', 'Machine Serial Number', 'Make', 'Type', 'Model',
  'Key On (l)', 'Low Load (l)', 'Medium Load (l)', 'High Load (l)', 'Idle (l)', 'Working (l)', 'Transport (l)', 'Total Fuel (l)',
  'Key On (h)', 'Low Load (h)', 'Medium Load (h)', 'High Load (h)', 'Idle (h)', 'Working (h)', 'Transport (h)', 'Total Hours',
  'Last Known Latitude', 'Last Known Longitude', 'Report Start Date', 'Report Start Time', 'Report End Date', 'Report End Time',
];

function quote(value) {
  return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
}

function dataRow(fields) {
  return COLS.map(function(col) {
    return quote(fields[col] == null ? '' : fields[col]);
  }).join(',');
}

function csv(rows) {
  return [COLS.map(quote).join(',')].concat(rows.map(dataRow)).join('\n');
}

function blankNums() {
  var out = {};
  [
    'Key On (l)', 'Low Load (l)', 'Medium Load (l)', 'High Load (l)', 'Idle (l)', 'Working (l)', 'Transport (l)', 'Total Fuel (l)',
    'Key On (h)', 'Low Load (h)', 'Medium Load (h)', 'High Load (h)', 'Idle (h)', 'Working (h)', 'Transport (h)', 'Total Hours',
  ].forEach(function(col) { out[col] = '---'; });
  return out;
}

function machine(over) {
  var row = Object.assign({
    Organization: '1000001',
    Nickname: '959MH - Example Logging',
    'Machine Serial Number': '1T0000TESTMH000001',
    Make: 'JOHN DEERE',
    Type: 'Forestry Harvester',
    Model: '959MH',
    'Key On (l)': '0.02',
    'Low Load (l)': '18.61',
    'Medium Load (l)': '66.08',
    'High Load (l)': '219.17',
    'Idle (l)': '3.14',
    'Working (l)': '---',
    'Transport (l)': '---',
    'Total Fuel (l)': '307.02',
    'Key On (h)': '0.31',
    'Low Load (h)': '1.64',
    'Medium Load (h)': '2.21',
    'High Load (h)': '4.03',
    'Idle (h)': '1.60',
    'Working (h)': '---',
    'Transport (h)': '---',
    'Total Hours': '9.47',
    'Last Known Latitude': '-41.5',
    'Last Known Longitude': '172.8',
    'Report Start Date': 'Oct 29, 2026',
    'Report Start Time': '12:00 AM',
    'Report End Date': 'Oct 30, 2026',
    'Report End Time': '12:00 AM',
  }, over || {});
  return row;
}

var ROW_A = machine();
var ROW_B = machine({
  Nickname: '2156GH - Example Logging',
  'Machine Serial Number': '1FF0000TESTGH000002',
  Type: 'Swing Machine',
  Model: '2156G',
  'Key On (l)': '---',
  'Low Load (l)': '14.49',
  'Medium Load (l)': '121.81',
  'High Load (l)': '225.75',
  'Idle (l)': '3.11',
  'Total Fuel (l)': '365.16',
  'Key On (h)': '0.04',
  'Low Load (h)': '1.95',
  'Medium Load (h)': '5.40',
  'High Load (h)': '7.18',
  'Idle (h)': '1.84',
  'Total Hours': '16.38',
  'Last Known Latitude': '-41.6',
  'Last Known Longitude': '172.9',
});

var ONE_DAY = csv([ROW_A, ROW_B]);

function captureConsole() {
  var lines = [];
  var origLog = console.log;
  var origWarn = console.warn;
  var origError = console.error;
  function push(args) { lines.push(Array.prototype.slice.call(args).join(' ')); }
  console.log = function() { push(arguments); };
  console.warn = function() { push(arguments); };
  console.error = function() { push(arguments); };
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

function assertNoSecret(text, label) {
  var blob = String(text);
  assert.strictEqual(blob.indexOf(TOKEN) === -1, true, (label || 'output') + ' contains the token');
  assert.strictEqual(blob.indexOf(HANDLE) === -1, true, (label || 'output') + ' contains the handle');
  assert.strictEqual(blob.indexOf(CF) === -1, true, (label || 'output') + ' contains the CloudFront URL');
  assert.strictEqual(blob.indexOf(S3) === -1, true, (label || 'output') + ' contains the S3 URL');
  assert.strictEqual(blob.indexOf('X-Amz') === -1, true, (label || 'output') + ' contains an S3 signature parameter');
  assert.strictEqual(blob.indexOf('handle=') === -1, true, (label || 'output') + ' contains a handle query');
  assert.strictEqual(blob.indexOf('token=') === -1, true, (label || 'output') + ' contains a token query');
}

function assets() {
  return [
    { id: 11, asset_name: 'Other name', visionlink_serial: '1t0000testmh000001', current_hours: 400, telematics_provider: null },
    { id: 12, asset_name: '2156GH', visionlink_serial: null, current_hours: 80, telematics_provider: '' },
    { id: 13, asset_name: 'Bracket Rig (1QQ0000BRACKET000003)', visionlink_serial: '', current_hours: 10, telematics_provider: 'VisionLink' },
  ];
}

function createMock(list) {
  var state = { inserts: [], updates: [], upserts: [] };
  var fleet = list || assets();
  function read(table) {
    if (table === 'assets') return { data: fleet, error: null };
    if (table === 'user_settings') return { data: { user_id: USER, upload_email: 'yard-a3x9' }, error: null };
    return { data: [], error: null };
  }
  function supabaseFrom(table) {
    return {
      select: function() {
        var chain = {
          eq: function() { return chain; },
          in: function() { return chain; },
          not: function() { return chain; },
          gt: function() { return chain; },
          order: function() { return chain; },
          limit: function() { return Promise.resolve(read(table)); },
          maybeSingle: function() { return Promise.resolve(read(table)); },
          single: function() { return Promise.resolve(read(table)); },
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
                return Promise.resolve({ data: { id: 'import-' + state.inserts.length }, error: null });
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
  return { supabase: { from: supabaseFrom }, state: state, assets: fleet };
}

function telematics(state) {
  return state.upserts.filter(function(entry) { return entry.table === 'telematics_records'; });
}

function pending(state) {
  return state.upserts.filter(function(entry) { return entry.table === 'pending_assets'; });
}

function hourUpdates(state) {
  return state.updates.filter(function(entry) {
    return entry.table === 'assets' && Object.prototype.hasOwnProperty.call(entry.payload, 'current_hours');
  });
}

function htmlEmail() {
  return [
    '<p>Utilization report has been generated</p>',
    '<p>Download the report (expires in 7 days):</p>',
    '<ul><li><a href="' + CF.replace(/&/g, '&amp;') + '">CSV</a></li></ul>',
    '<p>View in Machine Reports (expires in 90 days):</p>',
    '<a href="' + MACHINE_REPORTS + '">Open Operations Center</a>',
  ].join('');
}

function forwardedText() {
  return [
    'Example Logging desk',
    'From: JohnDeere@JohnDeere.com',
    'To: desk@example.com',
    'Date: Sun, 1 Nov 2026 18:00:00 +0000',
    'Subject: Daily Utilization (Utilization) Report Completed',
    '',
    'Utilization report has been generated',
    'Download the report (expires in 7 days):',
    '- CSV (' + CF + ')',
    'View in Machine Reports (' + MACHINE_REPORTS + ') (expires in 90 days)',
    'Organization',
    'Example Logging Co',
    'Category',
    'Reports',
    'Severity',
    'Info',
  ].join('\n');
}

function testLinks() {
  console.log('\n=== Link extraction ===');
  var fromHtml = deere.extractJohnDeereReportLinks(
    htmlEmail(),
    '',
    'Daily Utilization (Utilization) Report Completed'
  );
  assert.strictEqual(fromHtml.length, 1);
  assert.strictEqual(fromHtml[0], CF);

  var fromText = deere.extractJohnDeereReportLinks(
    '',
    forwardedText(),
    'Fwd: Daily Utilization (Utilization) Report Completed'
  );
  assert.strictEqual(fromText.length, 1);
  assert.strictEqual(fromText[0], CF);

  var both = deere.extractJohnDeereReportLinks(
    htmlEmail(),
    forwardedText(),
    'Fwd: Daily Utilization (Utilization) Report Completed'
  );
  assert.strictEqual(both.length, 1);

  assert.deepStrictEqual(deere.extractJohnDeereReportLinks(
    '<p>You are invited to Example Logging. Code 482913.</p><a href="' + CF + '">Join</a>',
    'Your invitation code is 482913',
    'You are invited to a John Deere team'
  ), []);
  assert.deepStrictEqual(deere.extractJohnDeereReportLinks(
    '<p>Your verification code is 482913.</p>',
    'Your verification code is 482913',
    'Verify your sign-in'
  ), []);
  assert.deepStrictEqual(deere.extractJohnDeereReportLinks(
    '<p>A password was changed for Example Logging.</p>',
    'Password changed. If this was not you, reset it.',
    'Your password was changed'
  ), []);

  assert.deepStrictEqual(deere.extractJohnDeereReportLinks(
    '<a href="https://evil.example/report.csv">CSV</a>',
    '',
    'Daily Utilization (Utilization) Report Completed'
  ), []);
  assert.deepStrictEqual(deere.extractJohnDeereReportLinks(
    '<a href="http://dexample1234.cloudfront.net/?handle=' + HANDLE + '&token=' + TOKEN + '">CSV</a>',
    '',
    'Daily Utilization (Utilization) Report Completed'
  ), []);
  assert.deepStrictEqual(deere.extractJohnDeereReportLinks(
    '<a href="' + CF + '">Download the report</a>',
    '',
    'Daily Utilization (Utilization) Report Completed'
  ), []);
  assert.deepStrictEqual(deere.extractJohnDeereReportLinks(
    '<a href="' + MACHINE_REPORTS + '">CSV</a>',
    'View in Machine Reports (' + MACHINE_REPORTS + ')',
    'Daily Utilization (Utilization) Report Completed'
  ), []);

  var visionMail = '<a href="' + VL + '">Download Report</a>';
  assert.deepStrictEqual(deere.extractJohnDeereReportLinks(
    visionMail,
    'Download Report ' + VL,
    'Report Completed'
  ), []);
  assert.deepStrictEqual(links.extractVisionLinkReportLinks(htmlEmail(), forwardedText()), []);
  assert.strictEqual(links.extractVisionLinkReportLinks(visionMail, '').length, 1);

  var many = [1, 2, 3, 4].map(function(n) {
    return '<a href="https://dexample' + n + '.cloudfront.net/?handle=00000000-0000-4000-8000-00000000000' + n + '&token=' + TOKEN.slice(0, 60) + String(n) + '">CSV</a>';
  }).join('');
  var capped = deere.extractJohnDeereReportLinks(many, '', 'Report Completed');
  assert.strictEqual(capped.length, 3);
  console.log('✓ HTML and forwarded text each yield one CloudFront CSV link');
}

function testDetection() {
  console.log('\n=== Detection ===');
  assert.strictEqual(deere.isJohnDeereUtilizationCsv(ONE_DAY), true);
  assert.strictEqual(deere.isJohnDeereUtilizationCsv('\uFEFF' + ONE_DAY), true);
  assert.strictEqual(deere.parseJohnDeereDate('Nov 1, 2026'), '2026-11-01');
  assert.strictEqual(deere.parseJohnDeereDate('Oct 29, 2026'), '2026-10-29');
  var midnight = deere.parseJohnDeereTime('12:00 AM');
  assert.strictEqual(midnight.hour, 0);
  assert.strictEqual(midnight.minute, 0);
  var evening = deere.parseJohnDeereTime('11:59 PM');
  assert.strictEqual(evening.hour, 23);
  assert.strictEqual(evening.minute, 59);

  var samples = [
    ['visionlink', visionlink.isVisionLinkCsv, 'Callouts,Asset ID,Asset Serial Number,Make,Model,Hour Meter (Hours),Runtime (Hours),Idle Time (Hours),Total Fuel Burned (L)\n"",EQ1,SER1,CAT,320,10,4,1,20'],
    ['visionlink-fuel', visionFuel.isVisionLinkFuelCsv, 'Asset ID,Asset Serial Number,Idle Fuel Burn (L),Working Fuel Burn (L),Total Fuel Burned (L),Runtime (Hours)\nEQ1,SER1,1,2,3,4'],
    ['navman', navman.isNavmanCsv, 'VehicleName,TotalHours,IdleTime\nTruck,8,1'],
    ['navman-mileage', mileage.isNavmanMileageCsv, 'Vehicle,ActivityDate,ActualDistance\nTruck,25/08/2026,10'],
    ['navman-idle', idle.isNavmanIdleCsv, 'Vehicle,IdleStart,IdleEnd,Duration\nTruck,25/08/2026 1:00 PM,25/08/2026 1:10 PM,10'],
    ['bp', bp.isBpCsv, 'Transaction Effective Date,Card Number,Litres,Customer Value ($)\n01/08/2026,123,40,80'],
    ['bp-transaction', bpTx.isBpTransactionCsv, 'Transaction Effective Date,Card Number,Litres,Customer Value ($),Vehicle Description\n01/08/2026,123,40,80,Truck'],
    ['mobil', mobil.isMobilCsv, 'Transaction Date,Card No.,Quantity,Total,Product Description\n01/08/2026,123,40,80,Diesel'],
    ['eroad', eroad.isEroadCsv, 'EROAD Fleet Summary Report,01/08/2026 - 01/08/2026\nid,Name,Rego/Plate,Distance (km),Running Time (hours),Total Idle Time Minutes\n1,Truck,ABC123,10,1,5'],
  ];
  samples.forEach(function(sample) {
    assert.strictEqual(sample[1](sample[2]), true, sample[0] + ' sample should match its own detector');
    assert.strictEqual(deere.isJohnDeereUtilizationCsv(sample[2]), false, sample[0] + ' sample matched John Deere');
    assert.strictEqual(sample[1](ONE_DAY), false, 'John Deere fixture matched ' + sample[0]);
  });
  console.log('✓ John Deere headers detected; no cross-match with existing samples');
}

async function parseFile(raw, list) {
  var mock = createMock(list);
  var cap = captureConsole();
  try {
    var result = await deere.parseJohnDeereUtilizationReport(mock.supabase, {
      userId: USER,
      importId: 'import-1',
      rawCsv: raw,
      filename: 'DailyUtilization_2026-11-02.csv',
    });
    return { result: result, mock: mock, log: cap.text() };
  } catch (err) {
    return { error: err, mock: mock, log: cap.text() };
  } finally {
    cap.restore();
  }
}

async function testParse() {
  console.log('\n=== Parse ===');
  var out = await parseFile('\uFEFF' + ONE_DAY);
  assert.ok(!out.error, out.error && out.error.message);
  assert.strictEqual(out.result.recordDate, '2026-10-29');
  assert.strictEqual(out.result.recordsUpserted, 2);
  assert.strictEqual(out.result.skippedEmpty, 0);
  assert.strictEqual(out.result.pendingStaged, 0);
  assert.strictEqual(
    out.result.summary,
    '2 updated, 0 staged, 0 skipped (no activity reported), record date 29 Oct 2026'
  );
  assert.strictEqual(telematics(out.mock.state).length, 1);
  var rows = telematics(out.mock.state)[0].rows;
  assert.strictEqual(telematics(out.mock.state)[0].opts.onConflict, 'asset_id,record_date');
  var byId = {};
  rows.forEach(function(row) { byId[row.asset_id] = row; });
  assert.strictEqual(byId[11].record_date, '2026-10-29');
  assert.strictEqual(byId[11].operating_hours, 7.87);
  assert.strictEqual(byId[11].idle_hours, 1.6);
  assert.strictEqual(byId[11].litres_consumed, 307.02);
  assert.strictEqual(byId[11].idle_fuel_litres, 3.14);
  assert.strictEqual(byId[11].working_fuel_litres, 303.86);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(byId[11], 'total_engine_hours'), false);
  assert.strictEqual(byId[12].operating_hours, 14.54);
  assert.strictEqual(byId[12].idle_hours, 1.84);
  assert.strictEqual(byId[12].litres_consumed, 365.16);
  assert.strictEqual(byId[12].idle_fuel_litres, 3.11);
  assert.strictEqual(byId[12].working_fuel_litres, 362.05);
  assert.strictEqual(hourUpdates(out.mock.state).length, 0);
  assert.ok(out.mock.state.updates.some(function(entry) {
    return entry.table === 'assets' && entry.payload.telematics_provider === 'John Deere' && entry.filters[0].val === 11;
  }));
  assert.ok(out.mock.state.updates.some(function(entry) {
    return entry.table === 'email_imports' && entry.payload.status === 'processed' && entry.payload.error_message === out.result.summary;
  }));
  console.log('✓ midnight-to-midnight file uses the start date and the working-hour convention');

  var again = await parseFile(ONE_DAY, out.mock.assets);
  assert.strictEqual(again.result.recordsUpserted, 2);
  var resent = telematics(again.mock.state)[0].rows;
  resent.forEach(function(row) {
    assert.strictEqual(row.record_date, '2026-10-29');
  });
  assert.deepStrictEqual(
    resent.map(function(row) { return row.asset_id; }).sort(),
    rows.map(function(row) { return row.asset_id; }).sort()
  );
  console.log('✓ a re-send of the same day upserts the same asset and date');

  var sameDay = await parseFile(csv([
    machine({ 'Report End Date': 'Oct 29, 2026', 'Report End Time': '11:59 PM' }),
    machine(Object.assign({}, ROW_B, { 'Report End Date': 'Oct 29, 2026', 'Report End Time': '11:59 PM' })),
  ]));
  assert.strictEqual(sameDay.result.recordDate, '2026-10-29');
  assert.strictEqual(sameDay.result.recordsUpserted, 2);
  console.log('✓ a same-day file is accepted');

  var twoDay = await parseFile(csv([
    machine({ 'Report End Date': 'Oct 31, 2026' }),
    machine(Object.assign({}, ROW_B, { 'Report End Date': 'Oct 31, 2026' })),
  ]));
  assert.ok(twoDay.error);
  assert.ok(twoDay.error.message.indexOf('29 Oct to 30 Oct') !== -1, twoDay.error.message);
  assert.ok(twoDay.error.message.indexOf('This John Deere report covers more than one day') === 0);
  assert.strictEqual(telematics(twoDay.mock.state).length, 0);
  assert.strictEqual(pending(twoDay.mock.state).length, 0);
  assert.ok(twoDay.mock.state.updates.some(function(entry) {
    return entry.payload.status === 'failed' && entry.payload.error_message.indexOf('29 Oct to 30 Oct') !== -1;
  }));
  console.log('✓ a two-day file writes nothing and explains 29 Oct to 30 Oct');

  var emptyRows = [ROW_A, ROW_B].map(function(row) {
    return Object.assign({}, row, blankNums(), {
      'Report Start Date': 'Nov 1, 2026',
      'Report End Date': 'Nov 2, 2026',
    });
  });
  var empty = await parseFile(csv(emptyRows));
  assert.ok(!empty.error, empty.error && empty.error.message);
  assert.strictEqual(empty.result.recordsUpserted, 0);
  assert.strictEqual(empty.result.pendingStaged, 0);
  assert.strictEqual(empty.result.skippedEmpty, 2);
  assert.strictEqual(
    empty.result.summary,
    '0 updated, 0 staged, 2 skipped (no activity reported), record date 1 Nov 2026'
  );
  assert.strictEqual(telematics(empty.mock.state).length, 0);
  assert.ok(empty.mock.state.updates.some(function(entry) {
    return entry.payload.status === 'processed' && entry.payload.error_message === empty.result.summary;
  }));
  console.log('✓ an all-empty file is a successful import');

  var quietUnknown = await parseFile(csv([
    Object.assign({}, emptyRows[0], {
      Nickname: '000X - Nowhere Logging',
      'Machine Serial Number': '1ZZ0000NOMATCH000099',
      Type: 'Swing Machine',
      Model: '2156G',
    }),
  ]));
  assert.strictEqual(quietUnknown.result.recordsUpserted, 0);
  assert.strictEqual(quietUnknown.result.pendingStaged, 1);
  assert.strictEqual(quietUnknown.result.skippedEmpty, 1);
  assert.strictEqual(telematics(quietUnknown.mock.state).length, 0);
  var stagedQuiet = pending(quietUnknown.mock.state)[0].rows;
  assert.strictEqual(stagedQuiet.asset_name, '000X');
  assert.strictEqual(stagedQuiet.asset_type, 'Swing Machine');
  assert.strictEqual(stagedQuiet.raw_data.serial, '1ZZ0000NOMATCH000099');
  assert.strictEqual(stagedQuiet.raw_data.make, 'John Deere');
  assert.strictEqual(stagedQuiet.raw_data.telematicsProvider, 'John Deere');
  assert.strictEqual(stagedQuiet.source, 'john-deere');
  console.log('✓ an unmatched machine with no activity is staged and not written');

  var extra = await parseFile(csv([
    machine({
      Nickname: '000X - Nowhere Logging',
      'Machine Serial Number': '1ZZ0000NOMATCH000099',
      Type: 'Forestry Harvester',
      Model: '959MH',
    }),
    machine({
      Nickname: 'Other - Name',
      'Machine Serial Number': '1QQ0000BRACKET000003',
      Type: 'Excavator',
      Model: '200G',
    }),
    machine({
      Nickname: 'Split Unknown - Example Logging',
      'Machine Serial Number': '1T0000TESTMH000001',
      'Low Load (l)': '---',
      'Medium Load (l)': '---',
      'High Load (l)': '---',
      'Idle (l)': '2.00',
      'Working (l)': '12.50',
      'Transport (l)': '1.25',
      'Total Fuel (l)': '15.75',
      'Low Load (h)': '---',
      'Medium Load (h)': '---',
      'High Load (h)': '---',
      'Idle (h)': '1.00',
      'Total Hours': '4.00',
      'Key On (l)': '---',
      'Key On (h)': '---',
    }),
  ]));
  assert.ok(!extra.error, extra.error && extra.error.message);
  assert.strictEqual(extra.result.pendingStaged, 1);
  var staged = pending(extra.mock.state)[0].rows;
  assert.strictEqual(staged.asset_name, '000X');
  assert.strictEqual(staged.asset_type, 'Forestry Harvester');
  assert.strictEqual(staged.raw_data.model, '959MH');
  var written = telematics(extra.mock.state)[0].rows;
  assert.strictEqual(written.length, 2);
  var split = written.filter(function(row) { return row.asset_id === 11; })[0];
  assert.strictEqual(split.operating_hours, 3);
  assert.strictEqual(split.idle_hours, 1);
  assert.strictEqual(split.litres_consumed, 15.75);
  assert.strictEqual(split.idle_fuel_litres, 2);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(split, 'working_fuel_litres'), false);
  assert.ok(extra.log.indexOf('Working (l)') !== -1);
  assert.ok(extra.log.indexOf('Transport (l)') !== -1);
  assert.ok(extra.log.indexOf('not guessing') !== -1);
  var bracket = written.filter(function(row) { return row.asset_id === 13; })[0];
  assert.ok(bracket);
  assert.ok(!extra.mock.state.updates.some(function(entry) {
    return entry.table === 'assets' && entry.filters[0].val === 13;
  }));
  console.log('✓ serial, nickname, and bracket matches; unmapped working litres are not guessed');

  var noFuel = await parseFile(csv([
    machine(Object.assign(blankNums(), {
      'Low Load (h)': '1.00',
      'Medium Load (h)': '2.00',
      'High Load (h)': '3.50',
      'Idle (h)': '---',
      'Total Hours': '---',
      'Total Fuel (l)': '---',
      'Idle (l)': '---',
    })),
  ]));
  assert.ok(!noFuel.error, noFuel.error && noFuel.error.message);
  var fuelBlank = telematics(noFuel.mock.state)[0].rows[0];
  assert.strictEqual(fuelBlank.operating_hours, 6.5);
  assert.strictEqual(fuelBlank.litres_consumed, null);
  assert.strictEqual(fuelBlank.idle_fuel_litres, null);
  assert.strictEqual(fuelBlank.idle_hours, null);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(fuelBlank, 'working_fuel_litres'), false);
  assert.strictEqual(JSON.stringify(fuelBlank).indexOf(':0') === -1, true);
  console.log('✓ "---" stays null, never 0, and missing totals fall back to the load-band hours');
}

function testRates() {
  console.log('\n=== Rates from the first fixture row ===');
  var idleRate = 3.14 / 1.6;
  assert.ok(Math.abs(idleRate - 1.96) < 0.01, String(idleRate));
  var days = [1, 2, 3].map(function(n) {
    return {
      record_date: '2026-10-' + String(n).padStart(2, '0'),
      operating_hours: 7.87,
      working_fuel_litres: 303.86,
      idle_hours: 1.6,
      idle_fuel_litres: 3.14,
    };
  });
  var working = FCM.measuredWorkingRate(days);
  assert.strictEqual(working.rate, 38.61);
  assert.strictEqual(working.rate.toFixed(1), '38.6');
  var label = FCM.resolvedIdleRate({
    asset_type: 'Forestry Harvester',
    telematics_provider: 'John Deere',
    idle_burn_rate_lph: 1.96,
    idle_rate_source: 'measured',
  });
  assert.strictEqual(label.rate, 1.96);
  assert.strictEqual(label.label, 'Measured (telematics)');

  var updates = [];
  var idleRows = days.map(function(day) {
    return { record_date: day.record_date, idle_fuel_litres: 3.14, idle_hours: 1.6 };
  });
  var supabase = {
    from: function(table) {
      return {
        select: function() {
          var chain = {
            eq: function() { return chain; },
            not: function() { return chain; },
            gt: function() { return chain; },
            order: function() { return chain; },
            limit: function() {
              return Promise.resolve({
                data: table === 'assets'
                  ? [{ id: 11, asset_type: 'Forestry Harvester', idle_burn_rate_lph: null, idle_rate_source: null }]
                  : idleRows,
                error: null,
              });
            },
          };
          return chain;
        },
        update: function(payload) {
          updates.push(payload);
          var chain = {
            eq: function() { return chain; },
            then: function(resolve) { resolve({ error: null }); },
          };
          return chain;
        },
      };
    },
  };
  return idleRates.recomputeMeasuredIdleRates(supabase, USER, [11]).then(function() {
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].idle_burn_rate_lph, 1.96);
    assert.strictEqual(updates[0].idle_rate_source, 'measured');
    console.log('✓ idle is about 1.96 L/h and working is about 38.6 L/h');
  });
}

function response(body, status, headers) {
  return new Response(body, { status: status || 200, headers: headers || { 'content-type': 'text/csv' } });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location: location } });
}

async function runInbound(fields, files, download) {
  var mock = createMock();
  var cap = captureConsole();
  var alerts = [];
  var calls = [];
  var previousKey = process.env.RESEND_API_KEY;
  var previousFetch = global.fetch;
  process.env.RESEND_API_KEY = 'test-resend-key';
  global.fetch = function(url, opts) {
    var href = String(url);
    calls.push({ url: href, opts: opts || {} });
    if (href.indexOf('api.resend.com') !== -1) {
      alerts.push(JSON.parse(opts.body));
      return Promise.resolve(response('{}', 200, { 'content-type': 'application/json' }));
    }
    return download(href, opts || {}, calls);
  };
  try {
    var result = await inbound.processInboundEmail(mock.supabase, {
      receivedAt: '2026-11-02T18:00:00.000Z',
      fields: fields,
      files: files || [],
    });
    return { result: result, mock: mock, log: cap.text(), alerts: alerts, calls: calls };
  } finally {
    cap.restore();
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
  }
}

function secretBlob(run) {
  return [
    run.log,
    JSON.stringify(run.mock.state.inserts),
    JSON.stringify(run.mock.state.updates),
    JSON.stringify(run.mock.state.upserts),
    JSON.stringify(run.alerts),
  ].join('\n');
}

async function testFetch() {
  console.log('\n=== Link fetch ===');
  var novFile = csv([
    machine({ 'Report Start Date': 'Nov 1, 2026', 'Report End Date': 'Nov 2, 2026' }),
    machine(Object.assign({}, ROW_B, { 'Report Start Date': 'Nov 1, 2026', 'Report End Date': 'Nov 2, 2026' })),
  ]);
  var mail = {
    to: TO,
    from: 'desk@example.com',
    subject: 'Fwd: Daily Utilization (Utilization) Report Completed',
    text: forwardedText(),
    html: '',
  };

  var direct = await runInbound(mail, [], function() {
    return Promise.resolve(response(novFile, 200, {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="DailyUtilization_2026-11-02.csv"',
    }));
  });
  assert.strictEqual(direct.calls.length, 1);
  assert.strictEqual(telematics(direct.mock.state).length, 1);
  assert.strictEqual(telematics(direct.mock.state)[0].rows[0].record_date, '2026-11-01');
  assert.ok(direct.mock.state.inserts.some(function(entry) {
    return entry.row.filename === 'DailyUtilization_2026-11-02.csv' && entry.row.status === 'pending';
  }));
  assert.ok(!direct.mock.state.inserts.some(function(entry) { return entry.row.status === 'no_attachment'; }));
  assertNoSecret(secretBlob(direct), 'direct csv');
  console.log('✓ a CSV response imports, and the filename date is not the record date');

  var hopped = await runInbound(mail, [], function(url, opts, calls) {
    if (calls.length === 1) return Promise.resolve(redirect(S3));
    assert.strictEqual(opts.headers, undefined);
    assert.ok(!opts.headers || !opts.headers.Cookie);
    assert.ok(!opts.headers || !opts.headers.Authorization);
    assert.strictEqual(opts.redirect, 'manual');
    return Promise.resolve(response(novFile, 200, {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="DailyUtilization_2026-11-02.csv"',
    }));
  });
  assert.strictEqual(hopped.calls.length, 2);
  assert.strictEqual(telematics(hopped.mock.state)[0].rows[0].record_date, '2026-11-01');
  assertNoSecret(secretBlob(hopped), 'redirect csv');
  console.log('✓ a 302 to the allowed S3 host imports with no cookie or Authorization header');

  var html = await runInbound(mail, [], function() {
    return Promise.resolve(response(
      '<html><body><p>Example portal page</p></body></html>',
      200,
      { 'content-type': 'text/html; charset=utf-8' }
    ));
  });
  assert.strictEqual(telematics(html.mock.state).length, 0);
  var htmlRow = html.mock.state.inserts.filter(function(entry) { return entry.row.status === 'failed'; })[0].row;
  assert.ok(htmlRow.error_message.indexOf('did not return a Utilization CSV') !== -1);
  assert.ok(htmlRow.error_message.indexOf('HTTP 200') !== -1);
  assert.ok(htmlRow.error_message.indexOf('text/html') !== -1);
  assert.ok(htmlRow.error_message.indexOf('Example portal page') !== -1);
  assert.strictEqual(html.alerts.length, 1);
  assert.ok(html.alerts[0].html.indexOf('John Deere download link could not be fetched:') !== -1);
  assertNoSecret(secretBlob(html), 'html body');
  console.log('✓ an HTML body records status, content type, and a snippet');

  var emptyBody = await runInbound(mail, [], function() {
    return Promise.resolve(response('', 200, { 'content-type': 'text/plain' }));
  });
  var emptyRow = emptyBody.mock.state.inserts.filter(function(entry) { return entry.row.status === 'failed'; })[0].row;
  assert.ok(emptyRow.error_message.indexOf('HTTP 200') !== -1);
  assert.ok(emptyRow.error_message.indexOf('text/plain') !== -1);
  assert.ok(emptyRow.error_message.indexOf('bytes 0') !== -1);
  assert.strictEqual(telematics(emptyBody.mock.state).length, 0);
  assertNoSecret(secretBlob(emptyBody), 'empty body');
  console.log('✓ an empty 200 is a failed import with status, content type, and length');

  var otherHost = await runInbound(mail, [], function() {
    return Promise.resolve(redirect('https://other-bucket.s3.us-east-1.amazonaws.com/file.csv?X-Amz-Signature=EXAMPLE'));
  });
  var otherRow = otherHost.mock.state.inserts.filter(function(entry) { return entry.row.status === 'failed'; })[0].row;
  assert.ok(otherRow.error_message.indexOf('other-bucket.s3.us-east-1.amazonaws.com') !== -1, otherRow.error_message);
  assert.strictEqual(telematics(otherHost.mock.state).length, 0);
  assertNoSecret(secretBlob(otherHost), 'other bucket');
  console.log('✓ a redirect to another bucket is refused and names the hostname');

  var httpHop = await runInbound(mail, [], function() {
    return Promise.resolve(redirect('http://evil.example/file.csv?token=' + TOKEN));
  });
  var httpRow = httpHop.mock.state.inserts.filter(function(entry) { return entry.row.status === 'failed'; })[0].row;
  assert.ok(httpRow.error_message.indexOf('evil.example') !== -1, httpRow.error_message);
  assertNoSecret(secretBlob(httpHop), 'http redirect');
  console.log('✓ an http redirect is refused and names the hostname');

  var tooMany = await runInbound(mail, [], function(url, opts, calls) {
    return Promise.resolve(redirect(
      'https://' + deere.JOHN_DEERE_REPORT_S3_HOST + '/r' + calls.length + '?X-Amz-Signature=EXAMPLE'
    ));
  });
  var manyRow = tooMany.mock.state.inserts.filter(function(entry) { return entry.row.status === 'failed'; })[0].row;
  assert.ok(manyRow.error_message.indexOf('too many redirects') !== -1, manyRow.error_message);
  var reportCalls = tooMany.calls.filter(function(call) {
    return call.url.indexOf('api.resend.com') === -1;
  });
  assert.strictEqual(reportCalls.length, 3);
  assertNoSecret(secretBlob(tooMany), 'too many redirects');
  console.log('✓ more than 2 redirects is refused');

  var huge = await runInbound(mail, [], function() {
    return Promise.resolve(response('x', 200, {
      'content-type': 'text/csv',
      'content-length': String(6 * 1024 * 1024),
    }));
  });
  var hugeRow = huge.mock.state.inserts.filter(function(entry) { return entry.row.status === 'failed'; })[0].row;
  assert.ok(hugeRow.error_message.indexOf('exceeded 5 MB') !== -1, hugeRow.error_message);
  assert.strictEqual(telematics(huge.mock.state).length, 0);
  assertNoSecret(secretBlob(huge), 'oversized');
  console.log('✓ an oversized body is refused');

  var attached = await runInbound({
    to: TO,
    from: 'desk@example.com',
    subject: 'Daily Utilization (Utilization) Report Completed',
    text: 'CSV attached',
    html: '',
  }, [{
    filename: 'DailyUtilization_2026-11-02.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(ONE_DAY),
  }], function() {
    throw new Error('attachment must not be fetched');
  });
  assert.strictEqual(attached.calls.length, 0);
  assert.strictEqual(telematics(attached.mock.state)[0].rows[0].record_date, '2026-10-29');
  assert.ok(attached.mock.state.updates.some(function(entry) {
    return entry.payload.status === 'processed';
  }));
  assert.ok(!attached.mock.state.updates.some(function(entry) {
    return entry.payload.status === 'unrecognized';
  }));
  console.log('✓ a John Deere CSV attachment imports without a link fetch');

  var invite = await runInbound({
    to: TO,
    from: 'desk@example.com',
    subject: 'You are invited to a John Deere team',
    text: 'Join Example Logging. Your code is 482913.',
    html: '<p>Join Example Logging.</p>',
  }, [], function() { throw new Error('an invitation must not be fetched'); });
  assert.strictEqual(invite.calls.length, 0);
  assert.strictEqual(telematics(invite.mock.state).length, 0);
  assert.strictEqual(invite.mock.state.inserts.length, 1);
  assert.strictEqual(invite.mock.state.inserts[0].row.status, 'no_attachment');
  console.log('✓ an invitation is not treated as a report');
}

async function main() {
  testLinks();
  testDetection();
  await testParse();
  await testRates();
  await testFetch();
  console.log('\nALL JOHN DEERE UTILIZATION TESTS PASSED');
}

main().catch(function(err) {
  console.error('\nFAILED:', err);
  process.exit(1);
});
