// JPM Film Tracker sync: Notion (Weddings + Editing Backlog) -> Supabase.
// Runs on GitHub Actions (see .github/workflows/sync.yml). Node 20+, no packages needed.
// Copies ONLY client-safe fields. Never copies money, notes, editor names or the internal proxy Dropbox link.
// Never deletes anything: couples whose Film Tracker box is unticked just lose sign-in access (emails cleared).

const { NOTION_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
const SITE = 'https://films.jpmweddings.com';
const EMAIL_DELAY_MIN = 10;
const WELCOME = -100;   // notifications.stage_index marker for sent welcome emails
let transport;          // Gmail sender, created on first use
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
    ['Ceremony film', 'Your full ceremony, start to finish', 'Ceremony Film Delivered', 'ceremony', 1],
    ['Social Drop reels', 'Short reels made for sharing', 'Social Drop Delivered', 'reels', 1],
    ['Raw footage film', 'The unedited footage of your day', 'Raw Footage Delivered', 'raw', 1],
  ],
};
const CEREMONY = PACKAGES['The Short Film'][1];
PACKAGES['Custom'] = [PACKAGES['The Feature'][0], PACKAGES['The Feature'][3], PACKAGES['The Feature'][4]];

// ---------- helpers ----------
const todayCT = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const ctDate = iso => iso ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(iso)) : null;
const p = {
  title: x => (x?.title || []).map(t => t.plain_text).join('').trim(),
  text: x => (x?.rich_text || []).map(t => t.plain_text).join('').trim(),
  // An email field can hold more than one address ("a@x.com, b@y.com"); split them.
  emails: x => (x?.email || '').toLowerCase().split(/[\s,;]+/).filter(Boolean),
  date: x => x?.date?.start ? x.date.start.slice(0, 10) : null,
  select: x => x?.select?.name || null,
  url: x => (x?.url || '').trim() || null,
  check: x => !!x?.checkbox,
  formulaDate: x => x?.formula?.type === 'date' ? (x.formula.date?.start || '').slice(0, 10) || null
                  : x?.formula?.type === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x.formula.string || '') ? x.formula.string.slice(0, 10) : null,
  relation: x => (x?.relation || []).map(r => r.id),
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/;
let badEmails = 0;
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
  // Ceremony, raw footage and reels live in Dropbox Server Backup (VidFlow credits cost), each with its own link field.
  // Justin, 2026-09-23: these snippets show the moment their link is in Notion, at any stage, to build excitement.
  const rawLink = httpsOnly(p.url(W['Raw Footage Link']));
  const ceremonyLink = httpsOnly(p.url(W['Ceremony Film Link']));
  const reelsLink = httpsOnly(p.url(W['Reels Link']));
  const earlyLinks = { raw: rawLink, ceremony: ceremonyLink, reels: reelsLink };

  const pkg = p.select(W['Package']) || 'The Feature';
  const reelState = p.select(B['Social Drop']);
  const items = [...(PACKAGES[pkg] || PACKAGES['The Feature'])];
  // A ceremony file for a package without a ceremony card still gets one.
  if (ceremonyLink && !items.some(i => i[3] === 'ceremony')) items.splice(1, 0, CEREMONY);
  const deliverables = items.map(([name, desc, field, kind, at]) => {
    const date = d(field);
    let status;
    if (earlyLinks[kind]) status = 'ready';
    else if (kind === 'reels') status = (date || reelState === 'Sent to couple') ? 'ready' : (reelState === 'SemMedia making' || reelState === 'Matt review') ? 'work' : 'soon';
    else status = date || (stage === 6 && (kind === 'film' || kind === 'ceremony')) ? 'ready' : (stage >= at ? 'work' : 'soon');
    const links = { film: filmLink, raw: rawLink, ceremony: ceremonyLink || filmLink, reels: reelsLink };
    const link = status === 'ready' ? links[kind] || null : null;
    return { name, desc, status, date: date || null, link };
  });

  // Typos (no @, no .com) are left out and counted, so one bad address never stops the whole sync.
  const rawEmails = [...p.emails(W['Client Email']), ...p.emails(W['Client Email 2'])];
  const emails = [...new Set(rawEmails.filter(e => EMAIL_RE.test(e)))];
  badEmails += rawEmails.length - rawEmails.filter(e => EMAIL_RE.test(e)).length;

  const due = p.formulaDate(W['Delivery Due']);
  const lastEdited = [b?.last_edited_time, w.last_edited_time].filter(Boolean).sort().pop();

  return {
    notion_id: w.id,
    emails,
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

// Queue a status email when a film moves FORWARD (never on the first sync, never when it moves back).
const before = new Map(((await sb('/rest/v1/couples?select=notion_id,stage_index')) || []).map(r => [r.notion_id, r.stage_index]));
const queue = couples.filter(c => before.has(c.notion_id) && c.stage_index >= 0 && c.stage_index > before.get(c.notion_id))
                     .map(c => ({ notion_id: c.notion_id, stage_index: c.stage_index }));

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

// Make sure every couple email can receive a sign-in link (new couples AND emails changed in Notion).
// Old emails need no clean-up: access follows the couples.emails list, so a removed email just sees nothing.
const known = new Set();
for (let page = 1; ; page++) {
  const list = (await sb(`/auth/v1/admin/users?page=${page}&per_page=1000`))?.users || [];
  list.forEach(u => known.add((u.email || '').toLowerCase()));
  if (list.length < 1000) break;
}
let created = 0, failed = 0;
for (const email of new Set(couples.flatMap(c => c.emails))) {
  if (known.has(email)) continue;
  try {
    await sb('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, email_confirm: true }) });
    created++;
  } catch (err) {
    if (!/already|exists/i.test(err.message)) failed++;  // keep going; the run is marked failed at the end
  }
}

if (queue.length) await sb('/rest/v1/notifications', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(queue) });
const sent = await sendDueEmails(new Map(couples.map(c => [c.notion_id, c])));
const welcomed = await sendWelcomes(couples);

// Counts only: GitHub Actions logs can be public, so never log names or emails.
console.log(`Synced ${couples.length} couple(s); ${skipped} skipped (no Client Email); ${badEmails} invalid email(s) ignored; ${paused} paused; ${created} new sign-in email(s); ${failed} sign-in setup failure(s); ${queue.length} update email(s) queued; ${sent} sent; ${welcomed} welcome email(s) sent.`);
// A sign-in setup failure fails the run (GitHub emails info@), after everyone else has synced.
// Typo'd emails only show in the log count; failing on them would email info@ every 10 minutes.
if (failed) process.exitCode = 1;

// ---------- email ----------
async function mailer() {
  if (!transport) {
    const nodemailer = (await import('nodemailer')).default;
    transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
  }
  return transport;
}

// ---------- welcome emails ----------
// Approved by Justin 2026-09-23 as the second automatic client email (fixed template): sent once to each couple email,
// on the first sync after Film Tracker is ticked (or a new email is added). Logged as notifications rows with stage_index -100.
// TEST couples are skipped; the demo sends its own copy.
async function sendWelcomes(list) {
  const todo = [];
  const done = new Set(((await sb(`/rest/v1/notifications?stage_index=eq.${WELCOME}&select=result`)) || []).map(r => (r.result || '').replace(/^welcome:/, '')));
  for (const c of list) {
    if (/^TEST\s/i.test(c.names)) continue;
    for (const email of c.emails) if (!done.has(email)) todo.push([c, email]);
  }
  if (!todo.length) return 0;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) { console.warn('Welcome emails waiting, but GMAIL_USER / GMAIL_APP_PASSWORD secrets are not set.'); return 0; }
  const mail = await mailer();
  let count = 0;
  for (const [c, email] of todo) {
    const e = welcomeEmail(c);
    await mail.sendMail({ from: `"JPM Weddings" <${GMAIL_USER}>`, to: email, replyTo: GMAIL_USER, subject: e.subject, text: e.text, html: e.html });
    await sb('/rest/v1/notifications', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ notion_id: c.notion_id, stage_index: WELCOME, sent_at: new Date().toISOString(), result: 'welcome:' + email }]) });
    count++;
  }
  return count;
}

