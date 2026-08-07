// Varre o catalogo inteiro da Nuvemshop, casa cada variante pelo campo
// "barcode" com o barcode dos nossos produtos, e grava o resultado em
// nuvemshop_product_map. E essa tabela que permite empurrar baixa de
// estoque em 1 chamada por item vendido (sem precisar buscar o produto
// na Nuvemshop toda hora). Chamado manualmente pelo botao "Sincronizar
// catalogo com Nuvemshop" na aba Backup & Dados — Kennedy roda de novo
// sempre que adicionar produtos novos na loja Nuvemshop.
//
// verify_jwt fica no padrao (true) — so usuarios logados no sistema
// podem disparar isso.

import { getNuvemshopCredentials, nuvemshopFetch, serviceClient } from "../_shared/nuvemshop.ts";

Deno.serve(async () => {
  try {
    const supabase = serviceClient();
    const { store_id, access_token } = await getNuvemshopCredentials(supabase);

    const { data: ourProducts, error: prodErr } = await supabase
      .from("products")
      .select("barcode");
    if (prodErr) throw new Error(`Falha ao ler produtos: ${prodErr.message}`);
    const ourBarcodes = new Set((ourProducts ?? []).map((p) => p.barcode).filter(Boolean));

    const nuvemshopBarcodeMap = new Map<string, { productId: string; variantId: string }>();
    let page = 1;
    const perPage = 100;
    let scanned = 0;

    while (true) {
      const resp = await nuvemshopFetch(
        store_id,
        access_token,
        `/products?page=${page}&per_page=${perPage}&fields=id,variants`,
      );
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Nuvemshop GET /products falhou (${resp.status}): ${errText}`);
      }
      const batch = await resp.json();
      if (!Array.isArray(batch) || batch.length === 0) break;

      for (const product of batch) {
        for (const variant of product.variants ?? []) {
          scanned++;
          if (variant.barcode) {
            nuvemshopBarcodeMap.set(String(variant.barcode), {
              productId: String(product.id),
              variantId: String(variant.id),
            });
          }
        }
      }

      if (batch.length < perPage) break;
      page++;
      if (page > 100) break; // trava de seguranca, catalogo nao deveria passar de ~10 mil variantes
    }

    const rows = [];
    for (const barcode of ourBarcodes) {
      const match = nuvemshopBarcodeMap.get(String(barcode));
      if (match) {
        rows.push({
          barcode,
          nuvemshop_product_id: match.productId,
          nuvemshop_variant_id: match.variantId,
          updated_at: new Date().toISOString(),
        });
      }
    }

    if (rows.length > 0) {
      const { error: upsertErr } = await supabase
        .from("nuvemshop_product_map")
        .upsert(rows, { onConflict: "barcode" });
      if (upsertErr) throw new Error(`Falha ao gravar mapa: ${upsertErr.message}`);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        variantesNaNuvemshop: scanned,
        produtosNoSistema: ourBarcodes.size,
        casados: rows.length,
        semCorrespondencia: ourBarcodes.size - rows.length,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("nuvemshop-sync-catalog error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: String(err instanceof Error ? err.message : err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
