"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { CountryCodeSelect } from "./country-code-select";
import { type ForgotPasswordState, forgotPasswordAction } from "@/lib/auth-actions";
import { Field } from "./form-parts";

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
      <div className="flex gap-2">
        <CountryCodeSelect />
        <div className="flex-1">
          <Field
            label="Email or phone"
            name="identifier"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            hint="We send a reset link to your email if the account exists."
            defaultValue={state.values?.identifier ?? ""}
            required
          />
        </div>
      </div>
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
