ALTER TABLE public.checkins ADD COLUMN IF NOT EXISTS created_by TEXT;

CREATE OR REPLACE FUNCTION public.record_punch_checkin(p_checkin JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  requested public.checkins;
  recorded public.checkins;
BEGIN
  requested := jsonb_populate_record(NULL::public.checkins, p_checkin);

  IF requested.payment_method = 'Punch Card' AND requested.punch_card_holder_id IS NOT NULL
     AND requested.pt_punch_holder_id IS NULL THEN
    UPDATE public.customers SET punches_remaining = punches_remaining - 1
    WHERE id = requested.punch_card_holder_id AND punches_remaining > 0;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Punch card holder has no punches remaining.';
    END IF;
  ELSIF requested.payment_method = 'PT Punch' AND requested.pt_punch_holder_id IS NOT NULL
        AND requested.punch_card_holder_id IS NULL THEN
    UPDATE public.customers SET pt_punches_remaining = pt_punches_remaining - 1
    WHERE id = requested.pt_punch_holder_id AND pt_punches_remaining > 0;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PT punch holder has no punches remaining.';
    END IF;
  ELSE
    RAISE EXCEPTION 'Select a punch holder matching the payment method.';
  END IF;

  INSERT INTO public.checkins (
    customer_name, date, time, payment_method, amount, notes,
    punch_card_holder_id, punch_card_holder_name, pt_punch_holder_id, pt_punch_holder_name,
    checkin_type, addons, referral_code, referred_by_id, referred_by_name,
    referral_discount_pct, created_by
  ) VALUES (
    requested.customer_name, requested.date, requested.time, requested.payment_method,
    requested.amount, requested.notes, requested.punch_card_holder_id,
    requested.punch_card_holder_name, requested.pt_punch_holder_id,
    requested.pt_punch_holder_name, requested.checkin_type, requested.addons,
    requested.referral_code, requested.referred_by_id, requested.referred_by_name,
    requested.referral_discount_pct, requested.created_by
  ) RETURNING * INTO recorded;

  RETURN to_jsonb(recorded);
END;
$$;

REVOKE ALL ON FUNCTION public.record_punch_checkin(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_punch_checkin(JSONB) TO service_role;