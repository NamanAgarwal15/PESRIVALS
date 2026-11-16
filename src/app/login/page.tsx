import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthShell } from "@/components/auth/auth-shell";
import { OrDivider } from "@/components/auth/form-parts";
import { GoogleButton } from "@/components/auth/google-button";
import { LoginForm } from "@/components/auth/login-form";
import { OauthError } from "@/components/auth/oauth-error";
import { isGoogleEnabled } from "@/lib/auth-helpers";

export const metadata: Metadata = { title: "Log in | PESRIVALS" };

export default function LoginPage() {
  const googleEnabled = isGoogleEnabled();

  return (
    <AuthShell
      title="Log in"
      description="Welcome back. Your rivals are waiting."
      footer={
        <>
          New here?{" "}
          <Link href="/signup" className="text-primary underline-offset-4 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <Suspense fallback={null}>
        <OauthError />
      </Suspense>
      <LoginForm />
      {googleEnabled ? (
        <>
          <OrDivider />
          <GoogleButton />
        </>
      ) : null}
    </AuthShell>
  );
}
