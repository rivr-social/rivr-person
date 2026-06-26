import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchDataSourceContent } from "./data-source-registry";

describe("builder data source registry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not fetch REA sources without selected source ids", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchDataSourceContent("rivr-resources", {
      scopeTypes: ["document"],
      scopeIds: [],
    });

    expect(result).toEqual({
      label: "My Resources",
      data: null,
      error: "My Resources requires at least one selected source item.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes explicit selected ids to the REA source endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ items: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchDataSourceContent("rivr-resources", {
      scopeTypes: ["document"],
      scopeIds: ["resource-1", "resource-2"],
    });

    expect(result).toEqual({
      label: "My Resources",
      data: { items: [] },
      error: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/builder/rea-source?kind=rivr-resources&types=document&ids=resource-1%2Cresource-2",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
      }),
    );
  });
});
