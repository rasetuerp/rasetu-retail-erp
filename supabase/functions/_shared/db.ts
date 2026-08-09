import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// service_role — full table access, bypasses RLS. Never sent to the desktop
// app; lives only as an Edge Function secret.
export function serviceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );
}
