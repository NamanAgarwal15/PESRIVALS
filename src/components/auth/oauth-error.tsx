"use client";

import { useSearchParams } from "next/navigation";
import { FormError } from "./form-parts";

// Auth.js sends failed OAuth sign-ins back to /login?error=<code>.
// Must be rendered inside <Suspense> because it reads the URL.
export function OauthError() {
  const error = useSearchParams().get("error");
  if (!error) return null;
  return <FormError>Could not sign you in. Please try again.</FormError>;
}
