/**
 * Access gate for signed-in app pages.
 *
 * Allow only when:
 *   - subscription_status === 'active' (paid or permanently-free accounts), or
 *   - trial_ends_at is a real timestamp still in the future.
 *
 * A missing trial_ends_at is "no trial", not "trial has not expired".
 * Trial length is 10 days, matching terms-of-service.html §3.
 */
(function(global) {
  var TRIAL_DAYS = 10;
  var MS_PER_DAY = 24 * 60 * 60 * 1000;

  function trialEndsAtFrom(fromDate) {
    var start = fromDate ? new Date(fromDate.getTime()) : new Date();
    return new Date(start.getTime() + TRIAL_DAYS * MS_PER_DAY).toISOString();
  }

  function hasAccess(profile, nowMs) {
    if (nowMs == null) nowMs = Date.now();
    if (!profile) return false;
    if (profile.subscription_status === 'active') return true;
    if (!profile.trial_ends_at) return false;
    var trialEndsAt = new Date(profile.trial_ends_at);
    if (isNaN(trialEndsAt.getTime())) return false;
    return trialEndsAt.getTime() >= nowMs;
  }

  async function checkAccess(supabase, userId, options) {
    options = options || {};

    var result = await supabase
      .from('profiles')
      .select('subscription_status, trial_ends_at')
      .eq('id', userId)
      .maybeSingle();

    if (result.error) {
      console.warn('FleetMagnifySubscriptionGuard: profile lookup failed', result.error.message);
    }

    var allowed = hasAccess(result.data, Date.now());
    if (allowed) return true;

    if (!options.skipRedirect && typeof window !== 'undefined') {
      window.location.href = 'upgrade.html';
    }
    return false;
  }

  global.FleetMagnifySubscriptionGuard = {
    TRIAL_DAYS: TRIAL_DAYS,
    trialEndsAtFrom: trialEndsAtFrom,
    hasAccess: hasAccess,
    checkAccess: checkAccess
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.FleetMagnifySubscriptionGuard;
  }
})(typeof window !== 'undefined' ? window : globalThis);
