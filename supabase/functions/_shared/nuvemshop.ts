// Cliente compartilhado pra API da Nuvemshop/Tiendanube — usado pelas
// Edge Functions nuvemshop-sync-catalog e nuvemshop-push-stock.

import { createClient } from "jsr:@supabase/supabase-js@2";

const API_VERSION = "2025-03";
const USER_AGENT = "VaidosaGestao (kennedy12395@gmail.com)";

export function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

// Loja unica (Vaidosa Fashion Plus) — pega a credencial mais recente
// caso um dia exista mais de uma linha (reconexao).
export async function getNuvemshopCredentials(supabase: ReturnType<typeof serviceClient>) {
  const { data, error } = await supabase
    .from("nuvemshop_credentials")
    .select("store_id, access_token")
    .order("connected_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Falha ao ler credenciais Nuvemshop: ${error.message}`);
  if (!data) throw new Error("Nenhuma loja Nuvemshop conectada ainda.");
  return data as { store_id: string; access_token: string };
}

export async function nuvemshopFetch(
  storeId: string,
  accessToken: string,
  path: string,
  init: RequestInit = {},
) {
  const url = `https://api.tiendanube.com/${API_VERSION}/${storeId}${path}`;
  const resp = await fetch(url, {
    ...init,
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "User-Agent": USER_AGENT,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  return resp;
}
