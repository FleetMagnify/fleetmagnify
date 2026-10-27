/**
 * VisionLink scheduled reports arrive as an https download link, not an
 * attachment. Extract vl.cat.com/downloadreport links from the email and
 * fetch the CSV. Never log the URL or the token: host and path only, and
 * the final hostname after redirects.
 */

var MAX_REDIRECTS = 3;
var TIMEOUT_MS = 20000;
var MAX_BYTES = 5 * 1024 * 1024;
var ALLOWED_HOST_SUFFIXES = ['.cat.com', '.caterpillar.com', '.amazonaws.com'];

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, function(_, hex) {
      var code = parseInt(hex, 16);
      return isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, function(_, dec) {
      var code = parseInt(dec, 10);
      return isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function isIpLiteral(hostname) {
  var host = String(hostname || '').toLowerCase();
  if (host.charAt(0) === '[' && host.charAt(host.length - 1) === ']') {
    host = host.slice(1, -1);
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.indexOf(':') !== -1) return true;
  return false;
}

function isAllowedDownloadHost(hostname) {
  var host = String(hostname || '').toLowerCase().replace(/\.+$/, '');
  if (!host || host === 'localhost' || isIpLiteral(host)) return false;
  if (host === 'vl.cat.com') return true;
  for (var i = 0; i < ALLOWED_HOST_SUFFIXES.length; i++) {
    var suffix = ALLOWED_HOST_SUFFIXES[i];
    if (host.length > suffix.length && host.endsWith(suffix)) return true;
  }
  return false;
}

function linkError(message, filename) {
  var err = new Error(message);
  err.reportFilename = filename || null;
  return err;
}

function scrubLinkError(message) {
  return String(message || 'download failed')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/[?&]token=[^\s&]*/gi, '')
    .replace(/\btoken=[^\s&]*/gi, '')
    .slice(0, 300);
}

/**
 * Accept only https://vl.cat.com/downloadreport?token=... parsed with URL.
 * Other hosts, paths, schemes, ports, and userinfo are ignored.
 */
function acceptReportLink(raw) {
  var trimmed = String(raw || '').trim().replace(/[)\].,;>]+$/, '');
  if (!trimmed) return null;
  var parsed;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.port) return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.hostname !== 'vl.cat.com') return null;
  if (parsed.pathname !== '/downloadreport') return null;
  var token = parsed.searchParams.get('token');
  if (!token || !String(token).trim()) return null;
  return parsed;
}

