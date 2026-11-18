import { extractMatchFromScreenshot } from "@/lib/gemini-extract";
import type { IngestResult, MatchTelemetryIngestor } from "./types";

/** Screenshot ingestion through the Gemini vision extractor. */
export const VisionVlmIngestor: MatchTelemetryIngestor<{ bytes: Uint8Array }> = {
  source: "screenshot",
  ingest: (image): Promise<IngestResult> => extractMatchFromScreenshot(image),
};
