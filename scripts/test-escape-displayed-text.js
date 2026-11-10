/**
 * Displayed text is escaped in the admin dropdowns, the settings
 * division list, and the import failure alert.
 * Reads files as text. No browser and no network.
 *
 *   node scripts/test-escape-displayed-text.js
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');

function read(name) {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

function extractFunction(source, name) {
  var marker = 'function ' + name;
  var start = source.indexOf(marker);
  assert.ok(start !== -1, 'missing ' + name);
  var open = source.indexOf('{', start);
  var depth = 0;
  for (var i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

function assertNoRaw(label, value) {
  assert.strictEqual(value.indexOf('<'), -1, label + ' still has <');
  assert.strictEqual(value.indexOf('>'), -1, label + ' still has >');
  assert.strictEqual(value.indexOf('"'), -1, label + ' still has a double quote');
  assert.strictEqual(value.indexOf("'"), -1, label + ' still has a single quote');
  var stripped = value.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, '');
  assert.strictEqual(stripped.indexOf('&'), -1, label + ' still has a raw ampersand');
}

var adminFn = extractFunction(read('admin.html'), 'populateUsers');
assert.ok(adminFn.indexOf("createElement('option')") !== -1, 'admin builds options with createElement');
assert.ok(adminFn.indexOf('option.textContent = label') !== -1, 'admin sets the label with textContent');
assert.ok(adminFn.indexOf('option.value = u.email') !== -1, 'admin option value is the email');
assert.ok(adminFn.indexOf('option.dataset.userId = u.id') !== -1, 'admin keeps the user id on the option');
assert.ok(adminFn.indexOf('innerHTML') === -1, 'admin populateUsers no longer assigns innerHTML');
assert.ok(adminFn.indexOf("u.company_name ? u.company_name + ' (' + u.email + ')' : u.email") !== -1);
assert.ok(adminFn.indexOf('aName.localeCompare(bName)') !== -1);
assert.ok(adminFn.indexOf("users.length + ' registered users'") !== -1);
assert.ok(adminFn.indexOf("getElementById('login-as-btn').disabled = false") !== -1);
assert.ok(adminFn.indexOf("getElementById('invoice-billing-btn').disabled = false") !== -1);
console.log('[PASS] admin dropdown is built with textContent');

var bulkFn = extractFunction(read('bulk-import.html'), 'populateAccounts');
assert.ok(bulkFn.indexOf("createElement('option')") !== -1, 'bulk import builds options with createElement');
assert.ok(bulkFn.indexOf('option.textContent = label') !== -1, 'bulk import sets the label with textContent');
assert.ok(bulkFn.indexOf('option.value = u.id') !== -1, 'bulk import option value is the user id');
assert.ok(bulkFn.indexOf('innerHTML') === -1, 'bulk import populateAccounts no longer assigns innerHTML');
assert.ok(bulkFn.indexOf("u.company_name ? u.company_name + ' (' + u.email + ')' : u.email") !== -1);
assert.ok(bulkFn.indexOf('.localeCompare(') !== -1);
console.log('[PASS] bulk import dropdown is built with textContent');

var settingsEscape = extractFunction(read('settings.html'), 'escapeHtml');
var settingsEscapeHtml = new Function('str', settingsEscape.slice(settingsEscape.indexOf('{') + 1, -1));
var marked = 'Test "Haulage" <Ltd> & Co\'s';
var escaped = settingsEscapeHtml(marked);
assertNoRaw('settings division name', escaped);
assert.strictEqual(escaped, 'Test &quot;Haulage&quot; &lt;Ltd&gt; &amp; Co&#39;s');
assert.strictEqual(settingsEscapeHtml('Test Haulage Ltd'), 'Test Haulage Ltd');
assert.strictEqual(settingsEscapeHtml(null), '');
console.log('[PASS] settings escapeHtml replaces quotes, less-than and ampersand');

var shared = require('../lib/escape-html');
assert.strictEqual(shared(marked), 'Test &quot;Haulage&quot; &lt;Ltd&gt; &amp; Co&#39;s');
assert.strictEqual(shared('Test Haulage Ltd'), 'Test Haulage Ltd');
console.log('[PASS] shared escape helper matches the contact form replacements');

var fileName = '<b>report</b>.csv';
var errorMessage = 'row < 2 & "quote"';
var userId = '00000000-0000-4000-8000-0000000000a1';
var calls = [];
var originalFetch = global.fetch;
process.env.RESEND_API_KEY = 'test-resend-key';
global.fetch = function(url, options) {
  calls.push({ url: url, options: options });
  return Promise.resolve({ ok: true, json: function() { return Promise.resolve({}); } });
};

var inbound = require('../api/email-inbound');
inbound.sendFailureAlert(fileName, errorMessage, userId).then(function() {
  global.fetch = originalFetch;
  assert.strictEqual(calls.length, 1);
  var body = JSON.parse(calls[0].options.body);
  assert.strictEqual(body.subject, '⚠️ FleetMagnify Import Failed: ' + fileName);
  assert.strictEqual(body.text, undefined);
  assert.ok(body.html.indexOf('&lt;b&gt;report&lt;/b&gt;.csv') !== -1);
  assert.strictEqual(body.html.indexOf('<b>'), -1);
  assert.ok(body.html.indexOf('row &lt; 2 &amp; &quot;quote&quot;') !== -1);
  assert.ok(body.html.indexOf(userId) !== -1);
  assert.ok(body.html.indexOf('<p><strong>File:</strong> ') === 0 || body.html.indexOf('<p><strong>Import failed</strong></p>') === 0);
  console.log('[PASS] failure alert HTML escapes the file name and error');
  console.log('\nAll displayed-text escape tests passed.');
}).catch(function(err) {
  global.fetch = originalFetch;
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
