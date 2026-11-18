"use client";

import { type ReactNode, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ConfidenceReport } from "@/lib/confidence";
import { saveExtractedMatch } from "@/lib/match-actions";
import type { ExtractedMatch } from "@/lib/match-schema";
import {
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MIME_TYPES,
  STAT_KEYS,
  STAT_LABELS,
} from "@/lib/match-stats";

type Side = "left" | "right";
type Host = "home" | "away";

const ACCEPT = SCREENSHOT_MIME_TYPES.join(",");
// Vercel rejects request bodies over 4.5 MB (before our route runs), so every
// phone-sized screenshot is re-encoded in the browser: max 1600px, JPEG 0.85.
const DOWNSCALE_ABOVE_BYTES = 1 * 1024 * 1024;
const DOWNSCALE_MAX_EDGE = 1600;
const UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;

async function shrinkIfLarge(file: File): Promise<File> {
  if (file.size <= DOWNSCALE_ABOVE_BYTES) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, DOWNSCALE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (blob && blob.size < file.size) {
      return new File([blob], "screenshot.jpg", { type: "image/jpeg" });
    }
  } catch {
    // Fall through and upload the original.
  }
  return file;
}

export function UploadMatchPanel({
  rivalryId,
  myUsername,
  opponentUsername,
}: {
  rivalryId: string;
  myUsername: string;
  opponentUsername: string;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<ExtractedMatch | null>(null);
  const [confidence, setConfidence] = useState<ConfidenceReport | null>(null);
  const [mySide, setMySide] = useState<Side | null>(null);
  const [host, setHost] = useState<Host | null>(null);
  const [decidedOnPens, setDecidedOnPens] = useState(false);
  const [remark, setRemark] = useState("");
  const [saving, startSaving] = useTransition();
  const pensId = useId();
  const remarkId = useId();

  function reset() {
    setExtracted(null);
    setConfidence(null);
    setMySide(null);
    setHost(null);
    setDecidedOnPens(false);
    setRemark("");
    setError(null);
  }

  async function onFileChosen(chosen: File | undefined) {
    if (fileInput.current) fileInput.current.value = ""; // allow re-picking the same file
    if (!chosen) return;
    setError(null);

    if (!(SCREENSHOT_MIME_TYPES as readonly string[]).includes(chosen.type)) {
      setError("Upload a PNG, JPG or WEBP screenshot.");
      return;
    }

    setAnalyzing(true);
    try {
      const file = await shrinkIfLarge(chosen);
      if (file.size > UPLOAD_LIMIT_BYTES || file.size > SCREENSHOT_MAX_BYTES) {
        setError("That image is too large (over 4 MB) even after shrinking. Upload a smaller screenshot.");
        return;
      }
      const body = new FormData();
      body.append("screenshot", file);
      const response = await fetch(`/api/rivalry/${rivalryId}/extract`, {
        method: "POST",
        body,
      });
      if (response.status === 413) {
        setError("That image is too large to upload. Use a smaller screenshot.");
        return;
      }
      const result = (await response.json().catch(() => null)) as
        | { ok: true; extracted: ExtractedMatch; confidence?: ConfidenceReport }
        | { ok: false; error?: string }
        | null;

      if (result?.ok) {
        reset();
        setExtracted(result.extracted);
        setConfidence(result.confidence ?? null);
      } else {
        setError(result?.error ?? "Could not read that screenshot. Please try again.");
      }
    } catch {
      setError("Could not upload the screenshot. Check your connection and try again.");
    } finally {
      setAnalyzing(false);
    }
  }

  function save() {
    if (!extracted || !mySide || !host) return;
    setError(null);
    startSaving(async () => {
      const result = await saveExtractedMatch({
        rivalryId,
        extracted,
        mySide,
        host,
        decidedOnPens,
        remark,
        needsReview: confidence?.hasYellow ?? false,
      });
      if (result.ok) {
        toast.success(`Match #${result.matchNo} saved`);
        reset();
      } else {
        setError(result.error);
      }
    });
  }

  // ---- Step 1: upload ----
  if (!extracted) {
    return (
      <div className="flex flex-col gap-3">
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          aria-label="Match stats screenshot"
          disabled={analyzing}
          onChange={(event) => onFileChosen(event.target.files?.[0])}
        />
        <Button
          type="button"
          size="lg"
          disabled={analyzing}
          onClick={() => fileInput.current?.click()}
          className="h-12 w-full text-base font-semibold"
        >
          {analyzing ? "Analyzing screenshot with AI..." : "Add Match Screenshot"}
        </Button>
        {analyzing ? (
          <p role="status" className="text-center text-sm text-muted-foreground">
            This usually takes a few seconds.
          </p>
        ) : (
          <p className="text-center text-xs text-muted-foreground">
            Upload the Full Time stats screen (PNG, JPG or WEBP, up to 8 MB).
          </p>
        )}
        {error ? <PanelError>{error}</PanelError> : null}
      </div>
    );
  }

  // ---- Step 2: read-only review + match context ----
  const { left, right } = extracted;
  const isYellow = (side: Side, key: string) =>
    (confidence?.yellow[side] as string[] | undefined)?.includes(key) ?? false;

  return (
    <Card>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-2xl font-semibold tracking-wide uppercase">Check the match</h2>
          <p className="text-sm text-muted-foreground">
            Read from your screenshot. These numbers cannot be edited.
          </p>
        </div>

        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-center">
          <SideHeading label="Left" team={left.team} />
          <p className="font-heading text-4xl font-bold whitespace-nowrap text-primary">
            {left.goals} – {right.goals}
          </p>
          <SideHeading label="Right" team={right.team} />
        </div>

        {confidence?.hasYellow ? (
          <div
            role="status"
            className="rounded-lg border border-draw/50 bg-draw/10 px-3 py-2 text-sm"
          >
            <p className="font-semibold text-draw">Yellow: please double-check these against your screenshot</p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {confidence.warnings.slice(0, 8).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted-foreground">
              It still saves and counts right away, but the match is marked for review.
            </p>
          </div>
        ) : (
          <p className="text-sm font-medium text-win">Green: every value looks consistent.</p>
        )}

        <dl className="flex flex-col divide-y divide-border text-sm">
          {STAT_KEYS.map((key) => (
            <div key={key} className="grid grid-cols-[3.5rem_1fr_3.5rem] items-center py-1.5">
              <dd
                data-confidence={isYellow("left", key) ? "yellow" : "green"}
                className={`rounded-md px-1 text-left font-semibold tabular-nums ${isYellow("left", key) ? "bg-draw/20 text-draw ring-1 ring-draw/50" : ""}`}
              >
                {left[key] ?? "–"}
              </dd>
              <dt className="text-center text-muted-foreground">{STAT_LABELS[key]}</dt>
              <dd
                data-confidence={isYellow("right", key) ? "yellow" : "green"}
                className={`rounded-md px-1 text-right font-semibold tabular-nums ${isYellow("right", key) ? "bg-draw/20 text-draw ring-1 ring-draw/50" : ""}`}
              >
                {right[key] ?? "–"}
              </dd>
            </div>
          ))}
        </dl>

        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={saving}
          onClick={reset}
          className="h-10 w-full"
        >
          Wrong screenshot? Re-upload
        </Button>

        <Choice
          legend="Which side are you?"
          name="mySide"
          value={mySide}
          onChange={setMySide}
          disabled={saving}
          options={[
            { value: "left", label: `Left (${left.team})` },
            { value: "right", label: `Right (${right.team})` },
          ]}
        />

        <Choice
          legend="Who hosted?"
          name="host"
          value={host}
          onChange={setHost}
          disabled={saving}
          options={[
            { value: "home", label: `Home (@${myUsername})` },
            { value: "away", label: `Away (@${opponentUsername})` },
          ]}
        />

        <div className="flex items-start gap-3">
          <input
            id={pensId}
            type="checkbox"
            checked={decidedOnPens}
            disabled={saving}
            onChange={(event) => setDecidedOnPens(event.target.checked)}
            className="mt-0.5 size-5 shrink-0 accent-primary"
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor={pensId}>Decided on penalties</Label>
            <p className="text-xs text-muted-foreground">
              Counts as a draw in rivalry standings regardless of score
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={remarkId}>Remark (optional)</Label>
          <Input
            id={remarkId}
            value={remark}
            maxLength={200}
            disabled={saving}
            onChange={(event) => setRemark(event.target.value)}
            placeholder="e.g. Last-minute winner"
            className="h-11"
          />
        </div>

        {error ? <PanelError>{error}</PanelError> : null}

        <Button
          type="button"
          size="lg"
          disabled={!mySide || !host || saving}
          onClick={save}
          className="h-12 w-full text-base font-semibold"
        >
          {saving ? "Saving…" : "Save Match"}
        </Button>
        {!mySide || !host ? (
          <p className="-mt-3 text-center text-xs text-muted-foreground">
            Choose your side and who hosted to save.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SideHeading({ label, team }: { label: string; team: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <span className="font-heading text-xl leading-tight font-semibold break-words">
        {team}
      </span>
    </div>
  );
}

function PanelError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {children}
    </p>
  );
}

function Choice<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  disabled,
}: {
  legend: string;
  name: string;
  value: T | null;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="grid grid-cols-2 gap-2">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-input px-3 py-2 text-center text-sm font-medium break-words transition-colors has-checked:border-primary has-checked:bg-primary has-checked:text-primary-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50 has-disabled:cursor-not-allowed has-disabled:opacity-50"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
