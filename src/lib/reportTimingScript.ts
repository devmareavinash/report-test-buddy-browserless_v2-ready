import { parse } from "acorn";
import { instrumentReportTiming } from "../../supabase/functions/_shared/script-timing";

export const timeReportScript = (source: string) => instrumentReportTiming(source, parse);