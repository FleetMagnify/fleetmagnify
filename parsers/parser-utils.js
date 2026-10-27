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
/**
 * Calendar date (YYYY-MM-DD) of a UTC instant in an IANA time zone.
 *
 * VisionLink "Hour Meter Last Reported Time" and "Latest Utilization Report"
 * are true UTC timestamps (they end in Z). The calendar date on the Z string
 * is the UTC date and can be one day earlier than the New Zealand date.
 * en-CA formats as YYYY-MM-DD. A blank or invalid zone falls back to
 * Pacific/Auckland.
 */
function utcTimestampToLocalDate(isoString, ianaZone) {
  var requested = String(ianaZone || '').trim();
  var zone = requested || 'Pacific/Auckland';
  var raw = String(isoString || '').trim();
  if (!raw) return null;

  var ms = Date.parse(raw);
  if (isNaN(ms)) {
    var normalized = raw.replace(/^(\d{4}-\d{2}-\d{2})[ ]/, '$1T');
    if (normalized !== raw) ms = Date.parse(normalized);
  }
  if (isNaN(ms)) return null;

  var formatted = formatInstantInZone(ms, zone);
  if (formatted) return formatted;
  if (zone !== 'Pacific/Auckland') return formatInstantInZone(ms, 'Pacific/Auckland');
  return null;
}

function formatInstantInZone(ms, zone) {
  try {
    var fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    var parts = fmt.formatToParts(new Date(ms));
    var year = '';
    var month = '';
    var day = '';
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === 'year') year = parts[i].value;
      else if (parts[i].type === 'month') month = parts[i].value;
      else if (parts[i].type === 'day') day = parts[i].value;
    }
    if (!year || !month || !day) return null;
    return year + '-' + month + '-' + day;
  } catch (e) {
    return null;
  }
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function validCalendarDate(year, month, day) {
  if (!year || year < 2000 || year > 2100) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  var dt = new Date(year, month - 1, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) return null;
  return year + '-' + pad2(month) + '-' + pad2(day);
}

function interpretVisionLinkReading(tokens, mode) {
  var out = [];
  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    var month = mode === 'dmy' ? token.b : token.a;
    var day = mode === 'dmy' ? token.a : token.b;
    var iso = validCalendarDate(token.year, month, day);
    if (!iso) return null;
    out.push(iso);
  }
  return out;
}

