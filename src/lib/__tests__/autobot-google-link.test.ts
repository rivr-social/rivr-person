import { describe, expect, it } from "vitest";
import {
  GOOGLE_BASE_SCOPES,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_SCOPE_TO_CONNECTOR_MAP,
  mapGrantedScopesToProviders,
} from "@/lib/autobot-google-link";

describe("GOOGLE_OAUTH_SCOPES", () => {
  it("requests identity scopes plus every connector-bearing feature scope", () => {
    for (const base of GOOGLE_BASE_SCOPES) {
      expect(GOOGLE_OAUTH_SCOPES).toContain(base);
    }
    for (const scope of Object.keys(GOOGLE_SCOPE_TO_CONNECTOR_MAP)) {
      expect(GOOGLE_OAUTH_SCOPES).toContain(scope);
    }
  });

  it("covers Calendar, Gmail, and Drive/Docs connectors up front", () => {
    const providers = new Set(Object.values(GOOGLE_SCOPE_TO_CONNECTOR_MAP));
    expect(providers).toContain("google_calendar");
    expect(providers).toContain("google_docs");
    expect(providers).toContain("gmail");
  });
});

describe("mapGrantedScopesToProviders", () => {
  it("maps a full grant to all three connectors", () => {
    const grants = mapGrantedScopesToProviders(GOOGLE_OAUTH_SCOPES.join(" "));
    const providers = grants.map((grant) => grant.provider).sort();
    expect(providers).toEqual(["gmail", "google_calendar", "google_docs"]);
  });

  it("collapses Drive + Docs scopes into a single google_docs grant", () => {
    const grants = mapGrantedScopesToProviders(
      "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file",
    );
    expect(grants).toHaveLength(1);
    expect(grants[0].provider).toBe("google_docs");
    expect(grants[0].scopes).toHaveLength(2);
  });

  it("handles a partial grant — only the granted connector is provisioned", () => {
    const grants = mapGrantedScopesToProviders(
      "openid email profile https://www.googleapis.com/auth/calendar",
    );
    expect(grants).toHaveLength(1);
    expect(grants[0].provider).toBe("google_calendar");
  });

  it("ignores identity-only and unknown scopes", () => {
    expect(mapGrantedScopesToProviders("openid email profile")).toEqual([]);
    expect(mapGrantedScopesToProviders("https://example.com/unknown")).toEqual([]);
  });

  it("returns nothing for empty / null input", () => {
    expect(mapGrantedScopesToProviders("")).toEqual([]);
    expect(mapGrantedScopesToProviders(null)).toEqual([]);
    expect(mapGrantedScopesToProviders(undefined)).toEqual([]);
  });
});
