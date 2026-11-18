import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthShell } from "@/components/auth/auth-shell";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export const metadata: Metadata = { title: "Reset password | PESRIVALS" };

export default function ResetPasswordPage({
  searchParams,
}: PageProps<"/reset-password">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
      <ResetPasswordContent searchParams={searchParams} />
    </Suspense>
  );
}

// Reads the URL (searchParams), so it streams in behind the Suspense boundary.
async function ResetPasswordContent({
  searchParams,
}: Pick<PageProps<"/reset-password">, "searchParams">) {
  const { token } = (await searchParams) ?? {};
  const validToken = typeof token === "string" && /^[0-9a-f]{64}$/.test(token) ? token : "";

  return (
    <AuthShell
      title="Reset password"
      description={
        validToken
          ? "Choose a new password for your account."
          : "This reset link is missing or malformed. Request a new one."
      }
      footer={
        <Link href="/forgot-password" className="text-primary underline-offset-4 hover:underline">
          Request a new link
        </Link>
      }
    >
      {validToken ? (
        <ResetPasswordForm token={validToken} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Reset links expire after 15 minutes and can only be used once.
        </p>
      )}
    </AuthShell>
  );
}
