-- HENOVA backend foundation — PREPARED, NOT DEPLOYED.
-- Run only in a dedicated HENOVA Supabase project; never on MIMA/LTF.
-- Server-only writes via a Telegram-authenticating Edge Function.
BEGIN;

CREATE TABLE IF NOT EXISTS public.henova_players (
  telegram_id bigint PRIMARY KEY CHECK (telegram_id > 0),
  first_name text NOT NULL DEFAULT '',
  username text,
  egg_balance bigint NOT NULL DEFAULT 0 CHECK (egg_balance >= 0),
  coin_balance bigint NOT NULL DEFAULT 0 CHECK (coin_balance >= 0),
  starter_hens integer NOT NULL DEFAULT 1 CHECK (starter_hens >= 1),
  red_hens integer NOT NULL DEFAULT 0 CHECK (red_hens >= 0),
  gold_hens integer NOT NULL DEFAULT 0 CHECK (gold_hens >= 0),
  royal_hens integer NOT NULL DEFAULT 0 CHECK (royal_hens >= 0),
  legend_hens integer NOT NULL DEFAULT 0 CHECK (legend_hens >= 0),
  fan_level smallint NOT NULL DEFAULT 0 CHECK (fan_level BETWEEN 0 AND 5),
  production_started_at timestamptz NOT NULL DEFAULT now(),
  last_daily_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.henova_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telegram_id bigint NOT NULL REFERENCES public.henova_players(telegram_id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('collect','daily','purchase','boost')),
  egg_delta bigint NOT NULL DEFAULT 0,
  coin_delta bigint NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (telegram_id, request_id)
);
CREATE INDEX IF NOT EXISTS henova_events_player_created_idx
  ON public.henova_events (telegram_id, created_at DESC);

ALTER TABLE public.henova_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.henova_events ENABLE ROW LEVEL SECURITY;
-- No client-facing policies: browser clients cannot read, insert or update.
REVOKE ALL ON TABLE public.henova_players, public.henova_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.henova_events_id_seq FROM PUBLIC, anon, authenticated;

-- Only the backend's service role can invoke the atomic actions.
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
  v_pending := LEAST(60, floor(GREATEST(0,extract(epoch FROM v_now - v.production_started_at))*v_rate/3600)::bigint);
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
    UPDATE public.henova_players SET coin_balance=coin_balance-v_price,
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

REVOKE ALL ON FUNCTION public.henova_process_action(bigint,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.henova_process_action(bigint,text,uuid,text) TO service_role;
GRANT SELECT,INSERT,UPDATE ON public.henova_players TO service_role;
GRANT SELECT,INSERT ON public.henova_events TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.henova_events_id_seq TO service_role;

COMMIT;
