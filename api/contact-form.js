/**
 * Public marketing-site contact form.
 *
 * Sends submissions to the Namecheap support mailbox via Resend,
 * following the same fetch + auth pattern as sendFailureAlert in
 * api/email-inbound.js. Destination is support@fleetmagnify.com
 * (not the old fleetmagnify@gmail.com shared inbox).
 *
 * The full form on contact.html is unchanged. A source of "widget"
 * is the small Contact us box: email and message only, with a
 * best-effort in-memory rate limit (each serverless instance has
 * its own memory).
 */

var crypto = require('crypto');
var FLEET_SIZE_OPTIONS = ['Under 10', '10 to 50', '51 to 200', 'Over 200'];
var MAX_NAME = 200;
var MAX_COMPANY = 200;
var MAX_EMAIL = 254;
var MAX_MESSAGE = 5000;
var WIDGET_MAX_MESSAGE = 2000;
var WIDGET_MAX_PAGE = 200;
var WIDGET_MIN_ELAPSED_MS = 2000;
var WIDGET_MAX_LINKS = 3;
var WIDGET_MAX_PER_HOUR = 3;
var WIDGET_MAX_PER_DAY = 10;
var WIDGET_GLOBAL_PER_HOUR = 40;
var HOUR_MS = 60 * 60 * 1000;
var DAY_MS = 24 * HOUR_MS;
var CONTACT_TO = 'support@fleetmagnify.com';
var CONTACT_FROM = 'alerts@fleetmagnify.com';
var escapeHtml = require('../lib/escape-html');
var SEND_ERROR = 'Could not send your message. Please email support@fleetmagnify.com.';

var buckets = Object.create(null);
var globalHits = [];
var nowFn = function () { return Date.now(); };

function trimToString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function isValidEmail(value) {
  if (!value || value.length > MAX_EMAIL) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (err) {
      return null;
    }
  }
  if (Buffer.isBuffer(req.body)) {
    try {
      return JSON.parse(req.body.toString('utf8'));
    } catch (err) {
      return null;
    }
  }
  return {};
}

function nl2br(value) {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

function headerValue(req, name) {
  var headers = req && req.headers ? req.headers : {};
  var value = headers[name];
  if (value == null) value = headers[String(name).toLowerCase()];
  if (Array.isArray(value)) value = value[0];
  return value == null ? '' : String(value);
}

function pruneRateLimit(now) {
  var dayCutoff = now - DAY_MS;
  var hourCutoff = now - HOUR_MS;
  var keys = Object.keys(buckets);
  for (var i = 0; i < keys.length; i++) {
    var kept = [];
    var hits = buckets[keys[i]];
    for (var j = 0; j < hits.length; j++) {
      if (hits[j] > dayCutoff) kept.push(hits[j]);
    }
    if (kept.length) buckets[keys[i]] = kept;
    else delete buckets[keys[i]];
  }
  var keptGlobal = [];
  for (var g = 0; g < globalHits.length; g++) {
    if (globalHits[g] > hourCutoff) keptGlobal.push(globalHits[g]);
  }
  globalHits = keptGlobal;
}

function clientKey(req) {
  var forwarded = headerValue(req, 'x-forwarded-for');
  var first = forwarded.split(',')[0].trim() || 'unknown';
  var agent = headerValue(req, 'user-agent');
  return crypto.createHash('sha256').update(first + '\n' + agent).digest('hex');
}

function allowWidgetMessage(req) {
  var now = nowFn();
  pruneRateLimit(now);
  if (globalHits.length >= WIDGET_GLOBAL_PER_HOUR) return false;
  var key = clientKey(req);
  var hits = buckets[key] || [];
  var hourCutoff = now - HOUR_MS;
  var inHour = 0;
  for (var i = 0; i < hits.length; i++) {
    if (hits[i] > hourCutoff) inHour++;
  }
  if (inHour >= WIDGET_MAX_PER_HOUR || hits.length >= WIDGET_MAX_PER_DAY) return false;
  hits.push(now);
  buckets[key] = hits;
  globalHits.push(now);
  return true;
}

function widgetElapsedOk(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= WIDGET_MIN_ELAPSED_MS;
}

function linkCount(message) {
  var matches = String(message).match(/https?:\/\/|www\./gi);
  return matches ? matches.length : 0;
}

function widgetPage(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > WIDGET_MAX_PAGE) {
    return '(unknown)';
  }
  if (!/^\/(?:[A-Za-z0-9\-._~!$&'()*+,;=:@%]+(?:\/[A-Za-z0-9\-._~!$&'()*+,;=:@%]+)*)?$/.test(value)) {
    return '(unknown)';
  }
  return value;
}

function given(value) {
  return value ? value : '(not given)';
}

function fakeSuccess(res) {
  return res.status(200).json({ ok: true });
}

