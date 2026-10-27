/**
 * VisionLink scheduled reports arrive as an https download link, not an
 * attachment. The vl.cat.com page is a web app: the CSV comes from a POST
 * to Cat's report-download API, which returns a short-lived S3 URL. Never log or
 * store a full URL, the token, or any X-Amz-* value. Log hosts only.
 */

var MAX_REDIRECTS = 3;
var TIMEOUT_MS = 45000;
var API_RETRY_DELAY_MS = 2000;
// Leave this much time after the first POST and the retry pause so a hung
// call can be tried once more and the file can still be fetched. A fast
// failure (5xx or a network error) does not wait out this reserve: the
// second attempt gets whatever budget remains.
var API_RETRY_TAIL_MS = 5000;
var MAX_BYTES = 5 * 1024 * 1024;
var API_MAX_BYTES = 64 * 1024;
var API_URL_PREFIX = 'https://api.cat.com/catDigital/reportDownloads/v1/download?token=';
var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
var S3_VIRTUAL_HOST = /^[a-z0-9][a-z0-9.-]*\.s3\.[a-z0-9-]+\.amazonaws\.com$/;
var S3_LEGACY_HOST = /^[a-z0-9][a-z0-9.-]*\.s3\.amazonaws\.com$/;

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

function hostOnly(hostname) {
  return String(hostname || '').toLowerCase().replace(/\.+$/, '');
}

function isS3Host(hostname) {
  var host = hostOnly(hostname);
  return S3_VIRTUAL_HOST.test(host) || S3_LEGACY_HOST.test(host);
}

function isCatHost(hostname) {
  var host = hostOnly(hostname);
  if (!host || host === 'localhost' || isIpLiteral(host)) return false;
  if (host === 'vl.cat.com') return true;
  return host.length > '.cat.com'.length && host.endsWith('.cat.com');
}

function isAllowedFileHost(hostname) {
  return isS3Host(hostname) || isCatHost(hostname);
}

function linkError(message, filename) {
  var err = new Error(scrubLinkError(message));
  err.reportFilename = filename || null;
  return err;
}

function scrubLinkError(message) {
  return String(message || 'download failed')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/X-Amz-[A-Za-z0-9-]+=[^&\s]*/gi, '')
    .replace(/X-Amz[A-Za-z0-9-]*/gi, '')
    .replace(/[?&]token=[^\s&]*/gi, '')
    .replace(/\btoken=[^\s&]*/gi, '')
    .replace(/[A-Za-z0-9+/_=-]{64,}/g, '[redacted]')
    .slice(0, 500);
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

function loosePercentDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    return value;
  }
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
  return basenameFilename(loosePercentDecode(unquote(plain)));
}

