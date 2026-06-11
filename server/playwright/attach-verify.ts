import { Page } from "playwright";

/**
 * Confirm a BidBoard "Attach Files" upload actually committed.
 *
 * In Procore's new BidBoard UI the "Attach Files" modal closes ONLY after the attach commits — if the
 * upload fails or stalls, the modal stays open (often showing an error). So a modal that never closes
 * is the strongest available signal that the attach did NOT land.
 *
 * Returns true iff the modal closed within `timeoutMs`. Returns false on ANY wait failure — timeout,
 * page crash, navigation, etc. — so the caller can fail loudly and retry instead of swallowing the
 * failure into a hardcoded success (the bug where "Attach Files modal did not close" was followed by
 * "Successfully uploaded N file(s)" anyway).
 */
export async function waitForAttachModalToClose(page: Page, timeoutMs = 60000): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => {
        // The modal is gone when no visible "Attach Files" header remains in the DOM.
        const headers = document.querySelectorAll("div, h2, h3");
        for (const h of headers) {
          if (h.textContent?.trim() === "Attach Files" && (h as HTMLElement).offsetParent !== null) {
            return false;
          }
        }
        return true;
      },
      undefined,
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    // Treat any wait failure (timeout, page crash, navigation) as "modal not closed" → attach unconfirmed.
    return false;
  }
}
