/**
 * Everlink Clarity fuel-bowser xlsx parser (on-site diesel dispensing).
 * First real prospect: Maugers Contracting.
 *
 * Headers: StartDate, EndDate, ActiveOrgName, SystemName, OrgName,
 * LocationName, FillTotal, FuelCount, TimeStamp, Equipment Name, Rego,
 * AssetNo, UserName, Group, TokenNumber, ItemName, ItemAbbr, ItemColour
 *
 * FillTotal is litres dispensed. FuelCount is ignored: in the Aug 2026
 * Maugers sample it is identical to FillTotal on every row (redundant /
 * mislabeled, not a transaction count).
 *
 * Matching is by the AssetNo column only. Do not parse a code out of
 * Equipment Name — the leading token is sometimes misleading
 * (e.g. "P345 FUEL TANK" has AssetNo F345, not P345).
 */

const { normalizeHeader, parseNumeric, updateImportStatus, detectAssetType } = require('./parser-utils');
const XLSX = require('xlsx');

var EVERLINK_SIGNATURE = ['StartDate', 'TimeStamp', 'Equipment Name', 'AssetNo', 'FillTotal', 'Group'];

function isEverlinkClarityHeaderRow(headers) {
  var normalized = headers.map(normalizeHeader);
  return EVERLINK_SIGNATURE.every(function(col) {
    return normalized.indexOf(col) !== -1;
  });
}

function sheetRowsFromBuffer(fileBuffer) {
  var workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  var firstSheetName = workbook.SheetNames[0];
  var sheet = workbook.Sheets[firstSheetName];
  if (!sheet) return [];
  // raw: false keeps date cells as their formatted text (e.g. "07/08/2026
  // 07:16:46 AM") instead of Excel serial numbers. Confirmed against the
  // Maugers fixture: default sheet_to_json returns TimeStamp as a number
  // (serial 46241.303…); with raw:false every TimeStamp is a string.
  // Never a JS Date unless cellDates:true is set — we do not set that.
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });
}

function isEverlinkClarityXlsx(fileBuffer) {
  if (!fileBuffer) return false;
  try {
    var sheetRows = sheetRowsFromBuffer(fileBuffer);
    var scanLimit = Math.min(sheetRows.length, 15);
    for (var i = 0; i < scanLimit; i++) {
      var candidate = (sheetRows[i] || []).map(function(v) { return v == null ? '' : String(v); });
      if (candidate.some(function(v) { return String(v).trim(); }) && isEverlinkClarityHeaderRow(candidate)) {
        return true;
      }
    }
    return false;
  } catch (err) {
    return false;
  }
}