function welcomeEmail(c) {
  const hi = `Hi ${c.names.replace(/^TEST\s+/i, '').replace(/ & /g, ' and ')},`;
  const subject = 'Your JPM Film Tracker is live';
  const text = `${hi}\n\nWe made something special for you: your own Film Tracker, where you can watch your wedding film move from footage to premiere.\n\nOpen your Film Tracker: ${SITE}\nEnter this email address and we will send you a one-time sign-in link. No password needed. You can even add your favorite photo to make the page yours.\n\nEvery time your film moves to the next stage, you will get a short update email from us.\n\nCan't wait for you to see it!\nGrecel\nClient Journey Manager, JPM Weddings`;
  const p = t => `<p style="margin:0 0 12px;color:#c9ced6;line-height:1.6">${t}</p>`;
  const html = `<div style="background:#08090b;padding:40px 16px;font-family:Lato,Helvetica,Arial,sans-serif;color:#f3f4f6">
<div style="max-width:480px;margin:0 auto;background:#111317;border:1px solid #252a33;border-radius:16px;padding:32px">
<p style="margin:0 0 6px;font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#4f86f2;font-weight:bold">JPM Weddings</p>
<h1 style="margin:0 0 16px;font-family:Georgia,serif;font-weight:normal;font-size:30px;line-height:1.15;color:#f3f4f6">Your Film Tracker is live</h1>
${p(hi)}${p('We made something special for you: your own Film Tracker, where you can watch your wedding film move from footage to premiere.')}
<p style="margin:0 0 24px;color:#c9ced6;line-height:1.6">Tap the button, enter this email address, and we will send you a one-time sign-in link. No password needed. You can even add your favorite photo to make the page yours.</p>
<a href="${SITE}" style="display:inline-block;background:#2f6bea;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 22px;border-radius:10px">Open my Film Tracker</a>
<p style="margin:24px 0 12px;color:#c9ced6;line-height:1.6">Every time your film moves to the next stage, you will get a short update email from us.</p>
<p style="margin:0 0 4px;color:#c9ced6;line-height:1.6">Can't wait for you to see it!</p>
<p style="margin:0;color:#c9ced6;line-height:1.6">Grecel<br>Client Journey Manager, JPM Weddings</p>
<p style="margin:16px 0 0;font-size:12px;color:#5d6571;line-height:1.6">Questions? Just reply to this email.</p>
</div></div>`;
  return { subject, text, html };
}

