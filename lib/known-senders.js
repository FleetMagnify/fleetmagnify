/**
 * Sender allowlist for inbound report email.
 *
 * Add a domain only when a real provider report has been seen from it.
 * INBOUND_EXTRA_SENDERS is an optional comma-separated list of extra
 * exact addresses (name@example.test) or bare domains (example.test).
 * Unset or empty adds nothing. An address matches a domain entry only
 * when its domain is exactly that entry or a true subdomain. Substring
 * and "contains" matches are not used.
 *
 * A sender that is not allowed is stored on email_imports with status
 * held_unapproved and is not parsed.
 */

var BUILTIN_DOMAINS = [
  'teletracnavman.net', // Navman
  'vl.cat.com', // VisionLink
  'bp.com', // BP
  'johndeere.com', // John Deere
];

function extractEmailAddress(raw) {
  if (!raw) return '';
  var str = String(raw).trim();
  var match = str.match(/<([^>]+)>/);
  return (match ? match[1] : str).trim().toLowerCase();
}

function isDomain(domain) {
  if (!domain || domain.length > 253) return false;
  if (domain.charAt(0) === '.' || domain.charAt(domain.length - 1) === '.') return false;
  var labels = domain.split('.');
  if (labels.length < 2) return false;
  for (var i = 0; i < labels.length; i++) {
    var label = labels[i];
    if (!label || label.length > 63) return false;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return false;
  }
  return true;
}

function parsedAddress(raw) {
  var address = extractEmailAddress(raw);
  if (!address) return null;
  var parts = address.split('@');
  if (parts.length !== 2) return null;
  var local = parts[0];
  var domain = parts[1];
  if (!local || local.indexOf(' ') !== -1 || !isDomain(domain)) return null;
  return { address: local + '@' + domain, domain: domain };
}

function domainCovers(domain, entry) {
  if (domain === entry) return true;
  var suffix = '.' + entry;
  if (domain.length <= suffix.length) return false;
  return domain.slice(domain.length - suffix.length) === suffix;
}

function extraEntries(env) {
  var raw = env && env.INBOUND_EXTRA_SENDERS != null ? String(env.INBOUND_EXTRA_SENDERS) : '';
  var out = [];
  raw.split(',').forEach(function (part) {
    var entry = part.trim().toLowerCase();
    if (!entry) return;
    if (entry.indexOf('@') !== -1) {
      var parsed = parsedAddress(entry);
      if (!parsed) return;
      out.push({ kind: 'address', value: parsed.address });
      return;
    }
    if (!isDomain(entry)) return;
    out.push({ kind: 'domain', value: entry });
  });
  return out;
}

function senderDomain(email) {
  var parsed = parsedAddress(email);
  return parsed ? parsed.domain : '';
}

function isAllowedSender(email, env) {
  var parsed = parsedAddress(email);
  if (!parsed) return false;
  for (var i = 0; i < BUILTIN_DOMAINS.length; i++) {
    if (domainCovers(parsed.domain, BUILTIN_DOMAINS[i])) return true;
  }
  var extras = extraEntries(env);
  for (var e = 0; e < extras.length; e++) {
    var entry = extras[e];
    if (entry.kind === 'address' && parsed.address === entry.value) return true;
    if (entry.kind === 'domain' && domainCovers(parsed.domain, entry.value)) return true;
  }
  return false;
}

module.exports = {
  BUILTIN_DOMAINS: BUILTIN_DOMAINS,
  extractEmailAddress: extractEmailAddress,
  senderDomain: senderDomain,
  isAllowedSender: isAllowedSender,
};
