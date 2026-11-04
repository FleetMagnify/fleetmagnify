/**
 * Decide which regular inbound feeds have gone quiet, and send one
 * owner alert. Dates are New Zealand calendar dates (Pacific/Auckland
 * via Intl). "now" is injectable. Nothing here writes an import.
 *
 * A feed is (user_id, from_email). processed and failed rows are
 * deliveries. Every profile is included except subscription_status
 * cancelled or canceled. trial, null, and blank still receive data.
 * A user with no profile row is left out. This is not the billing
 * status list used by the quantity sync.
 */

var NZ_TZ = 'Pacific/Auckland';
var HISTORY_DAYS = 28;
var REGULAR_DAYS = 14;
var REGULAR_MIN_DATES = 5;
var PAGE_SIZE = 1000;
var ALERT_FROM = 'alerts@fleetmagnify.com';
var ALERT_TO = 'fleetmagnify@gmail.com';
var DELIVERY_STATUSES = { processed: true, failed: true };
var EXCLUDED_ACCOUNT_STATUSES = { cancelled: true, canceled: true };

function asDate(value) {
  if (value instanceof Date) return value;
  return new Date(value);
}

function nzDateISO(instant) {
  var date = asDate(instant);
  if (isNaN(date.getTime())) return '';
  var map = {};
  new Intl.DateTimeFormat('en-NZ', {
    timeZone: NZ_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).forEach(function (part) {
    if (part.type !== 'literal') map[part.type] = part.value;
  });
  if (!map.year || !map.month || !map.day) return '';
  return map.year + '-' + map.month + '-' + map.day;
}

function addCalendarDays(iso, days) {
  var parts = String(iso).split('-');
  var utc = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + days));
  var month = String(utc.getUTCMonth() + 1);
  var day = String(utc.getUTCDate());
  if (month.length < 2) month = '0' + month;
  if (day.length < 2) day = '0' + day;
  return utc.getUTCFullYear() + '-' + month + '-' + day;
}

function weekdayNumber(iso) {
  var parts = String(iso).split('-');
  return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))).getUTCDay();
}

function isWeekend(iso) {
  var day = weekdayNumber(iso);
  return day === 0 || day === 6;
}

/**
 * UTC instant of midnight at the start of an NZ civil date.
 * NZ is either 12 or 13 hours ahead; Intl picks which one, so daylight
 * saving is not a fixed offset.
 */
function nzMidnightUtc(isoDate) {
  var prev = addCalendarDays(isoDate, -1);
  var parts = prev.split('-');
  var year = Number(parts[0]);
  var month = Number(parts[1]) - 1;
  var day = Number(parts[2]);
  var candidates = [
    new Date(Date.UTC(year, month, day, 11, 0, 0, 0)),
    new Date(Date.UTC(year, month, day, 12, 0, 0, 0))
  ];
  for (var i = 0; i < candidates.length; i++) {
    var instant = candidates[i];
    if (nzDateISO(instant) === isoDate && nzDateISO(new Date(instant.getTime() - 1)) !== isoDate) {
      return instant;
    }
  }
  throw new Error('Could not resolve New Zealand midnight');
}

function isDeliveryStatus(status) {
  return DELIVERY_STATUSES[String(status || '').toLowerCase()] === true;
}

function isBillableAccount(account) {
  if (!account) return false;
  var status = account.subscription_status;
  if (status == null) return true;
  var normalized = String(status).trim().toLowerCase();
  if (!normalized) return true;
  return !EXCLUDED_ACCOUNT_STATUSES[normalized];
}

function datesInWindow(dateList, today, days) {
  var start = addCalendarDays(today, -(days - 1));
  return dateList.filter(function (iso) {
    return iso >= start && iso <= today;
  });
}

function isRegular(dateList, today) {
  return datesInWindow(dateList, today, REGULAR_DAYS).length >= REGULAR_MIN_DATES;
}

function isWeekdayOnly(dateList, today) {
  var recent = datesInWindow(dateList, today, REGULAR_DAYS);
  for (var i = 0; i < recent.length; i++) {
    if (isWeekend(recent[i])) return false;
  }
  return true;
}

