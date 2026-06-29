(function(global) {
  var UPLOAD_DOMAIN = 'uploads.fleetmagnify.com';

  function slugifyCompanyName(name) {
    return String(name || '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function randomAlphanumeric(length) {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var result = '';
    for (var i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  function buildUploadEmailPrefix(companyName) {
    var slug = slugifyCompanyName(companyName);
    if (!slug) slug = 'fleet';
    return slug + '-' + randomAlphanumeric(4);
  }

  function isUniqueViolation(error) {
    if (!error) return false;
    if (error.code === '23505') return true;
    var msg = (error.message || '').toLowerCase();
    return msg.indexOf('duplicate') !== -1 || msg.indexOf('unique') !== -1;
  }

  function delay(ms) {
    return new Promise(function(resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function waitForSession(supabase, maxMs) {
    var deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      var result = await supabase.auth.getSession();
      if (result.data && result.data.session) {
        return result.data.session;
      }
      await delay(200);
    }
    return null;
  }

  async function upsertUploadEmail(supabase, userId, companyName) {
    var maxAttempts = 8;

    for (var attempt = 0; attempt < maxAttempts; attempt++) {
      var uploadPrefix = buildUploadEmailPrefix(companyName);
      var settingsResult = await supabase.from('user_settings').upsert(
        {
          user_id: userId,
          upload_email: uploadPrefix
        },
        { onConflict: 'user_id' }
      );

      if (!settingsResult.error) {
        return uploadPrefix;
      }

      if (isUniqueViolation(settingsResult.error)) {
        continue;
      }

      console.warn('upload email upsert failed', settingsResult.error.message);
      return null;
    }

    console.warn('upload email upsert failed: could not generate unique prefix');
    return null;
  }

  async function ensureUploadEmail(supabase, userId, companyName) {
    var existing = await supabase
      .from('user_settings')
      .select('upload_email')
      .eq('user_id', userId)
      .maybeSingle();

    if (existing.error) {
      console.warn('upload email lookup failed', existing.error.message);
      return null;
    }

    if (existing.data && existing.data.upload_email) {
      return existing.data.upload_email;
    }

    if (!companyName) {
      return null;
    }

    return upsertUploadEmail(supabase, userId, companyName);
  }

  async function trySaveUploadEmailAfterSignup(supabase, userId, companyName, signUpSession) {
    if (signUpSession) {
      return upsertUploadEmail(supabase, userId, companyName);
    }

    var session = await waitForSession(supabase, 3000);
    if (!session) {
      return null;
    }

    return upsertUploadEmail(supabase, userId, companyName);
  }

  function formatFullEmail(prefix) {
    return prefix ? prefix + '@' + UPLOAD_DOMAIN : null;
  }

  global.FleetMagnifyUploadEmail = {
    UPLOAD_DOMAIN: UPLOAD_DOMAIN,
    ensureUploadEmail: ensureUploadEmail,
    trySaveUploadEmailAfterSignup: trySaveUploadEmailAfterSignup,
    formatFullEmail: formatFullEmail
  };
})(window);
