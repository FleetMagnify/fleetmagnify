const { isNavmanCsv, parseNavmanReport } = require('./parsers/navman');
const { isNavmanMileageCsv, parseNavmanMileageReport } = require('./parsers/navman-mileage');
const { isNavmanIdleCsv, parseNavmanIdleReport } = require('./parsers/navman-idle');
const { isBpCsv, parseBpReport } = require('./parsers/bp');
const { isBpTransactionCsv, parseBpTransactionReport } = require('./parsers/bp-transaction');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var adminSecret = req.headers['x-admin-secret'];
  if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var userId = req.headers['x-user-id'];
  if (!userId) return res.status(400).json({ error: 'userId required' });

  var filename = req.headers['x-filename'] || 'upload.csv';
  var rawCsv = '';
  await new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(chunk) { chunks.push(chunk); });
    req.on('end', function() { rawCsv = Buffer.concat(chunks).toString('utf8'); resolve(); });
    req.on('error', reject);
  });

  var supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // Create a temporary import record
  var importRecord = await supabase
    .from('email_imports')
    .insert({
      user_id: userId,
      from_address: 'bulk-import@fleetmagnify.com',
      subject: 'Bulk Import: ' + filename,
      received_at: new Date().toISOString(),
      status: 'processing',
      filename: filename
    })
    .select()
    .single();

  var importId = importRecord.data ? importRecord.data.id : null;

  try {
    var options = {
      userId: userId,
      importId: importId,
      rawCsv: rawCsv,
      filename: filename,
      receivedAt: new Date().toISOString()
    };

    var result;
    var parser;

    if (isNavmanMileageCsv(rawCsv)) {
      parser = 'Navman Mileage';
      result = await parseNavmanMileageReport(supabase, options);
    } else if (isNavmanIdleCsv(rawCsv)) {
      parser = 'Navman Idle';
      result = await parseNavmanIdleReport(supabase, options);
    } else if (isNavmanCsv(rawCsv)) {
      parser = 'Navman Executive Summary';
      result = await parseNavmanReport(supabase, options);
    } else if (isBpTransactionCsv(rawCsv)) {
      parser = 'BP Transaction';
      result = await parseBpTransactionReport(supabase, options);
    } else if (isBpCsv(rawCsv)) {
      parser = 'BP Fuel';
      result = await parseBpReport(supabase, options);
    } else {
      return res.status(400).json({ error: 'Unrecognised CSV format' });
    }

    return res.status(200).json({
      ok: true,
      parser: parser,
      recordsUpserted: result.recordsUpserted || result.recordsProcessed || 0,
      pendingAdded: result.pendingAdded || 0
    });

  } catch(err) {
    return res.status(500).json({ error: err.message || 'Import failed' });
  }
};
