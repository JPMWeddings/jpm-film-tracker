// JPM Film Tracker sync: Notion (Weddings + Editing Backlog) -> Supabase.
// Runs on GitHub Actions (see .github/workflows/sync.yml). Node 20+, no packages needed.
// Copies ONLY client-safe fields. Never copies money, notes, editor names or the internal proxy Dropbox link.
// Never deletes anything: couples whose Film Tracker box is unticked just lose sign-in access (emails cleared).

const { NOTION_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!NOTION_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing NOTION_TOKEN, SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const WEDDINGS_DB = '86a48c21402f434a95dfd89aa5d3214b';
const NOTION = { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
const SB = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };

const POST_STAGE = { 'Ingest': 0, 'Culling': 1, 'Ready to Edit': 1, 'In Post': 2, 'Color': 3, 'Mix & Master': 4, 'Matt Review': 5, 'Approved': 5, 'Delivered': 6 };

const PACKAGES = {
  'The Feature': [
    ['Wedding film episode', 'Your 15 to 30 minute reality style episode', 'Episode Delivered', 'film', 2],
    ['Trailer', 'A teaser cut of your story', 'Trailer Delivered', 'film', 2],
    ['Documentary archive', 'The extended cut of your weekend', 'Doc Archive Delivered', 'film', 2],
    ['Social Drop reels', 'Short reels made for sharing', 'Social Drop Delivered', 'reels', 1],
    ['Raw footage film', 'The unedited footage of your day', 'Raw Footage Delivered', 'raw', 1],
  ],
  'The Short Film': [
    ['Wedding film episode', 'Your 10 to 15 minute wedding day episode', 'Episode Delivered', 'film', 2],
    ['Ceremony film', 'Your full ceremony, start to finish', 'Ceremony Film Delivered', 'film', 1],
    ['Social Drop reels', 'Short reels made for sharing', 'Social Drop Delivered', 'reels', 1],
    ['Raw footage film', 'The unedited footage of your day', 'Raw Footage Delivered', 'raw', 1],
  ],
};
PACKAGES['Custom'] = [PACKAGES['The Feature'][0], PACKAGES['The Feature'][3], PACKAGES['The Feature'][4]];

// ---------- helpers ----------
const todayCT = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const ctDate = iso => iso ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(iso)) : null;
const p = {
  title: x => (x?.title || []).map(t => t.plain_text).join('').trim(),
  text: x => (x?.rich_text || []).map(t => t.plain_text).join('').trim(),
  email: x => (x?.email || '').trim().toLowerCase(),
  date: x => x?.date?.start ? x.date.start.slice(0, 10) : null,
  select: x => x?.select?.name || null,
  url: x => (x?.url || '').trim() || null,
  check: x => !!x?.checkbox,
  formulaDate: x => x?.formula?.type === 'date' ? (x.formula.date?.start || '').slice(0, 10) || null
                  : x?.formula?.type === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x.formula.string || '') ? x.formula.string.slice(0, 10) : null,
  relation: x => (x?.relation || []).map(r => r.id),
};
const httpsOnly = u => u && /^https:\/\//i.test(u) ? u : null;

