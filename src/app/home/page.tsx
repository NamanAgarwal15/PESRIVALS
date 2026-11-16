import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { logoutAction } from "@/lib/auth-actions";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Home | PESRIVALS" };

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col gap-6">
      <Suspense fallback={<HomeFallback />}>
        <HomeContent />
      </Suspense>
    </main>
  );
}

function HomeFallback() {
  return <p className="text-sm text-muted-foreground">Loading…</p>;
}

// Reads the session, so it has to stream in behind the Suspense boundary.
async function HomeContent() {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  if (!session.user.onboarded) redirect("/onboarding");

  return (
    <>
      <header className="flex items-center justify-between gap-4">
        <h1 className="min-w-0 truncate text-4xl font-bold tracking-wide">
          Hi @{session.user.username}
        </h1>
        <form action={logoutAction}>
          <Button type="submit" variant="outline" size="lg" className="h-10 px-4">
            Log out
          </Button>
        </form>
      </header>
      <Card>
        <CardContent className="flex flex-col items-center gap-1 py-8 text-center">
          <p className="font-heading text-2xl font-semibold tracking-wide uppercase">
            No rivalries yet
          </p>
          <p className="text-sm text-muted-foreground">
            Your 1v1 rivalries will show up here.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
