/**
 * One-time migration: Add google_review_link and google_review_clicked
 * to closeout_surveys if they don't exist (schema drift from older deploys).
 */
import { pool } from "./db";

export async function ensureCloseoutSurveyColumns(): Promise<void> {
  try {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'closeout_surveys' AND column_name = 'google_review_link'
        ) THEN
          ALTER TABLE closeout_surveys ADD COLUMN google_review_link TEXT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'closeout_surveys' AND column_name = 'google_review_clicked'
        ) THEN
          ALTER TABLE closeout_surveys ADD COLUMN google_review_clicked BOOLEAN DEFAULT false;
        END IF;
      END $$;
    `);
    console.log("[migrate] closeout_surveys columns ensured");
  } catch (e) {
    console.error("[migrate] Failed to ensure closeout_surveys columns:", e);
    throw e;
  }
}