async function sendContactEmail(res, payload) {
  var apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('contact-form: RESEND_API_KEY is not configured');
    return res.status(500).json({ error: SEND_ERROR });
  }

  try {
    var resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    var resendBody = null;
    try {
      resendBody = await resendRes.json();
    } catch (parseErr) {
      resendBody = null;
    }

    if (!resendRes.ok) {
      console.error(
        'contact-form: Resend rejected the email',
        resendRes.status,
        resendBody && resendBody.message ? resendBody.message : resendBody
      );
      return res.status(500).json({ error: SEND_ERROR });
    }

    return res.status(200).json({
      ok: true,
      id: resendBody && resendBody.id ? resendBody.id : undefined
    });
  } catch (err) {
    console.error('contact-form: failed to send email', err && err.message ? err.message : err);
    return res.status(500).json({ error: SEND_ERROR });
  }
}

async function handleWidget(req, res, body) {
  if (!widgetElapsedOk(body.elapsed)) {
    console.log('contact-form: dropped widget submission');
    return fakeSuccess(res);
  }

  var name = trimToString(body.name);
  var company = trimToString(body.company);
  var email = trimToString(body.email).toLowerCase();
  var fleetSize = trimToString(body.fleetSize);
  var message = trimToString(body.message);

  if (!email || !message) {
    return res.status(400).json({
      error: 'A valid email address and a message are required'
    });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }

  if (name.length > MAX_NAME || company.length > MAX_COMPANY || fleetSize.length > MAX_NAME || message.length > WIDGET_MAX_MESSAGE) {
    return res.status(400).json({ error: 'One or more fields exceed the maximum length' });
  }

  if (linkCount(message) > WIDGET_MAX_LINKS) {
    console.log('contact-form: dropped widget submission');
    return fakeSuccess(res);
  }

  if (!allowWidgetMessage(req)) {
    return res.status(429).json({
      error: 'Too many messages. Please email support@fleetmagnify.com.'
    });
  }

  var page = widgetPage(body.page);
  var domain = email.split('@')[1] || email;
  var submittedAt = new Date().toISOString();
  var subject = 'Website message: ' + (name || domain);
  var html =
    '<p><strong>New website message</strong></p>' +
    '<p><strong>Name:</strong> ' + escapeHtml(given(name)) + '</p>' +
    '<p><strong>Company:</strong> ' + escapeHtml(given(company)) + '</p>' +
    '<p><strong>Email:</strong> ' + escapeHtml(email) + '</p>' +
    '<p><strong>Fleet size:</strong> ' + escapeHtml(given(fleetSize)) + '</p>' +
    '<p><strong>Page:</strong> ' + escapeHtml(page) + '</p>' +
    '<p><strong>Message:</strong></p>' +
    '<p>' + nl2br(message) + '</p>' +
    '<p><strong>Submitted at:</strong> ' + escapeHtml(submittedAt) + '</p>';

  return sendContactEmail(res, {
    from: CONTACT_FROM,
    to: CONTACT_TO,
    reply_to: email,
    subject: subject,
    html: html
  });
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var body = parseBody(req);
  if (!body) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  // Honeypot: bots often fill every input. Real users never see this field.
  // Return a fake success so scrapers don't retry or learn the filter.
  var honeypot = trimToString(body.website || body.company_website);
  if (honeypot) {
    console.log('contact-form: dropped honeypot submission');
    return res.status(200).json({ ok: true });
  }

  if (body.source === 'widget') {
    return handleWidget(req, res, body);
  }

  var name = trimToString(body.name);
  var company = trimToString(body.company);
  var email = trimToString(body.email).toLowerCase();
  var fleetSize = trimToString(body.fleetSize);
  var message = trimToString(body.message);

  if (!name || !company || !email || !fleetSize || !message) {
    return res.status(400).json({
      error: 'Name, company, email, fleet size, and message are required'
    });
  }

  if (name.length > MAX_NAME || company.length > MAX_COMPANY || message.length > MAX_MESSAGE) {
    return res.status(400).json({ error: 'One or more fields exceed the maximum length' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }

  if (FLEET_SIZE_OPTIONS.indexOf(fleetSize) === -1) {
    return res.status(400).json({ error: 'Please select a valid fleet size' });
  }

  var submittedAt = new Date().toISOString();
  var subject = 'Contact form: ' + name + ' / ' + company;
  var html =
    '<p><strong>New contact form submission</strong></p>' +
    '<p><strong>Name:</strong> ' + escapeHtml(name) + '</p>' +
    '<p><strong>Company:</strong> ' + escapeHtml(company) + '</p>' +
    '<p><strong>Email:</strong> ' + escapeHtml(email) + '</p>' +
    '<p><strong>Fleet size:</strong> ' + escapeHtml(fleetSize) + '</p>' +
    '<p><strong>Message:</strong></p>' +
    '<p>' + nl2br(message) + '</p>' +
    '<p><strong>Submitted at:</strong> ' + escapeHtml(submittedAt) + '</p>';

  return sendContactEmail(res, {
    from: CONTACT_FROM,
    to: CONTACT_TO,
    reply_to: email,
    subject: subject,
    html: html
  });
}

handler.setNow = function (fn) {
  nowFn = typeof fn === 'function' ? fn : function () { return Date.now(); };
};

handler.resetRateLimit = function () {
  buckets = Object.create(null);
  globalHits = [];
};

handler.rateLimitSize = function () {
  return { keys: Object.keys(buckets).length, global: globalHits.length };
};

module.exports = handler;
