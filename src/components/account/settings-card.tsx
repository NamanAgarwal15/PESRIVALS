"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type AccountSettingsState, updateAccountSettingsAction } from "@/lib/auth-actions";
import { Field, FormError, PhoneField } from "@/components/auth/form-parts";

export function SettingsCard({
  email,
  phone,
  publicLeaderboard,
}: {
  email: string | null;
  phone: string | null;
  publicLeaderboard: boolean;
}) {
  const [state, action, pending] = useActionState<AccountSettingsState, FormData>(
    updateAccountSettingsAction,
    {},
  );
  const errors = state.errors ?? {};
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile recovery &amp; privacy</CardTitle>
        <CardDescription>
          Add or update the email and phone used for login codes and password recovery.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-4">
          {errors.form ? <FormError>{errors.form}</FormError> : null}
          {state.message ? <p className="text-sm text-win">{state.message}</p> : null}
          <Field
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            defaultValue={state.values?.email ?? email ?? ""}
            error={errors.email}
            required
          />
          <PhoneField
            label="Phone"
            name="phone"
            type="tel"
            autoComplete="tel-national"
            hint={phone ? `Currently ${phone}. Leave blank to keep it.` : "Indian numbers work without +91."}
            defaultValue={state.values?.phone ?? ""}
            error={errors.phone}
          />
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="publicLeaderboard"
              value="true"
              defaultChecked={state.values?.publicLeaderboard ?? publicLeaderboard}
              className="mt-1 h-4 w-4 accent-(--primary)"
            />
            <span>Show my aggregated career stats on the public leaderboard.</span>
          </label>
          <Button type="submit" size="lg" disabled={pending} className="h-11">
            {pending ? "Saving…" : "Save settings"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
