(()=>{
  const config=window.VINYL_CLOUD_CONFIG||{};
  const configured=Boolean(config.url&&config.publishableKey&&window.supabase?.createClient);
  let client=null;
  let currentUser=null;
  let syncing=false;
  let rerun=false;
  const pendingDeleteKey='vinyl-archive-pending-deletes';
  const $=selector=>document.querySelector(selector);

  function updateStatus(state,label){const button=$('#syncStatus');if(!button)return;button.className=`sync-status ${state}`;button.querySelector('span').textContent=label;button.title=label}
  function localRecords(){return (window.vinylApp?.getRecords?.()||[]).filter(record=>!String(record.id).startsWith('demo-'))}
  function dataUrlToBlob(dataUrl){const [meta,data]=dataUrl.split(','),mime=meta.match(/data:(.*?);/)?.[1]||'image/jpeg',bytes=atob(data),array=new Uint8Array(bytes.length);for(let i=0;i<bytes.length;i++)array[i]=bytes.charCodeAt(i);return new Blob([array],{type:mime})}
  function cleanRecord(record){const copy={...record};delete copy.cover;delete copy.coverPath;delete copy.syncStatus;return copy}
  function pendingDeletes(){try{return JSON.parse(localStorage.getItem(pendingDeleteKey)||'[]')}catch{return[]}}
  function setPendingDeletes(ids){localStorage.setItem(pendingDeleteKey,JSON.stringify([...new Set(ids)]))}

  async function uploadRecord(record){let coverPath=record.coverPath||null;if(record.cover?.startsWith('data:image/')){const blob=dataUrlToBlob(record.cover),extension={'image/png':'png','image/webp':'webp','image/heic':'heic','image/heif':'heif'}[blob.type]||'jpg';coverPath=`${currentUser.id}/${record.id}.${extension}`;const {error:uploadError}=await client.storage.from('record-covers').upload(coverPath,blob,{contentType:blob.type||'image/jpeg',upsert:true});if(uploadError)throw uploadError}const now=new Date().toISOString();const {error}=await client.from('records').upsert({id:record.id,user_id:currentUser.id,data:cleanRecord(record),cover_path:coverPath,ai_status:record.aiStatus||'pending',updated_at:now},{onConflict:'id'});if(error)throw error;record.coverPath=coverPath;record.syncStatus='synced';if(['pending','error'].includes(record.aiStatus||'pending')&&coverPath){record.aiStatus='processing';window.vinylApp?.replaceRecords?.(window.vinylApp.getRecords());const {error:analysisError}=await client.functions.invoke('analyze-record',{body:{recordId:record.id}});if(analysisError){record.aiStatus='pending';window.vinylApp?.replaceRecords?.(window.vinylApp.getRecords());console.warn('AI analysis request failed; the record will be retried on the next sync',analysisError)}}}

  async function removePendingRecords(){const pending=pendingDeletes().map(item=>typeof item==='string'?{id:item,coverPath:null}:item);if(!pending.length)return;const {error}=await client.from('records').delete().in('id',pending.map(item=>item.id));if(error)throw error;const paths=pending.map(item=>item.coverPath).filter(Boolean);if(paths.length)await client.storage.from('record-covers').remove(paths);setPendingDeletes([])}

  async function downloadRecords(){const {data,error}=await client.from('records').select('id,data,cover_path,ai_status,updated_at').order('created_at',{ascending:false});if(error)throw error;const hydrated=await Promise.all((data||[]).map(async row=>{let cover='';if(row.cover_path){const {data:signed}=await client.storage.from('record-covers').createSignedUrl(row.cover_path,60*60*24*7);cover=signed?.signedUrl||''}return {...row.data,id:row.id,cover,coverPath:row.cover_path,aiStatus:row.ai_status,syncStatus:'synced'}}));window.vinylApp?.replaceRecords?.(hydrated)}

  async function syncAll(){if(!configured||!currentUser||!navigator.onLine)return;if(syncing){rerun=true;return}syncing=true;updateStatus('syncing','同期中…');try{await removePendingRecords();const items=localRecords();for(let index=0;index<items.length;index+=2)await Promise.all(items.slice(index,index+2).map(uploadRecord));await downloadRecords();updateStatus('synced','同期済み')}catch(error){console.error(error);updateStatus('error','同期を再試行');window.vinylApp?.notify?.('同期できませんでした。端末内に保持し、オンライン時に再試行します')}finally{syncing=false;if(rerun){rerun=false;syncAll()}}}

  function showRequiredLogin(){const dialog=$('#syncDialog');if(dialog&&!dialog.open)dialog.showModal();updateStatus('required','ログインが必要')}
  async function sendMagicLink(email){const redirectTo=`${location.origin}${location.pathname}`;const {error}=await client.auth.signInWithOtp({email,options:{emailRedirectTo:redirectTo}});if(error)throw error;$('#syncLoginForm').classList.add('sent');$('#syncLoginMessage').textContent='メールを送信しました。届いたリンクを開くと、自動同期が始まります。'}

  async function initCloudSync(){if(!configured){updateStatus('setup','同期設定中');return}client=window.supabase.createClient(config.url,config.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});client.auth.onAuthStateChange((_event,session)=>{currentUser=session?.user||null;if(currentUser){$('#syncDialog')?.close();syncAll()}else showRequiredLogin()});const {data}=await client.auth.getSession();currentUser=data.session?.user||null;if(currentUser)await syncAll();else showRequiredLogin()}

  window.queueCloudSync=()=>{if(configured&&currentUser)syncAll();else if(configured)showRequiredLogin()};
  window.deleteCloudRecord=(id,coverPath)=>{setPendingDeletes([...pendingDeletes(),{id,coverPath}]);window.queueCloudSync()};
  window.initCloudSync=initCloudSync;
  window.addEventListener('online',()=>window.queueCloudSync());
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')window.queueCloudSync()});
  $('#syncDialog')?.addEventListener('cancel',event=>event.preventDefault());
  $('#syncLoginForm')?.addEventListener('submit',async event=>{event.preventDefault();const button=$('#syncLoginButton'),email=new FormData(event.currentTarget).get('email');button.disabled=true;$('#syncLoginMessage').textContent='ログインメールを送信しています…';try{await sendMagicLink(email)}catch(error){$('#syncLoginMessage').textContent=`送信できませんでした：${error.message}`}finally{button.disabled=false}});
  $('#syncStatus')?.addEventListener('click',()=>{if(!configured)return window.vinylApp?.notify?.('クラウド同期の接続設定中です');if(currentUser)syncAll();else showRequiredLogin()});
})();
