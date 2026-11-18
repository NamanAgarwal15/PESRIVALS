import { COUNTRY_CODES, DEFAULT_COUNTRY_CODE } from "@/lib/country-codes";

/** Country calling-code dropdown shown next to phone inputs. */
export function CountryCodeSelect({
  name = "countryCode",
  defaultValue = DEFAULT_COUNTRY_CODE,
}: {
  name?: string;
  defaultValue?: string;
}) {
  return (
    <select
      name={name}
      defaultValue={defaultValue}
      aria-label="Phone country code"
      className="h-11 shrink-0 self-stretch rounded-md border border-input bg-secondary px-2 text-sm text-secondary-foreground"
    >
      {COUNTRY_CODES.map((c) => (
        <option key={c.code} value={c.code}>
          {c.code}
        </option>
      ))}
    </select>
  );
}
