import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {createClient} from 'jsr:@supabase/supabase-js@2';

// Deletes the caller's account: every photo in their Storage folder, then the
// auth user. Records, ai_usage and the AI quota rows reference auth.users with
// "on delete cascade", so deleting the user removes them too (docs/concept.md R4).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {...corsHeaders, 'Content-Type': 'application/json'},
  });

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', {headers: corsHeaders});
  if (request.method !== 'POST') return new Response('Method not allowed', {status: 405, headers: corsHeaders});

  const authorization = request.headers.get('Authorization');
  if (!authorization) return new Response('Unauthorized', {status: 401, headers: corsHeaders});
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: {headers: {Authorization: authorization}},
  });
  const {data: {user}} = await userClient.auth.getUser();
  if (!user) return new Response('Unauthorized', {status: 401, headers: corsHeaders});

  const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const bucket = admin.storage.from('record-covers');
  try {
    // Photos live at <user id>/<file>; list and remove in pages until none are left.
    for (let page = 0; page < 100; page++) {
      const {data: files, error: listError} = await bucket.list(user.id, {limit: 1000});
      if (listError) throw listError;
      if (!files?.length) break;
      const {error: removeError} = await bucket.remove(files.map((file) => `${user.id}/${file.name}`));
      if (removeError) throw removeError;
    }
    const {error: deleteError} = await admin.auth.admin.deleteUser(user.id);
    if (deleteError) throw deleteError;
  } catch (error) {
    console.error('delete-account failed', user.id, error);
    return jsonResponse({error: 'アカウントを削除できませんでした。時間をおいてもう一度お試しください。'}, 500);
  }
  return jsonResponse({ok: true});
});
