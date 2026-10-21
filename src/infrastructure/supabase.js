import { createClient } from '@supabase/supabase-js';

export function createRequestSupabaseClient(url, anonKey, accessToken) {
  return createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}
