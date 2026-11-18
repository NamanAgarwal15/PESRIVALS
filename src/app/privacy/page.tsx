import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy Policy | PESRIVALS" };

export default function Page() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 text-sm leading-relaxed">
      <h1 className="text-3xl font-bold tracking-wide uppercase">Privacy Policy</h1>
      <p className="text-muted-foreground">Last updated: 18 November 2026</p>
      <h2 className="text-lg font-semibold">What we store</h2>
      <p>Your username, display name, hashed password, optional recovery email and phone, and the matches you log with your rivals. Passwords, login codes and reset tokens are stored only as hashes.</p>
      <h2 className="text-lg font-semibold">What is public</h2>
      <p>If the public leaderboard setting is on (the default), your username, display name and aggregated career stats across all rivalries (matches, W-D-L, win %, goals, goal difference, average possession, pass accuracy, clean sheets and recent form) appear on the global leaderboard. Individual rivalry scores, head-to-head results, emails and phone numbers are never shown publicly.</p>
      <h2 className="text-lg font-semibold">Your choices</h2>
      <p>You can opt out of the leaderboard at any time from your account settings on the home page. Your email and phone are used only for login codes and account recovery.</p>
      <h2 className="text-lg font-semibold">Contact</h2>
      <p>To request correction or deletion of your data, contact the site administrator.</p>
      <Link href="/" className="text-primary underline-offset-4 hover:underline">
        Back to PESRIVALS
      </Link>
    </main>
  );
}
