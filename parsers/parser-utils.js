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

// Confirmed from real Mobil export samples ("Product Description" column).
// Kept as its own separate list from BP_FUEL_PRODUCT_ALLOWLIST above — same
// filtering mechanism, but a different provider's product catalogue, so the
// two should never be merged even where a value happens to overlap.
// Genuine fuel types:
//   "Diesel", "Mobil Diesel Efficient", "Synergy Diesel\Extra Diesel" (diesel),
//   "Unleaded 91", "Premium Unleaded", "Synergy Extra Unleaded" (petrol, for
//   non-diesel utes/cars on this fleet)
// Confirmed non-fuel (rejected):
//   "Diesel Exhaust Fluid", "Shop", "Lubricants", "Car Wash"
var MOBIL_FUEL_PRODUCT_ALLOWLIST = [
  'Diesel',
  'Mobil Diesel Efficient',
  'Synergy Diesel\\Extra Diesel',
  'Unleaded 91',
  'Premium Unleaded',
  'Synergy Extra Unleaded',
];

function isKnownMobilFuelProduct(product) {
  return MOBIL_FUEL_PRODUCT_ALLOWLIST.indexOf(String(product || '').trim()) !== -1;
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

  var truckTrailerKeywords = [
    'truck & trailer', 'truck and trailer', 'b-train', 'b train', 'a-train',
    'low-loader', 'low loader', 'lowloader'
  ];
  for (var tt = 0; tt < truckTrailerKeywords.length; tt++) {
    if (name.indexOf(truckTrailerKeywords[tt]) !== -1) {
      return 'Truck & Trailer';
    }
  }

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
    'prime mover',
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
    'ute', 'suv', 'sedan', 'wagon', 'van', 'transit', 'sprinter', 'hiace',
  ];
  for (var i = 0; i < lightVehicleKeywords.length; i++) {
    if (name.indexOf(lightVehicleKeywords[i]) !== -1) {
      return 'Light Vehicle';
    }
  }
  // 'car' is checked separately with a word-boundary match rather than
  // plain substring — as a substring it would false-positive on
  // "Card ••••1234" (the generic fallback stub name used when a real
  // vehicle code can't be parsed from a fuel import row), which contains
  // "car" as a substring of "Card".
  if (/\bcar\b/.test(name)) {
    return 'Light Vehicle';
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

/**
 * Parse a Navman calendar date into YYYY-MM-DD.
 *
 * From ~Aug 2026 Navman exports use MM-DD-YYYY with '-' or '/' separators
 * (e.g. "8-25-2026" = 25 August 2026). Real idle timestamps for the same
 * calendar day line up with mileage ActivityDate, so these values are NZ
 * local dates already — do NOT apply the old UTC+12 +1-day shift that was
 * used when Navman exported UTC-shifted DD/MM/YYYY strings.
 *
 * Ambiguous numeric dates (both month and day ≤ 12) are treated as
 * month-first to match the current Navman export convention.
 */
function parseNavmanDate(dateStr) {
  var raw = String(dateStr || '').trim();
  if (!raw) return null;

  // Take the date token only (idle fields append " H:MM AM/PM")
  var dateToken = raw.split(/\s+/)[0];
  var parts = dateToken.split(/[-\/]/);
  if (parts.length !== 3) return null;

  var a = parseInt(parts[0], 10);
  var b = parseInt(parts[1], 10);
  var year = parseInt(parts[2], 10);
  if (!year || year < 2000 || year > 2100) return null;
  if (!a || !b) return null;

  var month;
  var day;
  // If one side is > 12 it disambiguates. Otherwise prefer month-first
  // (current Navman MM-DD-YYYY convention).
  if (a > 12 && b >= 1 && b <= 12) {
    // Legacy DD-MM-YYYY (e.g. 25-08-2026)
    day = a;
    month = b;
  } else if (b > 12 && a >= 1 && a <= 12) {
    // Current MM-DD-YYYY (e.g. 8-25-2026)
    month = a;
    day = b;
  } else if (a >= 1 && a <= 12 && b >= 1 && b <= 12) {
    month = a;
    day = b;
  } else {
    return null;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Validate the calendar date (rejects 2-31-2026 etc.)
  var d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }

  return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

/**
 * Parse a Navman idle timestamp like "8-25-2026 5:07 AM".
 * Returns { dateIso, ms } or null. dateIso is the NZ-local calendar date
 * with no UTC day-shift (see parseNavmanDate).
 */
function parseNavmanDatetime(datetimeStr) {
  var raw = String(datetimeStr || '').trim();
  if (!raw) return null;

  var dateIso = parseNavmanDate(raw);
  if (!dateIso) return null;

  var match = raw.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) {
    // Date-only fallback
    var dateOnly = new Date(dateIso + 'T00:00:00');
    return { dateIso: dateIso, ms: dateOnly.getTime() };
  }

  var year = parseInt(match[3], 10);
  var month;
  var day;
  var a = parseInt(match[1], 10);
  var b = parseInt(match[2], 10);
  if (a > 12 && b <= 12) {
    day = a; month = b;
  } else {
    month = a; day = b;
  }

  var hour = parseInt(match[4], 10);
  var minute = parseInt(match[5], 10);
  var ampm = match[6] ? match[6].toUpperCase() : null;
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;

  var dt = new Date(year, month - 1, day, hour, minute, 0, 0);
  return { dateIso: dateIso, ms: dt.getTime() };
}

module.exports = {
  parseCsvLine: parseCsvLine,
  normalizeHeader: normalizeHeader,
  parseNumeric: parseNumeric,
  updateImportStatus: updateImportStatus,
  detectAssetType: detectAssetType,
  parseNavmanDate: parseNavmanDate,
  parseNavmanDatetime: parseNavmanDatetime,
  BP_FUEL_PRODUCT_ALLOWLIST: BP_FUEL_PRODUCT_ALLOWLIST,
  isKnownFuelProduct: isKnownFuelProduct,
  MOBIL_FUEL_PRODUCT_ALLOWLIST: MOBIL_FUEL_PRODUCT_ALLOWLIST,
  isKnownMobilFuelProduct: isKnownMobilFuelProduct,
};
