/**
 * Shared utility functions for FleetMagnify CSV parsers.
 * Used by navman.js, bp.js, and any future parsers.
 */

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

// Confirmed from 5 real BP export files (Transaction Report XLS and email-
// import CSV formats both use the exact same "Product" column header and
// the exact same literal values). Exact-string match only — not
// partial/normalized — since these are the literal confirmed values.
// Genuine fuel types:
//   "NZ Diesel", "NZ Ultimate Diesel", "NZ Ultimate", "NZ Premium Unleaded", "NZ Unleaded"
// Confirmed non-fuel (rejected):
//   "NZ AdBlue", "NZ Carwash", "NZ Fee Card Admin", "NZ LPG Bottle Swap",
//   "NZ Lubricants", "NZ Miscellaneous"
var BP_FUEL_PRODUCT_ALLOWLIST = [
  'NZ Diesel',
  'NZ Ultimate Diesel',
  'NZ Ultimate',
  'NZ Premium Unleaded',
  'NZ Unleaded',
];

function isKnownFuelProduct(product) {
  return BP_FUEL_PRODUCT_ALLOWLIST.indexOf(String(product || '').trim()) !== -1;
}

function parseNumeric(value) {
  if (value === '' || value == null) {
    return null;
  }
  var n = parseFloat(String(value).replace(/,/g, '').trim());
  return isNaN(n) ? null : n;
}

async function updateImportStatus(supabase, importId, status, errorMessage, parserName) {
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
    console.error((parserName || 'parser') + ': failed to update email_imports status', 
      importId, result.error.message);
  }
}

function detectAssetType(vehicleName) {
  var name = String(vehicleName || '').toLowerCase();

  var rigidTruckKeywords = ['hino', 'isuzu', 'fuso', 'ud ', 'rigid', 'truck'];
  var hasTruckKeyword = false;
  for (var t = 0; t < rigidTruckKeywords.length; t++) {
    if (name.indexOf(rigidTruckKeywords[t]) !== -1) {
      hasTruckKeyword = true;
      break;
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

  if (hasTruckKeyword) {
    return 'Rigid Truck';
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

  if (name.indexOf('bulldozer') !== -1 || name.indexOf('dozer') !== -1) return 'Bulldozer';
  if (name.indexOf('excavator') !== -1 || name.indexOf('digger') !== -1) return 'Excavator';
  if (name.indexOf('grader') !== -1) return 'Motor Grader';
  if (name.indexOf('forklift') !== -1) return 'Forklift';
  if (name.indexOf('crane') !== -1) return 'Crane';
  if (name.indexOf('loader') !== -1) return 'Wheel Loader';
  if (name.indexOf('roller') !== -1 || name.indexOf('scraper') !== -1) return 'Other';

  return 'Rigid Truck';
}

module.exports = {
  parseCsvLine: parseCsvLine,
  normalizeHeader: normalizeHeader,
  parseNumeric: parseNumeric,
  updateImportStatus: updateImportStatus,
  detectAssetType: detectAssetType,
  BP_FUEL_PRODUCT_ALLOWLIST: BP_FUEL_PRODUCT_ALLOWLIST,
  isKnownFuelProduct: isKnownFuelProduct,
};
