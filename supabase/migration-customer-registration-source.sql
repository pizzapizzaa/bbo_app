ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS registration_source TEXT NOT NULL DEFAULT 'unknown'
  CHECK (registration_source IN ('unknown', 'self', 'staff', 'import'));