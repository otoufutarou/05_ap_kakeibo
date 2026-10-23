const corsHeaders = {
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

Deno.serve(async (request) => {
  const allowedOrigin = Deno.env.get("ALLOWED_ORIGIN");
  const origin = request.headers.get("origin");
  const responseHeaders = {
    ...corsHeaders,
    ...(allowedOrigin && origin === allowedOrigin ? { "Access-Control-Allow-Origin": origin } : {}),
  };
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: responseHeaders,
    });
  }
  if (request.method !== "POST" || !allowedOrigin || origin !== allowedOrigin) {
    return new Response(JSON.stringify({ error: "Request not allowed." }), { status: 403, headers: responseHeaders });
  }

  const authorization = request.headers.get("authorization");
  const projectUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!authorization?.startsWith("Bearer ") || !projectUrl || !publishableKey || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: "Account deletion is not configured." }), { status: 503, headers: responseHeaders });
  }

  try {
    const identityResponse = await fetch(`${projectUrl}/auth/v1/user`, {
      headers: { apikey: publishableKey, authorization },
    });
    if (!identityResponse.ok) {
      return new Response(JSON.stringify({ error: "Please sign in again before deleting your account." }), { status: 401, headers: responseHeaders });
    }
    const identity = await identityResponse.json();
    if (typeof identity.id !== "string" || !/^[0-9a-f-]{36}$/i.test(identity.id)) {
      return new Response(JSON.stringify({ error: "Could not verify account." }), { status: 401, headers: responseHeaders });
    }

    const deletionResponse = await fetch(`${projectUrl}/auth/v1/admin/users/${identity.id}`, {
      method: "DELETE",
      headers: { apikey: serviceRoleKey, authorization: "Bearer " + serviceRoleKey },
    });
    if (!deletionResponse.ok) {
      return new Response(JSON.stringify({ error: "Account deletion failed. Please try again." }), { status: 502, headers: responseHeaders });
    }
    return new Response(JSON.stringify({ deleted: true }), { status: 200, headers: responseHeaders });
  } catch {
    return new Response(JSON.stringify({ error: "Account deletion failed. Please try again." }), { status: 502, headers: responseHeaders });
  }
});
