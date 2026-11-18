"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/** One-click copy of a short value (e.g. an eFootball ID). */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard blocked: the value is still visible to select manually.
        }
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}
