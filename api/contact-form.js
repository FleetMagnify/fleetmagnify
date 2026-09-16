/**
 * Public marketing-site contact form.
 *
 * Sends submissions to the Namecheap support mailbox via Resend,
 * following the same fetch + auth pattern as sendFailureAlert in
 * api/email-inbound.js. Destination is support@fleetmagnify.com
 * (not the old fleetmagnify@gmail.com shared inbox).
 */

var FLEET_SIZE_OPTIONS = ['Under 10', '10 to 50', '51 to 200', 'Over 200'];
var MAX_NAME = 200;
var MAX_COMPANY = 200;
var MAX_EMAIL = 254;
var MAX_MESSAGE = 5000;
var CONTACT_TO = 'support@fleetmagnify.com';
var CONTACT_FROM = 'alerts@fleetmagnify.com';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

module.exports = async function handler(req, res) {
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

  var apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('contact-form: RESEND_API_KEY is not configured');
    return res.status(500).json({
      error: 'Could not send your message. Please email support@fleetmagnify.com.'
    });
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

  var payload = {
    from: CONTACT_FROM,
    to: CONTACT_TO,
    reply_to: email,
    subject: subject,
    html: html
  };

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
      return res.status(500).json({
        error: 'Could not send your message. Please email support@fleetmagnify.com.'
      });
    }

    return res.status(200).json({
      ok: true,
      id: resendBody && resendBody.id ? resendBody.id : undefined
    });
  } catch (err) {
    console.error('contact-form: failed to send email', err && err.message ? err.message : err);
    return res.status(500).json({
      error: 'Could not send your message. Please email support@fleetmagnify.com.'
    });
  }
};
