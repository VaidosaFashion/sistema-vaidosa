// Callback OAuth da integracao Nuvemshop (Sistema Vaidosa).
//
// Fluxo: Kennedy clica "Instalar aplicativo" no Portal de Parceiros ->
// Nuvemshop pede autorizacao na loja dele -> Nuvemshop redireciona o
// navegador pra esta URL com ?code=... (valido por 5 minutos) -> esta
// funcao troca o code por um access_token permanente e guarda em
// nuvemshop_credentials. Nao precisa de login no Supabase (verify_jwt
// = false em supabase/config.toml), porque quem chama e o navegador do
// Kennedy vindo direto da Nuvemshop, sem sessao do nosso app.

import { createClient } from "jsr:@supabase/supabase-js@2";

const NUVEMSHOP_CLIENT_ID = Deno.env.get("NUVEMSHOP_CLIENT_ID")!;
const NUVEMSHOP_CLIENT_SECRET = Deno.env.get("NUVEMSHOP_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function htmlPage(title: string, message: string) {
  return new Response(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>${title}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#fdf2f8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
  .card{background:#fff;border-radius:16px;padding:32px 28px;max-width:420px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center}
  h1{font-size:1.15rem;margin:0 0 12px}
  p{color:#555;line-height:1.5;margin:0}
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");

  if (!code) {
    return htmlPage(
      "Faltou o codigo de autorizacao",
      "A Nuvemshop deveria ter mandado um codigo junto com esse link, mas ele nao veio. Volte pro Portal de Parceiros e tente instalar o aplicativo de novo.",
    );
  }

  const tokenResp = await fetch(
    "https://www.tiendanube.com/apps/authorize/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: NUVEMSHOP_CLIENT_ID,
        client_secret: NUVEMSHOP_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
      }),
    },
  );

  if (!tokenResp.ok) {
    const errText = await tokenResp.text();
    console.error("Nuvemshop token exchange failed:", tokenResp.status, errText);
    return htmlPage(
      "Nao deu pra concluir a conexao",
      "A Nuvemshop recusou a troca do codigo de autorizacao. Tenta instalar o aplicativo de novo — se continuar falhando, chama o suporte tecnico.",
    );
  }

  const tokenData = await tokenResp.json();
  const accessToken = tokenData.access_token as string | undefined;
  const storeId = tokenData.user_id != null ? String(tokenData.user_id) : undefined;
  const scope = tokenData.scope as string | undefined;

  if (!accessToken || !storeId) {
    console.error("Unexpected Nuvemshop token response shape:", JSON.stringify(tokenData));
    return htmlPage(
      "Resposta inesperada da Nuvemshop",
      "A conexao nao trouxe os dados esperados. Chama o suporte tecnico com esse aviso.",
    );
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { error } = await supabase
    .from("nuvemshop_credentials")
    .insert({ store_id: storeId, access_token: accessToken, scope });

  if (error) {
    console.error("Failed to persist Nuvemshop credentials:", error);
    return htmlPage(
      "Conexao feita, mas nao deu pra salvar",
      "A Nuvemshop autorizou certinho, mas o sistema nao conseguiu guardar a chave. Chama o suporte tecnico com esse aviso.",
    );
  }

  return htmlPage(
    "Loja conectada!",
    "O Sistema Vaidosa agora esta autorizado a atualizar o estoque na sua loja Nuvemshop. Pode fechar esta pagina.",
  );
});
