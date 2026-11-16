import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AuthShell } from "@/components/auth/auth-shell";
import { OnboardingForm } from "@/components/auth/onboarding-form";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Choose a username | PESRIVALS" };

export default function OnboardingPage() {
  return (
    <AuthShell
      title="Choose a username"
      description="One last step: claim the username your rivals will find you by."
    >
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <OnboardingGate />
      </Suspense>
    </AuthShell>
  );
}

// Reads the session, so it has to stream in behind the Suspense boundary.
async function OnboardingGate() {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  if (session.user.onboarded) redirect("/home");
  return <OnboardingForm />;
}
