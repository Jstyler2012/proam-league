// supabase-config.js
// Centralized Supabase client for the whole site.
// IMPORTANT: Use your NEW project's URL + PUBLISHABLE key (sb_publishable_*).
(function () {
  // TODO: Replace these 2 values with your NEW Supabase project values
  const SUPABASE_URL = "https://pgeiloiymvhhnuwirudn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_N3_mDqjkytg1Hu8vC724xw_nkFy6PeH";
  if (!window.supabase || !window.supabase.createClient) {
    console.error("Supabase JS library not loaded. Check script include order.");
    return;
  }

  // Expose on window so any page can use it consistently
  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
})();
