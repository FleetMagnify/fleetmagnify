/**
 * BP Transaction Report CSV parser.
 * Headers include: Transaction Effective Date, Card Number, Litres, 
 * Customer Value ($), Vehicle Description, Transaction Odometer Reading
 */

const { parseCsvLine, normalizeHeader, parseNumeric, updateImportStatus, detectAssetType } = require('./parser-utils');
const XLSX = require('xlsx');

var BP_TRANSACTION_SIGNATURE = ['Transaction Effective Date', 'Card Number', 'Litres', 'Customer Value ($)', 'Vehicle Description'];

function isBpTransactionHeaderRow(headers) {
  var normalized = headers.map(normalizeHeader);
  return BP_TRANSACTION_SIGNATURE.every(function(col) {
    return normalized.indexOf(col) !== -1;
  });
}

function isBpTransactionCsv(rawCsv) {
  if (!rawCsv || !String(rawCsv).trim()) return false;
  var lines = String(rawCsv).split(/\r?\n/);
  var scanLimit = Math.min(lines.length, 15);
  for (var i = 0; i < scanLimit; i++) {
    if (lines[i] && lines[i].trim() && isBpTransactionHeaderRow(parseCsvLine(lines[i]))) {
      return true;
    }
  }
  return false;
}

function parseDMY(dateStr) {
  // Parse DD/MM/YYYY explicitly
  var parts = String(dateStr || '').trim().split('/');
  if (parts.length !== 3) return null;
  var day = parts[0].padStart(2, '0');
  var month = parts[1].padStart(2, '0');
  var year = parts[2];
  if (year.length !== 4) return null;
  return year + '-' + month + '-' + day;
}

function parseBpTransactionRows(rawCsv) {
  var lines = String(rawCsv).split(/\r?\n/);
  var headerIdx = -1;
  var headers = [];
  for (var i = 0; i < Math.min(lines.length, 15); i++) {
    var candidate = parseCsvLine(lines[i]);
    if (isBpTransactionHeaderRow(candidate)) {
      headerIdx = i;
      headers = candidate.map(normalizeHeader);
      break;
    }
  }
  if (headerIdx === -1) return [];
  var rows = [];
  for (var j = headerIdx + 1; j < lines.length; j++) {
    var line = lines[j];
    if (!line || !line.trim()) continue;
    var values = parseCsvLine(line);
    if (values.every(function(v) { return !String(v).trim(); })) continue;
    var row = {};
    headers.forEach(function(h, idx) {
      if (h) row[h] = values[idx] != null ? String(values[idx]).trim() : '';
    });
    rows.push(row);
  }
  return rows;
}

function parseBpTransactionXlsRows(fileBuffer) {
  var workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  var firstSheetName = workbook.SheetNames[0];
  var sheet = workbook.Sheets[firstSheetName];
  if (!sheet) return [];

  // raw: false keeps date cells as their original text (e.g. "06/06/2026")
  // instead of converting them to JS Date objects
  var sheetRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });

  var headerIdx = -1;
  var headers = [];
  for (var i = 0; i < Math.min(sheetRows.length, 15); i++) {
    var candidate = (sheetRows[i] || []).map(function(v) { return v == null ? '' : String(v); });
    if (isBpTransactionHeaderRow(candidate)) {
      headerIdx = i;
      headers = candidate.map(normalizeHeader);
      break;
    }
  }
  if (headerIdx === -1) return [];

  var rows = [];
  for (var j = headerIdx + 1; j < sheetRows.length; j++) {
    var values = sheetRows[j] || [];
    if (values.every(function(v) { return v == null || !String(v).trim(); })) continue;
    var row = {};
    headers.forEach(function(h, idx) {
      if (h) row[h] = values[idx] != null ? String(values[idx]).trim() : '';
    });
    rows.push(row);
  }
  return rows;
}

async function loadAssetMap(supabase, userId) {
  var assetResult = await supabase.from('assets').select('id, asset_name').eq('user_id', userId);
  if (assetResult.error) throw new Error('Failed to load assets: ' + assetResult.error.message);
  var ignoredResult = await supabase.from('ignored_assets').select('asset_name').eq('user_id', userId);
  if (ignoredResult.error) throw new Error('Failed to load ignored assets: ' + ignoredResult.error.message);
  var ignoredSet = {};
  (ignoredResult.data || []).forEach(function(r) { ignoredSet[String(r.asset_name).trim()] = true; });
  var map = {};
  (assetResult.data || []).forEach(function(asset) {
    if (asset.asset_name) map[asset.asset_name] = { id: asset.id };
  });
  return { assetMap: map, ignoredSet: ignoredSet };
}

