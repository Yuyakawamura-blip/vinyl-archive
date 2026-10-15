import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {createClient} from 'jsr:@supabase/supabase-js@2';

const jsonSchema={type:'object',properties:{artist:{type:'string'},title:{type:'string'},year:{type:'integer'},genre:{type:'string',enum:['Jazz','Rock','Soul','Electronic','Hip-Hop','Classical','Pop','Other']},catalogNo:{type:'string'},aTitle:{type:'string'},bTitle:{type:'string'},confidence:{type:'number'},needsReview:{type:'boolean'},notes:{type:'string'}},required:['artist','title','year','genre','catalogNo','aTitle','bTitle','confidence','needsReview','notes']};
const corsHeaders={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type'};
const jsonResponse=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...corsHeaders,'Content-Type':'application/json'}});

Deno.serve(async request=>{
  if(request.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  if(request.method!=='POST')return new Response('Method not allowed',{status:405,headers:corsHeaders});
  const authorization=request.headers.get('Authorization');
  if(!authorization)return new Response('Unauthorized',{status:401,headers:corsHeaders});
  const supabaseUrl=Deno.env.get('SUPABASE_URL')!;
  const publishableKey=Deno.env.get('SUPABASE_ANON_KEY')!;
  const geminiKey=Deno.env.get('GEMINI_API_KEY');
  if(!geminiKey)return jsonResponse({error:'GEMINI_API_KEY is not configured'},503);
  const client=createClient(supabaseUrl,publishableKey,{global:{headers:{Authorization:authorization}}});
  const {data:{user}}=await client.auth.getUser();
  if(!user)return new Response('Unauthorized',{status:401,headers:corsHeaders});
  const {recordId}=await request.json();
  const {data:record,error:recordError}=await client.from('records').select('id,data,cover_path').eq('id',recordId).single();
  if(recordError||!record?.cover_path)return jsonResponse({error:'Record or cover not found'},404);
  await client.from('records').update({ai_status:'processing',ai_error:null}).eq('id',recordId);
  try{
    const {data:file,error:fileError}=await client.storage.from('record-covers').download(record.cover_path);
    if(fileError)throw fileError;
    const bytes=new Uint8Array(await file.arrayBuffer());
    let binary='';for(let index=0;index<bytes.length;index+=0x8000)binary+=String.fromCharCode(...bytes.subarray(index,index+0x8000));
    const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:'7インチレコードのジャケット写真を読み取り、所蔵データ候補を抽出してください。見えない情報を断定せず、不明は空文字または0にしてください。既知の作品からA面・B面を推定した場合はneedsReviewをtrueにしてください。日本語の表記を尊重してください。notesには短い根拠や注意点だけを書いてください。'},{inlineData:{mimeType:file.type||'image/jpeg',data:btoa(binary)}}]}],generationConfig:{responseMimeType:'application/json',responseJsonSchema:jsonSchema,temperature:.1}})});
    if(!response.ok)throw new Error(`Gemini ${response.status}: ${await response.text()}`);
    const gemini=await response.json();
    const text=gemini.candidates?.[0]?.content?.parts?.[0]?.text;
    if(!text)throw new Error('Gemini returned no result');
    const result=JSON.parse(text);
    const hasUsefulResult=[result.artist,result.title,result.catalogNo,result.aTitle,result.bTitle].some(value=>String(value||'').trim())||Number(result.year)>0;
    const nextData={...record.data,artist:result.artist||record.data.artist||'AIリソースなし',title:result.title||record.data.title,year:Number(result.year)||0,genre:result.genre||'Other',catalogNo:result.catalogNo||'',aTitle:result.aTitle||'',bTitle:result.bTitle||'',notes:[result.notes,!hasUsefulResult?'画像からレコード情報を取得できませんでした。':'',`AI信頼度 ${Math.round((Number(result.confidence)||0)*100)}%`].filter(Boolean).join(' / '),aiConfidence:Number(result.confidence)||0,aiNeedsReview:Boolean(result.needsReview)};
    const aiStatus=!hasUsefulResult?'no_resources':result.needsReview||Number(result.confidence)<.75?'review':'complete';
    const {error:updateError}=await client.from('records').update({data:nextData,ai_status:aiStatus,ai_error:null,updated_at:new Date().toISOString()}).eq('id',recordId);
    if(updateError)throw updateError;
    return jsonResponse({ok:true,status:aiStatus});
  }catch(error){await client.from('records').update({ai_status:'error',ai_error:String(error?.message||error),updated_at:new Date().toISOString()}).eq('id',recordId);return jsonResponse({error:String(error?.message||error)},500)}
});
