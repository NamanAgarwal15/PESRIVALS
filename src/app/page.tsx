import Link from "next/link";
import { Suspense } from "react";
import { buttonVariants } from "@/components/ui/button";
import { getSession } from "@/lib/session";

const primaryCta = buttonVariants({
  size: "lg",
  className: "h-12 w-full text-base font-semibold",
});
const secondaryCta = buttonVariants({
  variant: "outline",
  size: "lg",
  className: "h-12 w-full text-base font-semibold",
});

export default function Landing() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 text-center">
      <div className="flex flex-col gap-2">
        <h1 className="text-6xl font-bold tracking-wide text-primary uppercase">
          PESRIVALS
        </h1>
        <p className="text-muted-foreground">
          Track your eFootball rivalries, match by match.
        </p>
      </div>
      <div className="flex min-h-27 w-full flex-col gap-3">
        <Suspense fallback={null}>
          <LandingActions />
        </Suspense>
      </div>
    </main>
  );
}

// Reads the session, so it has to stream in behind the Suspense boundary.
async function LandingActions() {
  const session = await getSession();

  if (session?.user?.id) {
    return (
      <Link
        href={session.user.onboarded ? "/home" : "/onboarding"}
        className={primaryCta}
      >
        Go to your home
      </Link>
    );
  }

  return (
    <>
      <Link href="/signup" className={primaryCta}>
        Sign up
      </Link>
      <Link href="/login" className={secondaryCta}>
        Log in
      </Link>
    </>
  );
}
