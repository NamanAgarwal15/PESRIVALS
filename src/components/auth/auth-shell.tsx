import Link from "next/link";
import type { ReactNode } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Shared frame for the login, sign-up and onboarding screens.
export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex flex-1 flex-col justify-center gap-6 py-4">
      <Link
        href="/"
        className="self-center font-heading text-3xl font-bold tracking-wide text-primary uppercase"
      >
        PESRIVALS
      </Link>
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl font-semibold tracking-wide uppercase">
            <h1>{title}</h1>
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
      {footer ? (
        <p className="text-center text-sm text-muted-foreground">{footer}</p>
      ) : null}
    </main>
  );
}
