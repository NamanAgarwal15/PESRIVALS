import Link from "next/link";
import { Suspense } from "react";
import { getSession } from "@/lib/session";

const CLASS =
  "self-start text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline";

export function BackLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} className={CLASS}>
      {children}
    </Link>
  );
}

async function AuthAwareBackInner({ fallbackHref }: { fallbackHref: string }) {
  const session = await getSession();
  return session?.user?.id ? (
    <BackLink href="/home">← Back to Home</BackLink>
  ) : (
    <BackLink href={fallbackHref}>← Back</BackLink>
  );
}

/** "← Back to Home" when signed in, otherwise "← Back" to the fallback. */
export function AuthAwareBack({ fallbackHref = "/" }: { fallbackHref?: string }) {
  return (
    <Suspense fallback={<BackLink href={fallbackHref}>← Back</BackLink>}>
      <AuthAwareBackInner fallbackHref={fallbackHref} />
    </Suspense>
  );
}
