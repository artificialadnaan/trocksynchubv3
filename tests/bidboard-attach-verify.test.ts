import { describe, expect, it, vi } from "vitest";
import { waitForAttachModalToClose } from "../server/playwright/attach-verify";

describe("waitForAttachModalToClose", () => {
  it("returns false when the Attach Files modal never closes (timeout)", async () => {
    // Procore closes the Attach modal only on a committed attach; a timeout means it did NOT commit.
    const page = { waitForFunction: vi.fn().mockRejectedValue(new Error("Timeout 60000ms exceeded")) } as any;
    const closed = await waitForAttachModalToClose(page, 50);
    expect(closed).toBe(false);
  });

  it("returns true when the modal closes", async () => {
    const page = { waitForFunction: vi.fn().mockResolvedValue(true) } as any;
    const closed = await waitForAttachModalToClose(page, 50);
    expect(closed).toBe(true);
  });

  it("passes the configured timeout through to waitForFunction", async () => {
    const waitForFunction = vi.fn().mockResolvedValue(true);
    const page = { waitForFunction } as any;
    await waitForAttachModalToClose(page, 1234);
    expect(waitForFunction).toHaveBeenCalledWith(expect.any(Function), undefined, { timeout: 1234 });
  });
});
