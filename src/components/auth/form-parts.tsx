import type { ComponentProps, ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

export function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground uppercase">
      <span className="h-px flex-1 bg-border" />
      or
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
