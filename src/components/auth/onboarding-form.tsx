"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { type OnboardingState, claimUsernameAction } from "@/lib/auth-actions";
import { Field } from "./form-parts";

const initialState: OnboardingState = {};

export function OnboardingForm() {
  const [state, formAction, pending] = useActionState(
    claimUsernameAction,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field
        label="Username"
        name="username"
        type="text"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={20}
        hint="3 to 20 characters: lowercase letters, numbers or underscores. This cannot be changed here later."
        error={state.error}
        defaultValue={state.username ?? ""}
        required
      />
      <Button
        type="submit"
        size="lg"
        disabled={pending}
        className="h-12 w-full text-base font-semibold"
      >
        {pending ? "Saving…" : "Claim username"}
      </Button>
    </form>
  );
}
