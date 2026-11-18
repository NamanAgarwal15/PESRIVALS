"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { loginWithOtpAction, loginAction, sendOtpAction } from "@/lib/auth-actions";
import { Field, FormError } from "./form-parts";

type Mode = "username" | "email";
type Method = "password" | "otp";

const initialState = { error: undefined, identifier: "" } as {
  error?: string;
  identifier?: string;
};

function SubmitButton({ pending }: { pending: boolean }) {
  return (
    <Button
      type="submit"
      size="lg"
      disabled={pending}
      className="h-12 w-full text-base font-semibold"
    >
      {pending ? "Logging in…" : "Log in"}
    </Button>
  );
}

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);
  const [mode, setMode] = useState<Mode>("username");
  const [method, setMethod] = useState<Method>("password");
  const [identifier, setIdentifier] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpMessage, setOtpMessage] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState("");
  const [otpBusy, setOtpBusy] = useState(false);

  async function requestOtp() {
    setOtpBusy(true);
    setOtpMessage(null);
    const fd = new FormData();
    fd.set("identifier", identifier);
    const result = await sendOtpAction(fd);
    setOtpMessage(result.message);
    setOtpSent(result.ok);
    setOtpBusy(false);
  }

  async function submitOtp(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setOtpBusy(true);
    const fd = new FormData();
    fd.set("identifier", identifier);
    fd.set("code", otpCode);
    try {
      await loginWithOtpAction(fd);
    } catch {
      // NEXT_REDIRECT bubbles up for Next.js; anything else is a bad code.
      setOtpMessage("That code is wrong or has expired. Request a new one.");
    } finally {
      setOtpBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Login mode tabs: Username | Email */}
      <div
        role="tablist"
        aria-label="Login method"
        className="grid grid-cols-2 gap-1 rounded-full bg-secondary p-1"
      >
        {(
          [
            ["username", "Username"],
            ["email", "Email"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={mode === value}
            type="button"
            onClick={() => {
              setMode(value);
              setMethod("password");
              setOtpSent(false);
              setOtpMessage(null);
            }}
            className={`rounded-full px-2 py-1.5 text-xs font-bold tracking-wide uppercase transition-colors ${
              mode === value
                ? "bg-primary text-primary-foreground"
                : "text-secondary-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "username" ? (
        <form action={formAction} className="flex flex-col gap-4">
          {state.error ? <FormError>{state.error}</FormError> : null}
          <Field
            label="Username"
            name="identifier"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="enter_username"
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
          <SubmitButton pending={pending} />
        </form>
      ) : method === "password" ? (
        <form action={formAction} className="flex flex-col gap-4">
          {state.error ? <FormError>{state.error}</FormError> : null}
                      <Field
              label="Email"
              name="identifier"
              type="email"
              autoComplete="email"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
            />
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <SubmitButton pending={pending} />
          <button
            type="button"
            onClick={() => {
              setMethod("otp");
              setOtpSent(false);
              setOtpMessage(null);
            }}
            className="text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Login with OTP instead
          </button>
        </form>
      ) : (
        <form onSubmit={submitOtp} className="flex flex-col gap-4">
          {otpMessage ? (
            <p className="rounded-md bg-secondary px-3 py-2 text-sm text-secondary-foreground">
              {otpMessage}
            </p>
          ) : null}
                      <Field
              label="Email"
              name="identifier"
              type="email"
              autoComplete="email"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              disabled={otpSent}
              required
            />
          {otpSent ? (
            <>
              <Field
                label="6-digit code"
                name="code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value)}
                required
              />
              <Button
                type="submit"
                size="lg"
                disabled={otpBusy}
                className="h-12 w-full text-base font-semibold"
              >
                {otpBusy ? "Verifying…" : "Verify & log in"}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setOtpSent(false);
                  setOtpMessage(null);
                  setOtpCode("");
                }}
                className="text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Use a different email
              </button>
            </>
          ) : (
            <>
              <Button
                type="button"
                size="lg"
                disabled={otpBusy || identifier.trim().length === 0}
                onClick={requestOtp}
                className="h-12 w-full text-base font-semibold"
              >
                {otpBusy ? "Sending…" : "Send login code"}
              </Button>
              <button
                type="button"
                onClick={() => setMethod("password")}
                className="text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Use password instead
              </button>
            </>
          )}
        </form>
      )}

      <a
        href="/forgot-password"
        className="text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Forgot your password?
      </a>
    </div>
  );
}
