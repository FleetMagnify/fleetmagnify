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

function normalizeCardNumber(value) {
  return String(value || '').trim();
}

async function loadAssetMap(supabase, userId) {
  var assetResult = await supabase
    .from('assets')
    .select('id, bp_card_number')
    .eq('user_id', userId)
    .not('bp_card_number', 'is', null);
  if (assetResult.error) throw new Error('Failed to load assets: ' + assetResult.error.message);

  var cardMap = {};
  (assetResult.data || []).forEach(function(asset) {
    var card = normalizeCardNumber(asset.bp_card_number);
    if (card) cardMap[card] = { id: asset.id };
  });
  return { cardMap: cardMap };
}

function isValidCardNumber(cardNumber) {
  if (!cardNumber) return false;
  var lower = cardNumber.toLowerCase();
  return lower !== 'null' && lower !== 'undefined';
}

function looksLikePersonName(value) {
  var titleCasePattern = /^[A-Z][a-z]+(\s+[A-Z][a-z]+)+$/;
  var allCapsPattern = /^[A-Z]+(\s+[A-Z]+)+$/;
  return titleCasePattern.test(value) || allCapsPattern.test(value);
}

function isVehicleCodeLike(value) {
  var trimmed = String(value || '').trim();
  if (!trimmed) return false;
  return !looksLikePersonName(trimmed);
}

function resolveStubAssetName(row, cardNumber) {
  var vehicleDesc = String(row['Vehicle Description'] || '').trim();
  if (vehicleDesc && isVehicleCodeLike(vehicleDesc)) return vehicleDesc;

  var driverName = String(row['Driver Name'] || '').trim();
  if (driverName && isVehicleCodeLike(driverName)) return driverName;

  return 'Card ••••' + cardNumber.slice(-4);
}

async function ensureAssets(supabase, userId, rows) {
  var loaded = await loadAssetMap(supabase, userId);
  var cardMap = loaded.cardMap;
  var seen = {};

  for (var i = 0; i < rows.length; i++) {
    var cardNumber = normalizeCardNumber(rows[i]['Card Number']);
    if (!isValidCardNumber(cardNumber) || seen[cardNumber] || cardMap[cardNumber]) continue;
    seen[cardNumber] = true;

    var stubName = resolveStubAssetName(rows[i], cardNumber);
    var insertResult = await supabase.from('assets').insert({
      user_id: userId,
      asset_name: stubName,
      asset_type: detectAssetType(stubName),
      fuel_type: 'Diesel',
      bp_card_number: cardNumber,
    }).select('id').single();

    if (insertResult.error) {
      // Card may have been created by a concurrent import — fall back to lookup
      var existing = await supabase
        .from('assets')
        .select('id')
        .eq('user_id', userId)
        .eq('bp_card_number', cardNumber)
        .maybeSingle();
      if (existing.data) {
        cardMap[cardNumber] = { id: existing.data.id };
      } else {
        console.error('bp-transaction: failed to create stub asset for card', cardNumber, insertResult.error.message);
      }
      continue;
    }

    cardMap[cardNumber] = { id: insertResult.data.id };
  }

  return { cardMap: cardMap };
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
    var cardMap = assetResult.cardMap;

    // Build fuel purchase records
    var records = [];
    var seen = {};

    rows.forEach(function(row) {
      var dateStr = parseDMY(row['Transaction Effective Date']);
      var litres = parseNumeric(row['Litres']);
      var costExGst = parseNumeric(row['Customer Value ($)']);
      var cardNumber = normalizeCardNumber(row['Card Number']);
      var odometer = parseNumeric(row['Transaction Odometer Reading']);

      if (!cardNumber || !dateStr || litres === null || litres <= 0) return;
      if (costExGst === null) return;

      var pricePerLitre = costExGst / litres;
      if (pricePerLitre < 0.50 || pricePerLitre > 6.00) {
        console.warn(
          'bp-transaction: skipped implausible transaction: date=' + dateStr +
          ', litres=' + litres + ', cost=' + costExGst +
          ', price/litre=' + pricePerLitre.toFixed(2)
        );
        return;
      }

      var assetEntry = cardMap[cardNumber];
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
