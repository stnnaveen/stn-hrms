-- Hubs: PLACEHOLDER coordinates (city centres). HR must replace each with the hub's real
-- Google Maps pin before the pilot, or every check-in will flag as outside radius.
insert into hubs (name, lat, lng) values
  ('Chennai', 13.0827, 80.2707),
  ('Coimbatore', 11.0168, 76.9558),
  ('Madurai', 9.9252, 78.1198),
  ('Salem', 11.6643, 78.1460),
  ('Trichy', 10.7905, 78.7047),
  ('Erode', 11.3410, 77.7172),
  ('Hosur', 12.7409, 77.8253),
  ('Tirunelveli', 8.7139, 77.7567),
  ('Thoothukudi', 8.7642, 78.1348),
  ('Villupuram', 11.9401, 79.4861)
on conflict (name) do nothing;
