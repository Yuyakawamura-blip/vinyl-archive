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
    const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':geminiKey},body:JSON.stringify({contents:[{parts:[{text:'画像は候補発見の手掛かりです。まずジャケットに印刷された文字を丁寧に読み取り、アーティスト名・作品名・レーベル・カタログ番号を特定してください。その情報を使ってGoogle検索を最大1回行い、レコード店、レーベル、アーティスト、信頼できるディスコグラフィーを優先して照合してください。見つからない情報は推測せず空文字または0にしてください。オリジナル盤と再発盤の年を混同しないでください。商品価格や中古販売価格は発売年や作品情報として扱わないでください。日本語の表記を尊重し、検索結果と画像の記載が食い違う場合はneedsReviewをtrueにしてください。notesには判定根拠と食い違いだけを短く書いてください。'},{inlineData:{mimeType:file.type||'image/jpeg',data:btoa(binary)}}]}],tools:[{googleSearch:{}}],generationConfig:{responseMimeType:'application/json',responseJsonSchema:jsonSchema}})});
    if(!response.ok)throw new Error(`Gemini ${response.status}: ${await response.text()}`);
    const gemini=await response.json();
    const candidate=gemini.candidates?.[0];
    const text=candidate?.content?.parts?.[0]?.text;
    if(!text)throw new Error('Gemini returned no result');
    const result=JSON.parse(text);
    const aiSources=(candidate.groundingMetadata?.groundingChunks||[])
      .map((chunk:{web?:{uri?:string,title?:string}})=>({title:String(chunk.web?.title||''),url:String(chunk.web?.uri||'')}))
      .filter((source:{title:string,url:string})=>source.url.startsWith('https://'))
      .filter((source:{title:string,url:string},index:number,sources:{title:string,url:string}[])=>sources.findIndex(item=>item.url===source.url)===index)
      .slice(0,5);
    const hasUsefulResult=[result.artist,result.title,result.catalogNo,result.aTitle,result.bTitle].some(value=>String(value||'').trim())||Number(result.year)>0;
    const nextData={...record.data,artist:result.artist||record.data.artist||'AIリソースなし',title:result.title||record.data.title,year:Number(result.year)||0,genre:result.genre||'Other',catalogNo:result.catalogNo||'',aTitle:result.aTitle||'',bTitle:result.bTitle||'',notes:[result.notes,!hasUsefulResult?'画像とウェブ検索からレコード情報を確認できませんでした。':'',`AI信頼度 ${Math.round((Number(result.confidence)||0)*100)}%`].filter(Boolean).join(' / '),aiConfidence:Number(result.confidence)||0,aiNeedsReview:Boolean(result.needsReview),aiSources};
    const aiStatus=!hasUsefulResult?'no_resources':result.needsReview||Number(result.confidence)<.75?'review':'complete';
    const {error:updateError}=await client.from('records').update({data:nextData,ai_status:aiStatus,ai_error:null,updated_at:new Date().toISOString()}).eq('id',recordId);
    if(updateError)throw updateError;
    return jsonResponse({ok:true,status:aiStatus});
  }catch(error){await client.from('records').update({ai_status:'error',ai_error:String(error?.message||error),updated_at:new Date().toISOString()}).eq('id',recordId);return jsonResponse({error:String(error?.message||error)},500)}
});
