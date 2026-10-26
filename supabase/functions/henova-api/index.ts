// HENOVA secure API. Prepared for a dedicated Supabase project; NOT yet deployed.
// Never accept client-provided balances, Telegram user IDs, prices or egg counts.
// Requires private secrets: HENOVA_TELEGRAM_BOT_TOKEN and SUPABASE_SERVICE_ROLE_KEY.
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const encoder = new TextEncoder();
// Bot start button bootstrap: runs only after verified Telegram Mini App initData.
// A pre-existing webhook on another URL is never overwritten.
const HENOVA_BOT_MINIAPP_URL="https://mhmtalkasim2-ship-it.github.io/henova/";
let henovaBotStartup=null;
async function ensureHenovaStartButton(botToken,supabaseUrl){
  const botApi=async(method,params={})=>{
    const r=await fetch("https://api.telegram.org/bot"+botToken+"/"+method,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify(params),signal:AbortSignal.timeout(10000)
    });
    const json=await r.json().catch(()=>null);
    if(!r.ok||!json?.ok)throw new Error("telegram_"+method+"_error_"+(json?.error_code||r.status));
    return json.result;
  };
  const endpoint=supabaseUrl+"/functions/v1/henova-bot-webhook";
  const status=await botApi("getWebhookInfo");
  const current=String(status?.url||"");
  if(current && current!==endpoint){
    console.warn("HENOVA bot has existing webhook; preserving its configuration");
    return;
  }
  if(!current){
    const bytes=await crypto.subtle.digest("SHA-256",encoder.encode("henova-webhook-1:"+botToken));
    const secret=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
    await botApi("setWebhook",{url:endpoint,secret_token:secret,allowed_updates:["message"],max_connections:10,drop_pending_updates:false});
    console.info("HENOVA bot /start webhook registered");
  }
  await Promise.allSettled([
    botApi("setMyCommands",{commands:[{command:"start",description:"Open HENOVA Farm"}]}),
    botApi("setMyCommands",{language_code:"ar",commands:[{command:"start",description:"افتح مزرعة HENOVA"}]}),
    botApi("setMyCommands",{language_code:"tr",commands:[{command:"start",description:"HENOVA çiftliğini aç"}]}),
    botApi("setChatMenuButton",{menu_button:{type:"web_app",text:"🐔 Start",web_app:{url:HENOVA_BOT_MINIAPP_URL}}})
  ]);
}

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
  // Telegram initData is verified before this point. Leaderboard values are
  // aggregated on the server from confirmed collection events, not client state.
  if (["admin_payout_queue","admin_payout_approve","admin_payout_intent","admin_chain_audit"].includes(action)) {
    // Only existing HENOVA channel administrators can read or approve payouts.
    const adminResponse=await fetch("https://api.telegram.org/bot"+botToken+"/getChatMember",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({chat_id:"@HENOVA_FARM",user_id:telegram.id}),
      signal:AbortSignal.timeout(8000)
    }).catch(()=>null);
    const membership=await adminResponse?.json().catch(()=>null);
    if(!membership?.ok||!["creator","administrator"].includes(membership.result?.status))
      return reply({ok:false,error:"admin_only"},403);
    const settings=await admin.from("henova_payout_settings")
      .select("payout_wallet_address,enabled,gram_per_egg,min_eggs,max_eggs,chain_verifier_configured,test_transfer_verified,signer_configured,payout_mode").eq("singleton",true).single();
    if(settings.error)return reply({ok:false,error:"database_unavailable"},503);
    // No server-generated real payment intent until independent on-chain verification
    // and the controlled live transfer test are explicitly completed.
    if(action==="admin_payout_intent" &&
       (!settings.data.enabled || !settings.data.chain_verifier_configured || !settings.data.test_transfer_verified))
      return reply({ok:false,error:"payout_safety_gate_closed"},403);
    if(action==="admin_chain_audit"){
      // Read-only mainnet inspection, never authorizes a payout or changes its status.
      // Restrict requests to the configured treasury account only.
      const treasury=String(settings.data.payout_wallet_address||"");
      if(!/^(EQ|UQ)[A-Za-z0-9_-]{46}$/.test(treasury))
        return reply({ok:false,error:"treasury_unset"},503);
      try{
        const url=new URL("https://toncenter.com/api/v3/transactions");
        url.searchParams.set("account",treasury);
        url.searchParams.set("limit","15");
        url.searchParams.set("sort","desc");
        const headers={Accept:"application/json"};
        const key=Deno.env.get("TONCENTER_API_KEY");
        if(key)headers["X-API-Key"]=key;
        const response=await fetch(url,{headers,signal:AbortSignal.timeout(9000)});
        if(!response.ok)return reply({ok:false,error:"chain_provider_unavailable"},503);
        const data=await response.json();
        if(!Array.isArray(data?.transactions))return reply({ok:false,error:"chain_response_invalid"},503);
        const entries=data.transactions.filter(t=>t && !t.emulated).slice(0,15).map(t=>({
          hash:String(t.hash||"").slice(0,128),
          lt:String(t.lt||"").slice(0,40),
          timestamp:Number(t.now)||null,
          aborted:t.description?.aborted===true,
          action_success:t.description?.action?.success===true,
          outbound_messages:Array.isArray(t.out_msgs)?t.out_msgs.length:0
        }));
        return reply({ok:true,mode:"read_only",network:"mainnet",treasury,entries,
          warning:"Transactions viewed only. No withdrawal was matched, verified or paid."});
      }catch{
        return reply({ok:false,error:"chain_provider_unavailable"},503);
      }
    }
    if(action==="admin_payout_queue"){
      const result=await admin.from("henova_gram_withdrawals")
        .select("id,telegram_id,destination_address,eggs_amount,gram_amount,status,created_at,payout_tx_hash")
        .in("status",["pending","approved","broadcast"]).order("id",{ascending:true}).limit(50);
      if(result.error)return reply({ok:false,error:"database_unavailable"},503);
      return reply({ok:true,items:result.data||[],payout_wallet_address:settings.data.payout_wallet_address,payments_enabled:false,checks:{withdrawals_enabled:settings.data.enabled===true,chain_verifier_ready:settings.data.chain_verifier_configured===true,test_transfer_verified:settings.data.test_transfer_verified===true,manual_tonkeeper_approval_required:true},reason:"Payouts remain disabled until independently verified mainnet settlement and a signed test transfer."});
    }
    const id=Number(body?.withdrawalId);
    if(!Number.isSafeInteger(id)||id<=0)return reply({ok:false,error:"invalid_request"},400);
    if(action==="admin_payout_approve"){
      // Status approval is NOT a payment and cannot trigger 'PAID' notices.
      const result=await admin.from("henova_gram_withdrawals")
        .update({status:"approved",updated_at:new Date().toISOString()})
        .eq("id",id).eq("status","pending").select("id,status").maybeSingle();
      if(result.error)return reply({ok:false,error:"database_unavailable"},503);
      if(!result.data)return reply({ok:false,error:"not_pending"},409);
      return reply({ok:true,request:result.data});
    }
    const result=await admin.from("henova_gram_withdrawals")
      .select("id,status,destination_address,gram_amount,eggs_amount")
      .eq("id",id).eq("status","approved").maybeSingle();
    if(result.error||!result.data)return reply({ok:false,error:"not_approved"},409);
    if(!settings.data.payout_wallet_address)return reply({ok:false,error:"treasury_unset"},503);
    // The amount is server-side; never accept the amount or destination from the client.
    const nanograms=Math.round(Number(result.data.gram_amount)*1e9);
    if(!Number.isSafeInteger(nanograms)||nanograms<=0||nanograms>1e9)
      return reply({ok:false,error:"invalid_amount"},409);
    return reply({ok:true,intent:{
      id:result.data.id,destination:result.data.destination_address,
      amountNanograms:String(nanograms),amountGram:String(result.data.gram_amount),
      sender:settings.data.payout_wallet_address,network:"-239"
    },requires_manual_tonkeeper_signature:true,not_chain_confirmed:true});
  }
  if (action === "verify_withdrawals_channel") {
    // Verification only: do not grant coins until a separate audited reward
    // policy and idempotent reward ledger are configured.
    const result = await fetch("https://api.telegram.org/bot"+botToken+"/getChatMember", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({chat_id:"@HENOVA_WITHDRAWALS",user_id:telegram.id}),
      signal:AbortSignal.timeout(8000)
    }).catch(()=>null);
    const member = await result?.json().catch(()=>null);
    if(!member?.ok)return reply({ok:false,error:"verification_unavailable"},503);
    const status=member.result?.status;
    const joined=["creator","administrator","member"].includes(status) ||
      (status==="restricted" && member.result?.is_member===true);
    return reply({ok:true,joined,channel:"@HENOVA_WITHDRAWALS"});
  }
  if (action === "payout_setup") {
    const [settings,wallet,withdrawals] = await Promise.all([
      admin.from("henova_payout_settings").select("asset,network,enabled,min_eggs,max_eggs,cooldown_hours,gram_per_egg").eq("singleton",true).single(),
      admin.from("henova_ton_wallets").select("wallet_address,verified_owner").eq("telegram_id",telegram.id).maybeSingle(),
      admin.from("henova_gram_withdrawals").select("id,eggs_amount,gram_amount,status,payout_tx_hash,created_at").eq("telegram_id",telegram.id).order("created_at",{ascending:false}).limit(10)
    ]);
    if(settings.error||wallet.error||withdrawals.error)return reply({ok:false,error:"database_unavailable"},503);
    // Notify only for confirmed payments, never for pending submissions.
    // Conditional claim prevents parallel requests from double-posting.
    const due=await admin.from("henova_gram_withdrawals")
      .select("id,telegram_id,destination_address,eggs_amount,gram_amount,payout_tx_hash,blockchain_verified_at")
      .eq("telegram_id",telegram.id).eq("status","confirmed").is("notice_message_id",null)
      .not("payout_tx_hash","is",null).not("blockchain_verified_at","is",null)
      .order("id",{ascending:true}).limit(1);
    if(!due.error && due.data?.length){
      const wd=due.data[0];
      const claim=await admin.from("henova_gram_withdrawals").update({notice_message_id:-1})
        .eq("id",wd.id).eq("status","confirmed").is("notice_message_id",null)
        .select("id").maybeSingle();
      if(!claim.error&&claim.data){
        try{
          const mask=wd.destination_address.slice(0,6)+"..."+wd.destination_address.slice(-5);
          const hash=String(wd.payout_tx_hash);
          if(!/^[a-zA-Z0-9_+\/-]{32,100}={0,2}$/.test(hash))throw Error("invalid_payment_hash");
          const explorer="https://tonviewer.com/transaction/"+encodeURIComponent(hash);
          const bodyText="✅ WITHDRAWAL PAID · #"+wd.id+
            "\n\n👤 Farmer: Player #"+wd.telegram_id+
            "\n💎 Amount: "+wd.gram_amount+" GRAM"+
            "\n🥚 Eggs: "+wd.eggs_amount+
            "\n👛 Wallet: "+mask+
            "\n⚡ Network: TON"+
            "\n🕒 "+new Date(wd.blockchain_verified_at).toISOString().replace("T"," ").replace(".000Z"," UTC")+
            "\n\n🐔 HENOVA Chicken Farm";
          const sent=await fetch("https://api.telegram.org/bot"+botToken+"/sendMessage",{
            method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({chat_id:"@HENOVA_WITHDRAWALS",text:bodyText,
              reply_markup:{inline_keyboard:[
                [{text:"🔎 View transaction",url:explorer}],
                [{text:"🐔 Play & earn GRAM",url:"https://t.me/HenovaEggsBot/farm"}]
              ]}}),signal:AbortSignal.timeout(9000)});
          const payload=await sent.json().catch(()=>null);
          if(!sent.ok||!payload?.ok||!payload.result?.message_id)throw Error("telegram_send_failed");
          const saved=await admin.from("henova_gram_withdrawals")
            .update({notice_message_id:payload.result.message_id}).eq("id",wd.id).eq("notice_message_id",-1);
          if(saved.error)console.error("HENOVA notice message id persist failed",saved.error.code);
        }catch(err){
          console.warn("HENOVA notice delayed",String(err).slice(0,100));
          // Retry is safe only when the send definitely failed; avoid duplicate paid posts
          // after ambiguous network failures by leaving -1 pending manual reconciliation.
        }
      }
    }
    return reply({ok:true,payout:{...settings.data,enabled:false},wallet:wallet.data||null,withdrawals:withdrawals.data||[]});
  }
  // Issue a short-lived, server-generated TON Proof nonce after Telegram authentication.
  // This action does not mark any wallet as verified.
  if (action === "wallet_proof_challenge") {
    const address=String(body?.address||"");
    const saved=await admin.from("henova_ton_wallets").select("wallet_address")
      .eq("telegram_id",telegram.id).maybeSingle();
    if(saved.error)return reply({ok:false,error:"database_unavailable"},503);
    if(!saved.data || saved.data.wallet_address!==address)
      return reply({ok:false,error:"save_wallet_first"},403);
    const {data,error}=await admin.rpc("henova_issue_wallet_proof_challenge",{
      p_telegram_id:telegram.id,p_wallet_address:address
    });
    if(error)return reply({ok:false,error:"challenge_unavailable"},503);
    return reply(data,data?.ok?200:400);
  }
  if (action === "save_payout_wallet") {
    const address=String(body?.address||"");
    if(!/^(EQ|UQ)[A-Za-z0-9_-]{46}$/.test(address))
      return reply({ok:false,error:"invalid_ton_wallet"},400);
    const normalized=address.replace(/-/g,"+").replace(/_/g,"/");
    let raw;
    try { raw=Uint8Array.from(atob(normalized),ch=>ch.charCodeAt(0)); }
    catch{return reply({ok:false,error:"invalid_ton_wallet"},400)}
    if(raw.length!==36 || raw[1]!==0 || (raw[0]!==0x11 && raw[0]!==0x51))
      return reply({ok:false,error:"invalid_ton_wallet"},400);
    let crc=0;
    for(let i=0;i<34;i++){
      crc ^= raw[i]<<8;
      for(let bit=0;bit<8;bit++)crc=(crc&0x8000)?((crc<<1)^0x1021)&65535:(crc<<1)&65535;
    }
    if(crc!==((raw[34]<<8)|raw[35]))return reply({ok:false,error:"invalid_ton_wallet"},400);
    const {error}=await admin.from("henova_ton_wallets").upsert({
      telegram_id:telegram.id,wallet_address:address,verified_owner:false,updated_at:new Date().toISOString()
    },{onConflict:"telegram_id"});
    if(error)return reply({ok:false,error:"wallet_save_failed"},503);
    return reply({ok:true,wallet:{wallet_address:address,verified_owner:false},
      note:"Address saved; ownership not yet cryptographically verified"});
  }
  if (action === "request_gram_withdrawal") {
    const requestId=body?.requestId;
    const eggs=body?.eggs;
    if(typeof requestId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)
      ||!Number.isSafeInteger(eggs)||eggs<=0)return reply({ok:false,error:"invalid_request"},400);
    const {data,error}=await admin.rpc("henova_prepare_gram_withdrawal",{
      p_telegram_id:telegram.id,p_request_id:requestId,p_eggs:eggs
    });
    if(error){console.error("HENOVA reserve withdrawal failed",error.code);return reply({ok:false,error:"withdrawal_unavailable"},503)}
    return reply(data,data?.ok?200:403);
  }
  if (action === "leaderboard") {
    const { data, error } = await admin.rpc("henova_leaderboard", {
      p_telegram_id: telegram.id,
    });
    if (error || !data?.ok) {
      console.error("HENOVA leaderboard unavailable", error?.code || "unknown");
      return reply({ ok: false, error: "leaderboard_unavailable" }, 503);
    }
    return reply(data);
  }
  if (action === "join_channel") {
    const { data, error } = await admin.rpc("henova_claim_channel_reward", {
      p_telegram_id: telegram.id,
      p_request_id: body.requestId,
    });
    if (error) return reply({ ok: false, error: "action_failed" }, 400);
    return reply(data);
  }
  if (action === "state") {
    // Best-effort bot chat setup on the next authenticated app opening.
    if (!henovaBotStartup) {
      henovaBotStartup=ensureHenovaStartButton(botToken,supabaseUrl).catch(error=>{
        console.warn("HENOVA bot start setup deferred",String(error).slice(0,120));
      });
      try { EdgeRuntime.waitUntil(henovaBotStartup); } catch { /* unavailable in test runtimes */ }
    }
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
