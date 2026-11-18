"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { CountryCodeSelect } from "./country-code-select";
import { type LoginState, loginAction } from "@/lib/auth-actions";
import { Field, FormError } from "./form-parts";

const initialState: LoginState = {};

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state.error ? <FormError>{state.error}</FormError> : null}
      <div className="flex gap-2">
        <CountryCodeSelect />
        <div className="flex-1">
          <Field
            label="Username, email or phone"
            name="identifier"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            hint="The country code applies when you type a phone number."
            defaultValue={state.identifier ?? ""}
            required
          />
        </div>
      </div>
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
      <a
        href="/forgot-password"
        className="text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Forgot your password?
      </a>
    </form>
  );
}