function parseEverlinkClarityXlsRows(fileBuffer) {
  var sheetRows = sheetRowsFromBuffer(fileBuffer);

  var headerIdx = -1;
  var headers = [];
  for (var i = 0; i < Math.min(sheetRows.length, 15); i++) {
    var candidate = (sheetRows[i] || []).map(function(v) { return v == null ? '' : String(v); });
    if (isEverlinkClarityHeaderRow(candidate)) {
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

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymd(year, month, day) {
  if (!year || year < 2000 || year > 2100) return null;
  if (!month || month < 1 || month > 12 || !day || day < 1 || day > 31) return null;
  var d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }
  return year + '-' + pad2(month) + '-' + pad2(day);
}

/**
 * NZ-local calendar date only — no UTC day-shift (same rule as parseNavmanDate).
 *
 * Confirmed TimeStamp shapes against the real Maugers fixture:
 *   - xlsx default / raw:true  → Excel serial number (e.g. 46241.30331018518)
 *   - xlsx { raw: false }      → "07/08/2026 07:16:46 AM" (DD/MM/YYYY + 12-hour time)
 *   - JS Date                  → not observed (only if cellDates:true is set)
 *
 * Serial 46241 is 2026-08-07, so the formatted text is day-first, not US
 * month-first. Ambiguous numeric dates (both parts ≤ 12) are treated as
 * DD/MM/YYYY to match this export.
 */
function parseEverlinkDate(value) {
  if (value == null || value === '') return null;

  if (typeof value === 'number' && isFinite(value)) {
    var whole = Math.floor(value);
    var utc = new Date(Date.UTC(1899, 11, 30));
    utc.setUTCDate(utc.getUTCDate() + whole);
    return ymd(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
  }

  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return ymd(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  var raw = String(value).trim();
  if (!raw) return null;

  var asNumber = Number(raw);
  if (raw !== '' && isFinite(asNumber) && asNumber > 20000 && asNumber < 100000 && raw.indexOf('/') === -1 && raw.indexOf('-') === -1) {
    return parseEverlinkDate(asNumber);
  }

  var iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return ymd(parseInt(iso[1], 10), parseInt(iso[2], 10), parseInt(iso[3], 10));
  }

  var dateToken = raw.split(/\s+/)[0];
  var parts = dateToken.split(/[-\/]/);
  if (parts.length !== 3) return null;

  var a = parseInt(parts[0], 10);
  var b = parseInt(parts[1], 10);
  var year = parseInt(parts[2], 10);
  if (!year || String(parts[2]).length !== 4) return null;
  if (!a || !b) return null;

  var day;
  var month;
  if (a > 12 && b >= 1 && b <= 12) {
    day = a;
    month = b;
  } else if (b > 12 && a >= 1 && a <= 12) {
    month = a;
    day = b;
  } else if (a >= 1 && a <= 12 && b >= 1 && b <= 12) {
    // This export's formatted text is DD/MM/YYYY (07/08/2026 = 7 August).
    day = a;
    month = b;
  } else {
    return null;
  }

  return ymd(year, month, day);
}

function classifyEverlinkGroup(group) {
  if (group == null) return 'excluded_hired';
  if (typeof group === 'number' && isNaN(group)) return 'excluded_hired';
  var trimmed = String(group).trim();
  if (!trimmed || trimmed.toLowerCase() === 'nan') return 'excluded_hired';
  if (trimmed === 'FUE') return 'excluded_bulk_tank';
  if (trimmed === 'TAN') return 'excluded_allied_tanker';
  return 'included';
}

function normalizeAssetNo(value) {
  return String(value || '').trim();
}

function normalizeRego(value) {
  var reg = String(value == null ? '' : value).trim();
  if (!reg || /^no rego$/i.test(reg)) return null;
  return reg;
}

async function loadAssetMap(supabase, userId) {
  var assetResult = await supabase
    .from('assets')
    .select('id, everlink_asset_no')
    .eq('user_id', userId)
    .not('everlink_asset_no', 'is', null);
  if (assetResult.error) throw new Error('Failed to load assets: ' + assetResult.error.message);

  var assetMap = {};
  (assetResult.data || []).forEach(function(asset) {
    var code = normalizeAssetNo(asset.everlink_asset_no);
    if (code) assetMap[code] = { id: asset.id };
  });
  return { assetMap: assetMap };
}

async function fetchFuelRate(supabase, userId) {
  var settingsResult = await supabase
    .from('user_settings')
    .select('machinery_fuel_cost_per_litre')
    .eq('user_id', userId);

  if (settingsResult.error) throw new Error('Failed to load user_settings: ' + settingsResult.error.message);

  var row = Array.isArray(settingsResult.data) ? settingsResult.data[0] : settingsResult.data;
  if (!row || row.machinery_fuel_cost_per_litre == null || row.machinery_fuel_cost_per_litre === '') {
    return null;
  }
  return parseNumeric(row.machinery_fuel_cost_per_litre);
}

async function ensurePendingAssets(supabase, userId, unmatchedByAssetNo) {
  var assetNos = Object.keys(unmatchedByAssetNo);
  var pending = [];
  for (var i = 0; i < assetNos.length; i++) {
    var row = unmatchedByAssetNo[assetNos[i]];
    var name = String(row['Equipment Name'] || '').trim() || assetNos[i];
    pending.push({
      user_id: userId,
      asset_name: name,
      asset_type: detectAssetType(name),
      registration: normalizeRego(row.Rego),
      source: 'everlink-clarity',
      raw_data: row,
    });
  }

  if (pending.length === 0) return 0;

  // Batched instead of one row at a time — same timeout fix as
  // bp-transaction.js (a monthly Clarity export has ~89 unmatched assets
  // today; sequential upserts are why that parser timed out on Vercel).
  var upsertResult = await supabase
    .from('pending_assets')
    .upsert(pending, { onConflict: 'user_id,asset_name', ignoreDuplicates: true });

  if (upsertResult.error) {
    console.error('everlink-clarity: failed to batch-create pending assets', upsertResult.error.message);
    return 0;
  }
  return pending.length;
}

async function parseEverlinkClarityReport(supabase, options) {
  var userId = options.userId;
  var importId = options.importId;
  var fileBuffer = options.fileBuffer;

  try {
    var rows = parseEverlinkClarityXlsRows(fileBuffer);
    if (rows.length === 0) throw new Error('No Everlink Clarity rows found');

    var loaded = await loadAssetMap(supabase, userId);
    var assetMap = loaded.assetMap;
    var fuelRate = await fetchFuelRate(supabase, userId);

    var records = [];
    var seen = {};
    var skipped = 0;
    var excludedBulkTank = 0;
    var excludedAlliedTanker = 0;
    var excludedHired = 0;
    var missingFuelPriceSetting = false;
    var unmatchedByAssetNo = {};

    rows.forEach(function(row) {
      var category = classifyEverlinkGroup(row.Group);
      if (category === 'excluded_bulk_tank') { excludedBulkTank++; return; }
      if (category === 'excluded_allied_tanker') { excludedAlliedTanker++; return; }
      if (category === 'excluded_hired') { excludedHired++; return; }

      var assetNo = normalizeAssetNo(row.AssetNo);
      var litres = parseNumeric(row.FillTotal);
      var dateStr = parseEverlinkDate(row.TimeStamp);
      var assetEntry = assetNo ? assetMap[assetNo] : null;

      if (assetNo && !assetEntry && !unmatchedByAssetNo[assetNo]) {
        unmatchedByAssetNo[assetNo] = row;
      }

      if (!assetNo || litres === null || litres <= 0 || !dateStr) {
        skipped++;
        return;
      }

      if (!assetEntry) return;

      var dedupKey = assetEntry.id + '|' + dateStr + '|' + litres;
      if (seen[dedupKey]) return;
      seen[dedupKey] = true;

      var costNzd = null;
      if (fuelRate != null) {
        costNzd = litres * fuelRate;
      } else {
        missingFuelPriceSetting = true;
      }

      records.push({
        user_id: userId,
        vehicle_id: Number(assetEntry.id),
        purchase_date: dateStr,
        litres: litres,
        cost_nzd: costNzd,
        source: 'everlink-clarity',
      });
    });

    var pendingAdded = await ensurePendingAssets(supabase, userId, unmatchedByAssetNo);

    if (records.length > 0) {
      var upsertResult = await supabase
        .from('fuel_purchases')
        .upsert(records, { onConflict: 'vehicle_id,purchase_date,litres' });

      if (upsertResult.error) throw new Error('Failed to upsert Everlink Clarity transactions: ' + upsertResult.error.message);
    }

    await updateImportStatus(supabase, importId, 'processed', null, 'everlink-clarity');

    return {
      ok: true,
      recordsUpserted: records.length,
      rowsSkipped: skipped,
      pendingAdded: pendingAdded,
      excludedBulkTank: excludedBulkTank,
      excludedAlliedTanker: excludedAlliedTanker,
      excludedHired: excludedHired,
      missingFuelPriceSetting: missingFuelPriceSetting,
    };
  } catch (err) {
    await updateImportStatus(supabase, importId, 'failed', err.message, 'everlink-clarity');
    throw err;
  }
}

module.exports = {
  isEverlinkClarityXlsx: isEverlinkClarityXlsx,
  parseEverlinkClarityReport: parseEverlinkClarityReport,
  parseEverlinkClarityXlsRows: parseEverlinkClarityXlsRows,
  isEverlinkClarityHeaderRow: isEverlinkClarityHeaderRow,
  classifyEverlinkGroup: classifyEverlinkGroup,
  parseEverlinkDate: parseEverlinkDate,
  normalizeRego: normalizeRego,
};
