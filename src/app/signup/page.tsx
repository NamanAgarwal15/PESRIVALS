import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { OrDivider } from "@/components/auth/form-parts";
import { GoogleButton } from "@/components/auth/google-button";
import { SignupForm } from "@/components/auth/signup-form";
import { isGoogleEnabled } from "@/lib/auth-helpers";

export const metadata: Metadata = { title: "Sign up | PESRIVALS" };

export default function SignupPage() {
  const googleEnabled = isGoogleEnabled();

  return (
    <AuthShell
      title="Sign up"
      description="Pick a username your rivals will find you by."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="text-primary underline-offset-4 hover:underline">
            Log in
          </Link>
        </>
      }
    >
      {googleEnabled ? (
        <>
          <GoogleButton />
          <OrDivider />
        </>
      ) : null}
      <SignupForm />
    </AuthShell>
  );
}
