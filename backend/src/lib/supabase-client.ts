import { createClient } from '@supabase/supabase-js';

import { env } from '../config/env.js';

// Round 4 — anon/publishable key only. Used for Support Login's credential
// check (supabase.auth.signInWithPassword); the vendor account itself is
// created/rotated directly in Supabase Studio, never through this app.
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
