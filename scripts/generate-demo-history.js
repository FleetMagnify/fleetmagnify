/**
 * Generate 75 days of realistic historical activity for the FleetMagnify Demo
 * account so Fuel / Idle / Utilisation / Job Cost analysts have something
 * coherent to show.
 *
 * Usage:
 *   node scripts/generate-demo-history.js --simulate
 *     Local generator check (no database). Confirms fill-interval and
 *     telematics-day floors before any write.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/generate-demo-history.js [--dry-run] [--only kenworth]
 *
 *   --only <profile-key>  Regenerates one asset (telematics + fuel +
 *     calibration rows for that asset id). Does not touch jobs or
 *     user_settings. Known keys: excavator, grader, dozer, adt,
 *     compactor, isuzu, hino, volvoFh, kenworth, transporter.
 *
 * Safety:
 *   - Looks up asset IDs at runtime (never hardcoded)
 *   - Every write is scoped to DEMO_USER_ID or asset_ids confirmed to belong
 *     to that user
 *   - Probes live table columns before inserting (does not assume schema)
 *   - Idempotent: deletes this user's previously generated history in the
 *     75-day window, then re-inserts
 */

var { createClient } = require('@supabase/supabase-js');

var DEMO_USER_ID = '023182a8-1563-46dd-a7c3-1430fbfad5df';
var DAYS = 75;
var MIN_FUEL_INTERVALS = 8;
var MIN_TELEMATICS_DAYS = 60;
var NZ_TZ = 'Pacific/Auckland';

// Fallback only — live customer medians are preferred when available.
// 1.520 is the example bulk-tank rate in the product UI (settings / features).
var FALLBACK_BULK_NZD_PER_LITRE = 1.52;
var FALLBACK_FLEET_CARD_NZD_PER_LITRE = 1.849;

var ON_ROAD_TYPES = {
  'Light Vehicle': true,
  'Rigid Truck': true,
  'Semi Trailer': true,
  'Truck and Trailer / B-Train': true
};

// Matariki 2026 falls inside the 75-day window from 27 Aug 2026.
var NZ_HOLIDAYS = {
  '2026-07-10': true
};

// ---------------------------------------------------------------------------
// Asset profiles (matched by name at runtime — IDs are never hardcoded)
// startHours / startOdo are the hour-meter / odometer at the BEGINNING of
// the 75-day window. Final assets.current_* = start + generated activity.
// ---------------------------------------------------------------------------

var PROFILES = [
  {
    key: 'excavator',
    match: /hitachi.*zx350|zx350.*excavator/i,
    kind: 'machinery',
    startHours: 6200,
    weekdayRuntime: [7.6, 10.8],
    saturdayRuntime: [0, 5.5],
    idleFraction: [0.34, 0.48],
    workingLph: 28.0,
    idleLph: 6.4,
    tankL: 620,
    targetFills: 14
  },
  {
    key: 'grader',
    match: /komatsu.*gd655|gd655.*grader/i,
    kind: 'machinery',
    startHours: 8100,
    weekdayRuntime: [8.2, 10.4],
    saturdayRuntime: [0, 4.5],
    idleFraction: [0.14, 0.24],
    workingLph: 22.0,
    idleLph: 5.2,
    tankL: 480,
    targetFills: 13
  },
  {
    key: 'dozer',
    match: /caterpillar.*d8|d8.*bulldozer|d8t/i,
    kind: 'machinery',
    startHours: 11400,
    weekdayRuntime: [8.0, 11.0],
    saturdayRuntime: [0, 5.0],
    idleFraction: [0.26, 0.36],
    workingLph: 47.0,
    idleLph: 8.2,
    tankL: 900,
    targetFills: 16
  },
  {
    key: 'adt',
    match: /volvo.*a30g|a30g.*articulated|articulated dump/i,
    kind: 'machinery',
    startHours: 4200,
    weekdayRuntime: [9.0, 11.6],
    saturdayRuntime: [3.0, 7.0],
    idleFraction: [0.08, 0.16],
    workingLph: 31.0,
    idleLph: 6.0,
    tankL: 520,
    targetFills: 15
  },
  {
    key: 'compactor',
    match: /caterpillar.*cs56|cs56.*compactor/i,
    kind: 'machinery',
    startHours: 2800,
    weekdayRuntime: [4.2, 7.0],
    saturdayRuntime: [0, 4.0],
    idleFraction: [0.18, 0.28],
    workingLph: 14.0,
    idleLph: 3.4,
    tankL: 280,
    targetFills: 12
  },
  {
    key: 'isuzu',
    match: /isuzu.*frr|frr.*tipper/i,
    kind: 'truck',
    startOdo: 95000,
    weekdayKm: [70, 145],
    saturdayKm: [0, 80],
    avgSpeedKmh: 34,
    idleHours: [0.6, 1.6],
    travelLpk: 0.195,
    idleLph: 1.8,
    tankL: 200,
    targetFills: 12
  },
  {
    key: 'hino',
    match: /hino.*500|500.*tipper/i,
    kind: 'truck',
    startOdo: 142000,
    weekdayKm: [140, 250],
    saturdayKm: [0, 120],
    avgSpeedKmh: 42,
    idleHours: [0.8, 1.9],
    travelLpk: 0.255,
    idleLph: 2.2,
    tankL: 300,
    targetFills: 13
  },
  {
    key: 'volvoFh',
    match: /volvo.*fh|fh.*tipper/i,
    kind: 'truck',
    startOdo: 210000,
    weekdayKm: [240, 400],
    saturdayKm: [40, 180],
    avgSpeedKmh: 58,
    idleHours: [0.7, 1.7],
    travelLpk: 0.345,
    idleLph: 2.8,
    tankL: 500,
    targetFills: 14
  },
  {
    key: 'kenworth',
    match: /kenworth.*t659|t659/i,
    kind: 'truck',
    startOdo: 385000,
    weekdayKm: [380, 640],
    saturdayKm: [220, 420],
    avgSpeedKmh: 68,
    idleHours: [0.5, 1.1],
    idleVsKm: 'inverse',
    // Yard-idle weekdays (0 km, engine on) give the one-variable
    // regression idle hours that are not absorbed into L/km. Clustered
    // "50 km / 7 h" loading days previously became their own fill window.
    yardIdleDays: 12,
    yardClusterSize: 4,
    yardIdle: [3.8, 5.6],
    minFillGapDays: 2,
    minIntervalKm: 500,
    alignFillsToRegression: true,
    targetResidualIdleLph: 3.0,
    travelLpk: 0.515,
    idleLph: 3.2,
    tankL: 1400,
    targetFills: 16
  },
  {
    key: 'transporter',
    match: /freightliner.*argosy|argosy.*low-?loader|transporter/i,
    kind: 'truck',
    irregular: true,
    startOdo: 260000,
    weekdayKm: [180, 520],
    saturdayKm: [0, 0],
    avgSpeedKmh: 52,
    idleHours: [0.4, 1.2],
    travelLpk: 0.455,
    idleLph: 3.0,
    tankL: 700,
    targetFills: 11
  }
];

var JOB_SPECS = [
  {
    job_name: 'Site A — Bulk Earthworks',
    status: 'Completed',
    startOffset: 71, // days before today
    endOffset: 50,
    tonnes_moved: 18400,
    assetKeys: ['excavator', 'adt', 'dozer']
  },
  {
    job_name: 'Site B — Access Road Formation',
    status: 'Completed',
    startOffset: 47,
    endOffset: 29,
    tonnes_moved: 4300,
    assetKeys: ['grader', 'dozer', 'compactor']
  },
  {
    job_name: 'Site C — Platform Cut to Fill',
    status: 'Completed',
    startOffset: 26,
    endOffset: 14,
    tonnes_moved: 9600,
    assetKeys: ['excavator', 'adt', 'compactor']
  },
  {
    job_name: 'Site D — Subgrade & Trim',
    status: 'Active',
    startOffset: 11,
    endOffset: 2,
    tonnes_moved: 1750,
    assetKeys: ['grader', 'excavator', 'adt']
  }
];

// Shared rain-out weekdays: all machinery parked (realistic site-wide wet weather).
var RAIN_OUT = {
  '2026-07-14': true,
  '2026-07-15': true
};

// ---------------------------------------------------------------------------
// Date / RNG helpers
// ---------------------------------------------------------------------------

