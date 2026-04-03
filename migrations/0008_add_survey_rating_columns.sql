-- Add individual rating columns for 6-question survey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='closeout_surveys' AND column_name='rating_overall_experience') THEN
    ALTER TABLE closeout_surveys ADD COLUMN rating_overall_experience INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='closeout_surveys' AND column_name='rating_communication') THEN
    ALTER TABLE closeout_surveys ADD COLUMN rating_communication INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='closeout_surveys' AND column_name='rating_schedule') THEN
    ALTER TABLE closeout_surveys ADD COLUMN rating_schedule INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='closeout_surveys' AND column_name='rating_quality') THEN
    ALTER TABLE closeout_surveys ADD COLUMN rating_quality INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='closeout_surveys' AND column_name='rating_hire_again') THEN
    ALTER TABLE closeout_surveys ADD COLUMN rating_hire_again INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='closeout_surveys' AND column_name='rating_referral') THEN
    ALTER TABLE closeout_surveys ADD COLUMN rating_referral INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='closeout_surveys' AND column_name='rating_average') THEN
    ALTER TABLE closeout_surveys ADD COLUMN rating_average TEXT;
  END IF;
END $$;