async function ensureAssets(supabase, userId, rows) {
  var loaded = await loadAssetMap(supabase, userId);
  var assetMap = loaded.assetMap;
  var ignoredSet = loaded.ignoredSet;
  var pendingAdded = 0;
  var seen = {};
  for (var i = 0; i < rows.length; i++) {
    var vehicleDesc = String(rows[i]['Vehicle Description'] || '').trim();
    if (!vehicleDesc || seen[vehicleDesc]) continue;
    seen[vehicleDesc] = true;
    if (assetMap[vehicleDesc] || ignoredSet[vehicleDesc]) continue;
    var reg = rows[i]['Vehicle Registration Number'] 
      ? String(rows[i]['Vehicle Registration Number']).trim() : null;
    var pendingResult = await supabase.from('pending_assets').upsert({
      user_id: userId,
      asset_name: vehicleDesc,
      asset_type: detectAssetType(vehicleDesc),
      registration: reg || null,
      source: 'bp-transaction',
      raw_data: rows[i]
    }, { onConflict: 'user_id,asset_name', ignoreDuplicates: true });
    if (!pendingResult.error) pendingAdded++;
  }
  return { assetMap: assetMap, pendingAdded: pendingAdded };
}

async function parseBpTransactionReport(supabase, options) {
  var userId = options.userId;
  var importId = options.importId;
  var rawCsv = options.rawCsv;
  var fileBuffer = options.fileBuffer;

  try {
    var rows = fileBuffer ? parseBpTransactionXlsRows(fileBuffer) : parseBpTransactionRows(rawCsv);
    if (rows.length === 0) throw new Error('No BP transaction rows found');

    var assetResult = await ensureAssets(supabase, userId, rows);
    var assetMap = assetResult.assetMap;

    // Build fuel purchase records
    var records = [];
    var seen = {};

    rows.forEach(function(row) {
      var vehicleDesc = String(row['Vehicle Description'] || '').trim();
      var dateStr = parseDMY(row['Transaction Effective Date']);
      var litres = parseNumeric(row['Litres']);
      var costExGst = parseNumeric(row['Customer Value ($)']);
      var cardNumber = String(row['Card Number'] || '').trim();
      var receiptNumber = String(row['Transaction Receipt Number'] || '').trim();
      var odometer = parseNumeric(row['Transaction Odometer Reading']);

      if (!vehicleDesc || !dateStr || litres === null || litres <= 0) return;
      if (costExGst === null) return;

      var assetEntry = assetMap[vehicleDesc];
      if (!assetEntry) return;

      // Dedup: vehicle + date + litres (in case same transaction appears in overlapping exports)
      var dedupKey = assetEntry.id + '|' + dateStr + '|' + litres;
      if (seen[dedupKey]) return;
      seen[dedupKey] = true;

      records.push({
        user_id: userId,
        vehicle_id: Number(assetEntry.id),
        purchase_date: dateStr,
        litres: litres,
        cost_nzd: costExGst,
        odometer_reading: odometer && odometer > 0 ? odometer : null,
        source: 'bp-transaction',
      });
    });

    if (records.length === 0) throw new Error('No valid BP transaction records to import');

    var upsertResult = await supabase
      .from('fuel_purchases')
      .upsert(records, { onConflict: 'vehicle_id,purchase_date,litres' });

    if (upsertResult.error) throw new Error('Failed to upsert BP transactions: ' + upsertResult.error.message);

    await updateImportStatus(supabase, importId, 'processed', null, 'bp-transaction');

    return {
      ok: true,
      recordsUpserted: records.length,
      pendingAdded: assetResult.pendingAdded,
    };
  } catch (err) {
    await updateImportStatus(supabase, importId, 'failed', err.message, 'bp-transaction');
    throw err;
  }
}

module.exports = {
  isBpTransactionCsv: isBpTransactionCsv,
  parseBpTransactionReport: parseBpTransactionReport,
  parseBpTransactionXlsRows: parseBpTransactionXlsRows,
};
