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
        maxLength={72}
        hint="At least 8 characters."
        error={errors.password}
        required
      />
      <Field
        label="Email (optional)"
        name="email"
        type="email"
        autoComplete="email"
        error={errors.email}
        defaultValue={values?.email ?? ""}
      />
      <Field
        label="Phone (optional)"
        name="phone"
        type="tel"
        autoComplete="tel"
        hint="Indian numbers work without +91. Add the country code for others."
        error={errors.phone}
        defaultValue={values?.phone ?? ""}
      />
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