// ---------- status update emails ----------
// One of the two client emails that go out without Justin's review (with the welcome email): fixed template, pre-approved 2026-09-23.
async function sendDueEmails(byNotion) {
  // TEST couples (live demos, email goes to info@) skip the buffer so the email lands on camera.
  const cutoff = Date.now() - EMAIL_DELAY_MIN * 60000;
  const isTest = n => /^TEST\s/i.test(byNotion.get(n.notion_id)?.names || '');
  const due = (await sb(`/rest/v1/notifications?sent_at=is.null&select=*&order=created_at.asc`) || [])
    .filter(n => new Date(n.created_at).getTime() < cutoff || isTest(n));
  if (!due.length) return 0;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) { console.warn('Emails waiting, but GMAIL_USER / GMAIL_APP_PASSWORD secrets are not set.'); return 0; }
  const mail = await mailer();
  const mark = (id, result) => sb(`/rest/v1/notifications?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ sent_at: new Date().toISOString(), result }) });

  // One email per couple: if a film jumped two stages in one window, only the newest one goes out.
  const latest = new Map();
  for (const n of due) { const prev = latest.get(n.notion_id); if (prev) await mark(prev.id, 'superseded'); latest.set(n.notion_id, n); }

  let count = 0;
  for (const n of latest.values()) {
    const c = byNotion.get(n.notion_id);
    if (!c || !c.emails.length) { await mark(n.id, 'skipped: no access'); continue; }
    if (c.stage_index < n.stage_index) { await mark(n.id, 'skipped: moved back'); continue; }
    const e = statusEmail(c);
    await mail.sendMail({ from: `"JPM Weddings" <${GMAIL_USER}>`, to: c.emails.join(', '), replyTo: GMAIL_USER, subject: e.subject, text: e.text, html: e.html });
    await mark(n.id, 'sent'); count++;
  }
  return count;
}

function statusEmail(c) {
  const S = [
    ['Your wedding footage is safe with us', 'Footage secured', 'Every camera card and audio file from your day is now safely backed up in two places. Next, our team starts organizing it all so your story is ready to build.'],
    ['Your story is taking shape', 'Crafting your story', 'Our team is organizing hours of footage, syncing every angle and pulling your confessionals so your film is ready for the edit.'],
    ['Your film is in the edit bay', 'Editing your film', 'Justin is now editing your film: shaping the arc of your day, the confessionals, and the moments you did not even see happen.'],
    ['Your film is getting its cinematic look', 'Color grading', 'The edit is locked and your film is with our colorist, getting the cinematic look that makes it feel like a show you would binge.'],
    ['Your film is getting its sound', 'Sound and music', 'We are mixing every mic, the vows and the speeches so every word lands, and scoring your film with music that fits you.'],
    ['Your film is in final review', 'Final quality review', 'Our lead filmmaker is watching your film start to finish, frame by frame, before it reaches you. You are almost there.'],
    ['Your film is ready', 'Delivered', 'Your film is ready. Grab your favorite people, press play, and relive it all. Your links are waiting on your film tracker.'],
  ];
  const [subject, stage, body] = S[Math.max(0, Math.min(6, c.stage_index))];
  const hi = `Hi ${c.names.replace(/^TEST\s+/i, '')},`;
  const text = `${hi}\n\nYour film just moved to a new stage: ${stage}.\n\n${body}\n\nSee your film tracker: ${SITE}\n\nJustin and the JPM team`;
  const html = `<div style="background:#08090b;padding:40px 16px;font-family:Lato,Helvetica,Arial,sans-serif;color:#f3f4f6">
<div style="max-width:480px;margin:0 auto;background:#111317;border:1px solid #252a33;border-radius:16px;padding:32px">
<p style="margin:0 0 6px;font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#4f86f2;font-weight:bold">Film update</p>
<h1 style="margin:0 0 16px;font-family:Georgia,serif;font-weight:normal;font-size:28px;line-height:1.2;color:#f3f4f6">${subject}</h1>
<p style="margin:0 0 12px;color:#c9ced6;line-height:1.6">${hi}</p>
<p style="margin:0 0 12px;color:#c9ced6;line-height:1.6">Your film just moved to a new stage: <strong style="color:#f3f4f6">${stage}</strong>.</p>
<p style="margin:0 0 24px;color:#c9ced6;line-height:1.6">${body}</p>
<a href="${SITE}" style="display:inline-block;background:#2f6bea;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 22px;border-radius:10px">See your film tracker</a>
<p style="margin:24px 0 0;color:#c9ced6;line-height:1.6">Justin and the JPM team</p>
<p style="margin:16px 0 0;font-size:12px;color:#5d6571;line-height:1.6">Questions? Just reply to this email.</p>
</div></div>`;
  return { subject, text, html };
}
