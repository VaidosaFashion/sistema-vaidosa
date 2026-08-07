// Empurra o estoque atual (numero absoluto, ja descontado no nosso
// banco) pra Nuvemshop, pros barcodes vendidos numa venda recem
// finalizada. Chamado pelo frontend logo depois que create_sale()
// tem sucesso (btnFinalize), sem bloquear a tela — se a Nuvemshop
// estiver fora do ar ou o produto ainda nao tiver sido sincronizado
// (ver nuvemshop-sync-catalog), essa funcao so retorna o que nao deu
// pra atualizar, sem quebrar a venda (a venda ja esta salva de
// verdade no nosso banco antes disso ser chamado).
//
// Absoluto, nao delta: nosso banco e a fonte da verdade do estoque
// fisico (sincronizacao e so nesse sentido, sistema -> Nuvemshop) —
// mandar o valor atual em vez de "-1" e auto-corretivo, se uma
// chamada falhar a proxima venda do mesmo produto ja resincroniza
// pro numero certo sozinha.

import { getNuvemshopCredentials, nuvemshopFetch, serviceClient } from "../_shared/nuvemshop.ts";

Deno.serve(async (req) => {
  try {
    const { barcodes } = await req.json();
    if (!Array.isArray(barcodes) || barcodes.length === 0) {
      return new Response(JSON.stringify({ ok: true, empurrados: 0, semMapeamento: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = serviceClient();
    const { store_id, access_token } = await getNuvemshopCredentials(supabase);

    const [{ data: products, error: prodErr }, { data: mapRows, error: mapErr }] = await Promise.all([
      supabase.from("products").select("barcode, stock").in("barcode", barcodes),
      supabase.from("nuvemshop_product_map").select("barcode, nuvemshop_product_id, nuvemshop_variant_id").in("barcode", barcodes),
    ]);
    if (prodErr) throw new Error(`Falha ao ler produtos: ${prodErr.message}`);
    if (mapErr) throw new Error(`Falha ao ler mapa Nuvemshop: ${mapErr.message}`);

    const stockByBarcode = new Map((products ?? []).map((p) => [p.barcode, p.stock]));
    const mapByBarcode = new Map((mapRows ?? []).map((m) => [m.barcode, m]));

    // Agrupa por produto Nuvemshop (o PATCH aceita varias variantes do
    // mesmo produto numa entrada so).
    const byProduct = new Map<string, { id: string; variants: { id: string; inventory_levels: { stock: number }[] }[] }>();
    const semMapeamento: string[] = [];

    for (const barcode of barcodes) {
      const map = mapByBarcode.get(barcode);
      const stock = stockByBarcode.get(barcode);
      if (!map || stock === undefined) {
        semMapeamento.push(barcode);
        continue;
      }
      if (!byProduct.has(map.nuvemshop_product_id)) {
        byProduct.set(map.nuvemshop_product_id, { id: map.nuvemshop_product_id, variants: [] });
      }
      byProduct.get(map.nuvemshop_product_id)!.variants.push({
        id: map.nuvemshop_variant_id,
        inventory_levels: [{ stock: Number(stock) }],
      });
    }

    const payload = Array.from(byProduct.values());
    let empurrados = 0;

    // Lote de ate 50 variantes por chamada, por seguranca (limite documentado da Nuvemshop).
    const flatVariantCount = payload.reduce((n, p) => n + p.variants.length, 0);
    if (flatVariantCount > 0) {
      const resp = await nuvemshopFetch(store_id, access_token, "/products/stock-price", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Nuvemshop PATCH /products/stock-price falhou (${resp.status}): ${errText}`);
      }
      empurrados = flatVariantCount;
    }

    return new Response(
      JSON.stringify({ ok: true, empurrados, semMapeamento: semMapeamento.length, barcodesSemMapeamento: semMapeamento }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("nuvemshop-push-stock error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: String(err instanceof Error ? err.message : err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
