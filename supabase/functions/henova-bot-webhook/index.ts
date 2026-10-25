// HENOVA private Telegram bot chat entry point.
// Uses existing secret HENOVA_TELEGRAM_BOT_TOKEN. Never exposes bot tokens to Mini App.
const APP_URL = "https://mhmtalkasim2-ship-it.github.io/henova/";
const te = new TextEncoder();
const response = (data, status=200) => new Response(JSON.stringify(data), {
  status, headers: {"content-type":"application/json; charset=utf-8", "cache-control":"no-store"}
});
async function webhookToken(botToken: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", te.encode("henova-webhook-1:" + botToken));
  return Array.from(new Uint8Array(hash), b=>b.toString(16).padStart(2,"0")).join("");
}
function constantTimeEqual(a:string,b:string):boolean {
  if (a.length!==b.length)return false;
  let result=0;
  for(let i=0;i<a.length;i++)result|=a.charCodeAt(i)^b.charCodeAt(i);
  return result===0;
}
async function telegramPost(token:string,method:string,params:Record<string,unknown>){
  const result=await fetch("https://api.telegram.org/bot"+token+"/"+method,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify(params),signal:AbortSignal.timeout(10000)
  });
  const json=await result.json().catch(()=>null);
  if(!result.ok || !json?.ok)throw new Error("telegram_"+method+"_failed_"+(json?.error_code||result.status));
  return json.result;
}
function welcomeFor(language:string){
  const lang=String(language||"").toLowerCase().split("-")[0];
  if(lang==="ar")return {button:"🐔 ابدأ",text:"🐔 أهلاً بك في HENOVA!\nافتح مزرعتك وابدأ تربية الدجاج وجمع البيض. اضغط الزر أدناه للدخول."};
  if(lang==="tr")return {button:"🐔 Başlat",text:"🐔 HENOVA çiftliğine hoş geldin!\nTavuklarını yetiştirip yumurtalarını toplamak için aşağıdaki düğmeye dokun."};
  return {button:"🐔 Start",text:"🐔 Welcome to HENOVA!\nRaise your chickens and collect eggs. Tap the button below to open your farm."};
}
Deno.serve(async(request:Request)=>{
  if(request.method!=="POST")return response({ok:false,error:"method_not_allowed"},405);
  const token=Deno.env.get("HENOVA_TELEGRAM_BOT_TOKEN");
  if(!token)return response({ok:false,error:"not_configured"},503);
  const actual=request.headers.get("x-telegram-bot-api-secret-token")||"";
  if(!constantTimeEqual(actual,await webhookToken(token)))
    return response({ok:false,error:"unauthorized"},403);
  if(Number(request.headers.get("content-length")||0)>65536)return response({ok:false,error:"too_large"},413);
  let update:any;
  try{update=await request.json()}catch{return response({ok:false,error:"invalid_json"},400)}
  if(typeof update?.update_id!=="number")return response({ok:false,error:"invalid_update"},400);
  const message=update.message;
  if(!message || message.chat?.type!=="private" || !message.from?.id ||
      message.from.id!==message.chat.id)return response({ok:true,ignored:true});
  const msg=String(message.text||"");
  if(!/^\/(start|help)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/i.test(msg))
    return response({ok:true,ignored:true});
  const {button,text}=welcomeFor(message.from.language_code||"en");
  try{
    await telegramPost(token,"sendMessage",{
      chat_id:message.chat.id,
      text,
      reply_markup:{inline_keyboard:[[{text:button,web_app:{url:APP_URL}}]]}
    });
  }catch(e){
    console.error("HENOVA start message failed",String(e).slice(0,130));
    return response({ok:false,error:"start_delivery_failed"},502);
  }
  // Chat-specific button is localized to the user's own Telegram language.
  try{
    await telegramPost(token,"setChatMenuButton",{
      chat_id:message.chat.id,
      menu_button:{type:"web_app",text:button,web_app:{url:APP_URL}}
    });
  }catch(e){console.warn("HENOVA localized chat menu unavailable",String(e).slice(0,130))}
  return response({ok:true});
});