"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { sendEmail } from "@/lib/email";
import { eq } from "drizzle-orm";
import { auth, signIn, signOut, unstable_update } from "@/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  BCRYPT_COST,
  type FieldErrors,
  GENERIC_LOGIN_ERROR,
  claimUsername,
  isGoogleEnabled,
  passwordSchema,
  signUpUser,
} from "@/lib/auth-helpers";
import { LIMITS, consumeRateLimit } from "@/lib/rate-limit";
import { createPasswordResetToken, resetPasswordWithToken } from "@/lib/password-reset";
import { sendOtp } from "@/lib/otp";
import { deleteAccount } from "@/lib/account";
import { securityLog } from "@/lib/security-log";
import { setDisplayName } from "@/lib/profile";
import { revalidatePath } from "next/cache";
import { refreshLeaderboard } from "@/lib/leaderboard-cache";

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

/**
 * Rate-limit bucket key. Server Actions cannot read request headers, so the
 * salt is the identifying input (username / identifier) — a per-account
 * rather than per-IP bucket, which also works locally and in tests.
 */
function rateKey(name: string, salt: string): string {
  return `${name}:${salt.toLowerCase()}`;
}

export type SignUpState = {
  errors?: FieldErrors;
  // Echoed back so the form keeps what was typed. Never includes the password.
  values?: { username: string; displayName: string; email: string };
};

export async function signUpAction(
  _prev: SignUpState,
  formData: FormData,
): Promise<SignUpState> {
  const values = {
    username: text(formData, "username"),
    displayName: text(formData, "displayName"),
    email: text(formData, "email"),
  };
  const password = text(formData, "password");
  const agreed = formData.get("agree") === "true";
  if (!agreed) {
    return {
      errors: {
        agree:
          "Please agree to the Terms & Privacy Policy and the public leaderboard consent.",
      },
      values,
    };
  }

  // Rate limit: max 5 signups per 15 minutes per username bucket.
  const rl = await consumeRateLimit(
    rateKey("signup", values.username.toLowerCase()),
    LIMITS.signup.max,
    LIMITS.signup.windowMinutes,
  );
  if (!rl.ok) {
    return {
      errors: { form: "Too many sign-up attempts. Try again in a few minutes." },
      values,
    };
  }

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

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

export type ForgotPasswordState = { message?: string; values?: { identifier: string } };

/** Generic, non-enumerating confirmation for every forgot-password request. */
const FORGOT_CONFIRMATION =
  "If an account exists with those details, a password reset link has been sent.";

export async function forgotPasswordAction(
  _prev: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const raw = text(formData, "identifier");
  const identifier = raw.trim();
  const values = { identifier: raw };

  // Rate limit: max 3 requests per 15 minutes per identifier bucket.
  const rl = await consumeRateLimit(
    rateKey("forgot", identifier.toLowerCase()),
    LIMITS.forgotPassword.max,
    LIMITS.forgotPassword.windowMinutes,
  );
  if (!rl.ok) return { message: "Too many reset requests. Try again in a few minutes.", values };

  const result = await createPasswordResetToken(identifier, async () => "");
  if (result.ok && result.email) {
    // Failures are logged server-side by sendEmail and never shown, so the
    // response cannot reveal whether the account exists.
    await sendEmail({
      to: result.email,
      subject: "Reset your PESRIVALS password",
      text: `Use this link within 15 minutes to reset your password:

${
        process.env.NEXT_PUBLIC_SITE_URL?.trim() ?? "https://pesrivals.vercel.app"
      }/reset-password?token=${result.token}

If you did not request this, ignore this email.`,
    });
  }
  // Always the same message, whether or not the account exists.
  return { message: FORGOT_CONFIRMATION, values };
}

export type ResetPasswordState = { error?: string; token?: string };

export async function resetPasswordAction(
  _prev: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const token = text(formData, "token");
  const password = text(formData, "password");
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Enter a stronger password.", token };
  }
  const hash = await bcrypt.hash(parsed.data, BCRYPT_COST);
  const result = await resetPasswordWithToken(token, hash);
  if (!result.ok) {
    return {
      error: "That reset link is invalid or has expired. Request a new one.",
      token,
    };
  }
  redirect("/login?reset=1");
}

// ---------------------------------------------------------------------------
// Google linking from /home
// ---------------------------------------------------------------------------

/**
 * Starts the Google sign-in flow so an existing logged-in user can link a
 * Google account: matching emails (or an already-linked oauth_account) map to
 * the same users.id instead of creating a duplicate user.
 */
export async function linkGoogleAction(): Promise<void> {
  await signIn("google", { redirectTo: "/home" });
}

// ---------------------------------------------------------------------------
// OTP login
// ---------------------------------------------------------------------------

export type OtpSendState = { ok: boolean; message: string };

/** Sends a 6-digit OTP to an email address. Non-enumerating. */
export async function sendOtpAction(formData: FormData): Promise<OtpSendState> {
  const identifier = text(formData, "identifier").trim();
  if (!identifier) return { ok: false, message: "Enter your email address." };
  try {
    const result = await sendOtp(identifier);
    if (!result.ok) {
      if (result.code === "rate_limited") {
        return { ok: false, message: "Too many code requests. Try again in a few minutes." };
      }
      if (result.code === "send_failed") {
        return {
          ok: false,
          message: "Could not send the code right now. Try again or use your password.",
        };
      }
    }
  } catch {
    // Delivery failures look identical to successes: never enumerate accounts.
  }
  return {
    ok: true,
    message:
      "If an account exists with those details, a 6-digit code has been sent. It expires in 10 minutes.",
  };
}

export async function loginWithOtpAction(formData: FormData): Promise<void> {
  const identifier = text(formData, "identifier").trim();
  await signIn("otp", {
    identifier,
    code: text(formData, "code").trim(),
    redirectTo: "/home",
  });
}

// ---------------------------------------------------------------------------
// Account privacy (/home profile panel). Email and password changes
// go through OTP in profile-actions.ts and can NOT be changed here.
// ---------------------------------------------------------------------------

/** Toggles whether other (non-admin) players may inspect this profile's rivalry details. */
export async function setProfileVisibilityAction(visible: boolean): Promise<{ ok: boolean }> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  await db
    .update(users)
    .set({ publicLeaderboard: visible, updatedAt: new Date() })
    .where(eq(users.id, session.user.id));
  await unstable_update({});
  return { ok: true };
}

/** Updates the signed-in player's display name (trimmed, 2-50 characters). */
export async function updateDisplayNameAction(
  raw: string,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const result = await setDisplayName(session.user.id, typeof raw === "string" ? raw : "");
  if (result.ok) {
    revalidatePath("/home");
    revalidatePath("/leaderboard");
    refreshLeaderboard();
    revalidatePath("/player/[username]", "page");
  }
  return result;
}

/** Confirmation-gated account deletion (type DELETE). Anonymises the account and signs out. */
export async function deleteMyAccountAction(confirm: string): Promise<{ ok: false; error: string }> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (confirm !== "DELETE") return { ok: false, error: "Type DELETE to confirm." };
  const result = await deleteAccount(session.user.id);
  if (!result.ok) return result;
  securityLog("account_deleted", { userId: session.user.id }, "info");
  refreshLeaderboard();
  await signOut({ redirectTo: "/?deleted=1" });
  return { ok: false, error: "Signed out." }; // unreachable: signOut redirects
}
