/**
 * Migration: Ensure closeout_surveys has all required columns
 * (google_review columns + 6-question rating columns).
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
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'closeout_surveys' AND column_name = 'rating_overall_experience'
        ) THEN
          ALTER TABLE closeout_surveys ADD COLUMN rating_overall_experience INTEGER;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'closeout_surveys' AND column_name = 'rating_communication'
        ) THEN
          ALTER TABLE closeout_surveys ADD COLUMN rating_communication INTEGER;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'closeout_surveys' AND column_name = 'rating_schedule'
        ) THEN
          ALTER TABLE closeout_surveys ADD COLUMN rating_schedule INTEGER;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'closeout_surveys' AND column_name = 'rating_quality'
        ) THEN
          ALTER TABLE closeout_surveys ADD COLUMN rating_quality INTEGER;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'closeout_surveys' AND column_name = 'rating_hire_again'
        ) THEN
          ALTER TABLE closeout_surveys ADD COLUMN rating_hire_again INTEGER;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'closeout_surveys' AND column_name = 'rating_referral'
        ) THEN
          ALTER TABLE closeout_surveys ADD COLUMN rating_referral INTEGER;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'closeout_surveys' AND column_name = 'rating_average'
        ) THEN
          ALTER TABLE closeout_surveys ADD COLUMN rating_average TEXT;
        END IF;
      END $$;
    `);
    console.log("[migrate] closeout_surveys columns ensured");
  } catch (e) {
    console.error("[migrate] Failed to ensure closeout_surveys columns:", e);
    throw e;
  }
}
