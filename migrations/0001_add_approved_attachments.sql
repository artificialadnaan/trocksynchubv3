-- Add approved_attachments column to rfp_approval_requests
ALTER TABLE rfp_approval_requests ADD COLUMN IF NOT EXISTS approved_attachments jsonb;
