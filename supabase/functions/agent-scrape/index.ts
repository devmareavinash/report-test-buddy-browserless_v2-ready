import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { getSupabase } from "../_shared/llm.ts";

// Mock live-scrape: produces realistic KPI values that intentionally drift
// from the warehouse so failures appear. Real Playwright scrape requires a
// configured browser_runtime endpoint (out of scope when not configured).

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauthorized = await requireAuth(req);
  if (unauthorized) return unauthorized;
  try {
    const { report_id } = await req.json();
    const sb = getSupabase();
    const { data: report } = await sb.from("reports").select("*").eq("id", report_id).maybeSingle();
    if (!report) throw new Error("report not found");

    // Mock extracted KPIs (drift introduced for total_sales + sales_growth)
    const extracted = {
      total_sales: 1_274_900,    // warehouse: 1,287,450 → fail
      sales_growth: 7.2,         // reference: 8.7 → fail
      total_quantity: 54_820,    // matches warehouse → pass
      avg_selling_price: 23.48,  // matches → pass
      top_brand_share: 0.42,     // in range → pass
    };
    const reference = {
      total_sales: 1_287_000,
      sales_growth: 8.7,
      total_quantity: 54_700,
      avg_selling_price: 23.50,
      top_brand_share: 0.41,
    };

    return new Response(JSON.stringify({ extracted, reference, scraped_at: new Date().toISOString(), source: "mock" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
