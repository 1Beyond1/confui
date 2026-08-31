import { describe, expect, it } from "vitest";
import { formatDisplayValue } from "../web/src/value-display.ts";

describe("save diff value display", () => {
  it("renders BigInt and TOML special floats without throwing or losing their meaning", () => {
    expect(formatDisplayValue(9223372036854775807n)).toBe("9223372036854775807");
    expect(formatDisplayValue(Infinity)).toBe("inf");
    expect(formatDisplayValue(-Infinity)).toBe("-inf");
    expect(formatDisplayValue(Number.NaN)).toBe("nan");
  });
});
