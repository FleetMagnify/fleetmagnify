/**
 * BP Fleet Card transaction CSV parser for the email import pipeline.
 */

const { parseCsvLine, normalizeHeader, parseNumeric, updateImportStatus, detectAssetType, isKnownFuelProduct } = require('./parser-utils');

var BP_SIGNATURE = [
  'Transaction Effective Date',
  'Card Number',
  'Litres',
  'Customer Value ($)',
];

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

async function loadCardMap(supabase, userId) {
  var assetResult = await supabase
    .from('assets')
    .select('id, bp_card_number, asset_name')
    .eq('user_id', userId);

  if (assetResult.error) {
    throw new Error('Failed to load assets: ' + assetResult.error.message);
  }

  var ignoredResult = await supabase
    .from('ignored_assets')
    .select('asset_name')
    .eq('user_id', userId);

  if (ignoredResult.error) {
    throw new Error('Failed to load ignored assets: ' + ignoredResult.error.message);
  }

  var ignoredSet = {};
  (ignoredResult.data || []).forEach(function(r) {
    ignoredSet[String(r.asset_name).trim().toLowerCase()] = true;
  });

  var map = {};
  var nameMap = {};
  (assetResult.data || []).forEach(function(asset) {
    var card = normalizeCardNumber(asset.bp_card_number);
    if (card) {
      map[card] = asset.id;
    }
    var name = String(asset.asset_name || '').trim();
    if (name) {
      nameMap[name.toLowerCase()] = asset.id;
    }
  });

  return { cardMap: map, nameMap: nameMap, ignoredSet: ignoredSet };
}

function trimBpField(row, column) {
  var value = row[column];
  if (value == null || value === '') {
    return '';
  }
  return String(value).trim();
}

function resolveBpAssetName(row, cardNumber) {
  var vehicleDescription = trimBpField(row, 'Vehicle Description');
  if (vehicleDescription) {
    return vehicleDescription;
  }
  var registration = trimBpField(row, 'Vehicle Registration Number');
  if (registration) {
    return registration;
  }
  var driverName = trimBpField(row, 'Driver Name');
  if (driverName) {
    return driverName;
  }
  return normalizeCardNumber(cardNumber);
}

function resolveBpTypeHint(row) {
  var vehicleDescription = trimBpField(row, 'Vehicle Description');
  if (vehicleDescription) {
    return vehicleDescription;
  }
  var registration = trimBpField(row, 'Vehicle Registration Number');
  if (registration) {
    return registration;
  }
  return trimBpField(row, 'Driver Name');
}

function bpNameResolutionRank(row) {
  if (trimBpField(row, 'Vehicle Description')) {
    return 4;
  }
  if (trimBpField(row, 'Vehicle Registration Number')) {
    return 3;
  }
  if (trimBpField(row, 'Driver Name')) {
    return 2;
  }
  return 1;
}

function collectCardDetails(rows) {
  var cards = {};

  for (var i = 0; i < rows.length; i++) {
    var cardNumber = normalizeCardNumber(rows[i]['Card Number']);
    if (!cardNumber) {
      continue;
    }

    var rank = bpNameResolutionRank(rows[i]);
    var assetName = resolveBpAssetName(rows[i], cardNumber);
    var typeHint = resolveBpTypeHint(rows[i]) || assetName;

    if (!cards[cardNumber]) {
      cards[cardNumber] = {
        cardNumber: cardNumber,
        assetName: assetName,
        typeHint: typeHint,
        rank: rank,
      };
    } else if (rank > cards[cardNumber].rank) {
      cards[cardNumber].assetName = assetName;
      cards[cardNumber].typeHint = typeHint;
      cards[cardNumber].rank = rank;
    }
  }

  return cards;
}

