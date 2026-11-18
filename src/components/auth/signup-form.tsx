"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { type SignUpState, signUpAction } from "@/lib/auth-actions";
import { Field, FormError } from "./form-parts";

const initialState: SignUpState = {};

export function SignupForm() {
  const [state, formAction, pending] = useActionState(signUpAction, initialState);
  const errors = state.errors ?? {};
  const values = state.values;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {errors.form ? <FormError>{errors.form}</FormError> : null}
      <Field
        label="Username"
        name="username"
        type="text"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={20}
        hint="3 to 20 characters: lowercase letters, numbers or underscores."
        error={errors.username}
        defaultValue={values?.username ?? ""}
        required
      />
      <Field
        label="Display name"
        name="displayName"
        type="text"
        autoComplete="name"
        maxLength={40}
        error={errors.displayName}
        defaultValue={values?.displayName ?? ""}
        required
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={8}
        maxLength={128}
        hint="At least 8 characters, with a letter and a number."
        error={errors.password}
        required
      />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        hint="Used for account recovery and login codes."
        error={errors.email}
        defaultValue={values?.email ?? ""}
        required
      />
      <div className="flex flex-col gap-1.5">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="agree"
            value="true"
            className="mt-1 h-4 w-4 accent-(--primary)"
            required
          />
          <span>
            I agree to the{" "}
            <a href="/terms" className="text-primary underline-offset-4 hover:underline">
              Terms
            </a>{" "}
            &amp;{" "}
            <a href="/privacy" className="text-primary underline-offset-4 hover:underline">
              Privacy Policy
            </a>{" "}
            and consent to my aggregated career stats appearing on the public leaderboard.
          </span>
        </label>
        {errors.agree ? <p className="text-sm text-destructive">{errors.agree}</p> : null}
      </div>
      <Button
        type="submit"
        size="lg"
        disabled={pending}
        className="h-12 w-full text-base font-semibold"
      >
        {pending ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
