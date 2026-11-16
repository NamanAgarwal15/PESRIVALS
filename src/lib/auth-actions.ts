"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { auth, signIn, signOut, unstable_update } from "@/auth";
import {
  type FieldErrors,
  GENERIC_LOGIN_ERROR,
  claimUsername,
  isGoogleEnabled,
  signUpUser,
} from "@/lib/auth-helpers";

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

export type SignUpState = {
  errors?: FieldErrors;
  // Echoed back so the form keeps what was typed. Never includes the password.
  values?: { username: string; displayName: string; email: string; phone: string };
};

export async function signUpAction(
  _prev: SignUpState,
  formData: FormData,
): Promise<SignUpState> {
  const values = {
    username: text(formData, "username"),
    displayName: text(formData, "displayName"),
    email: text(formData, "email"),
    phone: text(formData, "phone"),
  };
  const password = text(formData, "password");

  const result = await signUpUser({ ...values, password });
  if (!result.ok) return { errors: result.errors, values };

  try {
    // Throws a redirect to /home once the session cookie is set.
    await signIn("credentials", {
      identifier: result.user.username,
      password,
      redirectTo: "/home",
    });
  } catch (err) {
    // The account exists but the automatic sign-in failed: send them to log in.
    if (err instanceof AuthError) redirect("/login");
    throw err;
  }
  return {};
}

export type LoginState = { error?: string; identifier?: string };

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const identifier = text(formData, "identifier");
  try {
    await signIn("credentials", {
      identifier,
      password: text(formData, "password"),
      redirectTo: "/home",
    });
  } catch (err) {
    // Unknown user, wrong password and throttled all look the same.
    if (err instanceof AuthError) return { error: GENERIC_LOGIN_ERROR, identifier };
    throw err;
  }
  return {};
}

export async function googleSignInAction(): Promise<void> {
  if (!isGoogleEnabled()) redirect("/login");
  await signIn("google", { redirectTo: "/home" });
}

export async function logoutAction(): Promise<void> {
  await signOut({ redirectTo: "/" });
}

export type OnboardingState = { error?: string; username?: string };

export async function claimUsernameAction(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (session.user.onboarded) redirect("/home");

  const username = text(formData, "username");
  const result = await claimUsername(session.user.id, username);
  if (!result.ok) return { error: result.error, username };

  // Re-issue the session cookie with the new username and onboarded = true.
  await unstable_update({});
  redirect("/home");
}