function collectCandidates(source) {
  var out = [];
  var hrefRe = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  var match;
  while ((match = hrefRe.exec(source))) {
    out.push(match[1] || match[2] || match[3] || '');
  }
  var urlRe = /https?:\/\/[^\s<>"']+/gi;
  while ((match = urlRe.exec(source))) {
    out.push(match[0]);
  }
  return out;
}

function extractVisionLinkReportLinks(html, text) {
  var sources = [];
  if (html) sources.push(String(html));
  if (text) sources.push(String(text));
  var found = [];
  var seen = {};
  for (var s = 0; s < sources.length; s++) {
    var candidates = collectCandidates(sources[s]);
    for (var i = 0; i < candidates.length; i++) {
      if (found.length >= 3) return found;
      var parsed = acceptReportLink(decodeHtmlEntities(candidates[i]));
      if (!parsed) continue;
      if (seen[parsed.href]) continue;
      seen[parsed.href] = true;
      found.push(parsed.href);
    }
  }
  return found;
}

function unquote(value) {
  var text = String(value || '').trim();
  if (text.length >= 2 && text.charAt(0) === '"' && text.charAt(text.length - 1) === '"') {
    return text.slice(1, -1);
  }
  return text;
}

function basenameFilename(name) {
  var cleaned = String(name || '').replace(/[\r\n]/g, '').trim();
  if (!cleaned) return null;
  var parts = cleaned.split(/[/\\]/);
  var base = parts[parts.length - 1].trim();
  if (!base || base === '.' || base === '..') return null;
  return base;
}

function matchDispositionParam(header, name) {
  var parts = String(header || '').split(';');
  var wanted = name.toLowerCase();
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    var eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim().toLowerCase() === wanted) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

function decodeRfc5987(value) {
  var raw = unquote(value);
  var encoded = raw;
  var marker = raw.match(/^([^']*)'[^']*'(.*)$/);
  if (marker) encoded = marker[2];
  try {
    encoded = decodeURIComponent(encoded.replace(/\+/g, '%20'));
  } catch (err) {
    // Keep the raw token when it is not percent-encoded.
  }
  return basenameFilename(encoded);
}

function filenameFromContentDisposition(header) {
  if (!header) return null;
  var star = matchDispositionParam(header, 'filename*');
  if (star) {
    var decoded = decodeRfc5987(star);
    if (decoded) return decoded;
  }
  var plain = matchDispositionParam(header, 'filename');
  if (!plain) return null;
  return basenameFilename(unquote(plain));
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function validateFetchUrl(urlString) {
  var parsed;
  try {
    parsed = new URL(urlString);
  } catch (err) {
    throw linkError('download link was not a valid URL');
  }
  if (parsed.protocol !== 'https:') throw linkError('redirect was not https');
  if (parsed.username || parsed.password) throw linkError('redirect host not allowed');
  if (parsed.port) throw linkError('redirect host not allowed');
  if (!isAllowedDownloadHost(parsed.hostname)) throw linkError('redirect host not allowed');
  return parsed;
}

async function cancelBody(response) {
  if (response && response.body && typeof response.body.cancel === 'function') {
    try { await response.body.cancel(); } catch (err) { /* already closed */ }
  }
}

async function readLimitedBody(response) {
  var declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(String(declared).trim()) && parseInt(declared, 10) > MAX_BYTES) {
    await cancelBody(response);
    throw linkError('download exceeded 5 MB');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    var buffered = Buffer.from(await response.arrayBuffer());
    if (buffered.length > MAX_BYTES) throw linkError('download exceeded 5 MB');
    return buffered;
  }
  var reader = response.body.getReader();
  var chunks = [];
  var received = 0;
  try {
    while (true) {
      var step = await reader.read();
      if (step.done) break;
      var piece = Buffer.from(step.value);
      received += piece.length;
      if (received > MAX_BYTES) {
        try { await reader.cancel(); } catch (err) { /* ignore */ }
        throw linkError('download exceeded 5 MB');
      }
      chunks.push(piece);
    }
  } finally {
    try { reader.releaseLock(); } catch (err) { /* already released */ }
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

function bodyLooksLikeHtml(buffer) {
  var head = buffer.slice(0, 64).toString('utf8').replace(/^\uFEFF/, '').trim();
  return head.charAt(0) === '<';
}

/**
 * GET the report. Follows at most 3 redirects, and only to https hosts
 * under cat.com, caterpillar.com, or amazonaws.com (or vl.cat.com).
 */
async function fetchReportFromLink(url, options) {
  var timeoutMs = options && options.timeoutMs ? options.timeoutMs : TIMEOUT_MS;
  var doFetch = (options && options.fetch) || global.fetch;
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  try {
    var current = String(url);
    var redirects = 0;
    var response;
    var loggedStart = false;
    while (true) {
      var parsed = validateFetchUrl(current);
      if (!loggedStart) {
        console.log('visionlink-link: fetch', parsed.hostname + parsed.pathname);
        loggedStart = true;
      }
      response = await doFetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      });
      if (isRedirectStatus(response.status)) {
        redirects += 1;
        var location = response.headers.get('location');
        await cancelBody(response);
        if (redirects > MAX_REDIRECTS) throw linkError('too many redirects');
        if (!location) throw linkError('redirect missing location');
        var next = new URL(location, current);
        console.log('visionlink-link: redirect host', next.hostname);
        current = next.href;
        continue;
      }
      break;
    }

    var finalHost = '';
    try { finalHost = new URL(current).hostname; } catch (err) { finalHost = ''; }
    console.log('visionlink-link: final host', finalHost);

    if (response.status !== 200) {
      await cancelBody(response);
      throw linkError('download returned HTTP ' + response.status);
    }

    var filename = filenameFromContentDisposition(response.headers.get('content-disposition'));
    if (filename && /\.xlsx?$/i.test(filename)) {
      await cancelBody(response);
      throw linkError(
        'link served an Excel file; only CSV is supported for link downloads',
        filename
      );
    }

    var contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType === 'text/html') {
      await cancelBody(response);
      throw linkError('download was an HTML page, not a CSV');
    }

    var buffer = await readLimitedBody(response);
    if (bodyLooksLikeHtml(buffer)) {
      throw linkError('download was an HTML page, not a CSV');
    }

    return {
      filename: filename,
      buffer: buffer,
      mimeType: 'text/csv',
      finalHost: finalHost,
    };
  } catch (err) {
    if (err && err.name === 'AbortError') throw linkError('download timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  extractVisionLinkReportLinks: extractVisionLinkReportLinks,
  fetchReportFromLink: fetchReportFromLink,
  scrubLinkError: scrubLinkError,
  filenameFromContentDisposition: filenameFromContentDisposition,
  isAllowedDownloadHost: isAllowedDownloadHost,
  MAX_BYTES: MAX_BYTES,
};