function todayNz() {
  return new Date().toLocaleDateString('en-CA', { timeZone: NZ_TZ });
}

function toUtcDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z');
}

function toDateStr(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  var d = toUtcDate(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return toDateStr(d);
}

function eachDateInclusive(startStr, endStr) {
  var out = [];
  var cur = toUtcDate(startStr);
  var end = toUtcDate(endStr);
  while (cur <= end) {
    out.push(toDateStr(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function dow(dateStr) {
  return toUtcDate(dateStr).getUTCDay();
}

function isWeekend(dateStr) {
  var d = dow(dateStr);
  return d === 0 || d === 6;
}

function isSaturday(dateStr) {
  return dow(dateStr) === 6;
}

function isSunday(dateStr) {
  return dow(dateStr) === 0;
}

function mulberry32(seed) {
  var a = seed >>> 0;
  return function() {
    a += 0x6D2B79F5;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  var h = 2166136261;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function lerp(rng, lo, hi) {
  return lo + (hi - lo) * rng();
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function median(nums) {
  if (!nums.length) return null;
  var s = nums.slice().sort(function(a, b) { return a - b; });
  var mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pickColumns(row, allowed) {
  var out = {};
  allowed.forEach(function(col) {
    if (Object.prototype.hasOwnProperty.call(row, col) && row[col] !== undefined) {
      out[col] = row[col];
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Schema probing — never assume a column exists
// ---------------------------------------------------------------------------

async function probeColumns(supabase, table, candidates) {
  var existing = [];
  var missing = [];
  for (var i = 0; i < candidates.length; i++) {
    var col = candidates[i];
    var result = await supabase.from(table).select(col).limit(0);
    if (result.error) {
      missing.push(col + ' (' + result.error.message + ')');
    } else {
      existing.push(col);
    }
  }
  return { existing: existing, missing: missing };
}

async function tableExists(supabase, table) {
  var result = await supabase.from(table).select('*').limit(0);
  return !result.error;
}

async function batchedInsert(supabase, table, rows, chunkSize) {
  chunkSize = chunkSize || 200;
  var inserted = 0;
  for (var i = 0; i < rows.length; i += chunkSize) {
    var chunk = rows.slice(i, i + chunkSize);
    var result = await supabase.from(table).insert(chunk);
    if (result.error) {
      throw new Error(table + ' insert failed at offset ' + i + ': ' + result.error.message);
    }
    inserted += chunk.length;
  }
  return inserted;
}

async function batchedUpsert(supabase, table, rows, onConflict, chunkSize) {
  chunkSize = chunkSize || 200;
  var upserted = 0;
  for (var i = 0; i < rows.length; i += chunkSize) {
    var chunk = rows.slice(i, i + chunkSize);
    var result = await supabase.from(table).upsert(chunk, { onConflict: onConflict });
    if (result.error) {
      throw new Error(table + ' upsert failed at offset ' + i + ': ' + result.error.message);
    }
    upserted += chunk.length;
  }
  return upserted;
}

async function deleteScoped(supabase, table, filter) {
  var q = supabase.from(table).delete();
  Object.keys(filter).forEach(function(k) {
    var v = filter[k];
    if (v && typeof v === 'object' && v.in) {
      q = q.in(k, v.in);
    } else if (v && typeof v === 'object' && v.gte) {
      q = q.gte(k, v.gte);
    } else if (v && typeof v === 'object' && v.lte) {
      q = q.lte(k, v.lte);
    } else {
      q = q.eq(k, v);
    }
  });
  var result = await q;
  if (result.error) {
    throw new Error('delete ' + table + ' failed: ' + result.error.message);
  }
}

// ---------------------------------------------------------------------------
// Live price / source discovery from existing customer data
// ---------------------------------------------------------------------------

async function discoverDieselPrice(supabase) {
  var bulkPrice = FALLBACK_BULK_NZD_PER_LITRE;
  var fleetPrice = FALLBACK_FLEET_CARD_NZD_PER_LITRE;
  var bulkSource = 'fallback (product UI example 1.520)';
  var fleetSource = 'fallback';
  var sourceValue = 'demo';

  var settings = await supabase
    .from('user_settings')
    .select('user_id, machinery_fuel_cost_per_litre');
  if (!settings.error && settings.data) {
    var bulkVals = settings.data
      .filter(function(r) {
        return r.user_id !== DEMO_USER_ID && r.machinery_fuel_cost_per_litre != null;
      })
      .map(function(r) { return parseFloat(r.machinery_fuel_cost_per_litre); })
      .filter(function(n) { return !isNaN(n) && n > 0.8 && n < 4; });
    var m = median(bulkVals);
    if (m != null) {
      bulkPrice = round3(m);
      bulkSource = 'median of ' + bulkVals.length + ' other user_settings rows';
    }
  } else if (settings.error) {
    console.log('  user_settings probe: ' + settings.error.message);
  }

  var purchases = await supabase
    .from('fuel_purchases')
    .select('user_id, litres, cost_nzd, source, purchase_date')
    .gt('litres', 20)
    .order('purchase_date', { ascending: false })
    .limit(400);
  if (!purchases.error && purchases.data && purchases.data.length) {
    var ppl = [];
    var sourceCounts = {};
    purchases.data.forEach(function(r) {
      if (r.user_id === DEMO_USER_ID) return;
      var litres = parseFloat(r.litres);
      var cost = parseFloat(r.cost_nzd);
      if (litres > 0 && cost > 0) {
        var rate = cost / litres;
        if (rate >= 0.8 && rate <= 4.0) ppl.push(rate);
      }
      if (r.source) {
        sourceCounts[r.source] = (sourceCounts[r.source] || 0) + 1;
      }
    });
    var med = median(ppl);
    if (med != null) {
      fleetPrice = round3(med);
      fleetSource = 'median of ' + ppl.length + ' other-customer fills';
    }
    var topSource = null;
    var topCount = 0;
    Object.keys(sourceCounts).forEach(function(s) {
      if (sourceCounts[s] > topCount) {
        topSource = s;
        topCount = sourceCounts[s];
      }
    });
    console.log('  existing fuel_purchases.source values:', JSON.stringify(sourceCounts));
    // Keep 'demo' so rows are obviously synthetic, unless source is used as
    // a hard enum / filter (it is not — parsers write free text like
    // 'BP CSV' / 'bp-transaction' / 'mobil').
    sourceValue = 'demo';
    if (topSource) {
      console.log('  most common live source is "' + topSource + '"; using "demo" so generated rows are identifiable without breaking source-agnostic reads');
    }
  } else if (purchases.error) {
    console.log('  fuel_purchases probe: ' + purchases.error.message);
  }

  return {
    bulkPrice: bulkPrice,
    bulkSource: bulkSource,
    fleetPrice: fleetPrice,
    fleetSource: fleetSource,
    sourceValue: sourceValue
  };
}

// ---------------------------------------------------------------------------
// Activity generation
// ---------------------------------------------------------------------------

function matchProfile(asset) {
  var name = String(asset.asset_name || '');
  for (var i = 0; i < PROFILES.length; i++) {
    if (PROFILES[i].match.test(name)) return PROFILES[i];
  }
  return null;
}

function buildTransporterActiveSet(dates, rng) {
  // Several consecutive working days, then several consecutive zeros.
  // Roughly 1–2 move windows per week, not every day.
  var active = {};
  var i = 0;
  while (i < dates.length) {
    var gap = Math.floor(lerp(rng, 3, 6.99)); // 3–6 parked days
    i += gap;
    if (i >= dates.length) break;
    var run = Math.floor(lerp(rng, 1, 2.99)); // 1–2 moving days
    for (var k = 0; k < run && i + k < dates.length; k++) {
      var d = dates[i + k];
      if (!isSunday(d)) active[d] = true;
    }
    i += run;
  }
  return active;
}

function buildSiteDays(dates, rng, weekCount) {
  var set = {};
  if (!weekCount) return set;
  var starts = [];
  dates.forEach(function(d, idx) {
    if (isWeekend(d) || NZ_HOLIDAYS[d]) return;
    var block = [];
    for (var k = 0; k < 4; k++) {
      if (idx + k >= dates.length) return;
      var day = dates[idx + k];
      if (isWeekend(day) || NZ_HOLIDAYS[day]) return;
      block.push(day);
    }
    starts.push(block);
  });
  // Shuffle
  for (var i = starts.length - 1; i > 0; i--) {
    var j = Math.floor(rng() * (i + 1));
    var tmp = starts[i];
    starts[i] = starts[j];
    starts[j] = tmp;
  }
  var used = {};
  var placed = 0;
  starts.forEach(function(block) {
    if (placed >= weekCount) return;
    var overlap = block.some(function(d) { return used[d]; });
    if (overlap) return;
    block.forEach(function(d) {
      set[d] = true;
      used[d] = true;
    });
    placed += 1;
  });
  return set;
}

function buildYardDays(dates, rng, count, clusterSize) {
  var set = {};
  if (!count) return set;
  var size = clusterSize || 4;
  var clustersNeeded = Math.max(1, Math.round(count / size));
  var mondays = dates.filter(function(d) {
    return dow(d) === 1 && !NZ_HOLIDAYS[d] && !RAIN_OUT[d];
  });
  if (!mondays.length) return set;
  var usedIdx = {};
  for (var c = 0; c < clustersNeeded; c++) {
    var slot = (c + 0.5) / clustersNeeded;
    var idx = clamp(Math.round(slot * (mondays.length - 1) + lerp(rng, -1, 1)), 0, mondays.length - 1);
    var tries = 0;
    while (usedIdx[idx] && tries < mondays.length) {
      idx = (idx + 2) % mondays.length;
      tries += 1;
    }
    if (usedIdx[idx]) continue;
    usedIdx[idx] = true;
    var start = mondays[idx];
    var startPos = dates.indexOf(start);
    var added = 0;
    for (var k = 0; k < 8 && added < size && startPos + k < dates.length; k++) {
      var day = dates[startPos + k];
      if (isWeekend(day) || NZ_HOLIDAYS[day] || RAIN_OUT[day]) continue;
      set[day] = true;
      added += 1;
    }
  }
  return set;
}

function generateDailyMap(profile, dates, rng) {
  var transporterActive = profile.irregular ? buildTransporterActiveSet(dates, rng) : {};
  var siteDays = profile.siteWeeks ? buildSiteDays(dates, rng, profile.siteWeeks) : {};
  var yardDays = profile.yardIdleDays
    ? buildYardDays(dates, rng, profile.yardIdleDays, profile.yardClusterSize)
    : {};
  var daily = {};
  dates.forEach(function(d) {
    daily[d] = dailyActivity(profile, d, rng, transporterActive, siteDays, yardDays);
  });
  return daily;
}

function dailyActivity(profile, dateStr, rng, transporterActive, siteDays, yardDays) {
  if (NZ_HOLIDAYS[dateStr] || isSunday(dateStr)) {
    return { active: false, operating: 0, idle: 0, km: 0, litres: 0 };
  }
  if (profile.kind === 'machinery' && RAIN_OUT[dateStr]) {
    return { active: false, operating: 0, idle: 0, km: 0, litres: 0 };
  }
  if (profile.irregular && !transporterActive[dateStr]) {
    return { active: false, operating: 0, idle: 0, km: 0, litres: 0 };
  }

  if (yardDays && yardDays[dateStr] && profile.kind === 'truck') {
    var yardIdle = lerp(rng, profile.yardIdle[0], profile.yardIdle[1]);
    var yardLitres = yardIdle * profile.idleLph * lerp(rng, 0.95, 1.05);
    return {
      active: true,
      operating: 0.3,
      idle: round1(yardIdle),
      km: 0,
      litres: round1(Math.max(0, yardLitres))
    };
  }

  // Occasional random weekday off for every asset (breakdown / no work).
  if (!isWeekend(dateStr) && rng() < (profile.irregular ? 0 : 0.06)) {
    return { active: false, operating: 0, idle: 0, km: 0, litres: 0 };
  }

  if (profile.kind === 'machinery') {
    var runtimeRange = isSaturday(dateStr) ? profile.saturdayRuntime : profile.weekdayRuntime;
    if (isSaturday(dateStr) && rng() < 0.45) {
      return { active: false, operating: 0, idle: 0, km: 0, litres: 0 };
    }
    var runtime = lerp(rng, runtimeRange[0], runtimeRange[1]);
    if (runtime < 0.4) {
      return { active: false, operating: 0, idle: 0, km: 0, litres: 0 };
    }
    var idleFrac = lerp(rng, profile.idleFraction[0], profile.idleFraction[1]);
    var idle = runtime * idleFrac;
    var operating = runtime - idle;
    var litres = operating * profile.workingLph + idle * profile.idleLph;
    litres *= lerp(rng, 0.94, 1.06);
    return {
      active: true,
      operating: round1(operating),
      idle: round1(idle),
      km: 0,
      litres: round1(Math.max(0, litres))
    };
  }

  var kmRange = isSaturday(dateStr) ? profile.saturdayKm : profile.weekdayKm;
  if (isSaturday(dateStr) && rng() < 0.35 && !profile.irregular) {
    return { active: false, operating: 0, idle: 0, km: 0, litres: 0 };
  }
  var siteDay = !!(siteDays && siteDays[dateStr] && !isSaturday(dateStr));
  var km = siteDay
    ? lerp(rng, profile.siteKm[0], profile.siteKm[1])
    : lerp(rng, kmRange[0], kmRange[1]);
  if (km < 8) {
    return { active: false, operating: 0, idle: 0, km: 0, litres: 0 };
  }
  var idleH = siteDay
    ? lerp(rng, profile.siteIdle[0], profile.siteIdle[1])
    : lerp(rng, profile.idleHours[0], profile.idleHours[1]);
  if (!siteDay && profile.idleVsKm === 'inverse') {
    var typicalKm = (profile.weekdayKm[0] + profile.weekdayKm[1]) / 2;
    idleH *= clamp(typicalKm / km, 0.5, 2.2);
  }
  var drivingH = km / profile.avgSpeedKmh;
  var litresT = km * profile.travelLpk + idleH * profile.idleLph;
  litresT *= lerp(rng, 0.95, 1.05);
  return {
    active: true,
    operating: round1(Math.max(0.2, drivingH)),
    idle: round1(idleH),
    km: round1(km),
    litres: round1(Math.max(0, litresT))
  };
}

function placeFillDates(dates, daily, profile, rng) {
  var fills = [];
  if (profile.irregular) {
    var inRun = false;
    dates.forEach(function(d) {
      if (daily[d].active && !inRun) {
        fills.push(d);
        inRun = true;
      } else if (!daily[d].active && inRun) {
        inRun = false;
      }
    });
    // Closing fill on the last active day of the last cluster (if it is a
    // different calendar day) so the final move's litres form an interval.
    var lastActive = null;
    for (var i = dates.length - 1; i >= 0; i--) {
      if (daily[dates[i]].active) { lastActive = dates[i]; break; }
    }
    if (lastActive && fills[fills.length - 1] !== lastActive) fills.push(lastActive);
  } else {
    var target = Math.max(profile.targetFills, MIN_FUEL_INTERVALS + 2);
    var spacing = (dates.length - 2) / (target - 1);
    for (var n = 0; n < target; n++) {
      var idx = Math.round(n * spacing + lerp(rng, -1.2, 1.2));
      idx = clamp(idx, 0, dates.length - 1);
      var candidate = dates[idx];
      // Prefer an active highway-ish day so a site-wait cluster cannot
      // become its own tiny fill-to-fill interval.
      var snapped = candidate;
      function fillQuality(day) {
        if (!daily[day] || !daily[day].active) return -1;
        return daily[day].km;
      }
      var minFillKm = profile.weekdayKm ? profile.weekdayKm[0] * 0.6 : 80;
      if (fillQuality(candidate) < minFillKm) {
        var best = candidate;
        var bestQ = fillQuality(candidate);
        for (var step = 1; step <= 5; step++) {
          var fwd = dates[clamp(idx + step, 0, dates.length - 1)];
          var back = dates[clamp(idx - step, 0, dates.length - 1)];
          if (fillQuality(fwd) > bestQ) { best = fwd; bestQ = fillQuality(fwd); }
          if (fillQuality(back) > bestQ) { best = back; bestQ = fillQuality(back); }
          if (bestQ >= minFillKm) break;
        }
        snapped = best;
      }
      if (fills.indexOf(snapped) === -1) fills.push(snapped);
    }
    fills.sort();
  }

    // Dedup, reject same-calendar-day fills (zero-distance interval that
    // the regression engine excludes), then top up to the minimum.
  var minGap = profile.minFillGapDays != null ? profile.minFillGapDays : 1;
  var uniq = [];
  fills.sort();
  fills.forEach(function(d) {
    if (uniq.indexOf(d) !== -1) return;
    if (uniq.length) {
      var prev = uniq[uniq.length - 1];
      var gap = (toUtcDate(d) - toUtcDate(prev)) / 86400000;
      if (gap < minGap) return;
    }
    uniq.push(d);
  });
  var need = MIN_FUEL_INTERVALS + 2;
  if (uniq.length < need) {
    var extras = dates.filter(function(d) {
      return daily[d].active && uniq.indexOf(d) === -1;
    });
    extras.forEach(function(d) {
      if (uniq.length >= need) return;
      var tooClose = uniq.some(function(u) {
        return Math.abs((toUtcDate(d) - toUtcDate(u)) / 86400000) < minGap;
      });
      if (!tooClose) {
        uniq.push(d);
        uniq.sort();
      }
    });
  }
  if (profile.minIntervalKm) {
    uniq = enforceMinIntervalKm(dates, daily, uniq, profile.minIntervalKm);
  }
  return uniq;
}

function enforceMinIntervalKm(dates, daily, fillDates, minKm) {
  var odo = 0;
  var odoAt = {};
  dates.forEach(function(d) {
    odo = round1(odo + daily[d].km);
    odoAt[d] = odo;
  });
  var out = [];
  fillDates.forEach(function(d) {
    if (!out.length) {
      out.push(d);
      return;
    }
    var km = odoAt[d] - odoAt[out[out.length - 1]];
    if (km >= minKm) out.push(d);
  });
  return out;
}

function intervalWindow(dates, daily, start, end) {
  var km = 0, idle = 0, burn = 0;
  dates.forEach(function(day) {
    if (day > start && day <= end) {
      km += daily[day].km;
      burn += daily[day].litres;
    }
    if (day >= start && day < end) idle += daily[day].idle;
  });
  return { km: km, idle: idle, burn: burn };
}

function idleKmRho(windows) {
  var sumKmIdle = 0, sumKm = 0, sumKm2 = 0, sumIdle = 0;
  windows.forEach(function(w) {
    if (w.km <= 0) return;
    sumKmIdle += w.km * w.idle;
    sumKm += w.km;
    sumKm2 += w.km * w.km;
    sumIdle += w.idle;
  });
  if (sumKm2 <= 0 || sumIdle <= 0) return 0;
  return (sumKmIdle * sumKm) / (sumKm2 * sumIdle);
}

function buildFills(dates, daily, profile, fillDates, price, rng) {
  var windows = [];
  for (var i = 1; i < fillDates.length; i++) {
    windows.push(intervalWindow(dates, daily, fillDates[i - 1], fillDates[i]));
  }
  var idleCoeff = profile.idleLph;
  if (profile.targetResidualIdleLph) {
    var rho = idleKmRho(windows);
    var denom = Math.max(0.28, 1 - rho);
    idleCoeff = clamp(profile.targetResidualIdleLph / denom, profile.idleLph, 8);
  }

  var fills = [];
  for (var i = 0; i < fillDates.length; i++) {
    var d = fillDates[i];
    var litres;
    if (i === 0) {
      litres = profile.tankL * lerp(rng, 0.55, 0.92);
    } else {
      var w = windows[i - 1];
      // Do NOT cap at tank size: a cap below actual interval burn understates
      // litres on long-haul intervals, biases travel L/km down, and dumps the
      // leftover into idle L/hr (Kenworth previously calibrated at ~8 L/hr).
      if (profile.alignFillsToRegression || profile.targetResidualIdleLph) {
        litres = (w.km * profile.travelLpk + w.idle * idleCoeff) * lerp(rng, 0.98, 1.02);
      } else {
        litres = w.burn * lerp(rng, 0.97, 1.03);
      }
      if (litres < 20) litres = Math.max(20, w.burn);
    }
    var ppl = price * lerp(rng, 0.975, 1.025);
    fills.push({
      purchase_date: d,
      litres: round1(litres),
      cost_nzd: round2(litres * ppl)
    });
  }
  if (profile.targetResidualIdleLph) {
    fills = retargetResidualIdle(dates, daily, fills, profile);
  }
  return fills;
}

function retargetResidualIdle(dates, daily, fills, profile) {
  if (fills.length < 3) return fills;
  var cal = truckResidualIdle(dates, daily, fills, profile);
  if (cal.idleLph == null || !cal.points.length) return fills;
  var rho = idleKmRho(cal.points);
  var alpha = (profile.targetResidualIdleLph - cal.idleLph) / Math.max(0.22, 1 - rho);
  var byEnd = {};
  cal.points.forEach(function(p) { byEnd[p.end] = p; });
  return fills.map(function(f, idx) {
    if (idx === 0) return f;
    var p = byEnd[f.purchase_date];
    if (!p) return f;
    var old = f.litres;
    var ppl = old > 0 ? f.cost_nzd / old : 1.85;
    var nextLitres = round1(clamp(old + alpha * p.idle, old * 0.85, old * 1.45));
    return {
      purchase_date: f.purchase_date,
      litres: nextLitres,
      cost_nzd: round2(nextLitres * ppl)
    };
  });
}

function truckResidualIdle(dates, daily, fills, profile) {
  var odoAt = {};
  var odo = 0;
  dates.forEach(function(d) {
    odo = round1(odo + daily[d].km);
    odoAt[d] = odo;
  });
  var typicalKm = (profile.weekdayKm[0] + profile.weekdayKm[1]) / 2;
  var typicalIdle = (profile.idleHours[0] + profile.idleHours[1]) / 2;
  var typicalIdlePer100 = typicalKm > 0 ? (typicalIdle / typicalKm) * 100 : 0;
  // Flag only the pathological case (short distance, huge idle) that
  // produced the 8 L/hr Kenworth rate — not a normal site-week interval.
  var flagAt = Math.max(typicalIdlePer100 * 2.5, 4.0);
  var points = [];
  var flagged = [];
  for (var i = 1; i < fills.length; i++) {
    var start = fills[i - 1].purchase_date;
    var end = fills[i].purchase_date;
    var km = odoAt[end] - odoAt[start];
    var idle = 0;
    dates.forEach(function(d) {
      // Match lib/fuel-regression.js evaluateInterval(): idle is summed
      // over [startDate, endDate) via eachDateBetween().
      if (d >= start && d < end) idle += daily[d].idle;
    });
    var litres = fills[i].litres;
    if (km <= 0 || litres < 3) continue;
    points.push({ km: km, idle: idle, litres: litres, start: start, end: end });
    // keep points on the return value for simulate dumps
    var idlePer100 = km > 0 ? (idle / km) * 100 : 0;
    if (flagAt > 0 && idlePer100 > flagAt) {
      flagged.push({
        start: start,
        end: end,
        km: round1(km),
        idle: round1(idle),
        idlePer100km: round1(idlePer100),
        litres: litres
      });
    }
  }
  var sxy = 0, sxx = 0, sumY = 0, sumX = 0, sumIdle = 0;
  points.forEach(function(p) {
    sxy += p.km * p.litres;
    sxx += p.km * p.km;
    sumY += p.litres;
    sumX += p.km;
    sumIdle += p.idle;
  });
  var slope = sxx > 0 ? sxy / sxx : 0;
  var idleLitres = sumY - slope * sumX;
  var idleLph = sumIdle > 0 ? Math.max(0, idleLitres) / sumIdle : null;
  return {
    intervals: points.length,
    travelLpk: slope,
    idleLph: idleLph,
    flagged: flagged,
    points: points
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseOnlyKey() {
  var idx = process.argv.indexOf('--only');
  if (idx === -1) return null;
  var key = process.argv[idx + 1];
  if (!key || key.charAt(0) === '-') {
    throw new Error('--only requires a profile key (e.g. kenworth)');
  }
  var known = PROFILES.some(function(p) { return p.key === key; });
  if (!known) {
    throw new Error(
      'Unknown --only key "' + key + '". Known: ' +
      PROFILES.map(function(p) { return p.key; }).join(', ')
    );
  }
  return key;
}

function simulateLocally() {
  var endDate = todayNz();
  var startDate = addDays(endDate, -(DAYS - 1));
  var dates = eachDateInclusive(startDate, endDate);
  var failed = false;
  var onlyKey = parseOnlyKey();
  console.log('Local simulate ' + startDate + ' → ' + endDate + ' (' + dates.length + ' days)' +
    (onlyKey ? '  [--only ' + onlyKey + ']' : '') + '\n');
  PROFILES.forEach(function(profile, idx) {
    if (onlyKey && profile.key !== onlyKey) return;
    var rng = mulberry32(hashSeed(profile.key + ':' + (100 + idx) + ':demo75'));
    var daily = generateDailyMap(profile, dates, rng);
    var telDays = 0;
    var activeDays = 0;
    dates.forEach(function(d) {
      var keep = profile.kind === 'truck' ? true : (daily[d].active || !isSunday(d));
      if (keep) telDays += 1;
      if (daily[d].active) activeDays += 1;
    });
    var fillDates = placeFillDates(dates, daily, profile, rng);
    var fills = buildFills(dates, daily, profile, fillDates, 1.85, rng);
    var intervals = fills.length - 1;
    var problems = [];
    if (intervals < MIN_FUEL_INTERVALS) problems.push('intervals=' + intervals);
    if (telDays < MIN_TELEMATICS_DAYS) problems.push('telDays=' + telDays);
    if (profile.kind === 'machinery') {
      var litreDays = 0;
      var totalLitres = 0, totalOp = 0, totalIdle = 0;
      dates.forEach(function(d) {
        if (daily[d].active && daily[d].litres > 0) litreDays += 1;
        totalLitres += daily[d].litres;
        totalOp += daily[d].operating;
        totalIdle += daily[d].idle;
      });
      if (litreDays < 40) problems.push('litres_consumed days=' + litreDays);
      // Fuel Analyst construction path reads these three telematics columns
      // directly — no regression. Confirm they would populate the UI.
      if (totalLitres < 500) problems.push('litres_consumed total=' + totalLitres.toFixed(0));
      if (totalOp < 80) problems.push('operating_hours total=' + totalOp.toFixed(0));
      if (totalIdle < 20) problems.push('idle_hours total=' + totalIdle.toFixed(0));
      console.log(
        '       Fuel Analyst (telematics): litres_consumed days=' + litreDays +
        '  total=' + totalLitres.toFixed(0) + ' L  working=' + totalOp.toFixed(0) +
        ' h  idle=' + totalIdle.toFixed(0) + ' h'
      );
    }
    if (profile.kind === 'truck') {
      var cal = truckResidualIdle(dates, daily, fills, profile);
      if (profile.key === 'kenworth' && (cal.idleLph == null || cal.idleLph < 1.3 || cal.idleLph > 4.5)) {
        problems.push('residual idle=' + (cal.idleLph != null ? cal.idleLph.toFixed(2) : 'n/a') + ' L/hr');
      }
      if (cal.flagged.length) {
        cal.flagged.forEach(function(f) {
          console.log(
            '       idle-heavy ' + f.start + '→' + f.end +
            '  ' + f.km + ' km / ' + f.idle + ' idle-h  (' + f.idlePer100km + ' h/100km)  ' + f.litres + ' L'
          );
        });
      }
      if (profile.key === 'kenworth') {
        var siteDaysN = 0;
        var yardDaysN = 0;
        dates.forEach(function(d) {
          if (daily[d].active && daily[d].km >= 8 && daily[d].km <= 240 && daily[d].idle >= 3.5) siteDaysN += 1;
          if (daily[d].active && daily[d].km < 8 && daily[d].idle >= 3.0) yardDaysN += 1;
        });
        console.log('       site-wait days=' + siteDaysN + '  yard-idle days=' + yardDaysN);
        console.log('       most idle-heavy fill intervals:');
        var ranked = (cal.points || []).slice().sort(function(a, b) {
          var aR = a.km > 0 ? a.idle / a.km : 0;
          var bR = b.km > 0 ? b.idle / b.km : 0;
          return bR - aR;
        }).slice(0, 3);
        ranked.forEach(function(p) {
          console.log(
            '       interval ' + p.start + '→' + p.end +
            '  ' + round1(p.km) + ' km / ' + round1(p.idle) + ' idle-h  (' +
            round1(p.km > 0 ? (p.idle / p.km) * 100 : 0) + ' h/100km)  ' + p.litres + ' L'
          );
        });
      }
      console.log(
        '       travel=' + cal.travelLpk.toFixed(3) + ' L/km  residual idle=' +
        (cal.idleLph != null ? cal.idleLph.toFixed(2) : 'n/a') + ' L/hr  (target idle ' + profile.idleLph + ')'
      );
    }
    if (profile.irregular) {
      var longestZero = 0, run = 0;
      dates.forEach(function(d) {
        if (!daily[d].active) { run += 1; longestZero = Math.max(longestZero, run); }
        else run = 0;
      });
      if (longestZero < 3) problems.push('transporter longest parked streak only ' + longestZero + 'd');
    }
    var flag = problems.length ? 'FAIL' : 'ok';
    if (problems.length) failed = true;
    console.log(
      '[' + flag + '] ' + profile.key +
      '  tel=' + telDays + '  active=' + activeDays +
      '  fills=' + fills.length + '  intervals=' + intervals +
      (problems.length ? '  ' + problems.join('; ') : '')
    );
  });
  if (!onlyKey || onlyKey === 'kenworth') {
    var kenworth = PROFILES.filter(function(p) { return p.key === 'kenworth'; })[0];
    var sweepBad = 0;
    var sweepMin = Infinity;
    var sweepMax = -Infinity;
    var sweepN = 0;
    for (var sid = 1; sid <= 60; sid++) {
      var sRng = mulberry32(hashSeed('kenworth:' + sid + ':demo75'));
      var sDaily = generateDailyMap(kenworth, dates, sRng);
      var sFills = buildFills(dates, sDaily, kenworth, placeFillDates(dates, sDaily, kenworth, sRng), 1.85, sRng);
      var sCal = truckResidualIdle(dates, sDaily, sFills, kenworth);
      if (sCal.idleLph == null) { sweepBad += 1; continue; }
      sweepN += 1;
      sweepMin = Math.min(sweepMin, sCal.idleLph);
      sweepMax = Math.max(sweepMax, sCal.idleLph);
      if (sCal.idleLph < 1.3 || sCal.idleLph > 4.5) sweepBad += 1;
    }
    console.log(
      'Kenworth seed sweep (ids 1–60): residual idle ' +
      (sweepN ? sweepMin.toFixed(2) + '–' + sweepMax.toFixed(2) : 'n/a') +
      ' L/hr  outside 1.3–4.5: ' + sweepBad + '/60'
    );
    if (sweepBad > 6) {
      console.error('Kenworth residual idle is seed-fragile — ' + sweepBad + ' of 60 ids outside 1.3–4.5 L/hr');
      failed = true;
    }
  }
  if (failed) {
    console.error('\nSimulate failed');
    process.exit(1);
  }
  console.log('\nSimulate passed');
}

async function main() {
  if (process.argv.indexOf('--simulate') !== -1) {
    simulateLocally();
    return;
  }

  var dryRun = process.argv.indexOf('--dry-run') !== -1;
  var onlyKey = parseOnlyKey();
  var supabaseUrl = process.env.SUPABASE_URL || 'https://pddsgvuzvuwueuvpoytw.supabase.co';
  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceKey) {
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY. Refusing to run.');
    process.exit(1);
  }

  var supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  var endDate = todayNz();
  var startDate = addDays(endDate, -(DAYS - 1));
  var dates = eachDateInclusive(startDate, endDate);

  console.log('Demo history generator');
  console.log('  user_id:   ' + DEMO_USER_ID);
  console.log('  window:    ' + startDate + ' → ' + endDate + ' (' + dates.length + ' days)');
  console.log('  mode:      ' + (dryRun ? 'DRY RUN (no writes)' : 'LIVE WRITE'));
  if (onlyKey) console.log('  --only:    ' + onlyKey + ' (jobs and user_settings left untouched)');
  console.log('');

  console.log('Probing live schemas…');
  var telCols = await probeColumns(supabase, 'telematics_records', [
    'user_id', 'asset_id', 'record_date',
    'operating_hours', 'idle_hours', 'total_engine_hours', 'litres_consumed',
    'daily_distance_km', 'odometer_km', 'data_quality_notes'
  ]);
  var fuelCols = await probeColumns(supabase, 'fuel_purchases', [
    'user_id', 'vehicle_id', 'purchase_date', 'litres', 'cost_nzd', 'source', 'odometer_reading'
  ]);
  var jobCols = await probeColumns(supabase, 'jobs', [
    'user_id', 'job_name', 'status', 'start_date', 'end_date', 'tonnes_moved'
  ]);
  var jobAssetCols = await probeColumns(supabase, 'job_assets', [
    'user_id', 'job_id', 'asset_id', 'work_date'
  ]);
  var assetCols = await probeColumns(supabase, 'assets', [
    'id', 'user_id', 'asset_name', 'asset_type', 'current_hours', 'current_odometer',
    'is_ignored', 'is_on_road'
  ]);
  var fuelRecordsExist = await tableExists(supabase, 'fuel_records');
  var fuelRecordCols = fuelRecordsExist
    ? await probeColumns(supabase, 'fuel_records', [
      'user_id', 'asset_id', 'record_date', 'litres', 'total_cost', 'cost_per_litre', 'supplier'
    ])
    : { existing: [], missing: ['table missing'] };
  var settingsExist = await tableExists(supabase, 'user_settings');

  console.log('  telematics_records columns:', telCols.existing.join(', '));
  if (telCols.missing.length) console.log('    not present:', telCols.missing.join('; '));
  console.log('  fuel_purchases columns:', fuelCols.existing.join(', '));
  if (fuelCols.missing.length) console.log('    not present:', fuelCols.missing.join('; '));
  console.log('  jobs columns:', jobCols.existing.join(', '));
  console.log('  job_assets columns:', jobAssetCols.existing.join(', '));
  console.log('  fuel_records:', fuelRecordsExist ? fuelRecordCols.existing.join(', ') : 'not available');
  console.log('');

  var requiredTel = ['user_id', 'asset_id', 'record_date', 'idle_hours'];
  requiredTel.forEach(function(c) {
    if (telCols.existing.indexOf(c) === -1) {
      throw new Error('telematics_records missing required column ' + c);
    }
  });
  if (fuelCols.existing.indexOf('vehicle_id') === -1 || fuelCols.existing.indexOf('purchase_date') === -1) {
    throw new Error('fuel_purchases missing required columns');
  }

  console.log('Loading demo assets…');
  var assetsResult = await supabase
    .from('assets')
    .select(assetCols.existing.join(','))
    .eq('user_id', DEMO_USER_ID);
  if (assetsResult.error) throw new Error('assets query failed: ' + assetsResult.error.message);
  var assets = (assetsResult.data || []).filter(function(a) { return a.is_ignored !== true; });
  console.log('  found ' + assets.length + ' non-ignored assets for this user');

  var byKey = {};
  var unmatched = [];
  assets.forEach(function(asset) {
    var profile = matchProfile(asset);
    if (!profile) {
      unmatched.push(asset.asset_name + ' (id=' + asset.id + ', type=' + asset.asset_type + ')');
      return;
    }
    if (byKey[profile.key]) {
      throw new Error('Profile ' + profile.key + ' matched two assets: ' + byKey[profile.key].asset.asset_name + ' and ' + asset.asset_name);
    }
    var onRoad = ON_ROAD_TYPES[(asset.asset_type || '').trim()] || asset.is_on_road === true;
    if (profile.kind === 'truck' && !onRoad) {
      console.log('  WARN: ' + asset.asset_name + ' matched a truck profile but asset_type=' + asset.asset_type);
    }
    if (profile.kind === 'machinery' && onRoad) {
      console.log('  WARN: ' + asset.asset_name + ' matched a machinery profile but asset_type=' + asset.asset_type);
    }
    byKey[profile.key] = { asset: asset, profile: profile };
    console.log('  matched ' + profile.key + ' → id=' + asset.id + ' "' + asset.asset_name + '" type=' + asset.asset_type);
  });

  var missingProfiles = PROFILES.filter(function(p) { return !byKey[p.key]; });
  if (onlyKey) {
    if (!byKey[onlyKey]) {
      throw new Error('--only ' + onlyKey + ' did not match a demo asset. Matched keys: ' + Object.keys(byKey).join(', '));
    }
    var kept = byKey[onlyKey];
    byKey = {};
    byKey[onlyKey] = kept;
    console.log('  --only ' + onlyKey + ': regenerating this asset only');
  } else if (missingProfiles.length) {
    throw new Error(
      'Could not match all 10 demo assets. Missing: ' +
      missingProfiles.map(function(p) { return p.key; }).join(', ') +
      (unmatched.length ? '. Unmatched rows: ' + unmatched.join('; ') : '')
    );
  }
  if (unmatched.length) {
    console.log('  extra unmatched assets (left untouched): ' + unmatched.join('; '));
  }

  var demoAssetIds = Object.keys(byKey).map(function(k) { return Number(byKey[k].asset.id); });

  console.log('');
  console.log('Discovering diesel price from existing customer data…');
  var pricing = await discoverDieselPrice(supabase);
  console.log('  machinery bulk $/L: ' + pricing.bulkPrice.toFixed(3) + '  [' + pricing.bulkSource + ']');
  console.log('  fleet card $/L:     ' + pricing.fleetPrice.toFixed(3) + '  [' + pricing.fleetSource + ']');
  console.log('  fuel_purchases.source: "' + pricing.sourceValue + '"');
  console.log('');

  // -------------------------------------------------------------------------
  // Generate per-asset series
  // -------------------------------------------------------------------------
  var telRows = [];
  var fuelPurchaseRows = [];
  var fuelRecordRows = [];
  var assetUpdates = [];
  var summaries = [];

  Object.keys(byKey).forEach(function(key) {
    var entry = byKey[key];
    var asset = entry.asset;
    var profile = entry.profile;
    var salt = 'demo75';
    if (profile.key === 'kenworth') {
      var kenworthSalts = ['demo75', 'demo75b', 'demo75c', 'demo75d', 'demo75e', 'demo75f'];
      var trialPpl = pricing.fleetPrice;
      for (var si = 0; si < kenworthSalts.length; si++) {
        var trialRng = mulberry32(hashSeed(profile.key + ':' + asset.id + ':' + kenworthSalts[si]));
        var trialDaily = generateDailyMap(profile, dates, trialRng);
        var trialFillDates = placeFillDates(dates, trialDaily, profile, trialRng);
        var trialFills = buildFills(dates, trialDaily, profile, trialFillDates, trialPpl, trialRng);
        var trialCal = truckResidualIdle(dates, trialDaily, trialFills, profile);
        if (trialCal.idleLph != null && trialCal.idleLph >= 1.8 && trialCal.idleLph <= 4.2) {
          salt = kenworthSalts[si];
          if (si > 0) console.log('  Kenworth seed salt=' + salt + ' (residual idle ' + trialCal.idleLph.toFixed(2) + ' L/hr)');
          break;
        }
        if (si === kenworthSalts.length - 1) {
          salt = kenworthSalts[0];
          console.log('  WARN: Kenworth residual idle stayed outside 1.8–4.2 L/hr across salts; using demo75');
        }
      }
    }
    var rng = mulberry32(hashSeed(profile.key + ':' + asset.id + ':' + salt));
    var daily = generateDailyMap(profile, dates, rng);

    var cumHours = profile.startHours || 0;
    var cumOdo = profile.startOdo || 0;
    var recordsKept = 0;
    var zeroDays = 0;

    dates.forEach(function(d) {
      var day = daily[d];
      var keep;
      if (profile.kind === 'truck') {
        // eROAD stores zero-activity rows. Keep every day so the regression
        // engine does not see weekday gaps (which exclude fill intervals).
        keep = true;
      } else {
        // VisionLink skips fully empty Sunday rows, but weekdays still get a
        // record even when the machine is parked (rain / breakdown) so we
        // stay comfortably above the 60/75 sanity floor.
        keep = day.active || !isSunday(d);
      }
      if (!keep) {
        zeroDays += 1;
        return;
      }
      recordsKept += 1;
      if (!day.active) zeroDays += 1;

      cumHours = round1(cumHours + day.operating + day.idle);
      cumOdo = round1(cumOdo + day.km);

      var row = {
        user_id: DEMO_USER_ID,
        asset_id: Number(asset.id),
        record_date: d,
        idle_hours: day.idle
      };
      if (profile.kind === 'machinery') {
        row.operating_hours = day.operating;
        row.total_engine_hours = cumHours;
        row.litres_consumed = day.litres;
      } else {
        row.daily_distance_km = day.km;
        row.odometer_km = cumOdo;
        row.operating_hours = day.operating;
      }
      telRows.push(pickColumns(row, telCols.existing));

      if (profile.kind === 'machinery' && day.active && fuelRecordsExist && day.litres > 0) {
        var fr = {
          user_id: DEMO_USER_ID,
          asset_id: Number(asset.id),
          record_date: d,
          litres: day.litres,
          total_cost: round2(day.litres * pricing.bulkPrice),
          cost_per_litre: pricing.bulkPrice,
          supplier: 'demo'
        };
        fuelRecordRows.push(pickColumns(fr, fuelRecordCols.existing));
      }
    });

    var fillDates = placeFillDates(dates, daily, profile, rng);
    var ppl = profile.kind === 'truck' ? pricing.fleetPrice : pricing.bulkPrice;
    var fills = buildFills(dates, daily, profile, fillDates, ppl, rng);
    fills.forEach(function(f) {
      var odoThatDay = null;
      if (profile.kind === 'truck') {
        var running = profile.startOdo;
        dates.some(function(d) {
          running = round1(running + daily[d].km);
          if (d === f.purchase_date) {
            odoThatDay = running;
            return true;
          }
          return false;
        });
      }
      var row = {
        user_id: DEMO_USER_ID,
        vehicle_id: Number(asset.id),
        purchase_date: f.purchase_date,
        litres: f.litres,
        cost_nzd: f.cost_nzd,
        source: pricing.sourceValue,
        odometer_reading: odoThatDay
      };
      fuelPurchaseRows.push(pickColumns(row, fuelCols.existing));
    });

    var finalHours = profile.kind === 'machinery' ? cumHours : null;
    var finalOdo = profile.kind === 'truck' ? cumOdo : null;
    var patch = { id: Number(asset.id) };
    if (profile.kind === 'machinery') patch.current_hours = finalHours;
    if (profile.kind === 'truck') patch.current_odometer = finalOdo;
    assetUpdates.push(patch);

    var totalOp = 0, totalIdle = 0, totalKm = 0, totalLitres = 0, activeDays = 0;
    dates.forEach(function(d) {
      var day = daily[d];
      totalOp += day.operating;
      totalIdle += day.idle;
      totalKm += day.km;
      totalLitres += day.litres;
      if (day.active) activeDays += 1;
    });

    summaries.push({
      key: key,
      name: asset.asset_name,
      id: asset.id,
      kind: profile.kind,
      telDays: recordsKept,
      activeDays: activeDays,
      fills: fills.length,
      intervals: fills.length - 1,
      startHours: profile.startHours || null,
      finalHours: finalHours,
      startOdo: profile.startOdo || null,
      finalOdo: finalOdo,
      totalOp: round1(totalOp),
      totalIdle: round1(totalIdle),
      totalKm: round1(totalKm),
      totalLitres: round1(totalLitres),
      firstFill: fills[0] && fills[0].purchase_date,
      lastFill: fills[fills.length - 1] && fills[fills.length - 1].purchase_date,
      daily: daily,
      fillDates: fillDates,
      residual: profile.kind === 'truck' ? truckResidualIdle(dates, daily, fills, profile) : null
    });
  });

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------
  var jobPayloads = JOB_SPECS.map(function(spec) {
    return pickColumns({
      user_id: DEMO_USER_ID,
      job_name: spec.job_name,
      status: spec.status,
      start_date: addDays(endDate, -spec.startOffset),
      end_date: addDays(endDate, -spec.endOffset),
      tonnes_moved: spec.tonnes_moved
    }, jobCols.existing);
  });

  function workDatesFor(spec, assetKey) {
    var summary = summaries.filter(function(s) { return s.key === assetKey; })[0];
    var start = addDays(endDate, -spec.startOffset);
    var end = addDays(endDate, -spec.endOffset);
    return dates.filter(function(d) {
      return d >= start && d <= end && summary.daily[d] && summary.daily[d].active && !isWeekend(d);
    });
  }

  // -------------------------------------------------------------------------
  // Sanity (pre-write)
  // -------------------------------------------------------------------------
  console.log('Pre-write sanity…');
  var sanityFailed = false;
  summaries.forEach(function(s) {
    var problems = [];
    if (s.intervals < MIN_FUEL_INTERVALS) problems.push('only ' + s.intervals + ' fuel intervals');
    if (s.telDays < MIN_TELEMATICS_DAYS) problems.push('only ' + s.telDays + ' telematics days');
    if (s.kind === 'machinery' && Math.abs(s.finalHours - (s.startHours + s.totalOp + s.totalIdle)) > 0.2) {
      problems.push('hours mismatch');
    }
    if (s.kind === 'truck' && Math.abs(s.finalOdo - (s.startOdo + s.totalKm)) > 0.2) {
      problems.push('odometer mismatch');
    }
    if (s.key === 'kenworth' && s.residual &&
        (s.residual.idleLph == null || s.residual.idleLph < 1.3 || s.residual.idleLph > 4.5)) {
      problems.push('residual idle=' + (s.residual.idleLph != null ? s.residual.idleLph.toFixed(2) : 'n/a') + ' L/hr');
    }
    if (problems.length) {
      sanityFailed = true;
      console.log('  FAIL ' + s.name + ': ' + problems.join('; '));
    } else {
      console.log('  ok   ' + s.name + '  tel=' + s.telDays + '  fills=' + s.fills + ' (' + s.intervals + ' intervals)');
    }
  });
  if (sanityFailed) throw new Error('Pre-write sanity checks failed — nothing written');

  if (dryRun) {
    printSummary(summaries, onlyKey ? [] : jobPayloads, startDate, endDate, pricing);
    console.log('\nDRY RUN complete — no database writes.');
    return;
  }

  // -------------------------------------------------------------------------
  // Writes (demo user only)
  // -------------------------------------------------------------------------
  console.log('');
  console.log('Clearing previously generated demo history for this user only…');

  await deleteScoped(supabase, 'telematics_records', {
    user_id: DEMO_USER_ID,
    asset_id: { in: demoAssetIds },
    record_date: { gte: startDate }
  });
  await deleteScoped(supabase, 'fuel_purchases', {
    user_id: DEMO_USER_ID,
    vehicle_id: { in: demoAssetIds },
    purchase_date: { gte: startDate }
  });
  if (fuelRecordsExist) {
    await deleteScoped(supabase, 'fuel_records', {
      user_id: DEMO_USER_ID,
      asset_id: { in: demoAssetIds },
      record_date: { gte: startDate }
    });
  }
  var calExists = await tableExists(supabase, 'fuel_calibration_intervals');
  if (calExists) {
    await deleteScoped(supabase, 'fuel_calibration_intervals', {
      asset_id: { in: demoAssetIds }
    });
  }

  console.log('Inserting ' + telRows.length + ' telematics_records…');
  await batchedInsert(supabase, 'telematics_records', telRows);

  console.log('Inserting ' + fuelPurchaseRows.length + ' fuel_purchases…');
  await batchedInsert(supabase, 'fuel_purchases', fuelPurchaseRows);

  if (fuelRecordRows.length) {
    console.log('Inserting ' + fuelRecordRows.length + ' fuel_records (machinery daily burn → Job Cost Analyst)…');
    await batchedInsert(supabase, 'fuel_records', fuelRecordRows);
  }

  console.log('Updating assets.current_hours / current_odometer…');
  for (var u = 0; u < assetUpdates.length; u++) {
    var patch = assetUpdates[u];
    var id = patch.id;
    delete patch.id;
    var upd = await supabase.from('assets').update(patch).eq('id', id).eq('user_id', DEMO_USER_ID);
    if (upd.error) throw new Error('asset update id=' + id + ' failed: ' + upd.error.message);
  }

  var insertedJobs = [];
  if (onlyKey) {
    console.log('  --only: leaving jobs and user_settings untouched');
  } else {
    if (settingsExist && jobCols.existing) {
      var existingSettings = await supabase
        .from('user_settings')
        .select('user_id, machinery_fuel_cost_per_litre')
        .eq('user_id', DEMO_USER_ID)
        .maybeSingle();
      if (!existingSettings.error) {
        if (existingSettings.data) {
          if (existingSettings.data.machinery_fuel_cost_per_litre == null) {
            var setUpd = await supabase
              .from('user_settings')
              .update({ machinery_fuel_cost_per_litre: pricing.bulkPrice })
              .eq('user_id', DEMO_USER_ID);
            if (setUpd.error) console.log('  WARN user_settings update: ' + setUpd.error.message);
            else console.log('  set user_settings.machinery_fuel_cost_per_litre = ' + pricing.bulkPrice);
          } else {
            console.log('  leaving existing machinery_fuel_cost_per_litre = ' + existingSettings.data.machinery_fuel_cost_per_litre);
          }
        } else {
          var setIns = await supabase.from('user_settings').insert({
            user_id: DEMO_USER_ID,
            machinery_fuel_cost_per_litre: pricing.bulkPrice
          });
          if (setIns.error) console.log('  WARN user_settings insert: ' + setIns.error.message);
          else console.log('  inserted user_settings.machinery_fuel_cost_per_litre = ' + pricing.bulkPrice);
        }
      }
    }

    // Remove existing demo jobs (this account is dedicated demo).
    var existingJobs = await supabase.from('jobs').select('id').eq('user_id', DEMO_USER_ID);
    if (existingJobs.error) throw new Error('jobs list failed: ' + existingJobs.error.message);
    var existingJobIds = (existingJobs.data || []).map(function(j) { return j.id; });
    if (existingJobIds.length) {
      await deleteScoped(supabase, 'job_assets', { user_id: DEMO_USER_ID, job_id: { in: existingJobIds } });
      await deleteScoped(supabase, 'jobs', { user_id: DEMO_USER_ID, id: { in: existingJobIds } });
    }

    console.log('Inserting jobs…');
    var jobInsert = await supabase.from('jobs').insert(jobPayloads).select('id, job_name, start_date, end_date');
    if (jobInsert.error) throw new Error('jobs insert failed: ' + jobInsert.error.message);
    insertedJobs = jobInsert.data || [];

    var jobAssetRows = [];
    insertedJobs.forEach(function(job) {
      var spec = JOB_SPECS.filter(function(s) { return s.job_name === job.job_name; })[0];
      spec.assetKeys.forEach(function(assetKey) {
        var assetId = Number(byKey[assetKey].asset.id);
        workDatesFor(spec, assetKey).forEach(function(d) {
          jobAssetRows.push(pickColumns({
            user_id: DEMO_USER_ID,
            job_id: job.id,
            asset_id: assetId,
            work_date: d
          }, jobAssetCols.existing));
        });
      });
    });
    console.log('Inserting ' + jobAssetRows.length + ' job_assets…');
    await batchedInsert(supabase, 'job_assets', jobAssetRows);
  }

  // -------------------------------------------------------------------------
  // Post-write sanity
  // -------------------------------------------------------------------------
  console.log('');
  console.log('Post-write sanity queries…');
  for (var s = 0; s < summaries.length; s++) {
    var sum = summaries[s];
    var telCount = await supabase
      .from('telematics_records')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', DEMO_USER_ID)
      .eq('asset_id', Number(sum.id))
      .gte('record_date', startDate)
      .lte('record_date', endDate);
    var fuelCount = await supabase
      .from('fuel_purchases')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', DEMO_USER_ID)
      .eq('vehicle_id', Number(sum.id))
      .gte('purchase_date', startDate)
      .lte('purchase_date', endDate);
    var assetRow = await supabase
      .from('assets')
      .select('current_hours, current_odometer')
      .eq('id', Number(sum.id))
      .eq('user_id', DEMO_USER_ID)
      .single();

    var telN = telCount.count || 0;
    var fuelN = fuelCount.count || 0;
    var intervals = fuelN - 1;
    var okTel = telN >= MIN_TELEMATICS_DAYS;
    var okFuel = intervals >= MIN_FUEL_INTERVALS;
    var okCum = true;
    var cumNote = '';
    if (sum.kind === 'machinery') {
      var ch = parseFloat(assetRow.data && assetRow.data.current_hours);
      okCum = Math.abs(ch - sum.finalHours) < 0.2;
      cumNote = 'current_hours=' + ch + ' expected=' + sum.finalHours;
    } else {
      var co = parseFloat(assetRow.data && assetRow.data.current_odometer);
      okCum = Math.abs(co - sum.finalOdo) < 0.2;
      cumNote = 'current_odometer=' + co + ' expected=' + sum.finalOdo;
    }
    var flag = (okTel && okFuel && okCum) ? 'OK  ' : 'FAIL';
    console.log(
      '  [' + flag + '] ' + sum.name +
      '  tel=' + telN + '/' + DAYS +
      '  fills=' + fuelN + ' (intervals=' + intervals + ')' +
      '  ' + cumNote
    );
    if (!okTel || !okFuel || !okCum) sanityFailed = true;
  }
  if (sanityFailed) throw new Error('Post-write sanity checks failed');

  printSummary(summaries, insertedJobs, startDate, endDate, pricing);

  console.log('');
  console.log('Running fuel regression calibration for this user…');
  try {
    var { spawnSync } = require('child_process');
    var rr = spawnSync(process.execPath, ['lib/fuel-regression.js', '--user-id', DEMO_USER_ID], {
      cwd: require('path').join(__dirname, '..'),
      env: process.env,
      encoding: 'utf8'
    });
    if (rr.stdout) process.stdout.write(rr.stdout);
    if (rr.stderr) process.stderr.write(rr.stderr);
    if (rr.status !== 0) {
      console.log('  WARN: fuel-regression exited ' + rr.status + ' (history was still written)');
    }
  } catch (err) {
    console.log('  WARN: could not run fuel-regression: ' + err.message);
  }

  console.log('\nDone.');
}

function printSummary(summaries, jobs, startDate, endDate, pricing) {
  console.log('');
  console.log('========== DEMO HISTORY SUMMARY ==========');
  console.log('Date range: ' + startDate + ' → ' + endDate);
  console.log('Diesel: bulk $' + pricing.bulkPrice.toFixed(3) + '/L (' + pricing.bulkSource + ')');
  console.log('         fleet card $' + pricing.fleetPrice.toFixed(3) + '/L (' + pricing.fleetSource + ')');
  console.log('fuel_purchases.source = "' + pricing.sourceValue + '"');
  console.log('');
  summaries.forEach(function(s) {
    console.log(s.name + '  [' + s.kind + ', id=' + s.id + ']');
    console.log('  telematics days: ' + s.telDays + '  (active ' + s.activeDays + ')');
    console.log('  fuel purchases:  ' + s.fills + '  (' + s.intervals + ' intervals)  ' + s.firstFill + ' → ' + s.lastFill);
    if (s.kind === 'machinery') {
      console.log('  hours:           ' + s.startHours.toFixed(1) + ' → ' + s.finalHours.toFixed(1) +
        '  (working ' + s.totalOp.toFixed(1) + 'h, idle ' + s.totalIdle.toFixed(1) + 'h)');
      console.log('  litres burned:   ' + s.totalLitres.toFixed(1) + ' L (VisionLink litres_consumed)');
    } else {
      console.log('  odometer:        ' + s.startOdo.toFixed(1) + ' → ' + s.finalOdo.toFixed(1) +
        ' km  (distance ' + s.totalKm.toFixed(1) + ' km, idle ' + s.totalIdle.toFixed(1) + 'h)');
      console.log('  litres (fills):  modelled from ' + s.totalLitres.toFixed(1) + ' L burned');
      if (s.residual) {
        console.log('  regression (predicted): travel ' + s.residual.travelLpk.toFixed(3) +
          ' L/km  residual idle ' +
          (s.residual.idleLph != null ? s.residual.idleLph.toFixed(2) : 'n/a') + ' L/hr');
      }
    }
  });
  console.log('');
  if (jobs && jobs.length) {
    console.log('Jobs:');
    jobs.forEach(function(j) {
      var spec = JOB_SPECS.filter(function(s) { return s.job_name === j.job_name; })[0];
      console.log('  ' + j.job_name + '  ' + (j.start_date || spec && addDays(endDate, -spec.startOffset)) +
        ' → ' + (j.end_date || '') + '  [' + (j.status || (spec && spec.status)) + ']  assets=' +
        (spec ? spec.assetKeys.join(', ') : ''));
    });
  }
  console.log('==========================================');
}

main().catch(function(err) {
  console.error('\nFatal: ' + err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
