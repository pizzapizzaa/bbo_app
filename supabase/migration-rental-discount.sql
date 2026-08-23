-- ── Rental Discount On Referral / Promo Codes ────────────────────────────────
-- Adds referral_codes.rental_discount_pct, which the app has queried since
-- "feat(referrals): per-code discount on shoe & chalk rental".
--
-- The same statements are in schema.sql, but they were appended to a file that
-- is only ever run on a fresh database, so an existing gym never received the
-- column. Every query naming it then failed with 42703 (undefined_column),
-- which took out the Promo Codes page, the referral panel on a customer, and
-- the check-in code lookup all at once.
--
-- Safe to run more than once, and safe to run on a database that already has
-- the column — ADD COLUMN IF NOT EXISTS is a no-op there, and the UPDATE only
-- touches the two codes named below.
--
-- Run it in the Supabase SQL editor (Dashboard → SQL Editor → New query).

-- 0 = gear rentals are charged in full, which is right for every other code.
-- Only the rental add-ons (Shoes Rental, Liquid Chalk Rental, Chalk Bag Rental)
-- are affected — retail add-ons (drinks, chalk balls, socks) never discount.
ALTER TABLE referral_codes
  ADD COLUMN IF NOT EXISTS rental_discount_pct INTEGER NOT NULL DEFAULT 0;

-- Hanie's and Huy Phan's codes give 50% off shoe and chalk rental.
UPDATE referral_codes SET rental_discount_pct = 50
WHERE upper(code) IN ('HANIE10', 'HUYPHAN10');
