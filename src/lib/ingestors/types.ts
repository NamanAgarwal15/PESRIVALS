// One interface for every way a match can enter the system. Each ingestor turns
// its raw input into the same validated ExtractedMatch plus a confidence report.

import type { ConfidenceReport } from "@/lib/confidence";
import type { ExtractedMatch } from "@/lib/match-schema";

export type IngestSource = "screenshot" | "import";

export type IngestFailureCode =
  | "invalid_image"
  | "too_large"
  | "not_stats_screen"
  | "not_configured"
  | "unavailable"
  | "invalid_data";

export type IngestResult =
  | { ok: true; extracted: ExtractedMatch; confidence: ConfidenceReport }
  | { ok: false; code: IngestFailureCode; error: string };

export interface MatchTelemetryIngestor<Input> {
  readonly source: IngestSource;
  ingest(input: Input): Promise<IngestResult>;
}
