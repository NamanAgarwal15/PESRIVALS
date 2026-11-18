import type { ComponentProps, ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CountryCodeSelect } from "./country-code-select";

export function Field({
  label,
  hint,
  error,
  name,
  ...inputProps
}: {
  label: string;
  hint?: string;
  error?: string;
  name: string;
} & Omit<ComponentProps<"input">, "name" | "id">) {
  const errorId = `${name}-error`;
  const hintId = `${name}-hint`;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        className="h-11"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        {...inputProps}
      />
      {error ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function FormError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {children}
    </p>
  );
}

/**
 * Phone input with the country-code dropdown aligned INSIDE the input row
 * (never beside the label): label on its own line above, then
 * [ +91 ▾ ][ number ] in one `items-stretch` row of matching height.
 */
export function PhoneField({
  label,
  hint,
  error,
  name,
  selectName = "countryCode",
  ...inputProps
}: {
  label: string;
  hint?: string;
  error?: string;
  name: string;
  selectName?: string;
} & Omit<ComponentProps<"input">, "name" | "id">) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <div className="flex items-stretch gap-2">
        <CountryCodeSelect name={selectName} />
        <Input id={name} name={name} className="h-11 flex-1" {...inputProps} />
      </div>
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground uppercase">
      <span className="h-px flex-1 bg-border" />
      or
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
