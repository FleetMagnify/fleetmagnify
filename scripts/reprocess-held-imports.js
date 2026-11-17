/**
 * Re-import email_imports rows held because the sender was not allowed,
 * once that sender is allowed by the built-in domains or INBOUND_EXTRA_SENDERS.
 *
 * Dry-run by default. Pass --apply to write.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/reprocess-held-imports.js [--apply]
 *
 * Prints a summary only. Does not print file contents.
 */
var { createClient } = require('@supabase/supabase-js');
var knownSenders = require('../lib/known-senders');
var inbound = require('../api/email-inbound');

var PAGE_SIZE = 1000;

function parseArgs() {
  var apply = false;
  process.argv.slice(2).forEach(function (arg) {
    if (arg === '--apply') apply = true;
  });
  return { apply: apply };
}

function attachmentFromRow(row) {
  var stored = row.raw_csv || '';
  if (stored.indexOf('BASE64_XLS:') === 0) {
    return {
      isXls: true,
      rawCsv: '',
      buffer: Buffer.from(stored.slice('BASE64_XLS:'.length), 'base64'),
      filename: row.filename || null,
    };
  }
  return {
    isXls: false,
    rawCsv: stored,
    buffer: Buffer.from(stored, 'utf8'),
    filename: row.filename || null,
  };
}

async function loadHeld(supabase) {
  var rows = [];
  var from = 0;
  while (true) {
    var result = await supabase
      .from('email_imports')
      .select('id, user_id, from_email, filename, raw_csv, received_at, status')
      .eq('status', 'held_unapproved')
      .order('received_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (result.error) throw result.error;
    var batch = result.data || [];
    rows = rows.concat(batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

async function main() {
  var args = parseArgs();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  var supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  var held = await loadHeld(supabase);
  var allowed = [];
  var stillHeld = 0;
  held.forEach(function (row) {
    if (knownSenders.isAllowedSender(row.from_email, process.env)) allowed.push(row);
    else stillHeld += 1;
  });

  console.log('Held rows:', held.length);
  console.log('Sender now allowed:', allowed.length);
  console.log('Still not allowed:', stillHeld);
  console.log('Mode:', args.apply ? 'APPLY' : 'DRY-RUN (no writes)');

  for (var i = 0; i < allowed.length; i++) {
    var row = allowed[i];
    var label = [
      'id=' + (row.id || ''),
      'user_id=' + (row.user_id || ''),
      'from=' + (row.from_email || '(empty)'),
      'file=' + (row.filename || '(no file)'),
    ].join(' ');
    if (!args.apply) {
      console.log('would reprocess', label);
      continue;
    }
    try {
      var file = attachmentFromRow(row);
      await inbound.importSavedAttachment(supabase, {
        userId: row.user_id,
        importId: row.id,
        filename: file.filename,
        rawCsv: file.rawCsv,
        buffer: file.buffer,
        isXls: file.isXls,
        receivedAt: row.received_at,
      });
      console.log('reprocessed', label);
    } catch (err) {
      console.log('failed', label, err && err.message ? err.message : err);
    }
  }
}

main().catch(function (err) {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
