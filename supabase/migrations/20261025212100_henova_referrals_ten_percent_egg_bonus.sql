BEGIN;
ALTER TABLE public.henova_players ADD COLUMN referred_by bigint REFERENCES public.henova_players(telegram_id) ON DELETE SET NULL;
ALTER TABLE public.henova_players ADD COLUMN referral_eggs_earned bigint NOT NULL DEFAULT 0 CHECK (referral_eggs_earned >= 0);
ALTER TABLE public.henova_players ADD COLUMN referral_remainder_tenths smallint NOT NULL DEFAULT 0 CHECK (referral_remainder_tenths BETWEEN 0 AND 9);
ALTER TABLE public.henova_players ADD CONSTRAINT henova_no_self_referral CHECK (referred_by IS NULL OR referred_by <> telegram_id);
CREATE INDEX henova_players_referrer_idx ON public.henova_players(referred_by);
ALTER TABLE public.henova_events DROP CONSTRAINT henova_events_action_check;
ALTER TABLE public.henova_events ADD CONSTRAINT henova_events_action_check CHECK (action IN ('collect','daily','purchase','boost','join_channel','referral_bonus'));
CREATE OR REPLACE FUNCTION public.henova_process_action(
  p_telegram_id bigint,
  p_action text,
  p_request_id uuid,
  p_item text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v public.henova_players%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_rate numeric;
  v_after_rate numeric;
  v_pending bigint;
  v_price bigint := 0;
  v_egg_delta bigint := 0;
  v_coin_delta bigint := 0;
  v_old_hen_count integer;
  v_referral_bonus bigint;
  v_new_remainder smallint;
  v_fan_multiplier numeric;
BEGIN
  IF p_telegram_id IS NULL OR p_telegram_id <= 0 OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023';
  END IF;
  IF p_action NOT IN ('collect','daily','purchase','boost') OR p_action IS NULL THEN
    RAISE EXCEPTION 'invalid_action' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v FROM public.henova_players WHERE telegram_id = p_telegram_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'player_not_initialized' USING ERRCODE = '22023';
  END IF;
  -- Same user+request id is applied only once, even after client retries.
  IF EXISTS (SELECT 1 FROM public.henova_events
    WHERE telegram_id = p_telegram_id AND request_id = p_request_id) THEN
    RETURN jsonb_build_object('ok',true,'already_applied',true,'eggs',v.egg_balance,'coins',v.coin_balance);
  END IF;
  v_fan_multiplier := CASE v.fan_level WHEN 0 THEN 1 WHEN 1 THEN 1.10
    WHEN 2 THEN 1.20 WHEN 3 THEN 1.35 WHEN 4 THEN 1.50 ELSE 1.75 END;
  v_rate := (v.starter_hens*10 + v.red_hens*30 + v.gold_hens*60 +
    v.royal_hens*120 + v.legend_hens*250) * v_fan_multiplier;
  v_pending := floor(LEAST(21600, GREATEST(0, extract(epoch FROM v_now - v.production_started_at))) * v_rate / 3600)::bigint;
  IF p_action = 'collect' THEN
    IF v_pending <= 0 THEN
      RETURN jsonb_build_object('ok',false,'error','no_eggs','eggs',v.egg_balance,'coins',v.coin_balance);
    END IF;
    v_egg_delta := v_pending;
    UPDATE public.henova_players SET egg_balance=egg_balance+v_pending,
      production_started_at=v_now,updated_at=v_now WHERE telegram_id=p_telegram_id;

  ELSIF p_action = 'daily' THEN
    IF v.last_daily_on = (v_now AT TIME ZONE 'UTC')::date THEN
      RETURN jsonb_build_object('ok',false,'error','already_claimed','coins',v.coin_balance);
    END IF;
    v_coin_delta := 100;
    UPDATE public.henova_players SET coin_balance=coin_balance+100,
      last_daily_on=(v_now AT TIME ZONE 'UTC')::date,updated_at=v_now
      WHERE telegram_id=p_telegram_id;

  ELSIF p_action = 'purchase' THEN
    v_price := CASE p_item WHEN 'red' THEN 1000 WHEN 'gold' THEN 3000
      WHEN 'royal' THEN 10000 WHEN 'legend' THEN 25000 ELSE 0 END;
    IF v_price=0 THEN RAISE EXCEPTION 'invalid_hen' USING ERRCODE='22023'; END IF;
    IF v.coin_balance < v_price THEN
      RETURN jsonb_build_object('ok',false,'error','insufficient_coins');
    END IF;
    v_coin_delta := -v_price;
    -- A purchased hen must not multiply production already accrued before purchase.
    v_after_rate := v_rate + (CASE p_item WHEN 'red' THEN 30 WHEN 'gold' THEN 60
       WHEN 'royal' THEN 120 WHEN 'legend' THEN 250 ELSE 0 END) * v_fan_multiplier;
    UPDATE public.henova_players SET coin_balance=coin_balance-v_price,
      production_started_at=v_now - make_interval(secs => (v_pending*3600/v_after_rate)::double precision),
      red_hens=red_hens+CASE WHEN p_item='red' THEN 1 ELSE 0 END,
      gold_hens=gold_hens+CASE WHEN p_item='gold' THEN 1 ELSE 0 END,
      royal_hens=royal_hens+CASE WHEN p_item='royal' THEN 1 ELSE 0 END,
      legend_hens=legend_hens+CASE WHEN p_item='legend' THEN 1 ELSE 0 END,
      updated_at=v_now WHERE telegram_id=p_telegram_id;

  ELSE -- boost
    v_price := CASE v.fan_level WHEN 0 THEN 500 WHEN 1 THEN 1500
      WHEN 2 THEN 4000 WHEN 3 THEN 10000 WHEN 4 THEN 25000 ELSE 0 END;
    IF v_price=0 THEN RETURN jsonb_build_object('ok',false,'error','max_boost'); END IF;
    IF v.coin_balance < v_price THEN
      RETURN jsonb_build_object('ok',false,'error','insufficient_coins');
    END IF;
    v_coin_delta := -v_price;
    v_after_rate := (v.starter_hens*10 + v.red_hens*30 + v.gold_hens*60 +
      v.royal_hens*120 + v.legend_hens*250) *
      (CASE v.fan_level+1 WHEN 1 THEN 1.10 WHEN 2 THEN 1.20
       WHEN 3 THEN 1.35 WHEN 4 THEN 1.50 ELSE 1.75 END);
    UPDATE public.henova_players SET coin_balance=coin_balance-v_price,
      fan_level=fan_level+1,
      production_started_at=v_now - make_interval(secs => (v_pending*3600/v_after_rate)::double precision),
      updated_at=v_now WHERE telegram_id=p_telegram_id;
  END IF;

  IF p_action = 'collect' AND v.referred_by IS NOT NULL AND v_egg_delta > 0 THEN
    v_referral_bonus := floor((v.referral_remainder_tenths + v_egg_delta)::numeric / 10)::bigint;
    v_new_remainder := ((v.referral_remainder_tenths + v_egg_delta) % 10)::smallint;
    UPDATE public.henova_players SET referral_remainder_tenths=v_new_remainder WHERE telegram_id=p_telegram_id;
    IF v_referral_bonus > 0 THEN
      UPDATE public.henova_players SET egg_balance=egg_balance+v_referral_bonus,
        referral_eggs_earned=referral_eggs_earned+v_referral_bonus,updated_at=v_now
        WHERE telegram_id=v.referred_by;
      INSERT INTO public.henova_events(telegram_id,request_id,action,egg_delta,details)
      VALUES(v.referred_by,p_request_id,'referral_bonus',v_referral_bonus,
        jsonb_build_object('from_telegram_id',p_telegram_id,'rate',10));
    END IF;
  END IF;

  INSERT INTO public.henova_events(telegram_id,request_id,action,egg_delta,coin_delta,details)
  VALUES(p_telegram_id,p_request_id,p_action,v_egg_delta,v_coin_delta,
    jsonb_build_object('item',p_item,'pending_before',v_pending));

  SELECT * INTO v FROM public.henova_players WHERE telegram_id=p_telegram_id;
  RETURN jsonb_build_object('ok',true,'eggs',v.egg_balance,'coins',v.coin_balance,
    'starter',v.starter_hens,'red',v.red_hens,'gold',v.gold_hens,
    'royal',v.royal_hens,'legend',v.legend_hens,'fan',v.fan_level,
    'production_started_at',v.production_started_at,'egg_delta',v_egg_delta,
    'coin_delta',v_coin_delta);
END;
$$;


COMMIT;