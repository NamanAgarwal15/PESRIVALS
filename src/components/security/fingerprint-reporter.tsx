"use client";

// Silent, once-a-day device check-in for signed-in pages. Sends only a SHA-256
// digest. Everything is best effort: errors are swallowed.

import { useEffect } from "react";
import { collectFingerprintHash } from "@/lib/fingerprint";

const KEY = "pesrivals:fp-day";

export function FingerprintReporter() {
  useEffect(() => {
    (async () => {
      const day = new Date().toISOString().slice(0, 10);
      try {
        if (sessionStorage.getItem(KEY) === day) return;
      } catch {
        // storage blocked: still report once per mount
      }
      const fingerprintHash = await collectFingerprintHash();
      const res = await fetch("/api/security/fingerprint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprintHash }),
      });
      if (res.ok) {
        try {
          sessionStorage.setItem(KEY, day);
        } catch {
          // ignore
        }
      }
    })().catch(() => {});
  }, []);
  return null;
}
