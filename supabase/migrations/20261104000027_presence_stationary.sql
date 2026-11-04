-- Store app, stronger background tracking: samples now say whether the phone was moving, and when location was
-- switched off. Standing still (no movement) keeps the last place until the phone moves again; location off is
-- "no signal". Mock (fake) locations are kept for a later dispute rule.
alter table presence_samples add column if not exists moving boolean;
alter table presence_samples add column if not exists event text;
alter table presence_samples add column if not exists mock boolean;
alter table presence_samples drop constraint if exists presence_samples_source_check;
alter table presence_samples add constraint presence_samples_source_check check (source in ('watch', 'beat', 'off'));

create or replace function public.presence_day(p_user uuid, p_day date default (now() at time zone 'Asia/Kolkata')::date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_day attendance_days; v_start timestamptz; v_end timestamptz; v_gap interval;
  r record; prev record; seg_from timestamptz; seg_to timestamptz; d interval; st text;
  m_in numeric := 0; m_out numeric := 0; m_od numeric := 0; m_none numeric := 0; n int := 0;
  has_prev boolean := false; trips jsonb := '[]'; t_from timestamptz; t_to timestamptz; t_max numeric := 0; last_inside boolean; last_at timestamptz;
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  select * into v_day from attendance_days where user_id = p_user and day = p_day;
  if v_day.in_time is null then return jsonb_build_object('tracked', false, 'reason', coalesce(v_day.status, 'not_in')); end if;
  v_gap := make_interval(mins => coalesce((select (value #>> '{}')::int from settings where key = 'presence_gap_minutes'), 15));
  v_start := greatest(v_day.in_time, (p_day::text || ' ' || (select value #>> '{}' from settings where key = 'office_start'))::timestamp at time zone 'Asia/Kolkata');
  v_end := least(coalesce(v_day.out_time, now()), now(), (p_day::text || ' ' || (select value #>> '{}' from settings where key = 'office_end'))::timestamp at time zone 'Asia/Kolkata');
  if v_end <= v_start then return jsonb_build_object('tracked', true, 'inside_min', 0, 'outside_min', 0, 'od_min', 0, 'no_signal_min', 0, 'trips', '[]'::jsonb, 'samples', 0); end if;

  for r in
    select s.at, s.inside, s.target_type, s.distance_m, s.moving, s.source from presence_samples s
    where s.user_id = p_user and s.at between v_start - v_gap and v_end order by s.at
  loop
    n := n + 1;
    if not has_prev then
      if r.at > v_start then m_none := m_none + extract(epoch from (r.at - v_start)) / 60; end if;
    else
      seg_from := greatest(prev.at, v_start); seg_to := least(r.at, v_end);
      if seg_to > seg_from then
        d := seg_to - seg_from;
        -- location turned off = no signal; a long silence counts as the same place only if the phone said it was
        -- standing still (it wakes and reports again as soon as it moves), otherwise no signal
        st := case when prev.source = 'off' then 'none'
                   when r.at - prev.at > v_gap and coalesce(prev.moving, true) then 'none'
                   when prev.target_type = 'od' then 'od' when prev.inside then 'in' else 'out' end;
        if st = 'none' then m_none := m_none + extract(epoch from d) / 60;
        elsif st = 'od' then m_od := m_od + extract(epoch from d) / 60;
        elsif st = 'in' then m_in := m_in + extract(epoch from d) / 60;
        else
          m_out := m_out + extract(epoch from d) / 60;
          if t_from is null then t_from := seg_from; t_max := 0; end if;
          t_to := seg_to; t_max := greatest(t_max, coalesce(prev.distance_m, 0), coalesce(r.distance_m, 0));
        end if;
        if st <> 'out' and t_from is not null then
          trips := trips || jsonb_build_object('from', t_from, 'to', t_to, 'min', round(extract(epoch from (t_to - t_from)) / 60), 'max_m', round(t_max));
          t_from := null;
        end if;
      end if;
    end if;
    prev := r; has_prev := true; last_inside := r.inside; last_at := r.at;
  end loop;

  if not has_prev then
    m_none := extract(epoch from (v_end - v_start)) / 60;
  elsif v_end > greatest(prev.at, v_start) then
    -- after the last sample: the last state holds for up to one gap, then no signal
    seg_from := greatest(prev.at, v_start);
    seg_to := case when prev.source = 'off' then seg_from when prev.moving is false then v_end else least(v_end, prev.at + v_gap) end;
    d := seg_to - seg_from;
    if seg_to > seg_from then
      if prev.target_type = 'od' then m_od := m_od + extract(epoch from d) / 60;
      elsif prev.inside then m_in := m_in + extract(epoch from d) / 60;
      else m_out := m_out + extract(epoch from d) / 60; if t_from is null then t_from := seg_from; end if; t_to := seg_to; end if;
    end if;
    if v_end > seg_to then m_none := m_none + extract(epoch from (v_end - greatest(seg_to, seg_from))) / 60; end if;
  end if;
  if t_from is not null then
    trips := trips || jsonb_build_object('from', t_from, 'to', t_to, 'min', round(extract(epoch from (t_to - t_from)) / 60), 'max_m', round(t_max), 'ongoing', t_to >= v_end - interval '1 minute');
  end if;

  return jsonb_build_object('tracked', true, 'from', v_start, 'to', v_end, 'inside_min', round(m_in), 'outside_min', round(m_out),
    'od_min', round(m_od), 'no_signal_min', round(m_none), 'trips', trips, 'samples', n, 'last_at', last_at, 'last_inside', last_inside);
end $$;
revoke execute on function presence_day(uuid, date) from public, anon;
grant execute on function presence_day(uuid, date) to authenticated;
