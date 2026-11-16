"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { type LoginState, loginAction } from "@/lib/auth-actions";
import { Field, FormError } from "./form-parts";

const initialState: LoginState = {};

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state.error ? <FormError>{state.error}</FormError> : null}
      <Field
        label="Username, email or phone"
        name="identifier"
        type="text"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        defaultValue={state.identifier ?? ""}
        required
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <Button
        type="submit"
        size="lg"
        disabled={pending}
        className="h-12 w-full text-base font-semibold"
      >
        {pending ? "Logging in…" : "Log in"}
      </Button>
    </form>
  );
}
