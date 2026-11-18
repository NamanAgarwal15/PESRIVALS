import type { Metadata } from "next";
import Link from "next/link";
import { AuthAwareBack } from "@/components/nav/back-link";

export const metadata: Metadata = { title: "Terms of Service | PESRIVALS" };

export default function Page() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 text-sm leading-relaxed">
      <AuthAwareBack />
      <h1 className="text-3xl font-bold tracking-wide uppercase">Terms of Service</h1>
      <p className="text-muted-foreground">Last updated: 18 November 2026</p>
      <h2 className="text-lg font-semibold">Using PESRIVALS</h2>
      <p>PESRIVALS is a hobby tool for tracking eFootball rivalries between friends. You are responsible for the accuracy of the matches you log and for keeping your account credentials safe.</p>
      <h2 className="text-lg font-semibold">Acceptable use</h2>
      <p>Do not log fraudulent results, harass other players, or attempt to access other accounts. Administrators may remove matches, suspend accounts or hide leaderboard entries to protect the service.</p>
      <h2 className="text-lg font-semibold">Leaderboard consent</h2>
      <p>By signing up you consent to your aggregated career stats appearing on the global leaderboard, as described in the <Link href="/privacy" className="text-primary underline-offset-4 hover:underline">Privacy Policy</Link>. You can make your profile and rivalry details private to other players in Profile &amp; Security; administrators retain access for moderation.</p>
      <h2 className="text-lg font-semibold">No warranty</h2>
      <p>The service is provided as is, without warranties of any kind.</p>
    </main>
  );
}
