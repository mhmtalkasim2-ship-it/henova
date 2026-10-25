// HENOVA secure API. Prepared for a dedicated Supabase project; NOT yet deployed.
// Never accept client-provided balances, Telegram user IDs, prices or egg counts.
// Requires private secrets: HENOVA_TELEGRAM_BOT_TOKEN and SUPABASE_SERVICE_ROLE_KEY.
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const encoder = new TextEncoder();
const allowedOrigin = Deno.env.get("HENOVA_ALLOWED_ORIGIN") || "https://mhmtalkasim2-ship-it.github.io";
const responses = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  Vary: "Origin",
};
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: responses });

const hex = (bytes) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");

async function telegramUser(initData, token) {
  if (typeof initData !== "string" || initData.length < 20 || initData.length > 16384) {
    throw new Error("invalid_init_data");
  }
  const params = new URLSearchParams(initData);
  const keys = Array.from(params.keys());
  if (new Set(keys).size !== keys.length) throw new Error("duplicate_init_data_keys");
  const actualHash = params.get("hash");
  const tsText = params.get("auth_date");
  if (!actualHash || !/^[a-f0-9]{64}$/i.test(actualHash) || !/^\d{10,12}$/.test(tsText || "")) {
    throw new Error("invalid_signature");
  }
  const authDate = Number(tsText);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(authDate) || authDate < now - 86400 || authDate > now + 90) {
    throw new Error("expired_init_data");
  }
  const checkString = Array.from(params.entries())
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + "=" + value)
    .join("\n");

  const initialKey = await crypto.subtle.importKey(
    "raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const secret = await crypto.subtle.sign("HMAC", initialKey, encoder.encode(token));
  const signingKey = await crypto.subtle.importKey(
    "raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const expected = hex(await crypto.subtle.sign("HMAC", signingKey, encoder.encode(checkString)));
  // Constant-work comparison over the fixed-length hashes.
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= expected.charCodeAt(i) ^ actualHash.toLowerCase().charCodeAt(i);
  if (diff !== 0) throw new Error("invalid_signature");
  let user;
  try { user = JSON.parse(params.get("user") || "null"); } catch { throw new Error("invalid_user"); }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) throw new Error("invalid_user");
  return {
    id: user.id,
    first_name: String(user.first_name || "").slice(0, 100),
    username: typeof user.username === "string" ? user.username.slice(0, 64) : null,
    referral_id: /^ref_[1-9][0-9]{0,18}$/.test(params.get("start_param") || "")
      ? Number((params.get("start_param") || "").slice(4)) : null,
  };
}
function publicState(player) {
  const rate = (player.starter_hens * 10 + player.red_hens * 30 +
    player.gold_hens * 60 + player.royal_hens * 120 + player.legend_hens * 250) *
    [1, 1.10, 1.20, 1.35, 1.50, 1.75][player.fan_level];
  const elapsed = Math.max(0, Date.now() - Date.parse(player.production_started_at));
  return {
    eggs: player.egg_balance,
    coins: player.coin_balance,
    hen: { starter: player.starter_hens, red: player.red_hens, gold: player.gold_hens,
      royal: player.royal_hens, legend: player.legend_hens },
    fan: player.fan_level,
    pending: Math.floor(Math.min(6 * 3600000, elapsed) * rate / 3600000),
    rate, production_started_at: player.production_started_at,
    daily_claimed_on: player.last_daily_on,
  };
}
Deno.serve(async (request) => {
  if (request.headers.get("origin") && request.headers.get("origin") !== allowedOrigin) {
    return reply({ ok: false, error: "origin_not_allowed" }, 403);
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responses });
  if (request.method !== "POST") return reply({ ok: false, error: "method_not_allowed" }, 405);
  const botToken = Deno.env.get("HENOVA_TELEGRAM_BOT_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!botToken || !supabaseUrl || !serviceKey) {
    console.error("HENOVA API secrets are not configured");
    return reply({ ok: false, error: "not_configured" }, 503);
  }
  let body;
  try {
    if (Number(request.headers.get("content-length") || 0) > 20000) throw new Error("too_large");
    body = await request.json();
  } catch { return reply({ ok: false, error: "invalid_json" }, 400); }

  let telegram;
  try { telegram = await telegramUser(body?.initData, botToken); }
  catch { return reply({ ok: false, error: "unauthorized" }, 401); }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // Read-only diagnostic reserved for a configured Telegram admin.
  // No player initialization or balances are changed by this action.
  if (body?.action === "diagnostic") {
    const allowedAdmin = Deno.env.get("HENOVA_ADMIN_TELEGRAM_ID") || "";
    if (!/^\\d+$/.test(allowedAdmin) || String(telegram.id) !== allowedAdmin) {
      return reply({ ok: false, error: "forbidden" }, 403);
    }
    const { error: dbError } = await admin.from("henova_players")
      .select("telegram_id", { head: true, count: "exact" }).limit(1);
    if (dbError) {
      console.error("HENOVA diagnostic failed", dbError.code);
      return reply({ ok: false, error: "database_unavailable" }, 503);
    }
    return reply({ ok: true, auth: "telegram_verified", database: "connected", mode: "read_only" });
  }
  // Membership is checked against Telegram itself, never against client claims.
  if (body?.action === "join_channel") {
    const memberResponse = await fetch(
      "https://api.telegram.org/bot" + botToken + "/getChatMember",
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: "@HENOVA_FARM", user_id: telegram.id }) }
    ).catch(() => null);
    if (!memberResponse) return reply({ ok: false, error: "verification_unavailable" }, 503);
    const member = await memberResponse.json().catch(() => null);
    if (!member?.ok) {
      console.warn("HENOVA channel verification unavailable", member?.error_code);
      return reply({ ok: false, error: "verification_unavailable" }, 503);
    }
    const m = member.result;
    if (!(["creator","administrator","member"].includes(m?.status) ||
      (m?.status === "restricted" && m?.is_member === true))) {
      return reply({ ok: false, error: "not_joined" }, 403);
    }
    const requestId = body?.requestId;
    if (typeof requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
      return reply({ ok: false, error: "invalid_request_id" }, 400);
    }
    // Preserve bootstrap logic by carrying the verified membership flag, then claim below.
  }
  // Atomic registration: first signed entry only; credit inviter 100 coins once.
  // The SQL function refuses to change the inviter for existing users.
  const { error: initError } = await admin.rpc("henova_register_player", {
    p_telegram_id: telegram.id,
    p_first_name: telegram.first_name,
    p_username: telegram.username,
    p_inviter_id: telegram.referral_id,
  });
  if (initError) {
    console.error("HENOVA player registration failed", initError.code);
    return reply({ ok: false, error: "database_unavailable" }, 503);
  }
  const action = body?.action;
  if (action === "join_channel") {
    const { data, error } = await admin.rpc("henova_claim_channel_reward", {
      p_telegram_id: telegram.id,
      p_request_id: body.requestId,
    });
    if (error) return reply({ ok: false, error: "action_failed" }, 400);
    return reply(data);
  }
  if (action === "state") {
    const { data, error } = await admin.from("henova_players")
      .select("egg_balance,coin_balance,starter_hens,red_hens,gold_hens,royal_hens,legend_hens,fan_level,production_started_at,last_daily_on,referral_eggs_earned,referral_coins_earned")
      .eq("telegram_id", telegram.id).single();
    if (error || !data) return reply({ ok: false, error: "database_unavailable" }, 503);
    const { count: referralCount, error: referralErr } = await admin.from("henova_players")
      .select("telegram_id", { head: true, count: "exact" }).eq("referred_by", telegram.id);
    if (referralErr) return reply({ ok: false, error: "database_unavailable" }, 503);
    const { data: reward } = await admin.from("henova_channel_rewards")
      .select("last_rewarded_at").eq("telegram_id", telegram.id).maybeSingle();
    return reply({ ok: true, state: {
      ...publicState(data), referrals_count: referralCount || 0,
      referral_eggs_earned: data.referral_eggs_earned || 0,
      referral_coins_earned: data.referral_coins_earned || 0,
      channel_next_at: reward?.last_rewarded_at
        ? new Date(Date.parse(reward.last_rewarded_at) + 21600000).toISOString() : null
    } });
  }
  if (!["collect", "daily", "purchase", "boost"].includes(action)) {
    return reply({ ok: false, error: "unknown_action" }, 400);
  }
  const requestId = body?.requestId;
  if (typeof requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    return reply({ ok: false, error: "invalid_request_id" }, 400);
  }
  const item = typeof body?.item === "string" ? body.item : null;
  const { data, error } = await admin.rpc("henova_process_action", {
    p_telegram_id: telegram.id,
    p_action: action,
    p_request_id: requestId,
    p_item: item,
  });
  if (error) {
    console.error("HENOVA transaction error", error.code);
    return reply({ ok: false, error: "action_failed" }, 400);
  }
  return reply(data);
});
