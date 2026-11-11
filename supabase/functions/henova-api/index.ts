// HENOVA secure API. Prepared for a dedicated Supabase project; NOT yet deployed.
// Never accept client-provided balances, Telegram user IDs, prices or egg counts.
// Requires private secrets: HENOVA_TELEGRAM_BOT_TOKEN and SUPABASE_SERVICE_ROLE_KEY.
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { Address, Cell, loadStateInit, contractAddress } from "npm:@ton/core@0.63.1";
import { WalletContractV4, WalletContractV5R1 } from "npm:@ton/ton@15.4.0";
import nacl from "npm:tweetnacl@1.0.3";
import { Buffer } from "node:buffer";

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
  "Access-Control-Max-Age": "86400",
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
    daily_streak: player.daily_streak || 0,
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
    if (!/^\d+$/.test(allowedAdmin) || String(telegram.id) !== allowedAdmin) {
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
  const action = body?.action;

  // Native GRAM top-ups: TON mainnet native coin, not a Jetton.
  if (action === "create_gram_topup") {
    const requestId=String(body?.requestId||"");
    const sender=String(body?.senderAddress||"");
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))
      return reply({ok:false,error:"invalid_request_id"},400);
    let senderRaw="";
    try{senderRaw=Address.parse(sender).toRawString().toLowerCase();}catch{}
    if(!/^0:[0-9a-f]{64}$/.test(senderRaw))
      return reply({ok:false,error:"invalid_sender_wallet"},400);
    const {data,error}=await admin.rpc("henova_create_gram_topup",{
      p_telegram_id:telegram.id,p_request_id:requestId,p_sender_address:senderRaw
    });
    if(error){console.error("HENOVA top-up intent failed",error.code);return reply({ok:false,error:"topup_unavailable"},503);}
    return reply(data,data?.ok?200:400);
  }
  if (action === "verify_gram_topup") {
    const requestId=String(body?.requestId||"");
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))
      return reply({ok:false,error:"invalid_request_id"},400);
    const {data:invoice,error:invoiceError}=await admin.from("henova_gram_topups")
      .select("request_id,telegram_id,sender_address,destination_address,amount_nano,coins_amount,status,created_at,expires_at,tx_hash")
      .eq("request_id",requestId).eq("telegram_id",telegram.id).maybeSingle();
    if(invoiceError)return reply({ok:false,error:"topup_lookup_unavailable"},503);
    if(!invoice)return reply({ok:false,error:"topup_not_found"},404);
    if(invoice.status==="credited")
      return reply({ok:true,credited:true,already_credited:true,coins_added:invoice.coins_amount,tx_hash:invoice.tx_hash});
    if(invoice.status!=="pending")return reply({ok:false,error:"invoice_not_pending"},409);

    const rawAddress=(value)=>{
      try{return Address.parse(String(value||"")).toRawString().toLowerCase();}catch{return "";}
    };
    const senderRaw=rawAddress(invoice.sender_address);
    const destinationRaw=rawAddress(invoice.destination_address);
    if(!/^0:[0-9a-f]{64}$/.test(senderRaw)||!/^0:[0-9a-f]{64}$/.test(destinationRaw))
      return reply({ok:false,error:"invoice_wallet_invalid"},503);

    const readComment=(message)=>{
      const decoded=message?.message_content?.decoded;
      for(const candidate of [decoded?.comment,decoded?.text]){
        if(typeof candidate==="string")return candidate;
      }
      const bodyValue=message?.message_content?.body;
      if(typeof bodyValue!=="string"||!bodyValue)return "";
      const parseCell=(cell)=>{
        const slice=cell.beginParse();
        if(slice.remainingBits<32||Number(slice.loadUint(32))!==0)return "";
        return slice.loadStringTail();
      };
      try{return parseCell(Cell.fromBase64(bodyValue));}catch{}
      try{
        const cells=Cell.fromBoc(Buffer.from(bodyValue,"hex"));
        if(cells.length)return parseCell(cells[0]);
      }catch{}
      return "";
    };

    const createdSeconds=Math.max(0,Math.floor(Date.parse(invoice.created_at)/1000)-60);
    const endSeconds=Math.floor(Date.now()/1000);
    const headers={Accept:"application/json"};
    const key=Deno.env.get("TONCENTER_API_KEY");
    if(key)headers["X-API-Key"]=key;
    try{
      for(let offset=0;offset<3000;offset+=1000){
        const url=new URL("https://toncenter.com/api/v3/transactions");
        url.searchParams.set("account",invoice.destination_address);
        url.searchParams.set("start_utime",String(createdSeconds));
        url.searchParams.set("end_utime",String(endSeconds));
        url.searchParams.set("limit","1000");
        url.searchParams.set("offset",String(offset));
        url.searchParams.set("sort","desc");
        const response=await fetch(url,{headers,signal:AbortSignal.timeout(12000)});
        if(!response.ok)return reply({ok:false,error:"chain_provider_unavailable"},503);
        const payload=await response.json();
        const transactions=Array.isArray(payload?.transactions)?payload.transactions:[];
        for(const tx of transactions){
          const msg=tx?.in_msg;
          if(!msg||tx.emulated===true||tx.description?.aborted===true||msg.bounced===true)continue;
          if(rawAddress(msg.source)!==senderRaw||rawAddress(msg.destination||tx.account)!==destinationRaw)continue;
          let value=0n;
          try{value=BigInt(String(msg.value||"0"));}catch{continue;}
          if(value!==200000000n)continue;
          const txTime=Number(tx.now||msg.created_at||0);
          if(!Number.isSafeInteger(txTime)||txTime<=0)continue;
          const txDate=new Date(txTime*1000);
          if(txDate.getTime()<Date.parse(invoice.created_at)-60000||txDate.getTime()>Date.parse(invoice.expires_at))continue;
          if(readComment(msg)!=="HENOVA_TOPUP:"+requestId)continue;
          const hash=String(tx.hash||"").toLowerCase();
          if(!/^[0-9a-f]{64}$/.test(hash))continue;
          const {data:credited,error:creditError}=await admin.rpc("henova_credit_gram_topup",{
            p_request_id:requestId,p_tx_hash:hash,p_sender_address:senderRaw,
            p_destination_address:destinationRaw,p_amount_nano:"200000000",
            p_tx_timestamp:txDate.toISOString(),p_tx_lt:String(tx.lt||"0")
          });
          if(creditError){console.error("HENOVA top-up credit failed",creditError.code);return reply({ok:false,error:"topup_credit_unavailable"},503);}
          return reply(credited,credited?.ok?200:409);
        }
        if(transactions.length<1000)break;
      }
      return reply({ok:true,credited:false,pending:true,coins_amount:invoice.coins_amount,
        message:"Payment has not been indexed and confirmed yet. Check again shortly."});
    }catch(error){
      console.warn("HENOVA native GRAM verification unavailable",String(error).slice(0,100));
      return reply({ok:false,error:"chain_provider_unavailable"},503);
    }
  }

  if(action==="claim_interstitial_chest"){
    const {data,error}=await admin.rpc("henova_claim_interstitial_open",{p_telegram_id:telegram.id});
    if(error){console.error("HENOVA chest reward failed",error.code);return reply({ok:false,error:"reward_unavailable"},503);}
    return reply(data,data?.ok?200:(data?.error==="cooldown"?429:400));
  }
  if(action==="presence_ping"){
    const {error}=await admin.from("henova_presence").upsert({telegram_id:telegram.id,last_seen_at:new Date().toISOString()},{onConflict:"telegram_id"});
    return error?reply({ok:false,error:"presence_unavailable"},503):reply({ok:true});
  }
  if(action==="admin_online_count"){
    if(String(telegram.id)!=="1035565575")return reply({ok:false,error:"forbidden"},403);
    const since=new Date(Date.now()-3600000).toISOString();
    const {count,error}=await admin.from("henova_presence").select("telegram_id",{count:"exact",head:true}).gte("last_seen_at",since);
    return error?reply({ok:false,error:"presence_unavailable"},503):reply({ok:true,online:count||0,window_seconds:3600});
  }
  // Server-generated, one-use arithmetic checks. Telegram initData was authenticated above.
  if(body?.action==="math_challenge"){
    const scope=String(body?.scope||"");
    if(scope!=="entry"&&scope!=="withdraw")return reply({ok:false,error:"invalid_scope"},400);
    const bytes=crypto.getRandomValues(new Uint32Array(2));
    const a=2+(bytes[0]%8),b=2+(bytes[1]%8),multiply=(bytes[0]%2)===0;
    const challengeId=crypto.randomUUID();
    const expires=new Date(Date.now()+5*60*1000).toISOString();
    const {error}=await admin.from("henova_math_challenges").upsert({
      telegram_id:telegram.id,scope,challenge_id:challengeId,
      answer:multiply?a*b:a+b,expires_at:expires,verified_at:null
    },{onConflict:"telegram_id,scope"});
    if(error)return reply({ok:false,error:"challenge_unavailable"},503);
    return reply({ok:true,challengeId,question:a+(multiply?" × ":" + ")+b,expires_at:expires});
  }
  if(body?.action==="math_verify_entry"){
    const challengeId=String(body?.challengeId||"");
    const answer=Number(body?.answer);
    if(!/^[0-9a-f-]{36}$/i.test(challengeId)||!Number.isSafeInteger(answer))return reply({ok:false,error:"invalid_answer"},400);
    const {data,error}=await admin.from("henova_math_challenges")
      .delete().eq("telegram_id",telegram.id).eq("scope","entry")
      .eq("challenge_id",challengeId).eq("answer",answer)
      .gt("expires_at",new Date().toISOString()).select("challenge_id").maybeSingle();
    if(error)return reply({ok:false,error:"challenge_unavailable"},503);
    if(!data)return reply({ok:false,error:"incorrect_answer"},403);
    return reply({ok:true,verified:true});
  }

  // Owner-only read-only trial: do not depend on Telegram channel admin membership.
  if(action==="withdrawal_eligibility_progress" || action==="admin_eligibility_progress"){
    const since="2026-10-31T12:22:20.284Z";
    const results=await Promise.all(["henova_adsgram_video_rewards","henova_adsgram_task_rewards","henova_interstitial_open_rewards"].map(table=>admin.from(table).select("id").eq("telegram_id",telegram.id).gte("rewarded_at",since).limit(100)));
    if(results.some(x=>x.error)){
      console.error("HENOVA eligibility lookup failed",results.map((x,i)=>({table:i,code:x.error?.code,message:x.error?.message?.slice(0,120)})));
      return reply({ok:false,error:"progress_unavailable"},503);
    }
    const confirmed=results.reduce((total,r)=>total+(r.data?.length||0),0);
    return reply({ok:true,percent:Math.min(100,confirmed),confirmed,goal:25,trial:true,since});
  }
  // Telegram initData is verified before this point. Leaderboard values are
  // aggregated on the server from confirmed collection events, not client state.
  if (["admin_eligibility_progress","admin_user_ads_search","admin_find_withdrawal","admin_batch_reconcile_local","admin_batch_publish_verified","admin_batch_resume","admin_batch_prior_confirmed","admin_batch_intent","admin_batch_signed","admin_batch_audit","admin_batch_preview","admin_payout_queue","admin_payout_approve","admin_payout_intent","admin_record_signed_payout","admin_chain_audit","admin_jetton_diagnose","admin_match_payout","admin_verify_payout","admin_track_signed_payout","admin_post_payout_notice","admin_repost_selected_proofs","admin_test_submit","admin_test_queue","admin_test_intent","admin_test_approve","admin_verify_test_transfer"].includes(action)) {
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
      .select("payout_wallet_address,enabled,manual_tonkeeper_enabled,gram_per_egg,min_eggs,max_eggs,chain_verifier_configured,test_transfer_verified,signer_configured,payout_mode").eq("singleton",true).single();
    if(settings.error)return reply({ok:false,error:"database_unavailable"},503);
    // No server-generated real payment intent until independent on-chain verification
    // and the controlled live transfer test are explicitly completed.
    if(action==="admin_payout_intent" &&
       (!settings.data.manual_tonkeeper_enabled || !settings.data.chain_verifier_configured || !settings.data.test_transfer_verified))
      return reply({ok:false,error:"payout_safety_gate_closed"},403);
    if(["admin_batch_intent","admin_batch_signed","admin_payout_intent","admin_record_signed_payout","admin_track_signed_payout",
        "admin_verify_payout","admin_match_payout","admin_jetton_diagnose","admin_post_payout_notice"].includes(action)
        && String(telegram.id)!=="1035565575")
      return reply({ok:false,error:"owner_only"},403);
    if(action==="admin_eligibility_progress"){
      if(String(telegram.id)!=="1035565575")return reply({ok:false,error:"owner_only"},403);
      const since="2026-10-31T12:22:20.284Z";
      const counts=await Promise.all(["henova_adsgram_video_rewards","henova_adsgram_task_rewards"].map(table=>admin.from(table).select("id",{count:"exact",head:true}).eq("telegram_id",telegram.id).gte("rewarded_at",since)));
      if(counts.some(x=>x.error))return reply({ok:false,error:"progress_unavailable"},503);
      const confirmed=(counts[0].count||0)+(counts[1].count||0);
      return reply({ok:true,percent:Math.min(100,confirmed),confirmed,goal:25,trial:true,since});
    }
    if(action==="admin_user_ads_search"){
      if(String(telegram.id)!=="1035565575")return reply({ok:false,error:"owner_only"},403);
      const q=String(body?.username||"").trim().replace(/^@/,"");
      if(!/^[A-Za-z0-9_]{3,32}$/.test(q))return reply({ok:false,error:"invalid_username"},400);
      const {data:players,error:pe}=await admin.from("henova_players").select("telegram_id,username,first_name").ilike("username",q).limit(5);
      if(pe)return reply({ok:false,error:"lookup_unavailable"},503);
      const users=[];
      for(const player of (players||[])){
        const counts=await Promise.all(["henova_adsgram_video_rewards","henova_adsgram_task_rewards","henova_interstitial_open_rewards"].map(table=>admin.from(table).select("id",{count:"exact",head:true}).eq("telegram_id",player.telegram_id)));
        if(counts.some(c=>c.error))return reply({ok:false,error:"stats_unavailable"},503);
        const [video,sponsored,interstitial]=counts.map(c=>c.count||0);
        users.push({telegram_id:player.telegram_id,username:player.username,first_name:player.first_name,video,sponsored,interstitial,total:video+sponsored+interstitial});
      }
      return reply({ok:true,users,metric:"confirmed_reward_records"});
    }
    // Read-only batch preparation. No signing reservation or TON transfer.
    // Independent, read-only batch verification. No "paid" status is written here.
    // Intent is created only at administrator's explicit signing action. A reserved
    // batch is never automatically released: possible wallet submission must be audited.
    if(action==="admin_batch_reconcile_local"){
      if(String(telegram.id)!=="1035565575")return reply({ok:false,error:"owner_only"},403);
      const batchId=String(body?.batchId||"");
      if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(batchId))
        return reply({ok:false,error:"invalid_batch_id"},400);
      const {data:batch,error:be}=await admin.from("henova_payout_batches")
        .select("id,status,owner_id").eq("id",batchId).eq("owner_id",Number(telegram.id)).maybeSingle();
      if(be||!batch)return reply({ok:false,error:"batch_not_found"},404);
      const {data:items,error:ie}=await admin.from("henova_payout_batch_items")
        .select("withdrawal_id").eq("batch_id",batchId);
      if(ie||!items||items.length!==5)return reply({ok:false,error:"batch_items_unavailable"},409);
      const ids=items.map(i=>i.withdrawal_id);
      const {data:rows,error:re}=await admin.from("henova_gram_withdrawals")
        .select("id,status,blockchain_verified_at,notice_message_id,payout_tx_hash,batch_sender_tx_hash,batch_outgoing_message_hash").in("id",ids);
      if(re||!rows||rows.length!==5)return reply({ok:false,error:"batch_withdrawals_unavailable"},503);
      const confirmed=rows.every(w=>w.status==="confirmed"&&!!w.blockchain_verified_at
        && (!!w.payout_tx_hash|| (!!w.batch_sender_tx_hash&&!!w.batch_outgoing_message_hash)));
      return reply({ok:true,batch_id:batchId,ids,all_confirmed:confirmed,
        all_proofs_published:rows.every(w=>!!w.notice_message_id),can_clear_local_receipt:confirmed,
        warning:confirmed?"Verified funds received; clearing local receipt does not trigger signing.":"Do not clear or re-sign pending batch."});
    }
    if(action==="admin_batch_prior_confirmed"){
      if(String(telegram.id)!=="1035565575")return reply({ok:false,error:"owner_only"},403);
      const ids=body?.withdrawalIds;
      if(!Array.isArray(ids)||ids.length!==5||ids.some(x=>!Number.isSafeInteger(x)||x<=0)||new Set(ids).size!==5)
        return reply({ok:false,error:"invalid_batch"},400);
      const {data:items,error}=await admin.from("henova_gram_withdrawals")
        .select("id,status,blockchain_verified_at,payout_tx_hash,batch_sender_tx_hash,batch_outgoing_message_hash")
        .in("id",ids);
      if(error)return reply({ok:false,error:"lookup_unavailable"},503);
      const allConfirmed=items?.length===5 && items.every(x=>x.status==="confirmed"
        && !!x.blockchain_verified_at && (/^[a-f0-9]{64}$/.test(String(x.payout_tx_hash||""))
          || (/^[a-f0-9]{64}$/.test(String(x.batch_sender_tx_hash||""))
            && /^[a-f0-9]{64}$/.test(String(x.batch_outgoing_message_hash||"")))));
      return reply({ok:true,all_confirmed:allConfirmed,ids:ids});
    }
    if(action==="admin_batch_resume"){
      if(String(telegram.id)!=="1035565575")return reply({ok:false,error:"owner_only"},403);
      const batchId=String(body?.batchId||"");
      const ids=body?.withdrawalIds;
      if(!/^[0-9a-f-]{36}$/i.test(batchId)||!Array.isArray(ids)||ids.length!==5
        ||ids.some(x=>!Number.isSafeInteger(x)||x<=0)||new Set(ids).size!==5)
        return reply({ok:false,error:"invalid_resume_request"},400);
      const {data:batch,error}=await admin.from("henova_payout_batches")
        .select("id,status,sender,signed_boc_hash").eq("id",batchId).eq("owner_id",Number(telegram.id)).maybeSingle();
      if(error||!batch||batch.status!=="reserved"||batch.signed_boc_hash)
        return reply({ok:false,error:"batch_not_resumable"},409);
      const {data:items,error:itemsError}=await admin.from("henova_payout_batch_items")
        .select("withdrawal_id,destination,amount_nano").eq("batch_id",batchId);
      if(itemsError||!items||items.length!==5||items.some(x=>!ids.includes(x.withdrawal_id)))
        return reply({ok:false,error:"batch_members_changed"},409);
      const {data:rows,error:rowError}=await admin.from("henova_gram_withdrawals")
        .select("id,status,signing_claimed_at,signed_boc_hash,payout_tx_hash,payout_sender_address,destination_address,gram_amount")
        .in("id",ids);
      if(rowError||!rows||rows.length!==5||rows.some(w=>{
        const i=items.find(x=>x.withdrawal_id===w.id);
        return w.status!=="approved"||!w.signing_claimed_at||w.signed_boc_hash||w.payout_tx_hash
          ||w.payout_sender_address!==batch.sender||w.destination_address!==i?.destination
          ||String(BigInt(Math.round(Number(w.gram_amount)*1e9)))!==String(i?.amount_nano);
      }))return reply({ok:false,error:"batch_not_safe_to_resume"},409);
      return reply({ok:true,batch_id:batchId,sender:batch.sender,network:"-239",
        messages:items.sort((a,b)=>a.withdrawal_id-b.withdrawal_id)
          .map(x=>({withdrawal_id:x.withdrawal_id,address:x.destination,amount:String(x.amount_nano)})),
        reserved:true,resumed:true,not_chain_confirmed:true});
    }
    if(action==="admin_batch_intent"){
      const ids=body?.withdrawalIds;
      if(!Array.isArray(ids)||ids.length<2||ids.length>5||
        ids.some(x=>!Number.isSafeInteger(x)||x<=291)||new Set(ids).size!==ids.length)
        return reply({ok:false,error:"invalid_batch"},400);
      if(!settings.data.manual_tonkeeper_enabled||!settings.data.chain_verifier_configured||!settings.data.test_transfer_verified)
        return reply({ok:false,error:"payout_safety_gate_closed"},403);
      const {data:prepared,error:prepError}=await admin.rpc("henova_reserve_payout_batch",{p_ids:ids,p_owner:Number(telegram.id)});
      if(prepError||!prepared?.ok)return reply({ok:false,error:prepared?.error||"batch_preparation_failed"},409);
      const batchId=prepared.batch_id;
      // Validate all destinations and amounts server-side BEFORE claiming a signing attempt.
      let sender;
      try{sender=Address.parse(settings.data.payout_wallet_address).toRawString()}catch{return reply({ok:false,error:"invalid_treasury"},409)}
      for(const x of prepared.items){
        try{if(Address.parse(x.destination).toRawString()===sender)throw Error("self_payment");
          if(!/^[0-9]+$/.test(x.amountNano)||BigInt(x.amountNano)<=0n||BigInt(x.amountNano)>1000000000n)throw Error("amount");}
        catch{return reply({ok:false,error:"invalid_batch_destination_or_amount",batch_id:batchId},409)}
      }
      const {data:claim,error:claimError}=await admin.rpc("henova_claim_payout_batch",{p_batch_id:batchId,p_owner:Number(telegram.id)});
      if(claimError||!claim?.ok)return reply({ok:false,error:claim?.error||"batch_claim_failed",batch_id:batchId},409);
      return reply({ok:true,batch_id:batchId,sender:settings.data.payout_wallet_address,network:"-239",
        messages:prepared.items.map(x=>({withdrawal_id:x.id,address:x.destination,amount:x.amountNano})),
        reservation_permanent:true,chain_confirmed:false});
    }
    if(action==="admin_batch_signed"){
      const batchId=String(body?.batchId||"");
      const signedBoc=String(body?.signedBoc||"");
      if(!/^[a-f0-9-]{36}$/i.test(batchId)||signedBoc.length>25000)return reply({ok:false,error:"invalid_batch_receipt"},400);
      let hash;
      try{hash=Cell.fromBase64(signedBoc).hash().toString("hex")}
      catch{return reply({ok:false,error:"invalid_signed_message"},400)}
      const {data:record,error}=await admin.rpc("henova_record_signed_batch",{
        p_batch_id:batchId,p_boc_hash:hash,p_owner:Number(telegram.id)});
      if(error||!record?.ok)return reply({ok:false,error:record?.error||"signed_receipt_record_failed"},409);
      return reply({...record,boc_hash:hash});
    }
    if(action==="admin_batch_preview"){
      if(String(telegram.id)!=="1035565575")return reply({ok:false,error:"owner_only"},403);
      const ids=body?.withdrawalIds;
      if(!Array.isArray(ids)||ids.length<2||ids.length>5||
         ids.some(x=>!Number.isSafeInteger(x)||x<=291) || new Set(ids).size!==ids.length)
        return reply({ok:false,error:"invalid_batch"},400);
      if(!settings.data.manual_tonkeeper_enabled || !settings.data.chain_verifier_configured ||
         !settings.data.test_transfer_verified)return reply({ok:false,error:"payout_safety_gate_closed"},403);
      const {data:rows,error}=await admin.from("henova_gram_withdrawals")
        .select("id,status,destination_address,gram_amount,signing_claimed_at,signed_boc_hash,payout_tx_hash")
        .in("id",ids);
      if(error||!rows||rows.length!==ids.length)return reply({ok:false,error:"requests_unavailable"},409);
      if(rows.some(r=>r.status!=="approved"||r.signing_claimed_at||r.signed_boc_hash||r.payout_tx_hash))
        return reply({ok:false,error:"one_or_more_requests_not_safe_to_sign"},409);
      const targets=[];
      let total=0n;
      for(const id of ids){
        const row=rows.find(x=>x.id===id);
        try{
          const destination=Address.parse(row.destination_address).toString({bounceable:false});
          if(Address.parse(destination).toRawString()===Address.parse(settings.data.payout_wallet_address).toRawString())
            return reply({ok:false,error:"treasury_as_recipient"},409);
          const amount=String(row.gram_amount);
          if(!/^[0-9]+(?:\.[0-9]{1,9})?$/.test(amount))return reply({ok:false,error:"invalid_batch_amount"},409);
          const [whole,fraction=""]=amount.split(".");
          const nano=BigInt(whole)*1000000000n+BigInt((fraction+"000000000").slice(0,9));
          if(nano<=0n||nano>1000000000n)return reply({ok:false,error:"invalid_batch_amount"},409);
          total+=nano;
          targets.push({id,destination:row.destination_address,amountNanograms:String(nano),gram:amount});
        }catch{return reply({ok:false,error:"invalid_recipient"},409)}
      }
      return reply({ok:true,preview:true,signing_enabled:false,reason:"batch_settlement_proof_not_ready",
        sender:settings.data.payout_wallet_address,network:"-239",targets,totalNanograms:String(total),
        message:"Review only. No funds reserved or transferred."});
    }
    if(action==="admin_jetton_diagnose"){
      // Read-only: no status transitions, no proofs, no payout signing.
      const id=Number(body?.withdrawalId);
      if(!Number.isSafeInteger(id)||id<=0)return reply({ok:false,error:"invalid_request"},400);
      const row=await admin.from("henova_gram_withdrawals")
        .select("id,status,gram_amount,created_at,signing_claimed_at,destination_address,payout_sender_address")
        .eq("id",id).maybeSingle();
      if(row.error||!row.data)return reply({ok:false,error:"request_not_found"},404);
      const w=row.data;
      const sender=String(settings.data.payout_wallet_address||"");
      const normalize=(value)=>{try{return Address.parse(String(value||"")).toRawString().toLowerCase()}catch{return null}};
      if(!normalize(sender)||!normalize(w.destination_address))return reply({ok:false,error:"invalid_address"},409);
      const signedAt=Date.parse(w.signing_claimed_at||w.created_at);
      const start=Math.max(0,Math.floor(signedAt/1000)-600);
      const end=Math.floor(signedAt/1000)+7200;
      const q=new URL("https://toncenter.com/api/v3/jetton/transfers");
      q.searchParams.set("owner_address",sender);
      q.searchParams.set("direction","out");
      q.searchParams.set("start_utime",String(start));
      q.searchParams.set("end_utime",String(end));
      q.searchParams.set("limit","1000");
      const headers={Accept:"application/json"};
      const key=Deno.env.get("TONCENTER_API_KEY");
      if(key)headers["X-API-Key"]=key;
      try{
        const rr=await fetch(q,{headers,signal:AbortSignal.timeout(12000)});
        if(!rr.ok)return reply({ok:false,error:"toncenter_unavailable",http_status:rr.status},503);
        const body=await rr.json();
        const entries=Array.isArray(body.jetton_transfers)?body.jetton_transfers:[];
        // Cross-check incoming records at the destination too: some indexer
        // entries are absent from the sender-owner lookup.
        let incoming=[];
        try{
          const incomingUrl=new URL("https://toncenter.com/api/v3/jetton/transfers");
          incomingUrl.searchParams.set("owner_address",w.destination_address);
          incomingUrl.searchParams.set("direction","in");
          incomingUrl.searchParams.set("start_utime",String(start));
          incomingUrl.searchParams.set("end_utime",String(end));
          incomingUrl.searchParams.set("limit","1000");
          const inbound=await fetch(incomingUrl,{headers,signal:AbortSignal.timeout(12000)});
          if(inbound.ok){const payload=await inbound.json();incoming=Array.isArray(payload.jetton_transfers)?payload.jetton_transfers:[]}
        }catch(e){console.warn("Jetton destination lookup unavailable",String(e).slice(0,75))}
        let timed=[];
        if(!entries.length&&!incoming.length){
          // Owner address filtering can miss a Jetton transfer. Cross-check a
          // narrow time slice without an owner filter; still filter source and
          // destination on the server. Diagnostic only.
          try{
            const broad=new URL("https://toncenter.com/api/v3/jetton/transfers");
            broad.searchParams.set("start_utime",String(Math.max(0,Math.floor(signedAt/1000)-120)));
            broad.searchParams.set("end_utime",String(Math.floor(signedAt/1000)+900));
            broad.searchParams.set("limit","1000");
            const answer=await fetch(broad,{headers,signal:AbortSignal.timeout(12000)});
            if(answer.ok){const content=await answer.json();timed=Array.isArray(content.jetton_transfers)?content.jetton_transfers:[]}
          }catch(error){console.warn("Global time-window Jetton lookup unavailable",String(error).slice(0,75))}
        }
        const observed=[...entries,...incoming,...timed];
        const matched=observed.filter(t=>
          normalize(t.source)===normalize(sender)&&
          normalize(t.destination)===normalize(w.destination_address));
        return reply({ok:true,request_id:id,matched:matched.slice(0,12).map(t=>({
          master:t.jetton_master,raw_amount:t.amount,
          tx_hash:t.transaction_hash,trace_id:t.trace_id,
          time:t.transaction_now,aborted:t.transaction_aborted
        })),scanned:observed.length,sender_scanned:entries.length,recipient_scanned:incoming.length,window_scanned:timed.length,search_window:{start,end},
          sample:entries.slice(0,5).map(t=>({source:t.source,destination:t.destination,master:t.jetton_master,amount:t.amount,aborted:t.transaction_aborted})),requested_gram:String(w.gram_amount)});
      }catch{return reply({ok:false,error:"jetton_lookup_unavailable"},503)}
    }
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
    const notifyPaidUser=async(paymentId)=>{
      const {data:claim,error:claimError}=await admin.rpc("henova_claim_verified_payout_user_notice",{p_id:paymentId});
      if(claimError||!claim?.ok)
        return {sent:false,error:claimError?"user_notice_claim_failed":"user_notice_already_sent_locked_or_not_confirmed"};
      const wallet=String(claim.destination_address||"");
      const maskedWallet=wallet.length>12?wallet.slice(0,6)+"..."+wallet.slice(-5):"Not available";
      const txHash=String(claim.tx_hash||"").toLowerCase();
      const hasHash=/^[a-f0-9]{64}$/.test(txHash);
      const message="✅ Withdrawal Paid!\n\n"+
        "Your withdrawal has been successfully sent and confirmed on TON.\n\n"+
        "💎 Amount: "+claim.gram_amount+" GRAM\n"+
        "🥚 Eggs: "+claim.eggs_amount+"\n"+
        "👛 Wallet: "+maskedWallet+"\n"+
        "⚡ Status: Confirmed on TON\n\n"+
        "Thank you for using HENOVA 🐔💚";
      const payload={chat_id:Number(claim.telegram_id),text:message,disable_web_page_preview:true};
      if(hasHash)payload.reply_markup={inline_keyboard:[[
        {text:"🔎 View transaction",url:"https://tonviewer.com/transaction/"+encodeURIComponent(txHash)}
      ]]};
      let response;
      try{
        response=await fetch("https://api.telegram.org/bot"+botToken+"/sendMessage",{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)
        });
      }catch{
        await admin.rpc("henova_finish_verified_payout_user_notice",{
          p_id:paymentId,p_message_id:null,p_error:"telegram_delivery_uncertain_check_user_chat"
        });
        return {sent:false,error:"telegram_delivery_uncertain_check_user_chat",manual_review:true};
      }
      const body=await response.json().catch(()=>null);
      if(!response.ok||!body?.ok||!body?.result?.message_id){
        const error="telegram_"+String(body?.error_code||response.status||"rejected")+"_"+String(body?.description||"").slice(0,100);
        await admin.rpc("henova_finish_verified_payout_user_notice",{
          p_id:paymentId,p_message_id:null,p_error:error
        });
        return {sent:false,error};
      }
      const messageId=body.result.message_id;
      const {error:finishError}=await admin.rpc("henova_finish_verified_payout_user_notice",{
        p_id:paymentId,p_message_id:messageId,p_error:null
      });
      return finishError
        ?{sent:true,stored:false,message_id:messageId,error:"user_notice_record_failed"}
        :{sent:true,stored:true,message_id:messageId};
    };
    const notifyVerifiedPayout=async(paymentId)=>{
      const userNotice=await notifyPaidUser(paymentId);
      const {data:claim,error:claimError}=await admin.rpc("henova_claim_verified_payout_notice",{p_id:paymentId});
      if(claimError||!claim?.ok)return {sent:false,error:claimError?"notice_claim_failed":"notice_already_sent_or_locked",user_notice:userNotice};
      // The older payout notice flow now uses the same rich format as confirmed withdrawals.
      const {data:noticeWithdrawal}=await admin.from("henova_gram_withdrawals")
        .select("telegram_id,eggs_amount,destination_address,blockchain_verified_at")
        .eq("id",claim.id).eq("status","confirmed").maybeSingle();
      let farmerLabel="HENOVA Farmer";
      if(noticeWithdrawal?.telegram_id){
        const {data:farmer}=await admin.from("henova_players")
          .select("username,first_name").eq("telegram_id",noticeWithdrawal.telegram_id).maybeSingle();
        const username=String(farmer?.username||"").trim().replace(/^@/,"");
        const firstName=String(farmer?.first_name||"").trim();
        farmerLabel=username?"@"+username:(firstName||"HENOVA Farmer");
      }
      const wallet=String(noticeWithdrawal?.destination_address||"");
      const maskedWallet=wallet.length>12?wallet.slice(0,6)+"..."+wallet.slice(-5):"Not available";
      const explorer="https://tonviewer.com/transaction/"+encodeURIComponent(String(claim.tx_hash));
      const message="✅ WITHDRAWAL PAID\n\n"+
        "👤 Farmer: "+farmerLabel+"\n"+
        "💎 Amount: "+claim.gram_amount+" GRAM\n"+
        "🥚 Eggs: "+(noticeWithdrawal?.eggs_amount??"-")+"\n"+
        "👛 Wallet: "+maskedWallet+"\n"+
        "⚡ Sent: Confirmed on TON\n"+
        "🕒 "+(noticeWithdrawal?.blockchain_verified_at?new Date(noticeWithdrawal.blockchain_verified_at).toISOString().replace("T"," ").replace(".000Z"," UTC"):"Confirmed")+"\n\n"+
        "🐔 HENOVA — hens lay eggs, eggs become GRAM.\n"+
        "Start free and withdraw when eligible 👇";
      let response;
      try{
        response=await fetch("https://api.telegram.org/bot"+botToken+"/sendMessage",{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({chat_id:"@HENOVA_WITHDRAWALS",text:message,
            disable_web_page_preview:true,
            reply_markup:{inline_keyboard:[
              [{text:"🔎 View transaction",url:explorer}],
              [{text:"🐔 Play & earn GRAM",url:"https://t.me/HenovaEggsBot/farm"}]
            ]}}),signal:AbortSignal.timeout(12000)
        });
      }catch{
        // A timed-out Telegram request MAY already have delivered the message.
        // Keep the claim locked; never blindly send the same proof twice.
        return {sent:false,error:"telegram_delivery_uncertain_check_channel",manual_review:true};
      }
      const replyBody=await response.json().catch(()=>null);
      if(!replyBody?.ok||!replyBody?.result?.message_id){
        if(replyBody?.ok===false){
          // Telegram explicitly rejected this message: safe to unlock so it
          // can be retried after fixing bot permissions/channel access.
          await admin.rpc("henova_finish_verified_payout_notice",{
            p_id:paymentId,p_message_id:null,p_success:false
          });
          return {sent:false,error:"telegram_rejected_"+String(replyBody.error_code||response.status),
            description:String(replyBody.description||"").slice(0,140)};
        }
        return {sent:false,error:"telegram_response_uncertain_check_channel",manual_review:true};
      }
      const messageId=replyBody.result.message_id;
      const {data:stored,error:storeError}=await admin.rpc("henova_finish_verified_payout_notice",{
        p_id:paymentId,p_message_id:messageId,p_success:true
      });
      if(storeError||!stored?.ok)
        return {sent:true,stored:false,message_id:messageId,error:"notice_record_failed_manual_reconcile"};
      return {sent:true,stored:true,message_id:messageId,user_notice:userNotice};
    };
    if(action==="admin_batch_publish_verified"){
      if(String(telegram.id)!=="1035565575")return reply({ok:false,error:"owner_only"},403);
      const batchId=String(body?.batchId||"");
      if(!/^[a-f0-9-]{36}$/i.test(batchId))return reply({ok:false,error:"invalid_batch"},400);
      const {data:batch}=await admin.from("henova_payout_batches").select("id,owner_id,status")
        .eq("id",batchId).eq("owner_id",Number(telegram.id)).maybeSingle();
      if(!batch||!["signed","review"].includes(batch.status))return reply({ok:false,error:"batch_not_verified"},409);
      const {data:items,error}=await admin.from("henova_payout_batch_items")
        .select("withdrawal_id").eq("batch_id",batchId).order("withdrawal_id");
      if(error||!items||items.length<2||items.length>5)return reply({ok:false,error:"batch_items_missing"},409);
      const {data:withdrawals,error:we}=await admin.from("henova_gram_withdrawals")
        .select("id,status,blockchain_verified_at,batch_sender_tx_hash,batch_outgoing_message_hash,notice_message_id,notice_claimed_at")
        .in("id",items.map(i=>i.withdrawal_id));
      if(we||!withdrawals||withdrawals.length!==items.length||
         withdrawals.some(w=>w.status!=="confirmed"||!w.blockchain_verified_at||
         !w.batch_sender_tx_hash||!w.batch_outgoing_message_hash))
        return reply({ok:false,error:"batch_not_fully_confirmed"},409);
      const results=[];
      for(const item of items){
        const w=withdrawals.find(x=>x.id===item.withdrawal_id);
        if(w.notice_message_id){results.push({id:w.id,already_published:true});continue}
        if(w.notice_claimed_at){results.push({id:w.id,error:"notice_locked_manual_review"});continue}
        results.push({id:w.id,notice:await notifyVerifiedPayout(w.id)});
      }
      return reply({ok:true,verified:true,results});
    }
    if(action==="admin_batch_audit"){
      if(String(telegram.id)!=="1035565575")return reply({ok:false,error:"owner_only"},403);
      const batchId=String(body?.batchId||"");
      let txHash=String(body?.txHash||"").toLowerCase();
      if(!/^[0-9a-f-]{36}$/.test(batchId)||(txHash&&!/^[a-f0-9]{64}$/.test(txHash)))
        return reply({ok:false,error:"invalid_batch_proof"},400);
      const {data:batch}=await admin.from("henova_payout_batches").select("id,sender,status,signed_boc_hash,created_at").eq("id",batchId).maybeSingle();
      if(!batch)return reply({ok:false,error:"batch_not_found"},404);
      const {data:items,error}=await admin.from("henova_payout_batch_items")
        .select("withdrawal_id,destination,amount_nano").eq("batch_id",batchId);
      if(error||!items||items.length<2||items.length>5)return reply({ok:false,error:"batch_items_invalid"},409);
      const raw=a=>{try{return Address.parse(a).toRawString()}catch{return null}};
      const hex=h=>{
        if(/^[a-f0-9]{64}$/i.test(String(h||"")))return String(h).toLowerCase();
        try{const b=Uint8Array.from(atob(String(h||"").replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
          return b.length===32?Array.from(b,x=>x.toString(16).padStart(2,"0")).join(""):null;}catch{return null}
      };
      const sender=raw(batch.sender);
      if(!sender)return reply({ok:false,error:"invalid_sender"},409);
      if(!txHash){
        const key=Deno.env.get("TONCENTER_API_KEY");
        const headers={Accept:"application/json"};
        if(key)headers["X-API-Key"]=key;

        if(batch.status==="signed"&&/^[a-f0-9]{64}$/.test(String(batch.signed_boc_hash||""))){
          // Preferred path: follow the exact wallet-returned signed message receipt.
          try{
            const lookup=new URL("https://toncenter.com/api/v3/transactionsByMessage");
            lookup.searchParams.set("msg_hash",batch.signed_boc_hash);
            lookup.searchParams.set("direction","in");
            lookup.searchParams.set("limit","10");
            const response=await fetch(lookup,{headers,signal:AbortSignal.timeout(12000)});
            if(!response.ok)return reply({ok:false,error:"chain_receipt_lookup_unavailable"},503);
            const data=await response.json();
            const found=(Array.isArray(data.transactions)?data.transactions:[]).filter(t=>
              raw(t.account)===sender && !t.emulated && t.description?.aborted!==true
              && t.description?.action?.success!==false && hex(t.hash));
            if(found.length!==1)return reply({ok:false,error:"source_transaction_pending_or_ambiguous",found:found.length},409);
            txHash=hex(found[0].hash);
          }catch{return reply({ok:false,error:"chain_receipt_lookup_failed"},503)}
        }else{
          // Recovery path for a real Tonkeeper payment whose local BOC receipt was lost.
          // Search only a bounded window after batch reservation and require an exact
          // five-output multiset match, so no arbitrary wallet transaction is accepted.
          try{
            const start=Math.max(0,Math.floor(Date.parse(batch.created_at)/1000)-30);
            const history=new URL("https://toncenter.com/api/v3/transactions");
            history.searchParams.set("account",batch.sender);
            history.searchParams.set("start_utime",String(start));
            history.searchParams.set("end_utime",String(start+7200));
            history.searchParams.set("limit","100");
            const response=await fetch(history,{headers,signal:AbortSignal.timeout(12000)});
            if(!response.ok)return reply({ok:false,error:"chain_history_lookup_unavailable"},503);
            const data=await response.json();
            const expected=new Map();
            const keyOf=(destination,amount)=>String(raw(destination)||"")+"|"+String(amount);
            for(const item of items){
              const k=keyOf(item.destination,item.amount_nano);
              expected.set(k,(expected.get(k)||0)+1);
            }
            const candidates=(Array.isArray(data.transactions)?data.transactions:[]).filter(t=>{
              if(raw(t.account)!==sender||t.emulated||t.description?.aborted===true
                 ||t.description?.action?.success===false||!hex(t.hash))return false;
              const outgoing=(Array.isArray(t.out_msgs)?t.out_msgs:[]).filter(m=>
                raw(m.source)===sender&&m.bounced!==true&&hex(m.hash));
              if(outgoing.length!==items.length)return false;
              const actual=new Map();
              for(const m of outgoing){
                const k=keyOf(m.destination,m.value);
                actual.set(k,(actual.get(k)||0)+1);
              }
              if(actual.size!==expected.size)return false;
              for(const [k,count] of expected)if(actual.get(k)!==count)return false;
              return true;
            });
            if(candidates.length!==1)
              return reply({ok:false,error:"source_transaction_pending_or_ambiguous",found:candidates.length,recovery_search:true},409);
            txHash=hex(candidates[0].hash);
          }catch{return reply({ok:false,error:"chain_history_lookup_failed"},503)}
        }
      }
      const u=new URL("https://toncenter.com/api/v3/transactions");
      u.searchParams.set("hash",txHash);u.searchParams.set("limit","10");
      try{
        const key=Deno.env.get("TONCENTER_API_KEY");
        const headers={Accept:"application/json"};
        if(key)headers["X-API-Key"]=key;
        const resp=await fetch(u,{headers,signal:AbortSignal.timeout(12000)});
        if(!resp.ok)return reply({ok:false,error:"chain_unavailable"},503);
        const parsed=await resp.json();
        const tx=(parsed.transactions||[]).find(t=>hex(t.hash)===txHash && raw(t.account)===sender
          && !t.emulated&&t.description?.aborted!==true&&t.description?.action?.success!==false);
        if(!tx)return reply({ok:false,error:"source_transaction_not_verified"},409);
        const matches=[];
        const used=new Set();
        // Group outputs by recipient + exact amount. This safely handles two or more
        // withdrawals that intentionally have the same destination and amount.
        const outgoing=(tx.out_msgs||[]).filter(m=>raw(m.source)===sender
          &&m.bounced!==true&&hex(m.hash));
        const groupKey=(destination,amount)=>String(raw(destination)||"")+"|"+String(amount);
        const expectedCounts=new Map();
        for(const item of items){
          const key=groupKey(item.destination,item.amount_nano);
          expectedCounts.set(key,(expectedCounts.get(key)||0)+1);
        }
        const actualGroups=new Map();
        for(const message of outgoing){
          const key=groupKey(message.destination,message.value);
          if(!actualGroups.has(key))actualGroups.set(key,[]);
          actualGroups.get(key).push(message);
        }
        // Require the exact number of outgoing messages for every recipient/amount pair.
        // This rejects missing payments and unexpected duplicate overpayments alike.
        for(const [key,count] of expectedCounts){
          if((actualGroups.get(key)||[]).length!==count)
            return reply({ok:false,error:"batch_output_missing_or_ambiguous",group:key,expected:count,found:(actualGroups.get(key)||[]).length},409);
        }
        for(const item of [...items].sort((a,b)=>a.withdrawal_id-b.withdrawal_id)){
          const key=groupKey(item.destination,item.amount_nano);
          const candidates=(actualGroups.get(key)||[])
            .filter(m=>!used.has(hex(m.hash)))
            .sort((a,b)=>String(a.created_lt||"").localeCompare(String(b.created_lt||"")));
          if(candidates.length<1)
            return reply({ok:false,error:"batch_output_missing_or_ambiguous",withdrawal_id:item.withdrawal_id},409);
          const msgHash=hex(candidates[0].hash);used.add(msgHash);
          matches.push({withdrawal_id:item.withdrawal_id,message_hash:msgHash,
            destination:item.destination,amount_nano:String(item.amount_nano)});
        }
        // Match each outgoing message against the recipient's incoming message and credited amount.
        // Inspect every recipient independently. Never settle a payout from sender outputs alone.
        const checks=[];
        for(const match of matches){
          const lookup=new URL("https://toncenter.com/api/v3/transactionsByMessage");
          lookup.searchParams.set("msg_hash",match.message_hash);
          lookup.searchParams.set("direction","in");lookup.searchParams.set("limit","10");
          // TONCenter free tier is rate limited. Five recipient lookups in a tight
          // loop produce HTTP 429; pace and retry without weakening chain checks.
          if(!Deno.env.get("TONCENTER_API_KEY"))await new Promise(resolve=>setTimeout(resolve,1450));
          let receiverResponse;
          for(let attempt=0;attempt<3;attempt++){
            try{receiverResponse=await fetch(lookup,{headers,signal:AbortSignal.timeout(12000)})}
            catch{return reply({ok:false,error:"recipient_lookup_network_error",withdrawal_id:match.withdrawal_id},503)}
            if(receiverResponse.status!==429)break;
            if(attempt<2)await new Promise(resolve=>setTimeout(resolve,1600*(attempt+2)));
          }
          if(!receiverResponse?.ok)return reply({ok:false,error:"recipient_lookup_unavailable",
            withdrawal_id:match.withdrawal_id,status:receiverResponse?.status||0},503);
          const receiverJson=await receiverResponse.json();
          const rows=Array.isArray(receiverJson.transactions)?receiverJson.transactions:[];
          const credited=rows.filter(t=>!t.emulated&&raw(t.account)===raw(match.destination)
            &&raw(t.in_msg?.source)===sender
            &&raw(t.in_msg?.destination||t.account)===raw(match.destination)
            &&hex(t.in_msg?.hash)===match.message_hash
            &&t.in_msg?.bounced!==true
            &&String(t.in_msg?.value)===match.amount_nano
            &&String(t.description?.credit_ph?.credit??"")===match.amount_nano);
          checks.push({...match,recipient_credit_verified:credited.length===1,
            recipient_transaction_hash:credited.length===1?hex(credited[0].hash):null});
        }
        const allCredited=checks.every(x=>x.recipient_credit_verified);
        // Only server-observed recipient credits can reach the proof ledger.
        // This recovery RPC also supports a reserved batch when Tonkeeper sent the
        // transaction but the browser lost the local signed BOC receipt.
        let evidence={saved:false,reason:allCredited?"batch_not_recoverable":"recipient_credit_pending"};
        if(allCredited && ["signed","reserved","review"].includes(batch.status)){
          const {data:recovered,error:recoverError}=await admin.rpc("henova_recover_verified_batch_payouts",{
            p_batch_id:batchId,p_source_hash:txHash,
            p_items:checks.map(x=>({withdrawal_id:x.withdrawal_id,
              message_hash:x.message_hash,recipient_credit_verified:true}))
          });
          evidence=recoverError?{saved:false,reason:"proof_storage_unavailable"}:
            {saved:recovered?.ok===true,result:recovered,
             finalization:recovered?.ok===true?{ok:true,...recovered}:{ok:false,error:recovered?.error||"settlement_unavailable"}};
          if(recovered?.ok===true){
            evidence.notices=[];
            for(const payout of checks){
              const notice=await notifyVerifiedPayout(payout.withdrawal_id);
              evidence.notices.push({withdrawal_id:payout.withdrawal_id,notice});
            }
          }
        }
        return reply({ok:true,read_only:!evidence.saved,
          source_transaction_verified:true,recipient_credits_verified:allCredited,
          signing_enabled:false,tx_hash:txHash,outputs:checks,evidence,
          message:"Every recipient checked against TON. No withdrawal status was finalized; batch signing remains locked."});
      }catch{return reply({ok:false,error:"chain_lookup_unavailable"},503)}
    }
        if(action==="admin_repost_selected_proofs"){
      // Administration-only: republish proof messages, NEVER repeat a payout.
      const results=[];
      for(const id of [14,15,16]){
        const {data:claimed,error:claimError}=await admin.rpc("henova_claim_proof_repost",{p_id:id});
        if(claimError){results.push({id,error:"claim_failed"});continue;}
        if(!claimed){results.push({id,status:"already_reposted_or_ineligible"});continue;}
        const {data:wd,error:readError}=await admin.from("henova_gram_withdrawals")
          .select("id,telegram_id,eggs_amount,gram_amount,destination_address,payout_tx_hash,blockchain_verified_at,status")
          .eq("id",id).eq("status","confirmed").single();
        if(readError||!wd){results.push({id,error:"confirmed_record_unavailable"});continue;}
        const {data:farmer}=await admin.from("henova_players")
          .select("username,first_name").eq("telegram_id",wd.telegram_id).maybeSingle();
        const username=String(farmer?.username||"").trim().replace(/^@/,"");
        const firstName=String(farmer?.first_name||"").trim();
        const farmerLabel=username?"@"+username:(firstName||"HENOVA Farmer");
        const hash=String(wd.payout_tx_hash||"");
        const wallet=String(wd.destination_address||"");
        if(!/^[a-f0-9]{64}$/i.test(hash)){results.push({id,error:"invalid_hash"});continue;}
        const explorer="https://tonviewer.com/transaction/"+encodeURIComponent(hash);
        const msg="✅ WITHDRAWAL PAID"+
          "\n\n👤 Farmer: "+farmerLabel+
          "\n💎 Amount: "+wd.gram_amount+" GRAM"+
          "\n🥚 Eggs: "+wd.eggs_amount+
          "\n👛 Wallet: "+wallet.slice(0,6)+"..."+wallet.slice(-5)+
          "\n⚡ Network: TON"+
          "\n🕒 "+new Date(wd.blockchain_verified_at).toISOString().replace("T"," ").replace(".000Z"," UTC")+
          "\n\n🐔 HENOVA Chicken Farm";
        try{
          const response=await fetch("https://api.telegram.org/bot"+botToken+"/sendMessage",{
            method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({chat_id:"@HENOVA_WITHDRAWALS",text:msg,
              reply_markup:{inline_keyboard:[
                [{text:"🔎 View transaction",url:explorer}],
                [{text:"🐔 Play & earn GRAM",url:"https://t.me/HenovaEggsBot/farm"}]
              ]}}),signal:AbortSignal.timeout(12000)
          });
          const payload=await response.json().catch(()=>null);
          if(response.ok&&payload?.ok&&payload.result?.message_id){
            await admin.from("henova_proof_reposts").update({telegram_message_id:payload.result.message_id})
              .eq("withdrawal_id",id);
            results.push({id,status:"posted",message_id:payload.result.message_id});
          } else {
            results.push({id,error:"telegram_not_confirmed"});
          }
        }catch{
          results.push({id,error:"telegram_delivery_uncertain"});
        }
      }
      return reply({ok:true,results});
    }
        if(action==="admin_post_payout_notice"){
      const id=Number(body?.withdrawalId);
      if(!Number.isSafeInteger(id)||id<=0)return reply({ok:false,error:"invalid_request"},400);
      return reply({ok:true,notice:await notifyVerifiedPayout(id)});
    }
    if(action==="admin_verify_payout" || action==="admin_track_signed_payout"){
      // Read authoritative ledger evidence on demand; no client-provided match booleans.
      const id=Number(body?.withdrawalId);
      // TONCenter v3 returns transaction/message hashes in base64 in many responses.
      // Normalize to canonical 64-character hex before correlating or saving proof.
      const hexHash=(value)=>{
        const h=String(value||"").trim();
        if(/^[0-9a-fA-F]{64}$/.test(h))return h.toLowerCase();
        try{
          const b=Uint8Array.from(atob(h.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
          return b.length===32?Array.from(b,x=>x.toString(16).padStart(2,"0")).join(""):null;
        }catch{return null;}
      };
      // TonCenter v3 free access is rate-limited (1 request / second).
      // Throttle lookups and retry HTTP 429 without weakening the proof checks.
      let lastTonCallAt=0;
      const fetchTon=async(url)=>{
        const key=Deno.env.get("TONCENTER_API_KEY");
        const headers={Accept:"application/json"};
        if(key)headers["X-API-Key"]=key;
        let response;
        for(let attempt=0;attempt<3;attempt++){
          if(!key && lastTonCallAt){
            const delay=1450-(Date.now()-lastTonCallAt);
            if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
          }
          lastTonCallAt=Date.now();
          response=await fetch(url,{headers,signal:AbortSignal.timeout(12000)});
          if(response.status!==429||attempt===2)return response;
          await new Promise(resolve=>setTimeout(resolve,1400*(attempt+1)));
        }
        return response;
      };
      let claimedHash=hexHash(body?.txHash)||"";
      if(!Number.isSafeInteger(id)||id<=0||(action==="admin_verify_payout"&&!/^[a-f0-9]{64}$/.test(claimedHash)))
        return reply({ok:false,error:"invalid_request"},400);
      const {data:req,error:reqError}=await admin.from("henova_gram_withdrawals")
        .select("id,status,created_at,signing_claimed_at,destination_address,gram_amount,payout_sender_address,payout_tx_hash,signed_boc_hash")
        .eq("id",id).maybeSingle();
      if(reqError)return reply({ok:false,error:"database_unavailable"},503);
      if(!req)return reply({ok:false,error:"not_found"},404);
      if(action==="admin_track_signed_payout"){
        if(req.status!=="broadcast" || !/^[a-f0-9]{64}$/.test(String(req.signed_boc_hash||"")))
          return reply({ok:false,error:"signed_payment_not_recorded"},409);
        try{
          const searchUrl=new URL("https://toncenter.com/api/v3/transactionsByMessage");
          searchUrl.searchParams.set("msg_hash",req.signed_boc_hash);
          searchUrl.searchParams.set("direction","in");
          searchUrl.searchParams.set("limit","10");
          const resp=await fetchTon(searchUrl);
          if(!resp.ok)return reply({ok:false,error:"chain_provider_unavailable"},503);
          const json=await resp.json();
          const transactions=Array.isArray(json?.transactions)?json.transactions:[];
          const found=transactions.filter(tx=>!tx?.emulated && tx?.description?.aborted!==true
            && typeof tx?.hash==="string" && hexHash(tx.hash));
          if(found.length!==1)return reply({ok:false,error:"transaction_not_final_or_ambiguous"},409);
          claimedHash=hexHash(found[0].hash)||"";
        }catch{return reply({ok:false,error:"chain_lookup_unavailable"},503);}
      }
      if(req.status==="confirmed"){
        if(req.payout_tx_hash!==claimedHash)return reply({ok:false,error:"confirmed_with_different_hash"},409);
        // Retry channel publication on an already-settled request without
        // signing or paying a second time. Notice RPC enforces single claim.
        const notice=await notifyVerifiedPayout(id);
        return reply({ok:true,confirmed:true,already_confirmed:true,notice});
      }
      if(!["approved","broadcast"].includes(req.status))
        return reply({ok:false,error:"not_approved"},409);
      const treasury=String(settings.data.payout_wallet_address||"");
      const raw=(value)=>{
        try{return Address.parse(String(value||"")).toRawString().toLowerCase();}
        catch{return null;}
      };
      const senderRaw=raw(treasury),destinationRaw=raw(req.destination_address);
      if(!senderRaw||!destinationRaw||senderRaw===destinationRaw||
        (req.payout_sender_address && raw(req.payout_sender_address)!==senderRaw))
        return reply({ok:false,error:"wallet_mismatch"},409);
      const amount=String(req.gram_amount);
      if(!/^[0-9]+(?:[.][0-9]+)?$/.test(amount) || (amount.split(".")[1]||"").slice(9).replace(/0/g,"")!=="")return reply({ok:false,error:"amount_invalid"},409);
      const [whole,fraction=""]=amount.split(".");
      const nano=(BigInt(whole)*1000000000n+BigInt((fraction+"000000000").slice(0,9))).toString();
      try{
        const url=new URL("https://toncenter.com/api/v3/transactions");
        url.searchParams.set("hash",claimedHash);
        url.searchParams.set("limit","10");
        const response=await fetchTon(url);
        if(!response.ok)return reply({ok:false,error:"chain_provider_unavailable"},503);
        const json=await response.json();
        let rows=Array.isArray(json?.transactions)?json.transactions:[];
        // A Tonviewer link can identify a trace/event rather than the treasury
        // transaction. Resolve candidate hashes, but use TONCenter transaction
        // and recipient-message checks below as the only settlement authority.
        if(!rows.some(t=>hexHash(t?.hash)===claimedHash && raw(t?.account)===senderRaw && t?.description?.aborted!==true)){
          try{
            const traceResp=await fetch("https://tonapi.io/v2/traces/"+encodeURIComponent(claimedHash),
              {headers:{Accept:"application/json"},signal:AbortSignal.timeout(9000)});
            if(traceResp.ok){
              const trace=await traceResp.json();
              const hashes=[];
              const visit=(node,depth)=>{
                if(depth>24||hashes.length>=40||!node||typeof node!=="object")return;
                const t=node.transaction;
                if(t?.hash && raw(t?.account?.address||t?.account)===senderRaw){
                  const h=hexHash(t.hash);
                  if(h&&!hashes.includes(h))hashes.push(h);
                }
                if(Array.isArray(node.children))for(const child of node.children)visit(child,depth+1);
              };
              visit(trace,0);
              for(const candidateHash of hashes.slice(0,6)){
                const candidateUrl=new URL("https://toncenter.com/api/v3/transactions");
                candidateUrl.searchParams.set("hash",candidateHash);
                candidateUrl.searchParams.set("limit","10");
                const candidateResp=await fetchTon(candidateUrl);
                if(!candidateResp.ok)continue;
                const candidateJson=await candidateResp.json();
                const verifiedRows=Array.isArray(candidateJson?.transactions)?candidateJson.transactions:[];
                if(verifiedRows.some(t=>hexHash(t?.hash)===candidateHash&&raw(t?.account)===senderRaw)){
                  rows=verifiedRows;
                  claimedHash=candidateHash;
                  break;
                }
              }
            }
          }catch(error){console.warn("Trace hash resolution unavailable",String(error).slice(0,70))}
        }
        // A destination-side transaction hash may have been copied from Tonkeeper.
        // Resolve its incoming message to the source-side transaction, then apply
        // exactly the same source/outgoing-message/recipient-credit verification.
        if(!rows.some(t=>hexHash(t?.hash)===claimedHash && raw(t?.account)===senderRaw && t?.description?.aborted!==true)){
          const destinationTx=rows.find(t=>hexHash(t?.hash)===claimedHash && raw(t?.account)===destinationRaw);
          const incomingHash=destinationTx?.in_msg?.hash;
          if(incomingHash && raw(destinationTx?.in_msg?.source)===senderRaw){
            const fromUrl=new URL("https://toncenter.com/api/v3/transactionsByMessage");
            fromUrl.searchParams.set("msg_hash",incomingHash);
            fromUrl.searchParams.set("direction","out");
            fromUrl.searchParams.set("limit","10");
            const fromResp=await fetchTon(fromUrl);
            if(fromResp.ok){
              const fromJson=await fromResp.json();
              const sourceTxs=(Array.isArray(fromJson?.transactions)?fromJson.transactions:[]).filter(t=>
                raw(t?.account)===senderRaw && t?.description?.aborted!==true &&
                t?.description?.action?.success!==false);
              if(sourceTxs.length===1 && hexHash(sourceTxs[0]?.hash)){
                claimedHash=hexHash(sourceTxs[0].hash);
                rows=sourceTxs;
              }
            }
          }
        }
        const tx=rows.find(t=>hexHash(t?.hash)===claimedHash &&
          raw(t?.account)===senderRaw && !t?.emulated && t?.description?.aborted!==true &&
          t?.description?.action?.success!==false &&
          Number(t?.now)>=Math.floor(Date.parse(req.created_at)/1000) &&
          (!req.signing_claimed_at || Number(t?.now)>=Math.floor(Date.parse(req.signing_claimed_at)/1000)-15));
        if(!tx){
          // Diagnostic only: never confirm a transaction based on this result.
          const candidate=rows.find(t=>hexHash(t?.hash)===claimedHash);
          const diagnostics=!candidate?"hash_not_found":{
            account_match:raw(candidate?.account)===senderRaw,
            emulated:candidate?.emulated===true,
            aborted:candidate?.description?.aborted===true,
            action_success: candidate?.description?.action?.success??null,
            after_request:Number(candidate?.now)>=Math.floor(Date.parse(req.created_at)/1000),
            after_signing:!req.signing_claimed_at||Number(candidate?.now)>=Math.floor(Date.parse(req.signing_claimed_at)/1000)-15
          };
          return reply({ok:false,error:"sender_transaction_unverified",diagnostics},409);
        }
        const matches=(Array.isArray(tx.out_msgs)?tx.out_msgs:[]).filter(x=>
          x?.bounced!==true && raw(x?.source)===senderRaw &&
          raw(x?.destination)===destinationRaw && String(x?.value)===nano &&
          typeof x?.hash==="string" && x.hash.length>0);
        if(matches.length!==1)return reply({ok:false,error:"recipient_message_unverified"},409);
        // Follow the one verified outgoing message to its actual recipient transaction.
        // Never scan a wallet's broad history or infer credit from the send alone.
        const recipientUrl=new URL("https://toncenter.com/api/v3/transactionsByMessage");
        recipientUrl.searchParams.set("msg_hash",matches[0].hash);
        recipientUrl.searchParams.set("direction","in");
        recipientUrl.searchParams.set("limit","10");
        const recipientResponse=await fetchTon(recipientUrl);
        if(!recipientResponse.ok)return reply({ok:false,error:"recipient_chain_unavailable",
          chain_http_status:recipientResponse.status},503);
        const recipientJson=await recipientResponse.json();
        if(!Array.isArray(recipientJson?.transactions))
          return reply({ok:false,error:"recipient_chain_invalid_response"},503);
        const validRecipient=(t)=>
          !t?.emulated && raw(t?.account)===destinationRaw &&
          // A recipient may remain uninitialized after an actual TON credit.
          // Verify the exact credited nano amount instead of contract execution.
          String(t?.description?.credit_ph?.credit??"")===nano &&
          t?.in_msg?.bounced!==true && raw(t?.in_msg?.source)===senderRaw &&
          raw(t?.in_msg?.destination||t?.account)===destinationRaw &&
          String(t?.in_msg?.value)===nano &&
          hexHash(t?.in_msg?.hash)===hexHash(matches[0].hash);
        let credited=recipientJson.transactions.some(validRecipient);
        if(!credited){
          // Indexer message lookup can lag or omit the recipient entry.
          // Independent destination-account lookup; still require the exact
          // sender's outgoing message hash, value and both account addresses.
          const fallbackUrl=new URL("https://toncenter.com/api/v3/transactions");
          fallbackUrl.searchParams.set("account",req.destination_address);
          fallbackUrl.searchParams.set("start_utime",String(Math.max(0,Number(tx.now)-120)));
          fallbackUrl.searchParams.set("end_utime",String(Number(tx.now)+3600));
          fallbackUrl.searchParams.set("limit","100");
          const fallbackResp=await fetchTon(fallbackUrl);
          if(fallbackResp.ok){
            const fallbackJson=await fallbackResp.json();
            if(Array.isArray(fallbackJson?.transactions))
              credited=fallbackJson.transactions.some(validRecipient);
          }
        }
        if(!credited){
          // Detailed, read-only diagnostics; do not claim settlement.
          const incoming=recipientJson.transactions.slice(0,6).map(t=>({
            account_match:raw(t?.account)===destinationRaw,
            source_match:raw(t?.in_msg?.source)===senderRaw,
            destination_match:raw(t?.in_msg?.destination||t?.account)===destinationRaw,
            amount_match:String(t?.in_msg?.value)===nano,
            message_match:hexHash(t?.in_msg?.hash)===hexHash(matches[0].hash),
            bounced:t?.in_msg?.bounced===true,aborted:t?.description?.aborted===true,
            action_success:t?.description?.action?.success??null
          }));
          return reply({ok:false,error:"recipient_credit_not_verified",
            checked:"message_lookup_and_destination_account",
            candidate_count:recipientJson.transactions.length,
            recipient_checks:incoming},409);
        }
        const {data:done,error:commitError}=await admin.rpc("henova_finalize_verified_gram_payout",{
          p_withdrawal_id:id,p_tx_hash:claimedHash,p_sender:treasury,
          p_destination:req.destination_address,p_amount_nano:nano,p_tx_lt:String(tx.lt)
        });
        if(commitError)return reply({ok:false,error:"settlement_commit_unavailable"},503);
        if(done?.ok && done?.confirmed){
          const notice=await notifyVerifiedPayout(id);
          return reply({...done,notice});
        }
        return reply(done,done?.ok?200:409);
      }catch(error){
        console.warn("HENOVA chain settlement check",String(error).slice(0,110));
        return reply({ok:false,error:"chain_verification_unavailable"},503);
      }
    }
    if(action==="admin_match_payout"){
      // Diagnostic only; an address/amount/time match is NOT definitive settlement proof.
      // Do not transition to confirmed, and never reuse an observed transaction as payment evidence.
      const id=Number(body?.withdrawalId);
      if(!Number.isSafeInteger(id)||id<=0)return reply({ok:false,error:"invalid_request"},400);
      const r=await admin.from("henova_gram_withdrawals")
        .select("id,destination_address,gram_amount,created_at,signing_claimed_at,status,payout_tx_hash")
        .eq("id",id).maybeSingle();
      if(r.error)return reply({ok:false,error:"database_unavailable"},503);
      if(!r.data)return reply({ok:false,error:"not_found"},404);
      const req=r.data;
      const treasury=String(settings.data.payout_wallet_address||"");
      const rawAddress=(address)=>{
        const a=String(address||"");
        if(/^-?[0-9]+:[a-fA-F0-9]{64}$/.test(a))return a.toLowerCase();
        if(!/^(EQ|UQ)[a-zA-Z0-9_-]{46}$/.test(a))return null;
        try{
          const bytes=Uint8Array.from(atob(a.replace(/-/g,"+").replace(/_/g,"/")),x=>x.charCodeAt(0));
          if(bytes.length!==36)return null;
          const wc=bytes[1]>127?bytes[1]-256:bytes[1];
          return wc+":"+Array.from(bytes.slice(2,34),x=>x.toString(16).padStart(2,"0")).join("");
        }catch{return null;}
      };
      const target=rawAddress(req.destination_address);
      if(!target||!rawAddress(treasury))return reply({ok:false,error:"wallet_address_invalid"},409);
      const decimal=String(req.gram_amount);
      if(!/^[0-9]+(?:[.][0-9]+)?$/.test(decimal) ||
         (decimal.split(".")[1]||"").slice(9).replace(/0/g,"")!=="")
        return reply({ok:false,error:"invalid_amount"},409);
      const [units,frac=""]=decimal.split(".");
      const nano=(BigInt(units)*1000000000n+BigInt((frac+"000000000").slice(0,9))).toString();
      const createdAt=Math.floor(Date.parse(req.created_at)/1000);
      if(!Number.isFinite(createdAt))return reply({ok:false,error:"invalid_created_at"},409);
      try{
        const url=new URL("https://toncenter.com/api/v3/transactions");
        url.searchParams.set("account",treasury);
        url.searchParams.set("limit","100");
        url.searchParams.set("sort","desc");
        url.searchParams.set("start_utime",String(Math.max(0,createdAt-60)));
        const headers={Accept:"application/json"};
        const key=Deno.env.get("TONCENTER_API_KEY");
        if(key)headers["X-API-Key"]=key;
        const response=await fetch(url,{headers,signal:AbortSignal.timeout(12000)});
        if(!response.ok)return reply({ok:false,error:"chain_provider_unavailable"},503);
        const data=await response.json();
        if(!Array.isArray(data?.transactions))return reply({ok:false,error:"chain_response_invalid"},503);
        const matches=[];
        for(const tx of data.transactions){
          if(tx?.emulated||tx?.description?.aborted===true||Number(tx?.now)<createdAt || (req.signing_claimed_at && Number(tx?.now)<Math.floor(Date.parse(req.signing_claimed_at)/1000)-15))continue;
          for(const msg of Array.isArray(tx?.out_msgs)?tx.out_msgs:[]){
            if(msg?.bounced===true||rawAddress(msg?.destination)!==target||String(msg?.value)!==nano)continue;
            matches.push({hash:String(tx.hash||""),lt:String(tx.lt||""),timestamp:Number(tx.now),message_hash:String(msg.hash||"")});
          }
        }
        return reply({ok:true,request_id:id,expected_nano:nano,matching_transactions:matches.slice(0,10),
          inspected_count:data.transactions.length,scan_limit:100,complete_history:false,
          payment_verified:false,mode:"read_only",
          note:"Candidate matches only; check full trace, recipient transaction, finality and unique payment correlation before confirming."});
      }catch{return reply({ok:false,error:"chain_provider_unavailable"},503);}
    }
    // Non-financial admin workflow test. The production payout and player balances are untouched.
    if(action==="admin_test_submit"){
      const amount=Number(body?.eggs);
      const requestId=String(body?.requestId||"");
      if(!Number.isSafeInteger(amount)||amount<500||amount>10000 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))
        return reply({ok:false,error:"invalid_test_request"},400);
      const wallet=await admin.from("henova_ton_wallets").select("wallet_address")
        .eq("telegram_id",telegram.id).maybeSingle();
      if(wallet.error)return reply({ok:false,error:"database_unavailable"},503);
      if(!wallet.data?.wallet_address)return reply({ok:false,error:"save_wallet_first"},409);
      const {data,error}=await admin.from("henova_payout_dry_runs").upsert({
        telegram_id:telegram.id,request_id:requestId,eggs_amount:amount,
        gram_amount:Number((amount/10000).toFixed(9)),destination_address:wallet.data.wallet_address
      },{onConflict:"request_id",ignoreDuplicates:true})
      .select("id,status,eggs_amount,gram_amount").maybeSingle();
      if(error)return reply({ok:false,error:"test_submission_failed"},503);
      return reply({ok:true,test_only:true,item:data||null,no_balance_deduction:true});
    }
    if(action==="admin_test_intent"){
      if(String(telegram.id)!=="1035565575")return reply({ok:false,error:"owner_only"},403);
      const testId=Number(body?.testId);
      if(testId!==3)return reply({ok:false,error:"test_not_authorized"},403);
      const {data:test,error}=await admin.from("henova_payout_dry_runs")
        .select("id,telegram_id,status,destination_address,gram_amount")
        .eq("id",testId).eq("telegram_id",telegram.id).maybeSingle();
      if(error||!test)return reply({ok:false,error:"test_missing"},404);
      if(test.status!=="approved")return reply({ok:false,error:"approve_test_first"},409);
      const {data:existingProof,error:proofError}=await admin.schema("henova_private").from("payout_proof_claims")
        .select("tx_hash").eq("test_id",testId).limit(1).maybeSingle();
      if(proofError)return reply({ok:false,error:"test_proof_check_unavailable"},503);
      if(existingProof)return reply({ok:false,error:"test_already_transferred_do_not_sign_again"},409);
      const sender=String(settings.data.payout_wallet_address||"");
      const toRaw=(address)=>{
        try{
          const a=Uint8Array.from(atob(String(address).replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
          if(a.length!==36)return null;
          return (a[1]>127?a[1]-256:a[1])+":"+Array.from(a.slice(2,34),b=>b.toString(16).padStart(2,"0")).join("");
        }catch{return null;}
      };
      if(!toRaw(sender)||!toRaw(test.destination_address)||toRaw(sender)===toRaw(test.destination_address))
        return reply({ok:false,error:"invalid_test_wallets"},409);
      if(Number(test.gram_amount)!==0.05)return reply({ok:false,error:"unexpected_test_amount"},409);
      return reply({ok:true,test_only:true,intent:{
        id:test.id,sender,destination:test.destination_address,
        amountNanograms:"50000000",amountGram:"0.05",network:"-239"
      },requires_manual_tonkeeper_signature:true,not_chain_confirmed:true});
    }
    if(action==="admin_test_queue"){
      const {data,error}=await admin.from("henova_payout_dry_runs")
        .select("id,telegram_id,eggs_amount,gram_amount,destination_address,status,created_at")
        .eq("telegram_id",telegram.id).order("id",{ascending:false}).limit(10);
      if(error)return reply({ok:false,error:"database_unavailable"},503);
      return reply({ok:true,test_only:true,items:data||[]});
    }
    if(action==="admin_test_approve"){
      const id=Number(body?.withdrawalId);
      if(!Number.isSafeInteger(id)||id<1)return reply({ok:false,error:"invalid_request"},400);
      const {data,error}=await admin.from("henova_payout_dry_runs")
        .update({status:"approved",updated_at:new Date().toISOString()})
        .eq("id",id).eq("telegram_id",telegram.id).eq("status","pending")
        .select("id,status").maybeSingle();
      if(error)return reply({ok:false,error:"database_unavailable"},503);
      if(!data)return reply({ok:false,error:"already_approved_or_not_found"},409);
      return reply({ok:true,test_only:true,item:data,payment_sent:false});
    }
    if(action==="admin_verify_test_transfer"){
      // Mainnet lookup for the previously signed TEST transfer: read-only, no payment status mutation.
      const testId=Number(body?.testId);
      const inputHash=String(body?.txHash||"").trim();
      if(!Number.isSafeInteger(testId)||testId<1||!/^[a-fA-F0-9]{64}$/.test(inputHash))
        return reply({ok:false,error:"invalid_test_or_hash"},400);
      const {data:test,error:testError}=await admin.from("henova_payout_dry_runs")
        .select("id,telegram_id,destination_address,gram_amount,status,created_at")
        .eq("id",testId).eq("telegram_id",telegram.id).maybeSingle();
      if(testError)return reply({ok:false,error:"database_unavailable"},503);
      if(!test||test.status!=="approved")return reply({ok:false,error:"test_not_approved"},409);
      const normalized=(a)=>{
        if(/^-?\d+:[0-9a-fA-F]{64}$/.test(String(a)))return String(a).toLowerCase();
        try{
          const b=Uint8Array.from(atob(String(a).replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
          if(b.length!==36)return null;
          const wc=b[1]>127?b[1]-256:b[1];
          return wc+":"+Array.from(b.slice(2,34),v=>v.toString(16).padStart(2,"0")).join("");
        }catch{return null;}
      };
      const expectedSender=normalized(settings.data.payout_wallet_address);
      const expectedRecipient=normalized(test.destination_address);
      if(!expectedSender||!expectedRecipient||expectedSender===expectedRecipient)
        return reply({ok:false,error:"invalid_test_wallets"},409);
      const amountText=String(test.gram_amount);
      if(!/^\d+(?:\.\d+)?$/.test(amountText))return reply({ok:false,error:"invalid_test_amount"},409);
      const [whole,fract=""]=amountText.split(".");
      if(fract.length>9 && /[1-9]/.test(fract.slice(9)))return reply({ok:false,error:"fractional_nanogram_not_supported"},409);
      const expectedNano=(BigInt(whole)*1000000000n+BigInt((fract+"000000000").slice(0,9))).toString();
      try{
        const url=new URL("https://toncenter.com/api/v3/transactions");
        url.searchParams.set("hash",inputHash);
        url.searchParams.set("limit","10");
        const headers={Accept:"application/json"};
        const key=Deno.env.get("TONCENTER_API_KEY");
        if(key)headers["X-API-Key"]=key;
        const resp=await fetch(url,{headers,signal:AbortSignal.timeout(10000)});
        if(!resp.ok)return reply({ok:false,error:"chain_provider_unavailable",http_status:resp.status},503);
        const payload=await resp.json();
        if(!Array.isArray(payload?.transactions))return reply({ok:false,error:"invalid_chain_response"},503);
        const hexToBase64=(v)=>btoa(String.fromCharCode(...(String(v).match(/../g)||[]).map(x=>parseInt(x,16))));
        const equalsHash=(value)=>String(value||"").replace(/=+$/,"")===inputHash ||
          String(value||"").replace(/=+$/,"")===hexToBase64(inputHash).replace(/=+$/,"");
        const tx=payload.transactions.find(t=>equalsHash(t?.hash));
        if(!tx)return reply({ok:true,found:false,verified:false,reason:"tx_not_indexed_or_hash_mismatch",test_only:true});
        const outgoing=Array.isArray(tx.out_msgs)?tx.out_msgs:[];
        const incoming=tx.in_msg;
        // A transaction hash can identify the recipient-side transaction: its value
        // is in in_msg, not necessarily in the sender's out_msgs.
        const incomingMatch=!!incoming &&
          normalized(incoming.source)===expectedSender &&
          normalized(incoming.destination||tx.account)===expectedRecipient &&
          String(incoming.value)===expectedNano && incoming.bounced!==true;
        const matching=outgoing.filter(m=>
          normalized(m?.source||tx.account)===expectedSender &&
          normalized(m?.destination)===expectedRecipient &&
          String(m?.value)===expectedNano && m?.bounced!==true);
        const paymentMatch=incomingMatch||matching.length===1;
        const txSuccess=tx.emulated!==true && tx.description?.aborted===false &&
          tx.description?.compute_ph?.success===true && tx.description?.action?.success===true;
        // Record a candidate test proof only after matching an observed successful
        // transfer. This is NOT final settlement and does not change payout status.
        let claim=null;
        if(paymentMatch && txSuccess){
          const c=await admin.rpc("henova_claim_test_payment_hash",{p_test_id:testId,p_hash:inputHash});
          if(c.error)return reply({ok:false,error:"proof_claim_unavailable"},503);
          claim=c.data;
        }
        // Follow the outgoing transfer into the recipient account transaction.
        // An executed sender action by itself is insufficient to establish credit.
        let recipientCredited=false;
        let recipientTxHash=null;
        if(paymentMatch && txSuccess){
          if(incomingMatch && normalized(tx.account)===expectedRecipient &&
             tx.description?.aborted===false &&
             String(tx.description?.credit_ph?.credit||"")===expectedNano){
            recipientCredited=true;recipientTxHash=inputHash;
          }else if(matching.length===1 && /^[0-9a-fA-F]{64}$/.test(String(matching[0].hash||""))){
            try{
              const follow=new URL("https://toncenter.com/api/v3/transactionsByMessage");
              follow.searchParams.set("msg_hash",matching[0].hash);
              follow.searchParams.set("direction","in");
              follow.searchParams.set("limit","10");
              const followResp=await fetch(follow,{headers,signal:AbortSignal.timeout(9000)});
              if(followResp.ok){
                const followData=await followResp.json();
                const rec=(followData.transactions||[]).find(r=>
                  r.emulated!==true && normalized(r.account)===expectedRecipient &&
                  normalized(r.in_msg?.source)===expectedSender &&
                  normalized(r.in_msg?.destination||r.account)===expectedRecipient &&
                  String(r.in_msg?.value)===expectedNano && r.in_msg?.bounced!==true &&
                  r.description?.aborted===false &&
                  String(r.description?.credit_ph?.credit||"")===expectedNano);
                if(rec){recipientCredited=true;recipientTxHash=String(rec.hash||"");}
              }
            }catch{}
          }
        }
        return reply({ok:true,found:true,verified:recipientCredited,test_only:true,recipient_credited:recipientCredited,recipient_tx_hash:recipientTxHash,proof_claim:claim,
          sender_matches:normalized(tx.account)===expectedSender || incomingMatch || matching.length===1,
          recipient_and_amount_matches:paymentMatch,transaction_success:txSuccess,
          hash:inputHash,matched_messages:matching.length+(incomingMatch?1:0),diagnostics:{tx_account:String(tx.account||""),expected_sender:expectedSender,expected_recipient:expectedRecipient,expected_nano:expectedNano,outbound:outgoing.slice(0,5).map(m=>({source:String(m.source||""),destination:String(m.destination||""),value:String(m.value||""),bounced:m.bounced===true}))},
          note:"Read-only audit; recipient-side settlement and unique payment correlation not established. No Paid status assigned."});
      }catch{return reply({ok:false,error:"chain_provider_unavailable"},503);}
    }
    if(action==="admin_find_withdrawal"){
      if(String(telegram.id)!=="1035565575")return reply({ok:false,error:"owner_only"},403);
      const requestId=Number(body?.withdrawalId);
      if(!Number.isSafeInteger(requestId)||requestId<=0)return reply({ok:false,error:"invalid_withdrawal_id"},400);
      const {data:request,error}=await admin.from("henova_gram_withdrawals")
        .select("id,telegram_id,eggs_amount,gram_amount,status,created_at,approved_at,blockchain_verified_at,notice_message_id,destination_address,signing_claimed_at,signed_boc_hash,payout_tx_hash,batch_sender_tx_hash")
        .eq("id",requestId).maybeSingle();
      if(error)return reply({ok:false,error:"lookup_unavailable"},503);
      return reply({ok:true,request:request||null});
    }
    if(action==="admin_payout_queue"){
      const fields="id,telegram_id,destination_address,eggs_amount,gram_amount,status,created_at,payout_tx_hash,signing_claimed_at,signed_boc_hash,notice_message_id,notice_claimed_at";
      const [active,confirmed]=await Promise.all([
        admin.from("henova_gram_withdrawals").select(fields)
          .in("status",["pending","approved","broadcast"]).order("id",{ascending:true}).limit(50),
        admin.from("henova_gram_withdrawals").select(fields)
          .eq("status","confirmed").order("id",{ascending:false}).limit(10)
      ]);
      if(active.error||confirmed.error)return reply({ok:false,error:"database_unavailable"},503);
      // Automatically publish the proof for one already-confirmed payout when
      // the owner opens approvals. No payment signing or transfer occurs here.
      let channelNotice=null;
      let confirmedItems=confirmed.data||[];
      if(String(telegram.id)==="1035565575"){
        const unsent=confirmedItems.find(x=>!x.notice_message_id&&!x.notice_claimed_at
          && /^[a-f0-9]{64}$/.test(String(x.payout_tx_hash||"")));
        if(unsent){
          channelNotice=await notifyVerifiedPayout(unsent.id);
          if(channelNotice?.stored){
            confirmedItems=confirmedItems.map(x=>x.id===unsent.id
              ?{...x,notice_message_id:channelNotice.message_id}:x);
          }else if(channelNotice?.manual_review){
            confirmedItems=confirmedItems.map(x=>x.id===unsent.id
              ?{...x,notice_claimed_at:new Date().toISOString()}:x);
          }
        }
      }
      const extra=await admin.from("henova_gram_withdrawals").select("id,status,signed_boc_hash").eq("status","broadcast").order("id",{ascending:true}).limit(100);
      const items=[...(active.data||[]),...confirmedItems];
      return reply({ok:true,items,unverified_items:extra.data||[],channel_notice:channelNotice,payout_wallet_address:settings.data.payout_wallet_address,payments_enabled:settings.data.manual_tonkeeper_enabled===true &&
        settings.data.chain_verifier_configured===true &&
        settings.data.test_transfer_verified===true,
        checks:{withdrawals_enabled:settings.data.manual_tonkeeper_enabled===true,
          chain_verifier_ready:settings.data.chain_verifier_configured===true,
          test_transfer_verified:settings.data.test_transfer_verified===true,
          manual_tonkeeper_approval_required:true},
        reason:"Manual Tonkeeper payouts require owner signature for every transfer."});
    }
    const id=Number(body?.withdrawalId);
    if(!Number.isSafeInteger(id)||id<=0)return reply({ok:false,error:"invalid_request"},400);
    if(action==="admin_record_signed_payout"){
      // The BOC proves a wallet returned a signed external message, NOT chain settlement.
      const signedBoc=String(body?.signedBoc||"");
      let hash="";
      try{
        if(signedBoc.length>15000)throw Error("boc_too_large");
        const cells=Cell.fromBase64(signedBoc);
        hash=cells.hash().toString("hex");
      }catch{return reply({ok:false,error:"invalid_signed_message"},400);}
      const address=String(body?.destination||"");
      const amount=String(body?.amountNanograms||"");
      const sender=String(settings.data.payout_wallet_address||"");
      if(!/^[a-f0-9]{64}$/.test(hash)||!/^[0-9]+$/.test(amount)||
         amount.length>22 || !/^(EQ|UQ)[A-Za-z0-9_-]{46}$/.test(address))
        return reply({ok:false,error:"invalid_signed_receipt"},400);
      const {data,error}=await admin.rpc("henova_record_signed_gram_payout",{
        p_withdrawal_id:id,p_boc_hash:hash,p_sender:sender,
        p_destination:address,p_amount_nano:amount
      });
      if(error)return reply({ok:false,error:"signing_receipt_unavailable"},503);
      return reply(data,data?.ok?200:409);
    }
    if(action==="admin_payout_approve" && String(telegram.id)!=="1035565575")
      return reply({ok:false,error:"owner_approval_only"},403);
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
      .select("id,status,destination_address,gram_amount,eggs_amount,signed_boc_hash,signing_claimed_at,payout_tx_hash")
      .eq("id",id).eq("status","approved").maybeSingle();
    if(result.error||!result.data)return reply({ok:false,error:"not_approved"},409);
    if(result.data.signed_boc_hash || result.data.payout_tx_hash || result.data.signing_claimed_at)
      return reply({ok:false,error:"signing_already_started_do_not_send_again"},409);
    if(!settings.data.payout_wallet_address)return reply({ok:false,error:"treasury_unset"},503);
    // Prevent accidental self-transfers, including differing TON friendly flags.
    const rawTon=(address)=>{
      try{
        const b=Uint8Array.from(atob(String(address).replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
        if(b.length!==36)return null;
        return b[1]+":"+Array.from(b.slice(2,34),x=>x.toString(16).padStart(2,"0")).join("");
      }catch{return null;}
    };
    const senderRaw=rawTon(settings.data.payout_wallet_address);
    const receiverRaw=rawTon(result.data.destination_address);
    if(!senderRaw||!receiverRaw)return reply({ok:false,error:"invalid_payout_address"},409);
    if(senderRaw===receiverRaw)return reply({ok:false,error:"recipient_matches_treasury"},409);
    // The amount is server-side; never accept the amount or destination from the client.
    const amountText=String(result.data.gram_amount||"");
    if(!/^[0-9]+(?:\.[0-9]+)?$/.test(amountText))
      return reply({ok:false,error:"invalid_amount"},409);
    const [wholePart,decimalPart=""]=amountText.split(".");
    if(decimalPart.length>9 && /[1-9]/.test(decimalPart.slice(9)))
      return reply({ok:false,error:"amount_precision_exceeds_nano"},409);
    const nanograms=BigInt(wholePart)*1000000000n+
      BigInt((decimalPart+"000000000").slice(0,9));
    if(nanograms<=0n||nanograms>1000000000n)
      return reply({ok:false,error:"invalid_amount"},409);
    // Atomically reserve one signing attempt before any wallet can transfer.
    // This reservation is never auto-released on network loss.
    const {data:lock,error:lockError}=await admin.rpc("henova_claim_gram_payout_signing",
      {p_withdrawal_id:id});
    if(lockError)return reply({ok:false,error:"signing_claim_unavailable"},503);
    if(!lock?.ok)return reply({ok:false,error:String(lock?.error||"signing_already_started_do_not_send_again")},409);
    return reply({ok:true,intent:{
      id:result.data.id,destination:result.data.destination_address,
      amountNanograms:String(nanograms),amountGram:String(result.data.gram_amount),
      sender:settings.data.payout_wallet_address,network:"-239"
    },requires_manual_tonkeeper_signature:true,not_chain_confirmed:true});
  }
  if (action === "claim_interstitial_open") {
    // A separate button-use reward, not verified AdsGram view credit.
    const {data,error}=await admin.rpc("henova_claim_interstitial_open",{p_telegram_id:telegram.id});
    if(error)return reply({ok:false,error:"reward_unavailable"},503);
    return reply(data);
  }
  if(action==="ad_view_start"){
    const {data,error}=await admin.from("henova_ad_view_sessions").insert({telegram_id:telegram.id}).select("id").single();
    if(error){console.error("HENOVA ad session insert failed",error.code,error.message);return reply({ok:false,error:"session_unavailable",diagnostics:{code:error.code,message:error.message}},503);}
    return reply({ok:true,session_id:data.id,min_seconds:14});
  }
  if(action==="ad_view_check"){
    const sessionId=String(body?.session_id||"");
    if(!/^[0-9a-f-]{36}$/i.test(sessionId))return reply({ok:false,error:"invalid_session"},400);
    const {data,error}=await admin.from("henova_ad_view_sessions").select("started_at,completed_at").eq("id",sessionId).eq("telegram_id",telegram.id).maybeSingle();
    if(error||!data)return reply({ok:false,error:"session_not_found"},404);
    const elapsed=Math.max(0,(Date.now()-Date.parse(data.started_at))/1000);
    const minSecondsMet=elapsed>=14;
    // Mark the timer session complete once. Repeated checks remain read-only/idempotent.
    if(minSecondsMet&&!data.completed_at){
      const {error:completeError}=await admin.from("henova_ad_view_sessions")
        .update({completed_at:new Date().toISOString()})
        .eq("id",sessionId).eq("telegram_id",telegram.id).is("completed_at",null);
      if(completeError){
        console.error("HENOVA ad session completion failed",completeError.code);
        return reply({ok:false,error:"session_completion_unavailable"},503);
      }
    }
    return reply({ok:true,min_seconds_met:minSecondsMet,elapsed_seconds:Math.floor(elapsed),completed:Boolean(data.completed_at)||minSecondsMet,reward_verified:false});
  }
  if(action==="ad_watch_status"){
    const {data,error}=await admin.from("henova_interstitial_open_rewards").select("rewarded_at").eq("telegram_id",telegram.id).order("rewarded_at",{ascending:false}).limit(1).maybeSingle();
    if(error)return reply({ok:false,error:"ad_status_unavailable"},503);
    const serverNow=Date.now();
    const nextAt=data?.rewarded_at?Date.parse(data.rewarded_at)+300000:0;
    return reply({ok:true,can_watch:serverNow>=nextAt,retry_after_seconds:Math.max(0,Math.ceil((nextAt-serverNow)/1000))});
  }
  if(action==="sponsored_watch_status"){
    const {data,error}=await admin.from("henova_adsgram_task_rewards").select("rewarded_at").eq("telegram_id",telegram.id).order("rewarded_at",{ascending:false}).limit(1).maybeSingle();
    if(error)return reply({ok:false,error:"ad_status_unavailable"},503);
    const remaining=Math.max(0,Math.ceil(((data?.rewarded_at?Date.parse(data.rewarded_at)+300000:0)-Date.now())/1000));
    return reply({ok:true,can_watch:remaining===0,retry_after_seconds:remaining});
  }
  if (action === "sponsored_reward_status") {
    const {data,error}=await admin.from("henova_adsgram_task_rewards").select("id,rewarded_at").eq("telegram_id",telegram.id).order("rewarded_at",{ascending:false}).limit(1).maybeSingle();
    if(error)return reply({ok:false,error:"reward_status_unavailable"},503);
    return reply({ok:true,reward:data||null});
  }
  if(action==="admin_publish_promo_code"){
    if(String(telegram.id)!=="1035565575")return reply({ok:false,error:"forbidden"},403);
    const code=String(body?.code||"").trim().toUpperCase();
    if(!/^HN[A-Z2-9]{12}$/.test(code))return reply({ok:false,error:"invalid_code"},400);
    const {data:p,error:e}=await admin.from("henova_promo_codes").select("*").eq("code",code).maybeSingle();
    if(e||!p)return reply({ok:false,error:"not_found"},404);
    if(p.telegram_post_id)return reply({ok:true,alreadyPosted:true,messageId:p.telegram_post_id});
    if(!p.active||Date.parse(p.expires_at)<=Date.now())return reply({ok:false,error:"expired"},400);
    const markup={inline_keyboard:[[{text:"📋 Copy code",copy_text:{text:code}}],[{text:"🎮 Open HENOVA Tasks",url:"https://t.me/HenovaEggsBot/farm?startapp=tasks"}]]};
    const remaining=Math.max(0,Math.ceil((Date.parse(p.expires_at)-Date.now())/3600000));
    const timeLabel=remaining<=1?"Less than 1 h":remaining+" h";
    const rewardAsset=p.reward_type==="gift"?(p.gift_reward_type||"coins"):p.reward_type;
    const rewardLabel=p.reward_type==="hen"
      ?"🐔 Timed Hen · 100 eggs/hour · "+Number(p.hen_duration_hours||1)+" hour(s)"
      :p.reward_type==="gift"?"🎁 Gift Box":rewardAsset==="eggs"?"🥚 Reward: "+Number(p.reward_coins).toLocaleString("en-US")+" eggs":"💰 Reward: "+Number(p.reward_coins).toLocaleString("en-US")+" coins";
    const msg=[
      "🎁 NEW PROMO CODE 🎁",
      "",
      "👉 "+code+" 👈",
      "Tap the code to copy it",
      "",
      rewardLabel,
      "👥 Only the first "+Number(p.max_claims).toLocaleString("en-US")+" players",
      "⏳ Valid for "+timeLabel,
      "",
      "🎮 Game → ✅ Tasks → 🎟️ Promo code",
      "",
      "🎁 Stay tuned for the next promo code!",
      "👇👇👇"
    ].join("\n");
    const res=await fetch("https://api.telegram.org/bot"+botToken+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:"@HENOVA_PROMO_CODES",text:msg,reply_markup:markup}),signal:AbortSignal.timeout(10000)}).catch(()=>null);
    const ans=await res?.json().catch(()=>null);
    if(!ans?.ok)return reply({ok:false,error:"publish_failed",detail:String(ans?.description||"telegram_unavailable").slice(0,100)},502);
    const {error:saveError}=await admin.from("henova_promo_codes").update({telegram_post_id:ans.result.message_id,posted_at:new Date().toISOString()}).eq("code",code).is("telegram_post_id",null);
    if(saveError)console.error("promo_post_tracking_failed",saveError.code);
    return reply({ok:true,messageId:ans.result.message_id});
  }
  if(action==="admin_create_promo_code"){
    if(String(telegram.id)!=="1035565575")return reply({ok:false,error:"forbidden"},403);
    const maxClaims=Number(body?.maxClaims),rewardCoins=Number(body?.rewardCoins),hours=Number(body?.hours),rewardType=String(body?.rewardType||"coins"),giftRewardType=String(body?.giftRewardType||"coins"),henDurationHours=Number(body?.henDurationHours||1);
    if(!["coins","eggs","gift","hen"].includes(rewardType)||!["coins","eggs"].includes(giftRewardType)||!Number.isSafeInteger(maxClaims)||maxClaims<1||maxClaims>100000||!Number.isSafeInteger(hours)||hours<1||hours>720||
       (rewardType==="hen"?(!Number.isSafeInteger(henDurationHours)||henDurationHours<1||henDurationHours>720):(!Number.isSafeInteger(rewardCoins)||rewardCoins<1||rewardCoins>100000)))return reply({ok:false,error:"invalid_promo_parameters"},400);
    const finalReward=rewardType==="hen"?henDurationHours*100:rewardCoins;
    const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes=crypto.getRandomValues(new Uint8Array(12));
    const code="HN"+Array.from(bytes,x=>chars[x%chars.length]).join("");
    const expiresAt=new Date(Date.now()+hours*3600000).toISOString();
    const {error}=await admin.from("henova_promo_codes").insert({code,reward_coins:finalReward,max_claims:maxClaims,expires_at:expiresAt,active:true,reward_type:rewardType,gift_reward_type:giftRewardType,hen_duration_hours:rewardType==="hen"?henDurationHours:1});
    if(error){console.error("promo_create",error.code);return reply({ok:false,error:"promo_create_unavailable"},503);}
    return reply({ok:true,code,maxClaims,rewardCoins:finalReward,rewardType,giftRewardType,henDurationHours:rewardType==="hen"?henDurationHours:null,hours,expiresAt});
  }
  if(action==="promo_membership_check"||action==="promo_ad_start"){
    const checks=await Promise.all(["@HENOVA_FARM","@HENOVA_WITHDRAWALS"].map(async(chat)=>{
      const response=await fetch("https://api.telegram.org/bot"+botToken+"/getChatMember",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chat,user_id:telegram.id})}).catch(()=>null);
      if(!response)return {chat,joined:false,available:false};
      const result=await response.json().catch(()=>null);
      if(!result?.ok)return {chat,joined:false,available:false};
      const m=result.result;
      return {chat,joined:["creator","administrator","member"].includes(m?.status)||(m?.status==="restricted"&&m?.is_member===true),available:true};
    }));
    if(checks.some(x=>!x.available))return reply({ok:false,error:"membership_verification_unavailable"},503);
    const membership={henova:checks[0].joined,withdrawals:checks[1].joined,allJoined:checks.every(x=>x.joined)};
    if(action==="promo_membership_check")return reply({ok:true,...membership});
    if(!membership.allJoined)return reply({ok:false,error:"channel_membership_required",...membership},403);
    const c=String(body?.code||"").trim().toUpperCase();
    const x=await admin.rpc("henova_start_promo_ad_session",{p_telegram_id:telegram.id,p_code:c});
    if(x.error)return reply({ok:false,error:"promo_session_unavailable"},503);
    return reply(x.data,x.data?.ok?200:400);
  }
  if(action==="promo_ad_check"){
    const sessionId=String(body?.session_id||"");
    if(!/^[0-9a-f-]{36}$/i.test(sessionId))return reply({ok:false,error:"invalid_session"},400);
    const x=await admin.rpc("henova_check_promo_ad_session",{p_telegram_id:telegram.id,p_session_id:sessionId});
    if(x.error)return reply({ok:false,error:"promo_session_unavailable"},503);
    return reply(x.data,x.data?.ok?200:400);
  }
  if(action==="redeem_promo_code"){
    const membershipChecks=await Promise.all(["@HENOVA_FARM","@HENOVA_WITHDRAWALS"].map(async(chat)=>{
      const response=await fetch("https://api.telegram.org/bot"+botToken+"/getChatMember",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chat,user_id:telegram.id})}).catch(()=>null);
      if(!response)return {joined:false,available:false};
      const result=await response.json().catch(()=>null);
      if(!result?.ok)return {joined:false,available:false};
      const m=result.result;
      return {joined:["creator","administrator","member"].includes(m?.status)||(m?.status==="restricted"&&m?.is_member===true),available:true};
    }));
    if(membershipChecks.some(x=>!x.available))return reply({ok:false,error:"membership_verification_unavailable"},503);
    if(!membershipChecks.every(x=>x.joined))return reply({ok:false,error:"channel_membership_required",henova:membershipChecks[0].joined,withdrawals:membershipChecks[1].joined},403);
    const c=String(body?.code||"").trim().toUpperCase();
    const sessionId=String(body?.session_id||"");
    if(!/^[0-9a-f-]{36}$/i.test(sessionId))return reply({ok:false,error:"ad_verification_required"},403);
    const x=await admin.rpc("henova_redeem_promo_after_ad",{p_telegram_id:telegram.id,p_code:c,p_session_id:sessionId});
    if(x.error)return reply({ok:false,error:"promo_unavailable"},503);
    return reply(x.data,x.data?.ok?200:400);
  }
  if (action === "post80_status") {
    const {data,error}=await admin.from("henova_post80_claims").select("telegram_id").eq("telegram_id",telegram.id).maybeSingle();
    if(error)return reply({ok:false,error:"status_unavailable"},503);
    return reply({ok:true,claimed:!!data});
  }
  if (action === "claim_post80_once") {
    const {data,error}=await admin.rpc("henova_claim_post80",{p_telegram_id:telegram.id});
    if(error)return reply({ok:false,error:"reward_unavailable"},503);
    return reply(data);
  }
  if (action === "claim_ngm_once") {
    const { data, error } = await admin.rpc("henova_claim_ngm_once", {p_telegram_id:telegram.id});
    if(error)return reply({ok:false,error:"reward_unavailable"},503);
    return reply(data);
  }
  if (action === "claim_ngm_cloud_once") {
    const { data, error } = await admin.rpc("henova_claim_ngm_cloud_once", {p_telegram_id:telegram.id});
    if(error)return reply({ok:false,error:"reward_unavailable"},503);
    return reply(data);
  }
  if (action === "claim_catsminer_once") {
    const { data, error } = await admin.rpc("henova_claim_catsminer_once", {p_telegram_id:telegram.id});
    if(error)return reply({ok:false,error:"reward_unavailable"},503);
    return reply(data);
  }
  if (action === "claim_utya_miner_once") {
    const { data, error } = await admin.rpc("henova_claim_utya_miner_once", {p_telegram_id:telegram.id});
    if(error)return reply({ok:false,error:"reward_unavailable"},503);
    return reply(data);
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
    if (!joined) return reply({ok:true,joined:false,channel:"@HENOVA_WITHDRAWALS"});
    const { data: reward, error: claimError } = await admin.rpc("henova_claim_withdrawals_channel_reward",{p_telegram_id:telegram.id});
    if(claimError)return reply({ok:false,error:"database_unavailable"},503);
    return reply({ok:true,joined:true,channel:"@HENOVA_WITHDRAWALS",reward_claimed:reward?.ok===true,coins_added:reward?.ok?20:0,already_claimed:reward?.error==="already_claimed"});
  }
  if (action === "verify_promo_codes_channel") {
    const result = await fetch("https://api.telegram.org/bot"+botToken+"/getChatMember", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({chat_id:"@HENOVA_PROMO_CODES",user_id:telegram.id}),
      signal:AbortSignal.timeout(8000)
    }).catch(()=>null);
    const member = await result?.json().catch(()=>null);
    if(!member?.ok)return reply({ok:false,error:"verification_unavailable"},503);
    const status=member.result?.status;
    const joined=["creator","administrator","member"].includes(status) ||
      (status==="restricted" && member.result?.is_member===true);
    if(!joined)return reply({ok:true,joined:false,channel:"@HENOVA_PROMO_CODES"});
    const {data:reward,error:claimError}=await admin.rpc("henova_claim_promo_channel_reward",{p_telegram_id:telegram.id});
    if(claimError)return reply({ok:false,error:"database_unavailable"},503);
    return reply({
      ok:true,joined:true,channel:"@HENOVA_PROMO_CODES",
      reward_claimed:reward?.ok===true,
      coins_added:reward?.ok?20:0,
      already_claimed:reward?.error==="already_claimed"
    });
  }
  if (action === "payout_setup") {
    const eligibilitySince="2026-10-31T12:22:20.284Z";
    const [settings,wallet,withdrawals,videoAds,sponsoredAds,interstitialAds] = await Promise.all([
      admin.from("henova_payout_settings").select("asset,network,enabled,withdrawal_requests_enabled,min_eggs,max_eggs,cooldown_hours,gram_per_egg").eq("singleton",true).single(),
      admin.from("henova_ton_wallets").select("wallet_address,verified_owner").eq("telegram_id",telegram.id).maybeSingle(),
      admin.from("henova_gram_withdrawals").select("id,eggs_amount,gram_amount,status,payout_tx_hash,created_at").eq("telegram_id",telegram.id).gte("created_at","2026-10-31T19:13:24.250Z").order("created_at",{ascending:false}).limit(10),
      admin.from("henova_adsgram_video_rewards").select("id",{count:"exact",head:true}).eq("telegram_id",telegram.id).gte("rewarded_at",eligibilitySince),
      admin.from("henova_adsgram_task_rewards").select("id",{count:"exact",head:true}).eq("telegram_id",telegram.id).gte("rewarded_at",eligibilitySince),
      admin.from("henova_interstitial_open_rewards").select("id",{count:"exact",head:true}).eq("telegram_id",telegram.id).gte("rewarded_at",eligibilitySince)
    ]);
    if(settings.error||wallet.error||withdrawals.error||videoAds.error||sponsoredAds.error||interstitialAds.error)
      return reply({ok:false,error:"database_unavailable"},503);
    const eligibilityConfirmed=(videoAds.count||0)+(sponsoredAds.count||0)+(interstitialAds.count||0);
    const eligibilityGoal=25;
    const eligibilityPercent=Math.min(100,eligibilityConfirmed);
    // Notify only for confirmed payments, never for pending submissions.
    // Conditional claim prevents parallel requests from double-posting.
    // The old wallet-page payout announcer was removed to prevent a second
    // posting path. Verified payouts are announced via notifyVerifiedPayout,
    // which uses the canonical #13-style template and an atomic claim.
    return reply({
      ok:true,
      payout:{...settings.data,enabled:settings.data.withdrawal_requests_enabled===true,real_payouts_enabled:false},
      eligibility:{percent:eligibilityPercent,confirmed:eligibilityConfirmed,goal:eligibilityGoal,eligible:eligibilityConfirmed>=eligibilityGoal,since:eligibilitySince},
      wallet:wallet.data||null,
      withdrawals:withdrawals.data||[]
    });
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
  // Inspect TON Proof prerequisites; NEVER treat this as signature verification.
  if (action === "wallet_proof_inspect") {
    const proof=body?.proof, address=String(body?.address||"");
    const wallet=await admin.from("henova_ton_wallets").select("wallet_address")
      .eq("telegram_id",telegram.id).maybeSingle();
    if(wallet.error)return reply({ok:false,error:"database_unavailable"},503);
    if(wallet.data?.wallet_address!==address)return reply({ok:false,error:"save_wallet_first"},403);
    if(!proof || typeof proof!=="object" || typeof proof.payload!=="string" ||
       !/^[a-f0-9]{64}$/.test(proof.payload) ||
       typeof proof.signature!=="string" || proof.signature.length>256 ||
       proof.domain?.value!=="mhmtalkasim2-ship-it.github.io" ||
       proof.domain?.lengthBytes!==encoder.encode(proof.domain.value).length ||
       !Number.isSafeInteger(Number(proof.timestamp)) ||
       Math.abs(Date.now()/1000-Number(proof.timestamp))>600)
      return reply({ok:false,error:"invalid_proof_envelope"},400);
    const {data:challenge,error:challengeError}=await admin.rpc("henova_check_wallet_proof_challenge",{
      p_telegram_id:telegram.id,p_wallet_address:address,p_nonce:proof.payload
    });
    if(challengeError)return reply({ok:false,error:"proof_challenge_unavailable"},503);
    if(!challenge?.ok)return reply({ok:false,error:"challenge_expired_or_mismatched"},403);
    // TON Proof signature is accepted ONLY when stateInit hashes to this wallet,
    // its code matches an audited standard wallet version, and Ed25519 verifies.
    if(body?.network!=="-239" || typeof body?.walletStateInit!=="string" ||
       body.walletStateInit.length>25000)return reply({ok:false,error:"invalid_wallet_network_or_state"},400);
    try{
      const parsed=Address.parse(address);
      const init=loadStateInit(Cell.fromBase64(body.walletStateInit).beginParse());
      if(!contractAddress(parsed.workChain,init).equals(parsed))
        return reply({ok:false,error:"wallet_state_address_mismatch"},403);
      if(!init.code||!init.data)return reply({ok:false,error:"invalid_wallet_state"},403);
      const known=[
        {factory:WalletContractV4,load:(cell)=>{cell.loadUint(32);cell.loadUint(32);return cell.loadBuffer(32);}},
        {factory:WalletContractV5R1,load:(cell)=>{cell.loadBoolean();cell.loadUint(32);cell.loadUint(32);return cell.loadBuffer(32);}}
      ];
      let trustedKey=null;
      for(const k of known){
        const knownCode=k.factory.create({workchain:0,publicKey:Buffer.alloc(32)}).init.code;
        if(knownCode?.equals(init.code)){trustedKey=k.load(init.data.beginParse());break;}
      }
      if(!trustedKey||trustedKey.length!==32)return reply({ok:false,error:"unsupported_wallet_contract"},403);
      if(body.publicKey!==undefined &&
        (!/^[a-f0-9]{64}$/i.test(String(body.publicKey)) ||
         Buffer.from(body.publicKey,"hex").compare(trustedKey)!==0))
        return reply({ok:false,error:"wallet_public_key_mismatch"},403);
      const signature=Buffer.from(proof.signature,"base64");
      if(signature.length!==64)return reply({ok:false,error:"invalid_signature"},403);
      const wc=Buffer.alloc(4);wc.writeInt32BE(parsed.workChain);
      const domainBytes=Buffer.from(proof.domain.value,"utf8");
      const domainLen=Buffer.alloc(4);domainLen.writeUInt32LE(domainBytes.length);
      const timestamp=Buffer.alloc(8);timestamp.writeBigUInt64LE(BigInt(proof.timestamp));
      const message=Buffer.concat([
        Buffer.from("ton-proof-item-v2/"),wc,parsed.hash,domainLen,domainBytes,
        timestamp,Buffer.from(proof.payload,"utf8")
      ]);
      const hash1=new Uint8Array(await crypto.subtle.digest("SHA-256",message));
      const hash2=new Uint8Array(await crypto.subtle.digest("SHA-256",
        Buffer.concat([Buffer.from([255,255]),Buffer.from("ton-connect"),Buffer.from(hash1)])));
      if(!nacl.sign.detached.verify(hash2,signature,trustedKey))
        return reply({ok:false,error:"invalid_wallet_signature"},403);
      // Atomic nonce consumption and wallet update. Never accept a reused proof.
      const {data:verified,error:verifiedError}=await admin.rpc("henova_consume_verified_wallet_proof",{
        p_telegram_id:telegram.id,p_wallet_address:address,p_nonce:proof.payload
      });
      if(verifiedError)return reply({ok:false,error:"wallet_proof_commit_failed"},503);
      return reply(verified,verified?.ok?200:409);
    }catch(err){
      console.warn("HENOVA TON proof verification rejected",String(err).slice(0,90));
      return reply({ok:false,error:"wallet_proof_verification_failed"},403);
    }
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
    // Authenticated Telegram requests use the database reservation and ad eligibility checks.
    const requestId=body?.requestId;
    const eggs=body?.eggs;
    if(typeof requestId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)
      ||!Number.isSafeInteger(eggs)||eggs<=0)return reply({ok:false,error:"invalid_request"},400);
    const {data,error}=await admin.rpc("henova_prepare_gram_withdrawal",{
      p_telegram_id:telegram.id,p_request_id:requestId,p_eggs:eggs
    });
    if(error){console.error("HENOVA reserve withdrawal failed",error.code);return reply({ok:false,error:"withdrawal_unavailable"},503)}
    // Best-effort private administrator alert; never reverse a valid withdrawal
    // if Telegram is unavailable. The atomic database claim avoids duplicates.
    if(data?.ok===true){
      try{
        const {data:withdrawal,error:readError}=await admin.from("henova_gram_withdrawals")
          .select("id,telegram_id,eggs_amount,gram_amount,destination_address")
          .eq("request_id",requestId).eq("telegram_id",telegram.id).maybeSingle();
        if(readError)console.warn("HENOVA withdrawal admin alert lookup",readError.code||"unavailable");
        if(withdrawal){
          const {data:claim,error:claimError}=await admin.from("henova_gram_withdrawals")
            .update({admin_alert_attempted_at:new Date().toISOString()})
            .eq("id",withdrawal.id).is("admin_alert_attempted_at",null)
            .select("id").maybeSingle();
          if(claimError)console.warn("HENOVA withdrawal alert claim",claimError.code||"unavailable");
          if(claim){
            const address=String(withdrawal.destination_address||"");
            const masked=address.length>17?address.slice(0,8)+"…"+address.slice(-6):address;
            const notice="📥 HENOVA — NEW WITHDRAWAL REQUEST\n"+
              "Request #"+withdrawal.id+" · Pending approval\n"+
              "👤 Player ID: "+withdrawal.telegram_id+"\n"+
              "🥚 Eggs: "+withdrawal.eggs_amount+"\n"+
              "💎 GRAM: "+withdrawal.gram_amount+"\n"+
              "👛 Recipient: "+masked+"\n\n"+
              "Approval does not transfer funds. Tonkeeper signature is required.";
            let messageId=null,alertError=null;
            try{
              const response=await fetch("https://api.telegram.org/bot"+botToken+"/sendMessage",{
                method:"POST",headers:{"Content-Type":"application/json"},
                body:JSON.stringify({
                  chat_id:1035565575,text:notice,disable_web_page_preview:true,
                  reply_markup:{inline_keyboard:[[{text:"📋 Open HENOVA Approvals",
                    url:"https://mhmtalkasim2-ship-it.github.io/henova/?admin=payouts"}]]}
                }),signal:AbortSignal.timeout(7000)
              });
              const telegramResult=await response.json().catch(()=>null);
              if(response.ok&&telegramResult?.ok&&telegramResult?.result?.message_id)
                messageId=telegramResult.result.message_id;
              else alertError="telegram_"+String(telegramResult?.error_code||response.status);
            }catch{alertError="telegram_delivery_unavailable";}
            const saved=messageId
              ?{admin_alert_message_id:messageId,admin_alert_error:null}
              :{admin_alert_error:alertError||"telegram_delivery_unavailable"};
            const {error:storeError}=await admin.from("henova_gram_withdrawals")
              .update(saved).eq("id",withdrawal.id).is("admin_alert_message_id",null);
            if(storeError)console.warn("HENOVA withdrawal alert outcome",storeError.code||"unavailable");
            if(alertError)console.warn("HENOVA withdrawal admin DM",alertError);
          }
        }
      }catch{console.warn("HENOVA admin alert best-effort failure");}
    }
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
  if (action === "state" || action === "state_refresh") {
    const {error:henCollectError}=await admin.rpc("henova_collect_expired_promo_hens",{p_telegram_id:telegram.id});
    if(henCollectError){console.error("HENOVA timed hen collection failed",henCollectError.code);return reply({ok:false,error:"state_unavailable"},503);}
    // Best-effort bot chat setup on the initial authenticated app opening.
    if (action === "state" && !henovaBotStartup) {
      henovaBotStartup=ensureHenovaStartButton(botToken,supabaseUrl).catch(error=>{
        console.warn("HENOVA bot start setup deferred",error instanceof Error ? error.name : "unknown_error");
      });
      try { EdgeRuntime.waitUntil(henovaBotStartup); } catch { /* unavailable in test runtimes */ }
    }
    let { data, error } = await admin.from("henova_players")
      .select("egg_balance,coin_balance,starter_hens,red_hens,gold_hens,royal_hens,legend_hens,fan_level,production_started_at,last_daily_on,daily_streak,referral_eggs_earned,referral_coins_earned")
      .eq("telegram_id", telegram.id).maybeSingle();
    if (error) return reply({ ok: false, error: "database_unavailable" }, 503);
    // Register only genuinely new players. Existing players no longer trigger
    // the registration RPC on every fresh app opening; referral rewards remain
    // atomic inside henova_register_player for first-time registrations.
    if (!data) {
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
      const registered = await admin.from("henova_players")
        .select("egg_balance,coin_balance,starter_hens,red_hens,gold_hens,royal_hens,legend_hens,fan_level,production_started_at,last_daily_on,daily_streak,referral_eggs_earned,referral_coins_earned")
        .eq("telegram_id", telegram.id).single();
      data = registered.data;
      error = registered.error;
      if (error || !data) return reply({ ok: false, error: "database_unavailable" }, 503);
    }
    // Fetch referral/task cooldown metadata in one database round-trip.
    const { data: stateExtras, error: stateExtrasError } = await admin.rpc("henova_get_state_extras", {
      p_telegram_id: telegram.id
    });
    if (stateExtrasError || !stateExtras) {
      console.error("HENOVA state extras failed", stateExtrasError?.code);
      return reply({ ok: false, error: "database_unavailable" }, 503);
    }
    const {data:activePromoHen,error:activePromoHenError}=await admin.from("henova_promo_hens")
      .select("started_at,ends_at,eggs_reward").eq("telegram_id",telegram.id)
      .is("collected_at",null).gt("ends_at",new Date().toISOString())
      .order("ends_at",{ascending:true}).limit(1).maybeSingle();
    if(activePromoHenError){console.error("HENOVA active promo hen lookup failed",activePromoHenError.code);return reply({ok:false,error:"state_unavailable"},503);}
    return reply({ ok: true, state: {
      ...publicState(data), promo_hen:activePromoHen||null, referrals_count: Number(stateExtras.referrals_count || 0),
      referral_eggs_earned: data.referral_eggs_earned || 0,
      referral_coins_earned: data.referral_coins_earned || 0,
      invite_daily_progress: Number(stateExtras.invite_daily_progress || 0),
      invite_daily_rewarded: stateExtras.invite_daily_rewarded === true,
      channel_next_at: stateExtras.channel_next_at || null,
      gift_chest_next_at: stateExtras.gift_chest_next_at || null
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
