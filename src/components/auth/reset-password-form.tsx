"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { type ResetPasswordState, resetPasswordAction } from "@/lib/auth-actions";
import { Field, FormError } from "./form-parts";

const initialState: ResetPasswordState = {};

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(resetPasswordAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state.error ? <FormError>{state.error}</FormError> : null}
      <input type="hidden" name="token" value={token} />
      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={8}
        maxLength={128}
        hint="At least 8 characters, with a letter and a number."
        required
      />
      <Button
        type="submit"
        size="lg"
        disabled={pending || !token}
        className="h-12 w-full text-base font-semibold"
      >
        {pending ? "Resetting…" : "Reset password"}
      </Button>
    </form>
  );
}
