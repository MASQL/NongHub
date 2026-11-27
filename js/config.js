// js/config.js
const APP_CONFIG = {
  appName: "NongkrongHub",
  supabaseUrl: "https://bgcujoithnjdduocoudy.supabase.co",
  supabaseAnonKey: "sb_publishable_Xo94j6k9liFpQiC54DcX5A_ugX59m7D"
};

// Gunakan sessionStorage agar setiap tab browser memiliki sesi login independen
// dan tidak saling menimpa saat menguji multi-akun (User A, User B, User C)
const supabaseClient = supabase.createClient(
  APP_CONFIG.supabaseUrl,
  APP_CONFIG.supabaseAnonKey,
  {
    auth: {
      storage: window.sessionStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true
    }
  }
);