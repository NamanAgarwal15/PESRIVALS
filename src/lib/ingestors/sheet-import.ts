import { assessConfidence } from "@/lib/confidence";
import { extractedMatchSchema } from "@/lib/match-schema";
import type { IngestResult, MatchTelemetryIngestor } from "./types";

/**
 * Historical spreadsheet rows, already parsed into left/right sides (see
 * scripts/sheet-parser.mjs). Values get the same validation as a screenshot;
 * rows with gaps come back with yellow flags instead of being dropped.
 */
export const SheetImportIngestor: MatchTelemetryIngestor<{ left: unknown; right: unknown }> = {
  source: "import",
  async ingest(row): Promise<IngestResult> {
    const parsed = extractedMatchSchema.safeParse(row);
    if (!parsed.success) {
      return { ok: false, code: "invalid_data", error: "That row is not a valid match." };
    }
    return { ok: true, extracted: parsed.data, confidence: assessConfidence(parsed.data) };
  },
};
