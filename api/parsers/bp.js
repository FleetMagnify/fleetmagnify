/**
 * BP Fleet Card transaction CSV parser for the email import pipeline.
 */

var BP_SIGNATURE = [
  'Transaction Effective Date',
  'Card Number',
  'Litres',
  'Customer Value ($)',
];

function parseCsvLine(line) {
  var result = [];
  var cur = '';
  var inQuotes = false;

  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }

  result.push(cur);
  return result;
}

function normalizeHeader(header) {
  return String(header || '').replace(/^\uFEFF/, '').trim();
}

function isBpHeaderRow(headers) {
  var normalized = headers.map(normalizeHeader);
  for (var i = 0; i < BP_SIGNATURE.length; i++) {
    if (normalized.indexOf(BP_SIGNATURE[i]) === -1) {
      return false;
    }
  }
  return true;
}

function isBpCsv(rawCsv) {
  if (!rawCsv || !String(rawCsv).trim()) {
    return false;
  }

  var lines = String(rawCsv).split(/\r?\n/);
  var scanLimit = Math.min(lines.length, 30);

  for (var i = 0; i < scanLimit; i++) {
    var line = lines[i];
    if (!line || !line.trim()) {
      continue;
    }
    if (isBpHeaderRow(parseCsvLine(line))) {
      return true;
    }
  }

  return false;
}

function parseBpRows(rawCsv) {
  var lines = String(rawCsv).split(/\r?\n/);
  var headerIdx = -1;
  var headers = [];
  var scanLimit = Math.min(lines.length, 30);

  for (var i = 0; i < scanLimit; i++) {
    var candidate = parseCsvLine(lines[i]);
    if (isBpHeaderRow(candidate)) {
      headerIdx = i;
      headers = candidate.map(normalizeHeader);
      break;
    }
  }

  if (headerIdx === -1) {
    return [];
  }

  var rows = [];

  for (var j = headerIdx + 1; j < lines.length; j++) {
    var line = lines[j];
    if (!line || !line.trim()) {
      continue;
    }

    var values = parseCsvLine(line);
    if (values.every(function(v) { return !String(v).trim(); })) {
      continue;
    }

    var row = {};
    headers.forEach(function(header, idx) {
      if (header) {
        row[header] = values[idx] != null ? String(values[idx]).trim() : '';
      }
    });
    rows.push(row);
  }

  return rows;
}

function parseNumeric(value) {
  if (value === '' || value == null) {
    return null;
  }
  var n = parseFloat(String(value).replace(/,/g, '').trim());
  return isNaN(n) ? null : n;
}

function parseCurrency(value) {
  if (value === '' || value == null) {
    return null;
  }
  var cleaned = String(value).replace(/\$/g, '').replace(/,/g, '').trim();
  var n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function parseBpDate(value) {
  var raw = String(value || '').trim();
  if (!raw) {
    return null;
  }

  var match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) {
    return null;
  }

  var day = match[1].length === 1 ? '0' + match[1] : match[1];
  var month = match[2].length === 1 ? '0' + match[2] : match[2];
  return match[3] + '-' + month + '-' + day;
}

function normalizeCardNumber(value) {
  return String(value || '').trim();
}

async function updateImportStatus(supabase, importId, status, errorMessage) {
  var payload = { status: status };
  if (errorMessage) {
    payload.error_message = errorMessage;
  } else {
    payload.error_message = null;
  }

  var result = await supabase
    .from('email_imports')
    .update(payload)
    .eq('id', importId);

  if (result.error) {
    console.error('bp: failed to update email_imports status', importId, result.error.message);
  }
}

async function loadCardMap(supabase, userId) {
  var result = await supabase
    .from('assets')
    .select('id, bp_card_number')
    .eq('user_id', userId);

  if (result.error) {
    throw new Error('Failed to load assets: ' + result.error.message);
  }

  var map = {};
  (result.data || []).forEach(function(asset) {
    var card = normalizeCardNumber(asset.bp_card_number);
    if (card) {
      map[card] = asset.id;
    }
  });

  return map;
}

function collectCardDetails(rows) {
  var cards = {};

  for (var i = 0; i < rows.length; i++) {
    var cardNumber = normalizeCardNumber(rows[i]['Card Number']);
    if (!cardNumber) {
      continue;
    }

    if (!cards[cardNumber]) {
      cards[cardNumber] = {
        cardNumber: cardNumber,
        driverName: rows[i]['Driver Name'] ? String(rows[i]['Driver Name']).trim() : '',
        vehicleDescription: rows[i]['Vehicle Description'] ? String(rows[i]['Vehicle Description']).trim() : '',
      };
    } else {
      if (!cards[cardNumber].driverName && rows[i]['Driver Name']) {
        cards[cardNumber].driverName = String(rows[i]['Driver Name']).trim();
      }
      if (!cards[cardNumber].vehicleDescription && rows[i]['Vehicle Description']) {
        cards[cardNumber].vehicleDescription = String(rows[i]['Vehicle Description']).trim();
      }
    }
  }

  return cards;
}

