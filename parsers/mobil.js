/**
 * Mobil Fuel Card Transaction Report CSV parser.
 * Headers include: Transaction Number, Transaction Date, Transaction Time,
 * Statement Date, Account Name, Merchant Site Name, Card No., Description,
 * Account No, Invoice No., Cost Centre, Price Zone, Odometer, Invoice Status,
 * Product Description, Unit Price, Quantity, Total, GST
 *
 * CSV-only for now — we've only ever seen genuine CSV exports from Mobil.
 * XLS support can be added later (see bp-transaction.js for that pattern)
 * if it's ever actually needed.
 */

const { parseCsvLine, normalizeHeader, parseNumeric, updateImportStatus, detectAssetType, isKnownMobilFuelProduct } = require('./parser-utils');

var MOBIL_SIGNATURE = ['Transaction Date', 'Card No.', 'Quantity', 'Total', 'Product Description'];

function isMobilHeaderRow(headers) {
  var normalized = headers.map(normalizeHeader);
  return MOBIL_SIGNATURE.every(function(col) {
    return normalized.indexOf(col) !== -1;
  });
}

function isMobilCsv(rawCsv) {
  if (!rawCsv || !String(rawCsv).trim()) return false;
  var lines = String(rawCsv).split(/\r?\n/);
  var scanLimit = Math.min(lines.length, 15);
  for (var i = 0; i < scanLimit; i++) {
    if (lines[i] && lines[i].trim() && isMobilHeaderRow(parseCsvLine(lines[i]))) {
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

function parseMobilRows(rawCsv) {
  var lines = String(rawCsv).split(/\r?\n/);
  var headerIdx = -1;
  var headers = [];
  for (var i = 0; i < Math.min(lines.length, 15); i++) {
    var candidate = parseCsvLine(lines[i]);
    if (isMobilHeaderRow(candidate)) {
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

function normalizeCardNumber(value) {
  return String(value || '').trim();
}

async function loadAssetMap(supabase, userId) {
  var assetResult = await supabase
    .from('assets')
    .select('id, mobil_card_number')
    .eq('user_id', userId)
    .not('mobil_card_number', 'is', null);
  if (assetResult.error) throw new Error('Failed to load assets: ' + assetResult.error.message);

  var cardMap = {};
  (assetResult.data || []).forEach(function(asset) {
    var card = normalizeCardNumber(asset.mobil_card_number);
    if (card) cardMap[card] = { id: asset.id };
  });
  return { cardMap: cardMap };
}

function isValidCardNumber(cardNumber) {
  if (!cardNumber) return false;
  var lower = cardNumber.toLowerCase();
  return lower !== 'null' && lower !== 'undefined';
}

// Same intent as bp-transaction.js's person-name filter on its Vehicle
// Description/Driver Name fields, but Mobil only has one field ("Description")
// carrying a single vehicle code per row (e.g. "T33", "T8"). Real samples
// showed non-vehicle values here too (e.g. a company name). Genuine Mobil
// codes are always a short single token, so requiring "no whitespace" plus
// a letter/digit shape is a stronger, simpler positive-match signal here
// than porting BP's Title-Case/ALL-CAPS regex verbatim — that regex is
// case-sensitive on each word's first letter and would NOT catch a value
// like "iIndependent Line Services" (leading lowercase letter), even though
// it is clearly not a vehicle code.
function isVehicleCodeLike(value) {
  var trimmed = String(value || '').trim();
  if (!trimmed) return false;
  if (/\s/.test(trimmed)) return false;
  return /^[A-Za-z]{1,4}\d{1,4}[A-Za-z]?$/.test(trimmed);
}

function resolveStubAssetName(row, cardNumber) {
  var description = String(row['Description'] || '').trim();
  if (description && isVehicleCodeLike(description)) return description;
  return 'Card ••••' + cardNumber.slice(-4);
}

function inferMobilFuelType(product) {
  return /diesel/i.test(String(product || '')) ? 'Diesel' : 'Petrol';
}

function findFuelProductForCard(rows, cardNumber) {
  for (var k = 0; k < rows.length; k++) {
    if (normalizeCardNumber(rows[k]['Card No.']) === cardNumber &&
        isKnownMobilFuelProduct(rows[k]['Product Description'])) {
      return rows[k]['Product Description'];
    }
  }
  return null;
}

async function ensureAssets(supabase, userId, rows) {
  var loaded = await loadAssetMap(supabase, userId);
  var cardMap = loaded.cardMap;
  var seen = {};

  for (var i = 0; i < rows.length; i++) {
    var cardNumber = normalizeCardNumber(rows[i]['Card No.']);
    if (!isValidCardNumber(cardNumber) || seen[cardNumber] || cardMap[cardNumber]) continue;
    seen[cardNumber] = true;

    var stubName = resolveStubAssetName(rows[i], cardNumber);
    var fuelProduct = findFuelProductForCard(rows, cardNumber);
    var stubFuelType = fuelProduct ? inferMobilFuelType(fuelProduct) : 'Diesel';
    var insertResult = await supabase.from('assets').insert({
      user_id: userId,
      asset_name: stubName,
      asset_type: detectAssetType(stubName),
      fuel_type: stubFuelType,
      mobil_card_number: cardNumber,
    }).select('id').single();

    if (insertResult.error) {
      // Card may have been created by a concurrent import — fall back to lookup
      var existing = await supabase
        .from('assets')
        .select('id')
        .eq('user_id', userId)
        .eq('mobil_card_number', cardNumber)
        .maybeSingle();
      if (existing.data) {
        cardMap[cardNumber] = { id: existing.data.id };
      } else {
        console.error('mobil: failed to create stub asset for card', cardNumber, insertResult.error.message);
      }
      continue;
    }

    cardMap[cardNumber] = { id: insertResult.data.id };
  }

  return { cardMap: cardMap };
}

async function parseMobilReport(supabase, options) {
  var userId = options.userId;
  var importId = options.importId;
  var rawCsv = options.rawCsv;

  try {
    var rows = parseMobilRows(rawCsv);
    if (rows.length === 0) throw new Error('No Mobil transaction rows found');

    var assetResult = await ensureAssets(supabase, userId, rows);
    var cardMap = assetResult.cardMap;

    // Build fuel purchase records
    var records = [];
    var seen = {};
    var skipped = 0;

    rows.forEach(function(row) {
      var dateStr = parseDMY(row['Transaction Date']);
      var litres = parseNumeric(row['Quantity']);
      var total = parseNumeric(row['Total']);
      var gst = parseNumeric(row['GST']) || 0;
      var cardNumber = normalizeCardNumber(row['Card No.']);
      var odometer = parseNumeric(row['Odometer']);
      var product = row['Product Description'];

      if (!cardNumber || !dateStr || litres === null || litres <= 0) { skipped++; return; }
      if (total === null) { skipped++; return; }

      // Mobil's Total is GST-inclusive (confirmed from samples) — subtract
      // GST to match the ex-GST convention already established for cost_nzd
      // by BP's parsers (BP's "Customer Value ($)" is stored as-is because
      // it's already ex-GST there, unlike Mobil's Total).
      var costExGst = total - gst;

      if (!isKnownMobilFuelProduct(product)) {
        console.warn(
          'mobil: skipped non-fuel product: date=' + dateStr +
          ', product="' + product + '", litres=' + litres + ', cost=' + costExGst
        );
        skipped++;
        return;
      }

      var pricePerLitre = costExGst / litres;
      if (pricePerLitre < 0.50 || pricePerLitre > 6.00) {
        console.warn(
          'mobil: skipped implausible transaction: date=' + dateStr +
          ', litres=' + litres + ', cost=' + costExGst +
          ', price/litre=' + pricePerLitre.toFixed(2)
        );
        skipped++;
        return;
      }

      var assetEntry = cardMap[cardNumber];
      if (!assetEntry) { skipped++; return; }

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
        source: 'mobil',
      });
    });

    if (records.length === 0) throw new Error('No valid Mobil transaction records to import');

    var upsertResult = await supabase
      .from('fuel_purchases')
      .upsert(records, { onConflict: 'vehicle_id,purchase_date,litres' });

    if (upsertResult.error) throw new Error('Failed to upsert Mobil transactions: ' + upsertResult.error.message);

    await updateImportStatus(supabase, importId, 'processed', null, 'mobil');

    return {
      ok: true,
      recordsUpserted: records.length,
      rowsSkipped: skipped,
    };
  } catch (err) {
    await updateImportStatus(supabase, importId, 'failed', err.message, 'mobil');
    throw err;
  }
}

module.exports = {
  isMobilCsv: isMobilCsv,
  parseMobilReport: parseMobilReport,
};