function countMissedDays(lastDate, today, weekdayOnly) {
  var yesterday = addCalendarDays(today, -1);
  if (!lastDate || lastDate >= yesterday) return 0;
  var cursor = addCalendarDays(lastDate, 1);
  var missed = 0;
  var guard = 0;
  while (cursor <= yesterday) {
    if (!weekdayOnly || !isWeekend(cursor)) missed += 1;
    cursor = addCalendarDays(cursor, 1);
    guard += 1;
    if (guard > 400) break;
  }
  return missed;
}

function isAlertMilestone(missedDays) {
  return missedDays === 1 || missedDays === 3 || missedDays === 7;
}

function collectFeeds(rows, today) {
  var windowStart = addCalendarDays(today, -(HISTORY_DAYS - 1));
  var feeds = {};
  (rows || []).forEach(function (row) {
    if (!row || !row.user_id) return;
    var sender = String(row.from_email || '').trim();
    if (!sender) return;
    if (!isDeliveryStatus(row.status)) return;
    var nzDate = nzDateISO(row.received_at);
    if (!nzDate || nzDate < windowStart || nzDate > today) return;
    var key = String(row.user_id) + '\n' + sender.toLowerCase();
    var received = String(row.received_at || '');
    if (!feeds[key]) {
      feeds[key] = { userId: String(row.user_id), fromEmail: sender, dates: {}, latestAt: received };
    }
    feeds[key].dates[nzDate] = true;
    if (received >= feeds[key].latestAt) {
      feeds[key].latestAt = received;
      feeds[key].fromEmail = sender;
    }
  });
  return Object.keys(feeds).map(function (key) {
    var feed = feeds[key];
    feed.dateList = Object.keys(feed.dates).sort();
    return feed;
  });
}

function findOverdueFeeds(rows, now, accounts) {
  var today = nzDateISO(now);
  var overdue = [];
  collectFeeds(rows, today).forEach(function (feed) {
    if (!isRegular(feed.dateList, today)) return;
    var account = accounts && accounts[feed.userId];
    if (!isBillableAccount(account)) return;
    var weekdayOnly = isWeekdayOnly(feed.dateList, today);
    var lastDate = feed.dateList[feed.dateList.length - 1];
    var missed = countMissedDays(lastDate, today, weekdayOnly);
    if (!isAlertMilestone(missed)) return;
    overdue.push({
      userId: feed.userId,
      fromEmail: feed.fromEmail,
      companyName: account.company_name ? String(account.company_name).trim() : '',
      accountEmail: '',
      lastDate: lastDate,
      missedDays: missed
    });
  });
  overdue.sort(function (a, b) {
    var left = accountLabel(a).toLowerCase();
    var right = accountLabel(b).toLowerCase();
    if (left < right) return -1;
    if (left > right) return 1;
    if (a.fromEmail < b.fromEmail) return -1;
    if (a.fromEmail > b.fromEmail) return 1;
    return 0;
  });
  return overdue;
}

