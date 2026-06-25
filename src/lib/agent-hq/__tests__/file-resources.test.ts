import { describe, expect, it } from "vitest";
import {
  resourceTypeForMime,
  shapeShareEmbed,
  type ShareableFileResource,
} from "@/lib/agent-hq/file-resources";

describe("resourceTypeForMime", () => {
  it("maps media MIME families to their media resource type", () => {
    expect(resourceTypeForMime("image/png")).toBe("image");
    expect(resourceTypeForMime("image/jpeg")).toBe("image");
    expect(resourceTypeForMime("video/mp4")).toBe("video");
    expect(resourceTypeForMime("audio/mpeg")).toBe("audio");
  });

  it("maps PDFs and text to document", () => {
    expect(resourceTypeForMime("application/pdf")).toBe("document");
    expect(resourceTypeForMime("text/plain")).toBe("document");
    expect(resourceTypeForMime("text/markdown")).toBe("document");
  });

  it("falls back to file for unknown, empty, or binary types", () => {
    expect(resourceTypeForMime("application/octet-stream")).toBe("file");
    expect(resourceTypeForMime("application/zip")).toBe("file");
    expect(resourceTypeForMime("")).toBe("file");
    expect(resourceTypeForMime(null)).toBe("file");
    expect(resourceTypeForMime(undefined)).toBe("file");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resourceTypeForMime("  IMAGE/PNG  ")).toBe("image");
    expect(resourceTypeForMime("Application/PDF")).toBe("document");
  });
});

describe("shapeShareEmbed", () => {
  const base: ShareableFileResource = {
    name: "Quarterly Report",
    type: "file",
    url: "https://cdn.example/report.pdf",
    contentType: "application/pdf",
  };

  it("returns an image embed for image resources (by type or content type)", () => {
    expect(
      shapeShareEmbed({ ...base, type: "image", contentType: null, url: "https://cdn/x.png" }),
    ).toEqual({ url: "https://cdn/x.png", kind: "image" });
    expect(
      shapeShareEmbed({ ...base, type: "file", contentType: "image/gif", url: "https://cdn/y.gif" }),
    ).toEqual({ url: "https://cdn/y.gif", kind: "image" });
  });

  it("returns a titled link embed for non-image files", () => {
    expect(shapeShareEmbed(base)).toEqual({
      url: "https://cdn.example/report.pdf",
      kind: "link",
      ogTitle: "Quarterly Report",
    });
  });

  it("omits ogTitle when the resource has no name", () => {
    expect(shapeShareEmbed({ ...base, name: null })).toEqual({
      url: "https://cdn.example/report.pdf",
      kind: "link",
    });
  });

  it("returns null when there is no resolvable url", () => {
    expect(shapeShareEmbed({ ...base, url: null })).toBeNull();
    expect(shapeShareEmbed({ ...base, url: "   " })).toBeNull();
  });
});
