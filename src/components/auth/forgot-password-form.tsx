"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { type ForgotPasswordState, forgotPasswordAction } from "@/lib/auth-actions";
import { PhoneField } from "./form-parts";

const initialState: ForgotPasswordState = {};

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(forgotPasswordAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state.message ? (
        <p className="rounded-md bg-secondary px-3 py-2 text-sm text-secondary-foreground">
          {state.message}
        </p>
      ) : null}
      <PhoneField
        label="Email or phone"
        name="identifier"
        type="tel"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        hint="Email works as-is; for a phone number pick its country code. We email a reset link."
        defaultValue={state.values?.identifier ?? ""}
        required
      />
      <Button
        type="submit"
        size="lg"
        disabled={pending}
        className="h-12 w-full text-base font-semibold"
      >
        {pending ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
