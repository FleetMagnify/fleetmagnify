window.FleetMagnifySubscriptionGuard = (function() {

  async function checkAccess(supabase, userId, options) {
    options = options || {};

    var result = await supabase
      .from('profiles')
      .select('subscription_status, trial_ends_at')
      .eq('id', userId)
      .maybeSingle();

    var profile = result.data;

    if (!profile) {
      console.warn('FleetMagnifySubscriptionGuard: no profile row found for user', userId);
      return true;
    }

    var isActive = profile.subscription_status === 'active';
    var trialEndsAt = profile.trial_ends_at ? new Date(profile.trial_ends_at) : null;
    var trialExpired = trialEndsAt ? trialEndsAt.getTime() < Date.now() : false;

    if (!isActive && trialExpired) {
      if (!options.skipRedirect) {
        window.location.href = 'upgrade.html';
      }
      return false;
    }

    return true;
  }

  return { checkAccess: checkAccess };

})();
