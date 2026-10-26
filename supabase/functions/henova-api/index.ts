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
  if (["admin_payout_queue","admin_payout_approve","admin_payout_intent","admin_record_signed_payout","admin_chain_audit","admin_match_payout","admin_verify_payout","admin_track_signed_payout","admin_post_payout_notice","admin_test_submit","admin_test_queue","admin_test_intent","admin_test_approve","admin_verify_test_transfer"].includes(action)) {
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
    if(["admin_payout_intent","admin_record_signed_payout","admin_track_signed_payout",
        "admin_verify_payout","admin_match_payout","admin_post_payout_notice"].includes(action)
        && String(telegram.id)!=="1035565575")
      return reply({ok:false,error:"owner_only"},403);
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
    const notifyVerifiedPayout=async(paymentId)=>{
      const {data:claim,error:claimError}=await admin.rpc("henova_claim_verified_payout_notice",{p_id:paymentId});
      if(claimError||!claim?.ok)return {sent:false,error:claimError?"notice_claim_failed":"notice_already_sent_or_locked"};
      const message="✅ HENOVA GRAM WITHDRAWAL CONFIRMED\n"+
        "Withdrawal #"+claim.id+"\nAmount: "+claim.gram_amount+" GRAM\n"+
        "TON transaction: https://tonviewer.com/transaction/"+claim.tx_hash;
      let response;
      try{
        response=await fetch("https://api.telegram.org/bot"+botToken+"/sendMessage",{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({chat_id:"@HENOVA_WITHDRAWALS",text:message,
            disable_web_page_preview:true}),signal:AbortSignal.timeout(12000)
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
      return {sent:true,stored:true,message_id:messageId};
    };
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
        const rows=Array.isArray(json?.transactions)?json.transactions:[];
        const tx=rows.find(t=>hexHash(t?.hash)===claimedHash &&
          raw(t?.account)===senderRaw && !t?.emulated && t?.description?.aborted!==true &&
          t?.description?.action?.success===true &&
          Number(t?.now)>=Math.floor(Date.parse(req.created_at)/1000) &&
          (!req.signing_claimed_at || Number(t?.now)>=Math.floor(Date.parse(req.signing_claimed_at)/1000)-15));
        if(!tx)return reply({ok:false,error:"sender_transaction_unverified"},409);
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
        const credited=recipientJson.transactions.some(t=>
          !t?.emulated && raw(t?.account)===destinationRaw &&
          t?.description?.aborted===false &&
          t?.in_msg?.bounced!==true && raw(t?.in_msg?.source)===senderRaw &&
          raw(t?.in_msg?.destination||t?.account)===destinationRaw &&
          String(t?.in_msg?.value)===nano &&
          hexHash(t?.in_msg?.hash)===hexHash(matches[0].hash)
        );
        if(!credited)return reply({ok:false,error:"recipient_credit_not_verified"},409);
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
      const items=[...(active.data||[]),...confirmedItems];
      return reply({ok:true,items,channel_notice:channelNotice,payout_wallet_address:settings.data.payout_wallet_address,payments_enabled:settings.data.manual_tonkeeper_enabled===true &&
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
    const nanograms=Math.round(Number(result.data.gram_amount)*1e9);
    if(!Number.isSafeInteger(nanograms)||nanograms<=0||nanograms>1e9)
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
      admin.from("henova_payout_settings").select("asset,network,enabled,withdrawal_requests_enabled,min_eggs,max_eggs,cooldown_hours,gram_per_egg").eq("singleton",true).single(),
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
    return reply({ok:true,payout:{...settings.data,enabled:settings.data.withdrawal_requests_enabled===true,real_payouts_enabled:false},wallet:wallet.data||null,withdrawals:withdrawals.data||[]});
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
