/**
 * Forestry asset types and idle-rate defaults.
 * Reads the pages as text and runs the extracted helpers. No browser.
 * Invented type names only.
 *
 *   node scripts/test-asset-types.js
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var deere = require('../parsers/john-deere-utilization');
var FCM = require('../js/fleet-cost-model');

var root = path.join(__dirname, '..');
var assetsPath = path.join(root, 'assets.html');
var html = fs.readFileSync(assetsPath, 'utf8');

var NEW_RATES = {
  'Skidder': 3.5,
  'Forestry Harvester': 4.0,
  'Swing Machine': 4.0
};

var PAGE_RATES = {
  'Excavator': 4.0,
  'Dump Truck': 5.5,
  'Wheel Loader': 4.5,
  'Motor Grader': 4.0,
  'Bulldozer': 5.0,
  'Skidder': 3.5,
  'Forestry Harvester': 4.0,
  'Swing Machine': 4.0,
  'Compactor': 2.5,
  'Crane': 4.5,
  'Forklift': 1.5,
  'Light Vehicle': 1.2,
  'Rigid Truck': 2.5,
  'Semi Trailer': 3.0,
  'Truck & Trailer': 3.0,
  'Water Truck': 3.5,
  'Other': 3.0
};

var MODEL_RATES = Object.assign({}, PAGE_RATES, { 'Motor Grader': 3.0 });

var TRUCK_RATES = {
  'Light Vehicle': 1.2,
  'Rigid Truck': 2.5,
  'Semi Trailer': 3.0,
  'Truck & Trailer': 3.0,
  'Truck and Trailer / B-Train': 3.0
};

var EXPECTED_TABLES = {
  'assets.html': PAGE_RATES,
  'home.html': PAGE_RATES,
  'idle-cost-analyst.html': PAGE_RATES,
  'job-cost-analyst.html': PAGE_RATES,
  'reports.html': PAGE_RATES,
  'emissions-intelligence.html': PAGE_RATES,
  'fuel-analyst.html': PAGE_RATES,
  'js/fleet-cost-model.js': MODEL_RATES,
  'truck-idle-monitor.html': TRUCK_RATES
};

function extractFunction(source, name) {
  var marker = 'function ' + name + '(';
  var start = source.indexOf(marker);
  if (start === -1) throw new Error('missing function ' + name);
  var i = source.indexOf('{', start);
  var depth = 0;
  var quote = '';
  for (; i < source.length; i++) {
    var ch = source[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unclosed function ' + name);
}

function extractAssignedLiteral(source, name) {
  var marker = 'var ' + name + ' = ';
  var start = source.indexOf(marker);
  if (start === -1) throw new Error('missing var ' + name);
  var i = start + marker.length;
  var open = source[i];
  var close = open === '{' ? '}' : open === '[' ? ']' : '';
  if (!close) throw new Error(name + ' is not an object or array');
  var depth = 0;
  var quote = '';
  for (; i < source.length; i++) {
    var ch = source[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return source.slice(start + marker.length, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

function evalLiteral(literal) {
  return new Function('return ' + literal + ';')();
}

function extractEsc(source) {
  var start = source.indexOf('function esc(str)');
  if (start === -1) throw new Error('missing function esc');
  var end = source.indexOf('\n  }', start);
  if (end === -1) throw new Error('unclosed function esc');
  return source.slice(start, end + 4);
}

function listSourceFiles(dir, acc) {
  fs.readdirSync(dir).forEach(function(name) {
    if (name === 'node_modules' || name === '.git') return;
    var full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) listSourceFiles(full, acc);
    else if (/\.(html|js)$/.test(name)) acc.push(full);
  });
  return acc;
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function selectOptionValues(page) {
  var start = page.indexOf('<select id="asset-type">');
  var end = page.indexOf('</select>', start);
  assert.ok(start !== -1 && end > start, 'Asset Type select missing');
  var block = page.slice(start, end);
  var values = [];
  var re = /<option value="([^"]*)"/g;
  var match;
  while ((match = re.exec(block))) {
    if (match[1] !== '') values.push(match[1]);
  }
  return values;
}

function decodeEntities(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function selectedOptionValues(markup) {
  var out = [];
  var re = /<option value="([^"]*)"([^>]*)>/g;
  var match;
  while ((match = re.exec(markup))) {
    if (/\sselected(?:=|\s|>|$)/.test(match[2]) || /selected$/.test(match[2])) {
      out.push(decodeEntities(match[1]));
    }
  }
  return out;
}

function rateKey(n) {
  return Number(n).toFixed(1);
}

var assetTypeOptions = evalLiteral(extractAssignedLiteral(html, 'ASSET_TYPE_OPTIONS'));
var onRoadTypes = evalLiteral(extractAssignedLiteral(html, 'ON_ROAD_TYPES'));
var onRoadSet = evalLiteral(extractAssignedLiteral(html, 'ON_ROAD_TYPE_SET'));
var choices = new Function(
  'var ASSET_TYPE_OPTIONS = ' + extractAssignedLiteral(html, 'ASSET_TYPE_OPTIONS') + ';\n' +
  extractFunction(html, 'assetTypeChoices') + '\n' +
  'return assetTypeChoices;'
)();
var buildOptionsHtml = new Function(
  'var ASSET_TYPE_OPTIONS = ' + extractAssignedLiteral(html, 'ASSET_TYPE_OPTIONS') + ';\n' +
  extractFunction(html, 'assetTypeChoices') + '\n' +
  extractFunction(html, 'buildAssetTypeOptionsHtml') + '\n' +
  extractEsc(html) + '\n' +
  'return buildAssetTypeOptionsHtml;'
)();
var validators = new Function(
  'var ON_ROAD_TYPE_SET = ' + extractAssignedLiteral(html, 'ON_ROAD_TYPE_SET') + ';\n' +
  extractFunction(html, 'isOnRoadType') + '\n' +
  extractFunction(html, 'validateImportRow') + '\n' +
  extractFunction(html, 'validateSheetTypeForAsset') + '\n' +
  'return { validateImportRow: validateImportRow, validateSheetTypeForAsset: validateSheetTypeForAsset, isOnRoadType: isOnRoadType };'
)();

console.log('\n=== Asset Type select and ASSET_TYPE_OPTIONS ===');

var selectValues = selectOptionValues(html);
assert.deepStrictEqual(selectValues, assetTypeOptions);
var skidderAt = assetTypeOptions.indexOf('Skidder');
assert.ok(skidderAt !== -1, 'Skidder missing from ASSET_TYPE_OPTIONS');
assert.strictEqual(assetTypeOptions[skidderAt + 1], 'Forestry Harvester');
assert.strictEqual(assetTypeOptions[skidderAt + 2], 'Swing Machine');
assert.strictEqual(selectValues[skidderAt + 1], 'Forestry Harvester');
assert.strictEqual(selectValues[skidderAt + 2], 'Swing Machine');
['Forestry Harvester', 'Swing Machine', 'Skidder'].forEach(function(type) {
  assert.strictEqual(onRoadTypes.indexOf(type), -1, type + ' must stay off the on-road list');
  assert.strictEqual(onRoadSet[type], undefined, type + ' must stay off the on-road set');
});
console.log('✓ select, ASSET_TYPE_OPTIONS, and order after Skidder match');

console.log('\n=== Valid asset_type notes ===');

var machineryNote = 'Valid asset_type values: Excavator, Dump Truck, Wheel Loader, Motor Grader, Bulldozer, Skidder, Forestry Harvester, Swing Machine, Crane, Forklift, Water Truck, Other';
var trucksNote = 'Valid asset_type values: Light Vehicle, Rigid Truck, Semi Trailer, Truck & Trailer';
assert.strictEqual(html.split(machineryNote).length - 1, 2, 'MACHINERY_TYPE_NOTE and the template note');
assert.ok(html.indexOf(trucksNote) !== -1);
['Skidder', 'Forestry Harvester', 'Swing Machine'].forEach(function(type) {
  assert.strictEqual(trucksNote.indexOf(type), -1);
});
console.log('✓ machinery notes include Skidder, Forestry Harvester, and Swing Machine');

console.log('\n=== Bulk-import type checks ===');

var bulk = fs.readFileSync(path.join(root, 'api', 'bulk-import.js'), 'utf8');
assert.strictEqual(bulk.indexOf('asset_type'), -1);
assert.strictEqual(bulk.indexOf('Forestry Harvester'), -1);
assert.strictEqual(bulk.indexOf('Swing Machine'), -1);
console.log('✓ api/bulk-import.js does not whitelist asset_type (telematics CSV dispatch only)');

['Skidder', 'Forestry Harvester', 'Swing Machine', 'Future Mill'].forEach(function(type) {
  var row = { asset_name: 'Example ' + type, asset_type: type, fuel_type: 'Diesel', _rowNum: 3 };
  assert.deepStrictEqual(validators.validateImportRow(row, 'machinery'), [], type);
  assert.deepStrictEqual(validators.validateSheetTypeForAsset('machinery', type), [], type);
  assert.strictEqual(validators.isOnRoadType(type), false, type);
  var onTrucks = validators.validateImportRow(row, 'trucks');
  assert.ok(onTrucks.some(function(issue) {
    return issue.indexOf('machinery asset type "' + type + '"') !== -1;
  }), type + ' should stay off the Trucks sheet');
});
var rigidOnMachinery = validators.validateImportRow({
  asset_name: 'Example Rigid',
  asset_type: 'Rigid Truck',
  fuel_type: 'Diesel'
}, 'machinery');
assert.ok(rigidOnMachinery.some(function(issue) { return issue.indexOf('on-road asset type') !== -1; }));
console.log('✓ machinery sheet accepts the forestry types and Skidder; Trucks sheet does not');

console.log('\n=== DEFAULT_IDLE_RATES copies ===');

var tables = [];
var rateMarker = 'var DEFAULT_IDLE_RATES = ';
listSourceFiles(root, []).forEach(function(file) {
  var source = fs.readFileSync(file, 'utf8');
  var at = source.indexOf(rateMarker);
  if (at === -1) return;
  if (source[at + rateMarker.length] !== '{') return;
  var literal = extractAssignedLiteral(source, 'DEFAULT_IDLE_RATES');
  tables.push({
    file: rel(file),
    literal: literal,
    rates: evalLiteral(literal)
  });
});
tables.sort(function(a, b) { return a.file < b.file ? -1 : a.file > b.file ? 1 : 0; });

var foundFiles = tables.map(function(t) { return t.file; });
assert.deepStrictEqual(foundFiles, Object.keys(EXPECTED_TABLES).sort());

var machineryTypes = assetTypeOptions.filter(function(type) {
  return onRoadTypes.indexOf(type) === -1;
});

tables.forEach(function(table) {
  assert.deepStrictEqual(table.rates, EXPECTED_TABLES[table.file], table.file);
  var onRoadOnly = Object.keys(table.rates).every(function(key) {
    return !!onRoadSet[key];
  });
  if (onRoadOnly) {
    Object.keys(NEW_RATES).forEach(function(type) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(table.rates, type), false, table.file + ' ' + type);
    });
    return;
  }
  machineryTypes.forEach(function(type) {
    assert.strictEqual(typeof table.rates[type], 'number', table.file + ' missing ' + type);
  });
  Object.keys(NEW_RATES).forEach(function(type) {
    assert.strictEqual(table.rates[type], NEW_RATES[type], table.file + ' ' + type);
  });
});

var fuelLiteral = tables.filter(function(t) { return t.file === 'fuel-analyst.html'; })[0].literal;
fuelLiteral.split('\n').forEach(function(line) {
  var keys = line.match(/'[^']+'\s*:/g) || [];
  assert.ok(keys.length <= 1, 'fuel-analyst.html should keep one rate per line: ' + line);
});

var disagreements = [];
var allKeys = {};
tables.forEach(function(table) {
  Object.keys(table.rates).forEach(function(key) { allKeys[key] = true; });
});
Object.keys(allKeys).sort().forEach(function(key) {
  var byValue = {};
  tables.forEach(function(table) {
    if (!Object.prototype.hasOwnProperty.call(table.rates, key)) return;
    var bucket = rateKey(table.rates[key]);
    if (!byValue[bucket]) byValue[bucket] = [];
    byValue[bucket].push(table.file);
  });
  if (Object.keys(byValue).length > 1) disagreements.push({ key: key, byValue: byValue });
});
console.log('Idle-rate disagreements (same key, different number):');
if (!disagreements.length) console.log('  none');
disagreements.forEach(function(item) {
  console.log('  ' + item.key);
  Object.keys(item.byValue).sort().forEach(function(value) {
    console.log('    ' + value + ': ' + item.byValue[value].join(', '));
  });
});
assert.strictEqual(disagreements.length, 1, JSON.stringify(disagreements));
assert.strictEqual(disagreements[0].key, 'Motor Grader');
assert.deepStrictEqual(disagreements[0].byValue['3.0'], ['js/fleet-cost-model.js']);
assert.deepStrictEqual(disagreements[0].byValue['4.0'].slice().sort(), [
  'assets.html',
  'emissions-intelligence.html',
  'fuel-analyst.html',
  'home.html',
  'idle-cost-analyst.html',
  'job-cost-analyst.html',
  'reports.html'
]);
console.log('✓ every machinery table has the new rates; existing numbers are unchanged');

console.log('\n=== FleetCostModel defaults ===');

assert.strictEqual(FCM.defaultIdleRateForAsset({ asset_type: 'Forestry Harvester' }), 4.0);
assert.strictEqual(FCM.defaultIdleRateForAsset({ asset_type: 'Swing Machine' }), 4.0);
assert.strictEqual(FCM.defaultIdleRateForAsset({ asset_type: 'Skidder' }), 3.5);
assert.strictEqual(FCM.defaultIdleRateForAsset({ asset_type: 'Other' }), 3.0);
assert.notStrictEqual(FCM.defaultIdleRateForAsset({ asset_type: 'Skidder' }), FCM.defaultIdleRateForAsset({ asset_type: 'Other' }));
assert.strictEqual(FCM.defaultIdleRateForAsset({ asset_type: 'Not A Listed Type' }), 3.0);
assert.strictEqual(FCM.DEFAULT_IDLE_RATES['Forestry Harvester'], 4.0);
assert.strictEqual(FCM.DEFAULT_IDLE_RATES['Swing Machine'], 4.0);
assert.strictEqual(FCM.DEFAULT_IDLE_RATES.Skidder, 3.5);
var harvesterDefault = FCM.resolvedIdleRate({ asset_type: 'Forestry Harvester' });
var swingDefault = FCM.resolvedIdleRate({ asset_type: 'Swing Machine' });
var skidderDefault = FCM.resolvedIdleRate({ asset_type: 'Skidder' });
assert.strictEqual(harvesterDefault.rate, 4.0);
assert.strictEqual(harvesterDefault.source, 'default');
assert.strictEqual(swingDefault.rate, 4.0);
assert.strictEqual(swingDefault.source, 'default');
assert.strictEqual(skidderDefault.rate, 3.5);
assert.strictEqual(skidderDefault.source, 'default');
console.log('✓ Forestry Harvester and Swing Machine default to 4.0; Skidder defaults to 3.5');

console.log('\n=== johnDeereAssetType branches ===');

var branches = [
  [undefined, 'Other'],
  [null, 'Other'],
  ['', 'Other'],
  ['   ', 'Other'],
  ['---', 'Other'],
  [' null ', 'Other'],
  ['Excavator', 'Excavator'],
  ['tracked excavator', 'Excavator'],
  ['Wheel Loader', 'Wheel Loader'],
  ['WHEEL LOADER', 'Wheel Loader'],
  ['Log Skidder 848L', 'Skidder'],
  ['Dozer', 'Bulldozer'],
  ['Crawler', 'Bulldozer'],
  ['Motor Grader', 'Motor Grader'],
  ['Compactor', 'Compactor'],
  ['Forklift', 'Forklift'],
  ['Telehandler', 'Forklift'],
  ['Crane', 'Crane'],
  ['Dump Truck', 'Dump Truck'],
  ['Articulated Truck', 'Dump Truck'],
  ['Forestry Harvester', 'Forestry Harvester'],
  ['FORESTRY HARVESTER', 'Forestry Harvester'],
  ['Swing Machine', 'Swing Machine'],
  ['swing', 'Swing Machine'],
  ['Forwarder', 'Other']
];
var returned = {};
branches.forEach(function(pair) {
  var actual = deere.johnDeereAssetType(pair[0]);
  assert.strictEqual(actual, pair[1], JSON.stringify(pair[0]) + ' → ' + actual);
  returned[actual] = true;
});
Object.keys(returned).forEach(function(type) {
  assert.ok(selectValues.indexOf(type) !== -1, type + ' missing from the Asset Type select');
  assert.ok(assetTypeOptions.indexOf(type) !== -1, type + ' missing from ASSET_TYPE_OPTIONS');
});
console.log('✓ every johnDeereAssetType branch is in the select and ASSET_TYPE_OPTIONS');

console.log('\n=== Edit form keeps an unknown saved type ===');

var editForm = extractFunction(html, 'openEditModal');
var resetForm = extractFunction(html, 'resetAssetForm');
var setter = extractFunction(html, 'setAssetTypeSelect');
assert.ok(editForm.indexOf('setAssetTypeSelect(asset.asset_type)') !== -1);
assert.strictEqual(editForm.indexOf("setSelectValue('asset-type'"), -1);
assert.ok(resetForm.indexOf("setAssetTypeSelect('')") !== -1);
assert.ok(setter.indexOf('assetTypeChoices(selectedType)') !== -1);
assert.ok(setter.indexOf('select.value = model.selected') !== -1);

function assertKept(saved, expectedSelected) {
  var model = choices(saved);
  assert.strictEqual(model.selected, expectedSelected, JSON.stringify(saved));
  assert.strictEqual(
    model.choices.filter(function(type) { return type === expectedSelected; }).length,
    expectedSelected ? 1 : 0
  );
  if (expectedSelected && assetTypeOptions.indexOf(expectedSelected) === -1) {
    assert.strictEqual(model.unknownAdded, true);
    assert.strictEqual(model.choices[model.choices.length - 1], expectedSelected);
  } else {
    assert.strictEqual(model.unknownAdded, false);
  }
  assert.deepStrictEqual(selectedOptionValues(buildOptionsHtml(saved)), [expectedSelected]);
}

assertKept('Future "Mill" & Co', 'Future "Mill" & Co');
assertKept('  Custom Yard  ', 'Custom Yard');
assertKept('forestry harvester', 'forestry harvester');
assertKept('Skidder', 'Skidder');
assertKept('  Swing Machine  ', 'Swing Machine');
assertKept('', '');
assertKept(null, '');
assertKept('   ', '');
assetTypeOptions.forEach(function(type) { assertKept(type, type); });
console.log('✓ unknown saved type is one selected option and is not replaced');

console.log('\nAll asset type tests passed.');
