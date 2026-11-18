// Country calling codes offered next to phone inputs (default: India).
export type CountryCode = { code: string; label: string };

export const COUNTRY_CODES: CountryCode[] = [
  { code: "+91", label: "🇮🇳 +91 India" },
  { code: "+1", label: "🇺🇸 +1 USA/Canada" },
  { code: "+44", label: "🇬🇧 +44 UK" },
  { code: "+971", label: "🇦🇪 +971 UAE" },
  { code: "+61", label: "🇦🇺 +61 Australia" },
  { code: "+49", label: "🇩🇪 +49 Germany" },
  { code: "+65", label: "🇸🇬 +65 Singapore" },
  { code: "+966", label: "🇸🇦 +966 Saudi Arabia" },
  { code: "+33", label: "🇫🇷 +33 France" },
  { code: "+81", label: "🇯🇵 +81 Japan" },
  { code: "+55", label: "🇧🇷 +55 Brazil" },
];

export const DEFAULT_COUNTRY_CODE = "+91";

export const COUNTRY_CODE_VALUES = COUNTRY_CODES.map((c) => c.code);

/** True when the code is one of the offered options. */
export function isValidCountryCode(value: unknown): value is string {
  return typeof value === "string" && COUNTRY_CODE_VALUES.includes(value);
}

/**
 * Smart E.164 handling: if the phone already starts with "+" keep it as-is;
 * otherwise prepend the selected country code. Indian numbers can be typed
 * as 10 digits without +91.
 */
export function applyCountryCode(phone: string, countryCode: string): string {
  const trimmed = phone.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("+")) return trimmed;
  const cc = isValidCountryCode(countryCode) ? countryCode : DEFAULT_COUNTRY_CODE;
  return `${cc}${trimmed.replace(/^[0+]+/, "")}`;
}
