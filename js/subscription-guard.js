/**
 * Access gate for signed-in app pages.
 *
 * Allow when any of these is true:
 *   - subscription_status is a Stripe-live status: active, trialing, past_due
 *     (past_due stays open while Stripe is still dunning — do not lock out
 *     on a single failed charge)
 *   - trial_ends_at is a real timestamp still in the future (old homegrown
 *     trial, kept so existing null-status trial accounts are not blocked)
 *
 * Terminal Stripe statuses (canceled / cancelled / unpaid / incomplete_expired)
 * always block, even if an old trial_ends_at is still in the future.
 *
 * A missing trial_ends_at is "no trial", not "trial has not expired".
 * Trial length is 10 days, matching terms-of-service.html §3.
 */
(function(global) {
  var TRIAL_DAYS = 10;
  var MS_PER_DAY = 24 * 60 * 60 * 1000;

  var LIVE_STATUSES = {
    active: true,
    trialing: true,
    past_due: true
  };

  var TERMINAL_STATUSES = {
    canceled: true,
    cancelled: true,
    unpaid: true,
    incomplete_expired: true
  };

  function trialEndsAtFrom(fromDate) {
    var start = fromDate ? new Date(fromDate.getTime()) : new Date();
    return new Date(start.getTime() + TRIAL_DAYS * MS_PER_DAY).toISOString();
  }

  function hasAccess(profile, nowMs) {
    if (nowMs == null) nowMs = Date.now();
    if (!profile) return false;

    var status = profile.subscription_status;
    if (TERMINAL_STATUSES[status]) return false;
    if (LIVE_STATUSES[status]) return true;

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
