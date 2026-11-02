/**
 * Date ranges for Asset overview. Dates are NZ calendar dates (YYYY-MM-DD).
 * Pass "today" in; this file never reads the clock, so a UTC host cannot
 * shift the day. Invented examples only — no customer data.
 *
 * Utilisation uses the same window rule as True Utilisation Analyst:
 * available hours = weekly capacity × (calendar days / 7). When the
 * selection is significantly wider than the recorded dates, the headline
 * uses the first-to-last telematics dates inside the selection. Otherwise
 * it uses the selected range.
 */
(function(root) {
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var NAMED_PRESETS = ['this-month', 'last-month', 'last-30', 'last-7'];
  var MAX_INCLUSIVE_DAYS = 366;
  var SUFFIX = {
    'this-month': 'this month',
    'last-month': 'last month',
    'last-30': 'last 30 days',
    'last-7': 'last 7 days',
    'custom': 'custom'
  };

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function parts(iso) {
    var text = String(iso || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    var p = text.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    if (d.getFullYear() !== p[0] || d.getMonth() !== p[1] - 1 || d.getDate() !== p[2]) return null;
    return p;
  }

  function isoFromParts(y, m, d) {
    return y + '-' + pad(m) + '-' + pad(d);
  }

  function addDaysISO(iso, days) {
    var p = parts(iso);
    if (!p) return '';
    var d = new Date(p[0], p[1] - 1, p[2]);
    d.setDate(d.getDate() + days);
    return isoFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  function inclusiveDays(from, to) {
    var a = parts(from);
    var b = parts(to);
    if (!a || !b) return NaN;
    return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000) + 1;
  }

  function calendarDaysInRange(dateFrom, dateTo) {
    var start = new Date(dateFrom + 'T00:00:00');
    var end = new Date(dateTo + 'T00:00:00');
    return Math.max(Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1, 1);
  }

  function daySpan(older, newer) {
    var days = inclusiveDays(older, newer);
    if (isNaN(days)) return NaN;
    return days - 1;
  }

  function dayMonth(iso) {
    var p = parts(iso);
    if (!p) return String(iso || '');
    return p[2] + ' ' + MONTHS[p[1] - 1];
  }

  function dayMonthYear(iso) {
    var p = parts(iso);
    if (!p) return '';
    return p[2] + ' ' + MONTHS[p[1] - 1] + ' ' + p[0];
  }

  function isNamedPreset(preset) {
    return NAMED_PRESETS.indexOf(preset) !== -1;
  }

  function thisMonthRange(today) {
    var p = parts(today);
    return { from: isoFromParts(p[0], p[1], 1), to: String(today).slice(0, 10) };
  }

  function lastMonthRange(today) {
    var p = parts(today);
    var year = p[0];
    var month = p[1] - 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
    return {
      from: isoFromParts(year, month, 1),
      to: addDaysISO(isoFromParts(p[0], p[1], 1), -1)
    };
  }

  function presetRange(preset, today) {
    var day = String(today).slice(0, 10);
    if (preset === 'last-month') return lastMonthRange(day);
    if (preset === 'last-30') return { from: addDaysISO(day, -29), to: day };
    if (preset === 'last-7') return { from: addDaysISO(day, -6), to: day };
    return thisMonthRange(day);
  }

  function defaultPreset(today) {
    var p = parts(today);
    if (!p) return 'this-month';
    return p[2] <= 7 ? 'last-30' : 'this-month';
  }

  function shortLabel(from, to) {
    return dayMonth(from) + ' to ' + dayMonth(to);
  }

  function rangeLabel(from, to, preset) {
    var suffix = SUFFIX[preset] || SUFFIX.custom;
    return shortLabel(from, to) + ' (' + suffix + ')';
  }

  function validateCustomRange(from, to, today) {
    var start = String(from || '').trim();
    var end = String(to || '').trim();
    var day = String(today || '').slice(0, 10);
    if (!parts(start) || !parts(end) || !parts(day)) {
      return { ok: false, message: 'Enter valid dates.' };
    }
    if (start > end) return { ok: false, message: 'From is after to.' };
    if (end > day) return { ok: false, message: 'To is after today.' };
    if (inclusiveDays(start, end) > MAX_INCLUSIVE_DAYS) {
      return { ok: false, message: 'Range is longer than 366 days.' };
    }
    return { ok: true, from: start, to: end };
  }

  function matchingPreset(from, to, today) {
    for (var i = 0; i < NAMED_PRESETS.length; i++) {
      var range = presetRange(NAMED_PRESETS[i], today);
      if (range.from === from && range.to === to) return NAMED_PRESETS[i];
    }
    return null;
  }

  function rangeFromQuery(search, today) {
    var query = String(search || '');
    if (query.charAt(0) === '?') query = query.slice(1);
    var params = new URLSearchParams(query);
    if (!params.has('from') && !params.has('to')) return null;
    var checked = validateCustomRange(params.get('from'), params.get('to'), today);
    if (!checked.ok) return null;
    return {
      from: checked.from,
      to: checked.to,
      preset: matchingPreset(checked.from, checked.to, today) || 'custom'
    };
  }

  function resolveInitialRange(search, rememberedPreset, today) {
    var fromUrl = rangeFromQuery(search, today);
    if (fromUrl) return fromUrl;
    var preset = isNamedPreset(rememberedPreset) ? rememberedPreset : defaultPreset(today);
    var range = presetRange(preset, today);
    return { from: range.from, to: range.to, preset: preset };
  }

  function overviewQuery(assetId, from, to) {
    var bits = [];
    if (assetId != null && String(assetId) !== '') bits.push('asset=' + encodeURIComponent(assetId));
    if (from) bits.push('from=' + encodeURIComponent(from));
    if (to) bits.push('to=' + encodeURIComponent(to));
    return bits.length ? '?' + bits.join('&') : '';
  }

  function isRangeSignificantlyWiderThanData(selFrom, selTo, dataFrom, dataTo) {
    if (selFrom >= dataFrom && selTo <= dataTo) return false;
    var selDays = calendarDaysInRange(selFrom, selTo);
    var dataDays = calendarDaysInRange(dataFrom, dataTo);
    if (dataDays <= 0) return false;
    return selDays > dataDays * 1.25 || (selDays - dataDays) >= 14;
  }

  function utilisationForSelection(opts) {
    var from = opts.from;
    var to = opts.to;
    var windowFrom = from;
    var windowTo = to;
    var usedDataWindow = false;
    if (opts.dataFrom && opts.dataTo && isRangeSignificantlyWiderThanData(from, to, opts.dataFrom, opts.dataTo)) {
      windowFrom = opts.dataFrom;
      windowTo = opts.dataTo;
      usedDataWindow = true;
    }
    var days = calendarDaysInRange(windowFrom, windowTo);
    var available = Number(opts.hoursPerWeek) * (days / 7);
    var working = Number(opts.workingHours) || 0;
    var rate = available > 0 ? (working / available) * 100 : 0;
    return {
      available: available,
      rate: rate,
      windowFrom: windowFrom,
      windowTo: windowTo,
      usedDataWindow: usedDataWindow
    };
  }

  function chartEmptyMessage(latestDate) {
    var day = String(latestDate || '').slice(0, 10);
    if (!parts(day)) return 'No records yet';
    return 'No records in this period. Last record: ' + dayMonthYear(day) + '.';
  }

  function reportIsToday(latestDate, today) {
    var latest = String(latestDate || '').slice(0, 10);
    var day = String(today || '').slice(0, 10);
    return !!parts(latest) && latest === day;
  }

  function isReportStale(latestDate, today) {
    var latest = String(latestDate || '').slice(0, 10);
    var day = String(today || '').slice(0, 10);
    if (!parts(latest) || !parts(day)) return false;
    return daySpan(latest, day) > 1;
  }

  var api = {
    MAX_INCLUSIVE_DAYS: MAX_INCLUSIVE_DAYS,
    isNamedPreset: isNamedPreset,
    presetRange: presetRange,
    defaultPreset: defaultPreset,
    shortLabel: shortLabel,
    rangeLabel: rangeLabel,
    dayMonth: dayMonth,
    validateCustomRange: validateCustomRange,
    matchingPreset: matchingPreset,
    rangeFromQuery: rangeFromQuery,
    resolveInitialRange: resolveInitialRange,
    overviewQuery: overviewQuery,
    inclusiveDays: inclusiveDays,
    calendarDaysInRange: calendarDaysInRange,
    isRangeSignificantlyWiderThanData: isRangeSignificantlyWiderThanData,
    utilisationForSelection: utilisationForSelection,
    chartEmptyMessage: chartEmptyMessage,
    reportIsToday: reportIsToday,
    isReportStale: isReportStale
  };

  root.AssetOverviewRange = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