function accountLabel(feed) {
  if (feed.companyName && String(feed.companyName).trim()) return String(feed.companyName).trim();
  if (feed.accountEmail && String(feed.accountEmail).trim()) return String(feed.accountEmail).trim();
  return 'Unknown account';
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderAlertHtml(feeds) {
  var parts = ['<p><strong>Regular data feeds have gone quiet.</strong></p>'];
  (feeds || []).forEach(function (feed) {
    parts.push(
      '<p>' + escapeHtml(accountLabel(feed)) +
      ' — ' + escapeHtml(feed.fromEmail) +
      ' — last delivery ' + escapeHtml(feed.lastDate) +
      ' (NZ) — ' + escapeHtml(String(feed.missedDays)) +
      ' missed day(s)</p>'
    );
  });
  return parts.join('');
}

function alertSubject(count) {
  return 'FleetMagnify: ' + count + ' data feed(s) have gone quiet';
}

async function fetchPages(build) {
  var rows = [];
  var from = 0;
  while (true) {
    var result = await build().range(from, from + PAGE_SIZE - 1);
    if (result.error) {
      throw new Error(result.error.message || 'Could not read rows');
    }
    var batch = result.data || [];
    rows = rows.concat(batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

async function fetchImportRows(supabase, sinceIso) {
  return fetchPages(function () {
    return supabase
      .from('email_imports')
      .select('user_id, from_email, received_at, status')
      .gte('received_at', sinceIso)
      .order('received_at', { ascending: true });
  });
}

async function fetchBillableAccounts(supabase) {
  // Fetch every profile, then drop cancelled ones. A SQL NOT IN would
  // also drop null subscription_status, and those accounts still receive data.
  var rows = await fetchPages(function () {
    return supabase
      .from('profiles')
      .select('id, company_name, subscription_status')
      .order('id', { ascending: true });
  });
  var accounts = {};
  rows.forEach(function (row) {
    if (!row || !row.id || !isBillableAccount(row)) return;
    accounts[row.id] = {
      id: row.id,
      company_name: row.company_name || '',
      subscription_status: row.subscription_status
    };
  });
  return accounts;
}

async function attachEmails(supabase, feeds) {
  var admin = supabase && supabase.auth && supabase.auth.admin;
  if (!admin || typeof admin.getUserById !== 'function') return;
  for (var i = 0; i < feeds.length; i++) {
    if (feeds[i].companyName) continue;
    try {
      var result = await admin.getUserById(feeds[i].userId);
      var email = result && result.data && result.data.user && result.data.user.email;
      if (email) feeds[i].accountEmail = String(email).trim();
    } catch (err) {
      console.warn('check-missing-reports: account email lookup failed');
    }
  }
}

function publicFeed(feed) {
  return {
    account: accountLabel(feed),
    fromEmail: feed.fromEmail,
    lastDate: feed.lastDate,
    missedDays: feed.missedDays
  };
}

async function sendAlert(feeds, fetchFn) {
  var apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('check-missing-reports: RESEND_API_KEY is not configured');
    return { ok: true, overdue: feeds.length, sent: false, reason: 'missing_key' };
  }
  try {
    var response = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: ALERT_FROM,
        to: ALERT_TO,
        subject: alertSubject(feeds.length),
        html: renderAlertHtml(feeds)
      })
    });
    var status = response && response.status;
    var accepted = response && (response.ok === true || (typeof status === 'number' && status >= 200 && status < 300));
    if (!accepted) {
      console.error('check-missing-reports: Resend failed', status || '');
      return { ok: true, overdue: feeds.length, sent: false, reason: 'resend_failed', status: status || null };
    }
    return { ok: true, overdue: feeds.length, sent: true };
  } catch (err) {
    var message = err && err.message ? err.message : String(err);
    console.error('check-missing-reports: Resend failed', message);
    return { ok: true, overdue: feeds.length, sent: false, reason: 'resend_failed', error: message };
  }
}

async function runCheck(opts) {
  opts = opts || {};
  var now = asDate(opts.now || new Date());
  var today = nzDateISO(now);
  var since = nzMidnightUtc(addCalendarDays(today, -(HISTORY_DAYS - 1))).toISOString();
  var rows = await fetchImportRows(opts.supabase, since);
  var accounts = await fetchBillableAccounts(opts.supabase);
  var overdue = findOverdueFeeds(rows, now, accounts);
  await attachEmails(opts.supabase, overdue);
  if (opts.dryRun) {
    return { ok: true, dryRun: true, overdue: overdue.length, feeds: overdue.map(publicFeed) };
  }
  if (!overdue.length) return { ok: true, overdue: 0 };
  return sendAlert(overdue, opts.fetch || global.fetch);
}

module.exports = {
  NZ_TZ: NZ_TZ,
  HISTORY_DAYS: HISTORY_DAYS,
  REGULAR_DAYS: REGULAR_DAYS,
  PAGE_SIZE: PAGE_SIZE,
  ALERT_FROM: ALERT_FROM,
  ALERT_TO: ALERT_TO,
  nzDateISO: nzDateISO,
  addCalendarDays: addCalendarDays,
  isWeekend: isWeekend,
  nzMidnightUtc: nzMidnightUtc,
  isDeliveryStatus: isDeliveryStatus,
  isBillableAccount: isBillableAccount,
  isRegular: isRegular,
  isWeekdayOnly: isWeekdayOnly,
  countMissedDays: countMissedDays,
  isAlertMilestone: isAlertMilestone,
  findOverdueFeeds: findOverdueFeeds,
  escapeHtml: escapeHtml,
  accountLabel: accountLabel,
  renderAlertHtml: renderAlertHtml,
  alertSubject: alertSubject,
  runCheck: runCheck
};