async function notion(path, body) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, { method: body ? 'POST' : 'GET', headers: NOTION, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`Notion ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}
async function queryAll(db, filter) {
  const out = []; let cursor;
  do {
    const r = await notion(`databases/${db}/query`, { filter, page_size: 100, start_cursor: cursor });
    out.push(...r.results); cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}
async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...opts, headers: { ...SB, ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`Supabase ${path} ${res.status}: ${await res.text()}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

function windowText(due) {
  const end = new Date(due + 'T12:00:00Z'), start = new Date(end.getTime() - 30 * 86400000);
  const m = d => d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  if (start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear())
    return end.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  if (start.getUTCFullYear() === end.getUTCFullYear()) return `${m(start)} to ${m(end)} ${end.getUTCFullYear()}`;
  return `${m(start)} ${start.getUTCFullYear()} to ${m(end)} ${end.getUTCFullYear()}`;
}

// ---------- build one couple ----------
async function buildCouple(w) {
  const W = w.properties;
  const backlogIds = p.relation(W['Editing']);
  const b = backlogIds.length ? await notion(`pages/${backlogIds[0]}`) : null;
  const B = b?.properties || {};

  const weddingDate = p.date(W['Wedding Date']);
  const today = todayCT();
  const wStage = p.select(W['Stage']);
  let stage;
  if (weddingDate && weddingDate > today) stage = -1;
  else if (wStage === 'Delivered' || wStage === 'Complete') stage = 6;
  else if (p.select(B['Post Stage']) in POST_STAGE) stage = POST_STAGE[p.select(B['Post Stage'])];
  else stage = weddingDate ? 0 : -1;

  const d = k => p.date(B[k]);
  const delivered = d('Episode Delivered') || p.date(W['Delivered Date']);
  const stageDates = [null, d('Edit Started'), d('Sent to Color'), d('Color Back'), d('Sent to Matt'), d('Approved Date'), stage === 6 ? delivered : null];

  const filmLink = (d('Episode Delivered') || wStage === 'Delivered' || wStage === 'Complete') ? httpsOnly(p.url(W['Client Film Link'])) : null;
  const rawLink = d('Raw Footage Delivered') ? httpsOnly(p.url(W['Raw Footage Link'])) : null;

  const pkg = p.select(W['Package']) || 'The Feature';
  const reelState = p.select(B['Social Drop']);
  const deliverables = (PACKAGES[pkg] || PACKAGES['The Feature']).map(([name, desc, field, kind, at]) => {
    const date = d(field);
    let status;
    if (kind === 'reels') status = (date || reelState === 'Sent to couple') ? 'ready' : (reelState === 'SemMedia making' || reelState === 'Matt review') ? 'work' : 'soon';
    else status = date || (stage === 6 && kind === 'film') ? 'ready' : (stage >= at ? 'work' : 'soon');
    const link = status === 'ready' ? (kind === 'film' ? filmLink : kind === 'raw' ? rawLink : null) : null;
    return { name, desc, status, date: date || null, link };
  });

  const due = p.formulaDate(W['Delivery Due']);
  const lastEdited = [b?.last_edited_time, w.last_edited_time].filter(Boolean).sort().pop();

  return {
    notion_id: w.id,
    emails: [...new Set([p.email(W['Client Email']), p.email(W['Client Email 2'])].filter(Boolean))],
    names: p.title(W['Couple']).replace(/\s*\+\s*/g, ' & '),
    collection: pkg,
    wedding_date: weddingDate,
    venue: p.text(W['Location']) || null,
    stage_index: stage,
    stage_dates: stageDates,
    deliverables,
    film_link: filmLink,
    raw_link: rawLink,
    delivery_window: p.check(W['Show Delivery Window']) && due && stage < 6 ? windowText(due) : null,
    last_update: ctDate(lastEdited),
    synced_at: new Date().toISOString(),
  };
}

// ---------- main ----------
const weddings = await queryAll(WEDDINGS_DB, { property: 'Film Tracker', checkbox: { equals: true } });
const couples = []; let skipped = 0;
for (const w of weddings) {
  const c = await buildCouple(w);
  if (!c.emails.length) { skipped++; continue; }
  couples.push(c);
}

if (couples.length) {
  await sb('/rest/v1/couples?on_conflict=notion_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(couples) });
}

// Pause access (not delete) for couples whose Film Tracker box was unticked.
const active = new Set(couples.map(c => c.notion_id));
let paused = 0;
const existing = await sb('/rest/v1/couples?select=notion_id,emails');
for (const row of existing || []) {
  if (!active.has(row.notion_id) && row.emails?.length) {
    await sb(`/rest/v1/couples?notion_id=eq.${encodeURIComponent(row.notion_id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ emails: [] }) });
    paused++;
  }
}

// Make sure every couple email can receive a sign-in link.
const users = await sb('/auth/v1/admin/users?per_page=1000');
const known = new Set((users?.users || []).map(u => (u.email || '').toLowerCase()));
let created = 0;
for (const email of new Set(couples.flatMap(c => c.emails))) {
  if (known.has(email)) continue;
  await sb('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, email_confirm: true }) });
  created++;
}

// Counts only: GitHub Actions logs can be public, so never log names or emails.
console.log(`Synced ${couples.length} couple(s); ${skipped} skipped (no Client Email); ${paused} paused; ${created} new sign-in email(s).`);
