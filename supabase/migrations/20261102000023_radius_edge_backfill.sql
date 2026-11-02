-- Raise the new 'Edge of radius' dispute for the last 7 days' check-ins/outs that were beyond their hub radius
-- but counted inside only because of the GPS accuracy allowance (e.g. 223 m from a 200 m hub, ±40 m).
insert into flags (punch_id, user_id, kind, rule, details)
select p.id, p.user_id, 'radius_edge',
       'R-02b ' || round(p.distance_m) || ' m, inside ' || h.radius_m || ' m only with GPS ±' || round(coalesce(p.accuracy_m, 0)) || ' m',
       jsonb_build_object('distance_m', round(p.distance_m), 'accuracy_m', p.accuracy_m, 'backfilled', true)
from punches p join hubs h on p.target_type = 'hub' and h.id = p.target_id
where p.server_time > now() - interval '7 days' and p.inside is true and p.distance_m > h.radius_m
  and not exists (select 1 from flags f where f.punch_id = p.id and f.kind in ('radius', 'radius_edge'));
