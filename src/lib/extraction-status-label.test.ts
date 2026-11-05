import { describe, expect, it } from "vitest";
import {
  formatExtractionStatusLabel,
  formatExtractionStatusLine,
  formatValidationStatusLine,
  resolveValidationDisplayStatus,
} from "./extraction-status-label";

describe("extraction-status-label", () => {
  it("formats extraction categories for display", () => {
    expect(formatExtractionStatusLabel("pass")).toBe("PASS");
    expect(formatExtractionStatusLabel("partial_extraction")).toBe("PARTIAL EXTRACTION");
    expect(formatExtractionStatusLabel("auth_failure")).toBe("AUTH FAILURE");
    expect(formatExtractionStatusLabel("browserless_timeout")).toBe("BROWSERLESS TIMEOUT");
    expect(formatExtractionStatusLabel("fail")).toBe("FAILED");
    expect(formatExtractionStatusLabel("cancelled")).toBe("CANCELLED");
    expect(formatExtractionStatusLabel("empty_extraction")).toBe("FAILED");
  });

  it("formats extraction line with Attempts", () => {
    expect(formatExtractionStatusLine("pass", 1)).toBe(
      "Extraction Status: PASS · Attempts: 1",
    );
    expect(formatExtractionStatusLine("pass", 2)).toBe(
      "Extraction Status: PASS · Attempts: 2",
    );
    expect(formatExtractionStatusLine("auth_failure", 1)).toBe(
      "Extraction Status: AUTH FAILURE · Attempts: 1",
    );
  });

  it("case 1: extraction pass + comparison pass", () => {
    expect(resolveValidationDisplayStatus("pass", "pass")).toBe("PASS");
    expect(formatValidationStatusLine("pass", "pass")).toBe("Validation Status: PASS");
  });

  it("case 2: extraction pass + comparison fail", () => {
    expect(resolveValidationDisplayStatus("pass", "fail")).toBe("FAIL");
    expect(formatValidationStatusLine("pass", "fail")).toBe("Validation Status: FAIL");
  });

  it("case 3: partial extraction → validation FAIL", () => {
    expect(formatExtractionStatusLabel("partial_extraction")).toBe("PARTIAL EXTRACTION");
    expect(resolveValidationDisplayStatus("partial_extraction", "pass")).toBe("FAIL");
  });

  it("case 4: auth failure → validation FAIL", () => {
    expect(formatExtractionStatusLabel("auth_failure")).toBe("AUTH FAILURE");
    expect(resolveValidationDisplayStatus("auth_failure", "pass")).toBe("FAIL");
  });

  it("case 5: browserless timeout → validation FAIL", () => {
    expect(formatExtractionStatusLabel("browserless_timeout")).toBe("BROWSERLESS TIMEOUT");
    expect(resolveValidationDisplayStatus("browserless_timeout", "fail")).toBe("FAIL");
  });

  it("case 6: cancelled must not show validation PASS", () => {
    expect(formatExtractionStatusLabel("cancelled")).toBe("CANCELLED");
    expect(resolveValidationDisplayStatus("cancelled", "pass")).toBe("FAIL");
    expect(formatValidationStatusLine("cancelled", "pass")).toBe("Validation Status: FAIL");
  });
});
