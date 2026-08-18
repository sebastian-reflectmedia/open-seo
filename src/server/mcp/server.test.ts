import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenSeoMcpServer } from "./server";

const mcpServerMocks = vi.hoisted(() => ({
  registerTool: vi.fn<(name: string, ...args: unknown[]) => void>(),
}));

vi.mock("@modelcontextprotocol/server", () => ({
  McpServer: class {
    registerTool(name: string, ...args: unknown[]) {
      mcpServerMocks.registerTool(name, ...args);
    }
  },
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: vi.fn(),
  env: {},
  waitUntil: vi.fn(),
}));

vi.mock("@/server/mcp/instrumentation", () => ({
  instrumentMcpToolHandler: (
    _name: string,
    _outputSchema: unknown,
    handler: unknown,
  ) => handler,
}));

describe("createOpenSeoMcpServer", () => {
  beforeEach(() => {
    mcpServerMocks.registerTool.mockClear();
  });

  it("does not expose GA4-backed tools while OAuth approval is pending", () => {
    createOpenSeoMcpServer({
      openSeoAuth: {
        userId: "user-1",
        userEmail: "user@example.com",
        organizationId: "org-1",
        baseUrl: "https://example.com",
      },
    });

    const registeredToolNames = mcpServerMocks.registerTool.mock.calls.map(
      ([name]) => name,
    );

    expect(registeredToolNames).toContain("whoami");
    expect(registeredToolNames).toContain("get_search_console_performance");
    expect(registeredToolNames).not.toContain(
      "get_google_analytics_organic_landing_pages",
    );
    expect(registeredToolNames).not.toContain(
      "get_google_analytics_page_performance",
    );
    expect(registeredToolNames).not.toContain(
      "get_google_analytics_key_events",
    );
    expect(registeredToolNames).not.toContain("get_search_opportunities");
    expect(registeredToolNames).not.toContain(
      "get_google_analytics_organic_overview",
    );
    expect(registeredToolNames).not.toContain(
      "get_google_analytics_traffic_acquisition",
    );
    expect(registeredToolNames).not.toContain(
      "get_google_analytics_measurement_health",
    );
    expect(registeredToolNames).not.toContain(
      "get_google_analytics_ecommerce_performance",
    );
    expect(registeredToolNames).not.toContain(
      "get_google_analytics_site_search",
    );
    expect(registeredToolNames).not.toContain(
      "get_google_analytics_audience_breakdown",
    );
  });
});