function detectAssetType(vehicleName) {
  var name = String(vehicleName || '').toLowerCase();

  if (name.indexOf('excavator') !== -1) {
    return 'Excavator';
  }
  if (name.indexOf('loader') !== -1) {
    return 'Wheel Loader';
  }
  if (name.indexOf('grader') !== -1) {
    return 'Motor Grader';
  }
  if (name.indexOf('bulldozer') !== -1 || name.indexOf('dozer') !== -1) {
    return 'Bulldozer';
  }
  if (name.indexOf('crane') !== -1) {
    return 'Crane';
  }
  if (name.indexOf('forklift') !== -1) {
    return 'Forklift';
  }

  var lightVehicleKeywords = [
    'ranger', 'hilux', 'navara', 'triton', 'colorado', 'd-max', 'bt-50', 'amarok',
    'ute', 'suv', 'car', 'sedan', 'wagon', 'van', 'transit', 'sprinter', 'hiace',
  ];
  for (var i = 0; i < lightVehicleKeywords.length; i++) {
    if (name.indexOf(lightVehicleKeywords[i]) !== -1) {
      return 'Light Vehicle';
    }
  }

  var semiTrailerKeywords = [
    'semi', 'kenworth', 'freightliner', 'mack', 'volvo', 'scania', 'man ', 'daf',
    'prime mover', 'b-train', 'a-train',
  ];
  for (var j = 0; j < semiTrailerKeywords.length; j++) {
    if (name.indexOf(semiTrailerKeywords[j]) !== -1) {
      return 'Semi Trailer';
    }
  }

  var rigidTruckKeywords = ['hino', 'isuzu', 'fuso', 'ud ', 'rigid', 'truck'];
  for (var k = 0; k < rigidTruckKeywords.length; k++) {
    if (name.indexOf(rigidTruckKeywords[k]) !== -1) {
      return 'Rigid Truck';
    }
  }

  return 'Rigid Truck';
}

async function ensureStubAssets(supabase, userId, rows) {
  var cardMap = await loadCardMap(supabase, userId);
  var cardDetails = collectCardDetails(rows);
  var created = 0;

  for (var cardNumber in cardDetails) {
    if (cardMap[cardNumber]) {
      continue;
    }

    var detail = cardDetails[cardNumber];
    var assetName = detail.driverName || detail.cardNumber;
    var typeHint = detail.driverName;
    if (detail.vehicleDescription) {
      typeHint = typeHint ? (typeHint + ' ' + detail.vehicleDescription) : detail.vehicleDescription;
    }

    var insertResult = await supabase
      .from('assets')
      .insert({
        user_id: userId,
        asset_name: assetName,
        asset_type: detectAssetType(typeHint),
        fuel_type: 'Diesel',
        bp_card_number: cardNumber,
      })
      .select('id, bp_card_number')
      .single();

    if (insertResult.error) {
      throw new Error('Failed to create stub asset for card ' + cardNumber + ': ' + insertResult.error.message);
    }

    cardMap[normalizeCardNumber(insertResult.data.bp_card_number)] = insertResult.data.id;
    created++;
  }

  return { cardMap: cardMap, assetsCreated: created };
}

function buildFuelPurchases(userId, cardMap, rows) {
  var records = [];
  var skipped = 0;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var cardNumber = normalizeCardNumber(row['Card Number']);

    if (!cardNumber) {
      skipped++;
      continue;
    }

    var vehicleId = cardMap[cardNumber];
    if (!vehicleId) {
      console.warn('bp: no asset match for card number', cardNumber);
      skipped++;
      continue;
    }

    var purchaseDate = parseBpDate(row['Transaction Effective Date']);
    var litres = parseNumeric(row.Litres);
    var costNzd = parseCurrency(row['Customer Value ($)']);

    if (!purchaseDate || litres === null) {
      skipped++;
      continue;
    }

    records.push({
      user_id: userId,
      vehicle_id: Number(vehicleId),
      purchase_date: purchaseDate,
      litres: litres,
      cost_nzd: costNzd,
      source: 'BP CSV',
    });
  }

  return { records: records, skipped: skipped };
}

async function parseBpReport(supabase, options) {
  var userId = options.userId;
  var importId = options.importId;
  var rawCsv = options.rawCsv;

  try {
    var rows = parseBpRows(rawCsv);
    if (rows.length === 0) {
      throw new Error('No BP transaction rows found in CSV');
    }

    var assetResult = await ensureStubAssets(supabase, userId, rows);
    var purchases = buildFuelPurchases(userId, assetResult.cardMap, rows);

    if (purchases.records.length === 0) {
      throw new Error('No valid BP fuel purchase rows to import');
    }

    var upsertResult = await supabase
      .from('fuel_purchases')
      .upsert(purchases.records, { onConflict: 'vehicle_id,purchase_date,litres' });

    if (upsertResult.error) {
      throw new Error('Failed to upsert fuel purchases: ' + upsertResult.error.message);
    }

    await updateImportStatus(supabase, importId, 'processed', null);

    return {
      ok: true,
      assetsCreated: assetResult.assetsCreated,
      recordsUpserted: purchases.records.length,
      rowsSkipped: purchases.skipped,
    };
  } catch (err) {
    await updateImportStatus(supabase, importId, 'failed', err.message || 'BP parse failed');
    throw err;
  }
}

module.exports = {
  isBpCsv: isBpCsv,
  parseBpReport: parseBpReport,
};
