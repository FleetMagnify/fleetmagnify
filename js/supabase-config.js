// Replace with your Supabase project credentials from:
// https://supabase.com/dashboard/project/_/settings/api
window.SUPABASE_URL = 'https://pddsgvuzvuwueuvpoytw.supabase.co';
window.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBkZHNndnV6dnV3dWV1dnBveXR3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzNzQxOTQsImV4cCI6MjA5Njk1MDE5NH0.iTofb-BGv_Pdqsipw3YtoRs2m3ejmtRFPtA0CfCgA9Q';

// PostgREST returns HTTP 200 with zero rows when RLS blocks an UPDATE or
// DELETE (no matching policy / WITH CHECK failure after using()). Checking
// only result.error treats that as success. Chain .select() after the
// mutation and pass the result here; returns an error string or null.
window.supabaseWriteError = function(result, action) {
  action = action || 'Update';
  if (result && result.error) {
    return result.error.message || (action + ' failed.');
  }
  var data = result && result.data;
  if (Array.isArray(data)) {
    if (data.length > 0) return null;
  } else if (data) {
    return null;
  }
  return action + ' failed — no matching row, or you do not have permission.';
};
