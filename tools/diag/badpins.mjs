// Diagnostic: hub and OD venue pins that landed near our server (Mumbai) - the wrong-centre bug.
const { SUPA_URL, SERVICE } = process.env;
const h = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
const near = (lat, lng) => lat != null && Math.hypot(lat - 19.08, (lng - 72.88) * 0.95) < 0.6;
const hubs = await (await fetch(`${SUPA_URL}/rest/v1/hubs?select=name,lat,lng`, { headers: h })).json();
const ods = await (await fetch(`${SUPA_URL}/rest/v1/od_requests?select=id,subject,status,venue_lat,venue_lng,venue_place,created_at`, { headers: h })).json();
console.log('hubs near Mumbai:', JSON.stringify(hubs.filter((x) => near(x.lat, x.lng))));
console.log('ODs near Mumbai:', Array.isArray(ods) ? JSON.stringify(ods.filter((x) => near(x.venue_lat, x.venue_lng))) : JSON.stringify(ods).slice(0, 300));
