import { supabaseConfig } from "./supabase-config.js";

let clientPromise;

function isPublishableKey(key) {
  if (key.startsWith("sb_publishable_")) return true;
  if (!key.startsWith("eyJ")) return false;
  try {
    const payload = key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const role = JSON.parse(atob(payload)).role;
    return role === "anon";
  } catch {
    return false;
  }
}

export function isSupabaseConfigured() {
  try {
    const url = new URL(supabaseConfig.url);
    const secure = url.protocol === "https:";
    const localDevelopment = url.protocol === "http:"
      && ["localhost", "127.0.0.1"].includes(url.hostname);
    return (secure || localDevelopment) && isPublishableKey(supabaseConfig.publishableKey);
  } catch {
    return false;
  }
}

export async function getSupabaseClient() {
  if (!isSupabaseConfigured()) return null;
  clientPromise ??= import("https://esm.sh/@supabase/supabase-js@2.118.0?bundle").then(({ createClient }) =>
    createClient(supabaseConfig.url, supabaseConfig.publishableKey, {
      auth: {
        flowType: "pkce",
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  );
  return clientPromise;
}
