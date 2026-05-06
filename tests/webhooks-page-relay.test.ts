import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import WebhooksPage from "../client/src/pages/webhooks";

vi.stubGlobal("React", React);

function renderPageWithCache(records: {
  webhookData?: { logs: any[]; total: number };
  relayData?: { entries: any[] };
}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  if (records.webhookData) {
    client.setQueryData(["/api/webhook-logs?limit=50&offset=0"], records.webhookData);
    const webhookLogIds = records.webhookData.logs.map((log) => log.id).join(",");
    if (records.relayData) {
      client.setQueryData([`/api/trockcrm-relay-outbox?webhookLogIds=${webhookLogIds}`], records.relayData);
    }
  }
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(WebhooksPage),
    ),
  );
}

describe("webhook monitor TrockCRM relay observability", () => {
  it("renders relay status for webhook rows", () => {
    const html = renderPageWithCache({
      webhookData: {
        total: 1,
        logs: [
          {
            id: 77,
            createdAt: "2026-05-01T12:00:00.000Z",
            source: "procore",
            eventType: "create",
            resourceType: "projects",
            resourceId: "598134326517540",
            status: "processed",
            payload: {},
            response: null,
            retryCount: 0,
            maxRetries: 3,
            processingTimeMs: 145,
            errorMessage: null,
          },
        ],
      },
      relayData: {
        entries: [
          {
            id: 12,
            webhookLogId: 77,
            status: "sent",
            attempts: 1,
            sentAt: "2026-05-01T12:01:00.000Z",
          },
        ],
      },
    });

    expect(html).toContain("TrockCRM Relay");
    expect(html).toContain("sent");
    expect(html).toContain("projects #598134326517540");
  });

  it("renders the existing empty webhook state when there are no logs", () => {
    const html = renderPageWithCache({
      webhookData: {
        total: 0,
        logs: [],
      },
    });

    expect(html).toContain("No webhook deliveries yet");
  });
});
