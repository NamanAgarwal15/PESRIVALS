// Resend v6 resolves with { error } instead of throwing; the helper must
// trim env values, inspect that error, and never throw.

import { afterEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    constructor(public key: string) {
      keys.push(key);
    }
    emails = { send };
  },
}));
const keys: string[] = [];

import { sendEmail } from "@/lib/email";

const msg = { to: "a@example.com", subject: "s", text: "t" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  send.mockReset();
  keys.length = 0;
});

describe("sendEmail", () => {
  it("returns false (and does not call Resend) without an API key", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendEmail(msg)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("trims the key and sender and reports success", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key\r\n");
    vi.stubEnv("RESET_EMAIL_FROM", "  PESRIVALS <hi@example.com>\n");
    send.mockResolvedValue({ data: { id: "1" }, error: null });
    expect(await sendEmail(msg)).toBe(true);
    expect(keys[0]).toBe("re_test_key");
    expect(send.mock.calls[0][0].from).toBe("PESRIVALS <hi@example.com>");
  });

  it("treats a returned { error } as failure and logs name/message, not the key", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_secret_value");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    send.mockResolvedValue({
      data: null,
      error: { name: "validation_error", statusCode: 403, message: "only your own address" },
    });
    expect(await sendEmail(msg)).toBe(false);
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain("validation_error");
    expect(line).toContain("403");
    expect(line).not.toContain("re_secret_value");
  });

  it("swallows thrown network errors", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_x");
    vi.spyOn(console, "error").mockImplementation(() => {});
    send.mockRejectedValue(new Error("boom"));
    expect(await sendEmail(msg)).toBe(false);
  });
});