function filenameFromUrlPath(urlString) {
  var parsed;
  try {
    parsed = new URL(urlString);
  } catch (err) {
    return null;
  }
  var segments = String(parsed.pathname || '').split('/');
  var seg = '';
  for (var i = segments.length - 1; i >= 0; i--) {
    if (segments[i]) {
      seg = segments[i];
      break;
    }
  }
  if (!seg) return null;
  return basenameFilename(loosePercentDecode(seg));
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function mediaTypeOf(response) {
  return (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
}

function assertSafeUrl(urlString, allowHost) {
  var parsed;
  try {
    parsed = new URL(urlString);
  } catch (err) {
    throw linkError('download URL was not valid');
  }
  if (parsed.protocol !== 'https:') throw linkError('redirect was not https');
  if (parsed.username || parsed.password || parsed.port || parsed.hostname === 'localhost' ||
      isIpLiteral(parsed.hostname) || !allowHost(parsed.hostname)) {
    throw linkError('redirect host not allowed: ' + parsed.hostname);
  }
  return parsed;
}

function validateDownloadUrl(raw) {
  var parsed;
  try {
    parsed = new URL(String(raw));
  } catch (err) {
    throw linkError('download URL was not valid');
  }
  if (parsed.protocol !== 'https:') {
    throw linkError('download URL was not https: ' + parsed.hostname);
  }
  if (parsed.username || parsed.password || parsed.port || !isS3Host(parsed.hostname)) {
    throw linkError('download host not allowed: ' + parsed.hostname);
  }
  return parsed;
}

async function cancelBody(response) {
  if (response && response.body && typeof response.body.cancel === 'function') {
    try { await response.body.cancel(); } catch (err) { /* already closed */ }
  }
}

async function readLimitedBody(response, maxBytes, tooBigMessage) {
  var limit = maxBytes || MAX_BYTES;
  var declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(String(declared).trim()) && parseInt(declared, 10) > limit) {
    await cancelBody(response);
    throw linkError(tooBigMessage || 'download exceeded 5 MB');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    var buffered = Buffer.from(await response.arrayBuffer());
    if (buffered.length > limit) throw linkError(tooBigMessage || 'download exceeded 5 MB');
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
      if (received > limit) {
        try { await reader.cancel(); } catch (err) { /* ignore */ }
        throw linkError(tooBigMessage || 'download exceeded 5 MB');
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

function collapseSpace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripTags(value) {
  return collapseSpace(
    String(value || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
  );
}

function nonJsonBodyText(text) {
  var raw = String(text || '');
  var title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) {
    var titleText = stripTags(title[1]);
    if (titleText) return titleText.slice(0, 200);
  }
  return stripTags(raw).slice(0, 200);
}

function responseHeader(response, name) {
  if (!response || !response.headers || typeof response.headers.get !== 'function') return '(none)';
  var value = response.headers.get(name);
  if (!value) return '(none)';
  return collapseSpace(value).slice(0, 120);
}

function describeApiFailure(status, contentType, bodyBuffer, response) {
  var ctype = contentType || '(none)';
  var text = bodyBuffer ? bodyBuffer.toString('utf8') : '';
  var msg = 'report download API returned HTTP ' + status + ' Content-Type ' + ctype;
  var parsed = null;
  if (text && !(bodyBuffer && bodyLooksLikeHtml(bodyBuffer))) {
    try { parsed = JSON.parse(text); } catch (err) { parsed = null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    msg += '; not JSON';
    var snippet = nonJsonBodyText(text);
    if (snippet) msg += '; body: ' + snippet;
    msg += '; server: ' + responseHeader(response, 'server');
    msg += '; content-type: ' + responseHeader(response, 'content-type');
    msg += '; x-cache: ' + responseHeader(response, 'x-cache');
  } else {
    var keys = Object.keys(parsed);
    msg += '; keys: ' + (keys.length ? keys.join(', ') : '(none)');
    if (typeof parsed.downloadUrl !== 'string' || !String(parsed.downloadUrl).trim()) {
      msg += '; no downloadUrl';
    }
    var detail = '';
    ['message', 'error', 'errorMessage', 'error_message'].forEach(function(name) {
      if (!detail && typeof parsed[name] === 'string' && parsed[name]) {
        detail = parsed[name].slice(0, 120);
      }
    });
    if (detail) msg += '; detail: ' + detail;
  }
  return msg;
}

async function fetchWithRedirects(startUrl, options) {
  var current = startUrl;
  var redirects = 0;
  var response;
  while (true) {
    var parsed = assertSafeUrl(current, options.allowHost);
    console.log('visionlink-link:', options.label, 'host', parsed.hostname);
    var init = {
      method: options.method || 'GET',
      redirect: 'manual',
      signal: options.signal,
    };
    if (options.headers) init.headers = options.headers;
    if (options.body !== undefined) init.body = options.body;
    response = await options.doFetch(current, init);
    if (isRedirectStatus(response.status)) {
      // A POST must not be followed: the next hop would be a GET and can
      // return the web page. The API step reports the status instead.
      if (options.followRedirects === false) {
        return { response: response, finalUrl: current, finalHost: parsed.hostname };
      }
      redirects += 1;
      var location = response.headers.get('location');
      await cancelBody(response);
      if (redirects > MAX_REDIRECTS) throw linkError('too many redirects');
      if (!location) throw linkError('redirect missing location');
      var next;
      try {
        next = new URL(location, current);
      } catch (err) {
        throw linkError('redirect URL was not valid');
      }
      console.log('visionlink-link: redirect host', next.hostname);
      current = next.href;
      continue;
    }
    return { response: response, finalUrl: current, finalHost: parsed.hostname };
  }
}

function sleep(ms, signal) {
  return new Promise(function(resolve, reject) {
    function abort() {
      cleanup();
      var err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    }
    var timer = setTimeout(function() {
      cleanup();
      resolve();
    }, ms);
    function cleanup() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    }
    if (signal && signal.aborted) return abort();
    if (signal) signal.addEventListener('abort', abort);
  });
}

function isNetworkError(err) {
  if (!err || err.name === 'AbortError') return false;
  return !Object.prototype.hasOwnProperty.call(err, 'reportFilename');
}

function openAttempt(parent, limitMs) {
  var child = new AbortController();
  var timer = setTimeout(function() { child.abort(); }, Math.max(0, limitMs));
  function onParent() { child.abort(); }
  if (parent.signal.aborted) child.abort();
  else parent.signal.addEventListener('abort', onParent);
  return {
    signal: child.signal,
    clear: function() {
      clearTimeout(timer);
      parent.signal.removeEventListener('abort', onParent);
    },
  };
}

function firstApiAttemptLimit(timeoutMs, retryDelayMs, deadline) {
  var left = deadline - Date.now();
  if (left <= 0) return 0;
  var tail = Math.min(API_RETRY_TAIL_MS, Math.floor(timeoutMs / 5));
  var reserve = retryDelayMs + tail;
  if (left <= reserve) return left;
  return left - reserve;
}

async function requestReportApi(apiUrl, doFetch, signal) {
  var apiCall = await fetchWithRedirects(apiUrl, {
    doFetch: doFetch,
    signal: signal,
    label: 'api',
    method: 'POST',
    body: '',
    followRedirects: false,
    allowHost: function(host) { return hostOnly(host) === 'api.cat.com'; },
    headers: {
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://vl.cat.com',
      Referer: 'https://vl.cat.com/',
      'User-Agent': BROWSER_UA,
      'Content-Length': '0',
    },
  });

  var apiType = mediaTypeOf(apiCall.response);
  var apiStatus = apiCall.response.status;
  var apiBody;
  try {
    apiBody = await readLimitedBody(
      apiCall.response,
      API_MAX_BYTES,
      'report download API body exceeded 64 KB; HTTP ' + apiStatus + ' Content-Type ' + (apiType || '(none)')
    );
  } catch (err) {
    if (apiStatus >= 500 && apiStatus <= 599 && err && Object.prototype.hasOwnProperty.call(err, 'reportFilename')) {
      err.retryable = true;
    }
    throw err;
  }

  if (apiStatus >= 500 && apiStatus <= 599) {
    var failure = linkError(describeApiFailure(apiStatus, apiType, apiBody, apiCall.response));
    failure.retryable = true;
    throw failure;
  }

  var apiFailed = apiStatus !== 200 || apiType === 'text/html' || bodyLooksLikeHtml(apiBody);
  var payload = null;
  if (!apiFailed) {
    try { payload = JSON.parse(apiBody.toString('utf8')); } catch (err) { payload = null; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        typeof payload.downloadUrl !== 'string' || !payload.downloadUrl.trim()) {
      apiFailed = true;
    }
  }
  if (apiFailed) throw linkError(describeApiFailure(apiStatus, apiType, apiBody, apiCall.response));
  return payload;
}

/**
 * Turn a vl.cat.com/downloadreport link into a CSV. The page itself is not
 * the file: POST to api.cat.com for downloadUrl, then GET that S3 object.
 * The whole call, including one API retry, stays inside the 45s budget.
 */
async function fetchReportFromLink(url, options) {
  var timeoutMs = options && options.timeoutMs ? options.timeoutMs : TIMEOUT_MS;
  var retryDelayMs = API_RETRY_DELAY_MS;
  if (options && options.retryDelayMs != null) retryDelayMs = options.retryDelayMs;
  var doFetch = (options && options.fetch) || global.fetch;
  var controller = new AbortController();
  var deadline = Date.now() + timeoutMs;
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  try {
    var page = acceptReportLink(String(url));
    if (!page) throw linkError('download link was not a VisionLink report link');
    var token = page.searchParams.get('token');
    var apiUrl = API_URL_PREFIX + encodeURIComponent(token) + '&source=schedule';

    var payload = null;
    var attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      var limit = attempt === 1
        ? firstApiAttemptLimit(timeoutMs, retryDelayMs, deadline)
        : deadline - Date.now();
      if (limit <= 0 || controller.signal.aborted) throw linkError('download timed out');
      var attemptCtrl = openAttempt(controller, limit);
      try {
        payload = await requestReportApi(apiUrl, doFetch, attemptCtrl.signal);
        attemptCtrl.clear();
        break;
      } catch (err) {
        attemptCtrl.clear();
        var retryable = !!(err && (err.retryable || err.name === 'AbortError' || isNetworkError(err)));
        var timeLeft = deadline - Date.now();
        if (attempt === 1 && retryable && timeLeft > retryDelayMs && !controller.signal.aborted) {
          console.log('visionlink-link: retry api host api.cat.com');
          await sleep(retryDelayMs, controller.signal);
          continue;
        }
        if (err && err.name === 'AbortError') throw linkError('download timed out');
        throw err;
      }
    }

    var download = validateDownloadUrl(payload.downloadUrl.trim());
    var fileCall = await fetchWithRedirects(download.href, {
      doFetch: doFetch,
      signal: controller.signal,
      label: 'file',
      allowHost: isAllowedFileHost,
    });

    if (fileCall.response.status !== 200) {
      await cancelBody(fileCall.response);
      throw linkError('download returned HTTP ' + fileCall.response.status);
    }

    var filename = filenameFromContentDisposition(fileCall.response.headers.get('content-disposition'));
    if (!filename) filename = filenameFromUrlPath(fileCall.finalUrl);
    if (filename && /\.xlsx?$/i.test(filename)) {
      await cancelBody(fileCall.response);
      throw linkError(
        'link served an Excel file; only CSV is supported for link downloads',
        filename
      );
    }

    var fileType = mediaTypeOf(fileCall.response);
    if (fileType === 'text/html') {
      await cancelBody(fileCall.response);
      throw linkError('download was an HTML page, not a CSV');
    }

    var buffer = await readLimitedBody(fileCall.response, MAX_BYTES, 'download exceeded 5 MB');
    if (bodyLooksLikeHtml(buffer)) throw linkError('download was an HTML page, not a CSV');

    console.log('visionlink-link: final host', fileCall.finalHost);
    return {
      filename: filename,
      buffer: buffer,
      mimeType: 'text/csv',
      finalHost: fileCall.finalHost,
    };
  } catch (err) {
    if (err && err.name === 'AbortError') throw linkError('download timed out');
    if (err && Object.prototype.hasOwnProperty.call(err, 'reportFilename')) throw err;
    throw linkError(err && err.message ? err.message : 'download failed');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  extractVisionLinkReportLinks: extractVisionLinkReportLinks,
  fetchReportFromLink: fetchReportFromLink,
  scrubLinkError: scrubLinkError,
  filenameFromContentDisposition: filenameFromContentDisposition,
  isS3Host: isS3Host,
  MAX_BYTES: MAX_BYTES,
  API_MAX_BYTES: API_MAX_BYTES,
  TIMEOUT_MS: TIMEOUT_MS,
  API_RETRY_DELAY_MS: API_RETRY_DELAY_MS,
};