function readingsMatch(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  for (var i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function nzDateFromReceivedAt(receivedAt) {
  if (receivedAt == null || receivedAt === '') return null;
  if (receivedAt instanceof Date) {
    if (isNaN(receivedAt.getTime())) return null;
    return utcTimestampToLocalDate(receivedAt.toISOString(), 'Pacific/Auckland');
  }
  if (typeof receivedAt === 'number' && isFinite(receivedAt)) {
    return utcTimestampToLocalDate(new Date(receivedAt).toISOString(), 'Pacific/Auckland');
  }
  return utcTimestampToLocalDate(String(receivedAt), 'Pacific/Auckland');
}

function daysApart(isoA, isoB) {
  var ms = Date.parse(isoB + 'T00:00:00Z') - Date.parse(isoA + 'T00:00:00Z');
  if (isNaN(ms)) return Infinity;
  return Math.round(Math.abs(ms) / 86400000);
}

/**
 * Pick one locale reading (DD-MM-YYYY or MM-DD-YYYY) for a set of numeric
 * dates that share a VisionLink account locale.
 *
 * tokens: [{ a, b, year }, ...] in the order written (a is the first
 * number, b the second). A component greater than 12 makes the other
 * reading's month invalid, so only one reading survives. When both
 * readings are valid and differ, the reading whose END date (second
 * token, or the only token) is closest to receivedAt's New Zealand
 * calendar date is used, and only if that end date is within 7 days.
 * Otherwise null.
 */
function resolveVisionLinkDateReading(tokens, receivedAt) {
  if (!tokens || !tokens.length) return null;
  var dmy = interpretVisionLinkReading(tokens, 'dmy');
  var mdy = interpretVisionLinkReading(tokens, 'mdy');
  if (!dmy && !mdy) return null;
  if (dmy && !mdy) return dmy;
  if (mdy && !dmy) return mdy;
  if (readingsMatch(dmy, mdy)) return dmy;

  var receivedNz = nzDateFromReceivedAt(receivedAt);
  if (!receivedNz) return null;
  var endIdx = tokens.length >= 2 ? 1 : 0;
  var dmyDist = daysApart(dmy[endIdx], receivedNz);
  var mdyDist = daysApart(mdy[endIdx], receivedNz);
  var dmyIn = dmyDist <= 7;
  var mdyIn = mdyDist <= 7;
  if (!dmyIn && !mdyIn) return null;
  if (dmyIn && !mdyIn) return dmy;
  if (mdyIn && !dmyIn) return mdy;
  if (dmyDist < mdyDist) return dmy;
  if (mdyDist < dmyDist) return mdy;
  return null;
}

function inclusiveDayCount(start, end) {
  var days = daysApart(start, end);
  if (!isFinite(days)) return null;
  return days + 1;
}

function visionLinkOneDayMessage(start, end) {
  var n = inclusiveDayCount(start, end);
  return 'VisionLink report covers ' + n + ' days (' + start + ' to ' + end +
    '). FleetMagnify needs a one-day report: schedule it Daily with Report Duration \'Previous day\'.';
}

/**
 * Fleet Utilization <start> <end> <generated>.csv / .xlsx
 *
 * Case-insensitive. The name and the three dates may be separated by
 * underscores, spaces, or a hyphen with spaces (" - "). Optional trailing
 * _<digits> or (digits) before the extension (VisionLink sometimes appends
 * _1, and a download may append (1)). Date order follows the account
 * locale (DD-MM-YYYY or MM-DD-YYYY); see resolveVisionLinkDateReading.
 * Returns { start, end, generated } as YYYY-MM-DD, or null when the
 * name does not match or the locale cannot be resolved.
 */
function parseVisionLinkFilenameRange(filename, receivedAt) {
  if (!filename) return null;
  var base = String(filename).split(/[/\\]/).pop();
  // Separator between the title and each date. A bare hyphen is not a
  // separator: the dates themselves are DD-MM-YYYY or MM-DD-YYYY.
  var sep = '(?:_|\\s+-\\s+|\\s+)';
  var date = '(\\d{2})-(\\d{2})-(\\d{4})';
  var match = base.match(new RegExp(
    '^fleet(?:_|\\s+)utilization' + sep + date + sep + date + sep + date +
    '(?:_\\d+|\\s*\\(\\d+\\))?\\.(csv|xlsx)$',
    'i'
  ));
  if (!match) return null;
  var tokens = [
    { a: parseInt(match[1], 10), b: parseInt(match[2], 10), year: parseInt(match[3], 10) },
    { a: parseInt(match[4], 10), b: parseInt(match[5], 10), year: parseInt(match[6], 10) },
    { a: parseInt(match[7], 10), b: parseInt(match[8], 10), year: parseInt(match[9], 10) },
  ];
  var dates = resolveVisionLinkDateReading(tokens, receivedAt);
  if (!dates) return null;
  return { start: dates[0], end: dates[1], generated: dates[2] };
}

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
  utcTimestampToLocalDate: utcTimestampToLocalDate,
  resolveVisionLinkDateReading: resolveVisionLinkDateReading,
  parseVisionLinkFilenameRange: parseVisionLinkFilenameRange,
  visionLinkOneDayMessage: visionLinkOneDayMessage,
  BP_FUEL_PRODUCT_ALLOWLIST: BP_FUEL_PRODUCT_ALLOWLIST,
  isKnownFuelProduct: isKnownFuelProduct,
  MOBIL_FUEL_PRODUCT_ALLOWLIST: MOBIL_FUEL_PRODUCT_ALLOWLIST,
  isKnownMobilFuelProduct: isKnownMobilFuelProduct,
};
