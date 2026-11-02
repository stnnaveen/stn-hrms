// Diagnostic: Google's map search for the place text Google wrote into a share link -> coordinates?
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'en' };
const qs = ['SIDCO, S16, Thiru Vi Ka Industrial Estate, SIDCO Industrial Estate, Guindy, Chennai, Tamil Nadu 600032', 'Sidharth Square, M RAJA, 1306, Akash Nagar, Tharapakkam, Gerugambakkam, Tamil Nadu 600128', 'DLF IT SEZ Park Main Entrance, Ramapuram, Chennai'];
for (const q of qs) {
  for (const u of [`https://www.google.com/search?tbm=map&hl=en&gl=in&q=${encodeURIComponent(q)}`, `https://www.google.com/maps/search/${encodeURIComponent(q)}?hl=en`]) {
    const r = await fetch(u, { headers: UA, redirect: 'follow' });
    const t = await r.text();
    const nn = [...t.matchAll(/\[null,null,(-?\d{1,2}\.\d{4,}),(-?\d{1,3}\.\d{4,})\]/g)].slice(0, 3).map((x) => `${x[1]},${x[2]}`);
    const d34 = [...t.matchAll(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/g)].slice(0, 2).map((x) => `${x[1]},${x[2]}`);
    console.log(`GS ${r.status} ${t.length}B ${u.slice(22, 50)} | ${q.slice(0, 30)} | nullnull ${nn.join(' ; ') || '-'} | 3d4d ${d34.join(' ; ') || '-'} | final ${r.url.slice(0, 80)}`);
  }
}