async function ensureStubAssets(supabase, userId, rows) {
  var maps = await loadCardMap(supabase, userId);
  var cardMap = maps.cardMap;
  var nameMap = maps.nameMap;
  var ignoredSet = maps.ignoredSet;
  var cardDetails = collectCardDetails(rows);
  var pendingAdded = 0;
  var toPend = [];

  for (var cardNumber in cardDetails) {
    if (cardMap[cardNumber]) {
      continue;
    }

    var detail = cardDetails[cardNumber];
    var assetName = detail.assetName;
    var assetNameLower = assetName.toLowerCase();

    // Permanently ignored — skip silently
    if (ignoredSet[assetNameLower]) {
      continue;
    }

    var existingId = nameMap[assetNameLower];
    if (existingId) {
      cardMap[cardNumber] = existingId;
      continue;
    }

    // New asset — queue for pending_assets
    toPend.push({
      user_id: userId,
      asset_name: assetName,
      asset_type: detectAssetType(detail.typeHint),
      source: 'bp',
      raw_data: { cardNumber: cardNumber, typeHint: detail.typeHint }
    });
  }

  if (toPend.length > 0) {
    var pendingResult = await supabase
      .from('pending_assets')
      .upsert(toPend, { onConflict: 'user_id,asset_name', ignoreDuplicates: true });

    if (pendingResult.error) {
      console.error('bp: failed to add pending assets', pendingResult.error.message);
    } else {
      pendingAdded = toPend.length;
    }
  }

  return { 
    cardMap: cardMap, 
    nameMap: nameMap, 
    assetsCreated: 0, 
    pendingAdded: pendingAdded 
  };
}

function buildFuelPurchases(userId, cardMap, nameMap, rows) {
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
      var resolvedName = resolveBpAssetName(row, cardNumber);
      if (resolvedName) {
        vehicleId = nameMap[resolvedName.toLowerCase()];
      }
    }
    if (!vehicleId) {
      console.warn('bp: no asset match for card number', cardNumber);
      skipped++;
      continue;
    }

    var purchaseDate = parseBpDate(row['Transaction Effective Date']);
    var litres = parseNumeric(row.Litres);
    var costNzd = parseCurrency(row['Customer Value ($)']);
    var product = row['Product'];

    if (!purchaseDate || litres === null) {
      skipped++;
      continue;
    }

    if (!isKnownFuelProduct(product)) {
      console.warn(
        'bp: skipped non-fuel product: date=' + purchaseDate +
        ', product="' + product + '", litres=' + litres + ', cost=' + costNzd
      );
      skipped++;
      continue;
    }

    if (costNzd !== null && litres > 0) {
      var pricePerLitre = costNzd / litres;
      if (pricePerLitre < 0.50 || pricePerLitre > 6.00) {
        console.warn(
          'bp: skipped implausible transaction: date=' + purchaseDate +
          ', litres=' + litres + ', cost=' + costNzd +
          ', price/litre=' + pricePerLitre.toFixed(2)
        );
        skipped++;
        continue;
      }
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
    var purchases = buildFuelPurchases(userId, assetResult.cardMap, assetResult.nameMap, rows);

    if (purchases.records.length === 0) {
      throw new Error('No valid BP fuel purchase rows to import');
    }

    var upsertResult = await supabase
      .from('fuel_purchases')
      .upsert(purchases.records, { onConflict: 'vehicle_id,purchase_date,litres' });

    if (upsertResult.error) {
      throw new Error('Failed to upsert fuel purchases: ' + upsertResult.error.message);
    }

    await updateImportStatus(supabase, importId, 'processed', null, 'bp');

    return {
      ok: true,
      assetsCreated: assetResult.assetsCreated,
      pendingAdded: assetResult.pendingAdded,
      recordsUpserted: purchases.records.length,
      rowsSkipped: purchases.skipped,
    };
  } catch (err) {
    await updateImportStatus(supabase, importId, 'failed', err.message || 'BP parse failed', 'bp');
    throw err;
  }
}

module.exports = {
  isBpCsv: isBpCsv,
  parseBpReport: parseBpReport,
};
