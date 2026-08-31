/* ============================================================
   Forge Digital — shared bootstrap
   ------------------------------------------------------------
   Imported by all three pages — index.html (Workspace),
   client-hub.html, and script-generator.html — so that the Firebase
   config, the sign-in gate, the app nav, and the handful of domain
   rules they must agree on live in exactly one file.

   Loaded as an ES module, which means these pages must be served
   over http(s) — opening them as file:// will be blocked by the
   browser's module CORS rules. See README-FIREBASE.md.
   ============================================================ */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
  onSnapshot, serverTimestamp, writeBatch, increment
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';

/* ------------------------------------------------------------
   CONFIG
   ------------------------------------------------------------ */
const firebaseConfig = {
  apiKey: "AIzaSyCgF-3WLkV9a5u-67902SzIMUoEWgWQIRY",
  authDomain: "forge-digital-hub.firebaseapp.com",
  projectId: "forge-digital-hub",
  storageBucket: "forge-digital-hub.firebasestorage.app",
  messagingSenderId: "781049699062",
  appId: "1:781049699062:web:013a99e39e03dd69422ad7",
  measurementId: "G-BTH5KLLD9"
};

/* WHO CAN GET IN.
   This list is the friendly front door only — it decides what the
   page shows. The real lock is the matching list in firestore.rules,
   which is enforced by Google's servers and cannot be bypassed by
   editing this file. Change BOTH, then redeploy rules. */
export const ALLOWED_EMAILS = [
  'liam.coughlin1@gmail.com',
  'thomas.chkuaseli06@gmail.com'
];

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Re-exported so the two pages import everything Firebase-related from
// this one module instead of repeating CDN URLs (and risking a version drift).
export { collection, doc, addDoc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, onSnapshot, serverTimestamp, writeBatch, increment };

/* ------------------------------------------------------------
   SHARED DOMAIN RULES
   Both pages must agree on these — the Script Generator sets a
   lead's status when a call is logged, and the Client Hub decides
   from that same status whether the lead is active or history.
   ------------------------------------------------------------ */
export const STATUS_OPTIONS = ['New', 'Called', 'Sent Portfolio', 'Follow-up', 'Not Interested', 'Booked Call', 'Closed'];
export const DEFAULT_STATUS = 'New';

// A lead in one of these states is a dead end or a won deal, so it lives in
// the permanent History view rather than the active working queue.
export const TERMINAL_STATUSES = ['Not Interested', 'Closed'];
export function isTerminalStatus(status) { return TERMINAL_STATUSES.indexOf(status) !== -1; }

/* Maps the outcome(s) ticked in the Script Generator's "Log This Call" panel
   onto a Client Hub status. Priority order, most decisive first: Not Interested
   is a hard stop; Send Portfolio and Interested/Call Later are the two still-warm
   outcomes; a bare No Answer / Hung Up just records that contact was attempted. */
export function statusFromOutcomes(outcomes) {
  if (!outcomes || !outcomes.length) return 'Called';
  if (outcomes.indexOf('not_interested') !== -1) return 'Not Interested';
  if (outcomes.indexOf('send_portfolio') !== -1) return 'Sent Portfolio';
  if (outcomes.indexOf('interested') !== -1 || outcomes.indexOf('call_later') !== -1) return 'Follow-up';
  return 'Called';
}

/* ------------------------------------------------------------
   FOLLOW-UP SCHEDULING
   ------------------------------------------------------------
   A lead now lives in one of three buckets, all DERIVED from its
   own fields rather than a separate flag that could drift:

     history    — status is a dead end / won deal
     followups  — a call has been logged (lead.lastCallAt is set)
     active     — never called yet

   Deriving from lastCallAt is deliberate: leads that predate this
   feature have no lastCallAt, so they stay exactly where they were
   and nothing already in the database has to be rewritten.
   ------------------------------------------------------------ */
export const FOLLOWUP_DEFAULT_DAYS = 2;

export function leadBucket(lead) {
  if (!lead) return 'active';
  if (isTerminalStatus(lead.status)) return 'history';
  if (lead.lastCallAt) return 'followups';
  return 'active';
}

/* Day maths runs on plain YYYY-MM-DD strings parsed as UTC midnight. Using
   whole calendar days (rather than a 48-hour clock from the moment of the
   call) is what makes "Follow up today" appear on the right DAY: a call at
   5pm Monday scheduled +2 days is due Wednesday, and says "today" from the
   moment Wednesday starts — not at 5pm Wednesday. */
function isoToUtcMs(iso) {
  if (!iso || typeof iso !== 'string') return NaN;
  const parts = iso.slice(0, 10).split('-');
  if (parts.length !== 3) return NaN;
  return Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}
export function addDaysIso(iso, days) {
  const ms = isoToUtcMs(iso);
  if (isNaN(ms)) return iso;
  return new Date(ms + days * 86400000).toISOString().slice(0, 10);
}
// Positive = still in the future, 0 = due today, negative = overdue.
export function daysUntilIso(iso) {
  const target = isoToUtcMs(iso);
  const today = isoToUtcMs(todayIso());
  if (isNaN(target) || isNaN(today)) return null;
  return Math.round((target - today) / 86400000);
}

/* The label shown on a follow-up card. Recomputed on every render (and on a
   timer / tab focus) so leaving the app open overnight still rolls "in 1 day"
   over to "today" without a reload. */
export function followUpLabel(dueIso) {
  const days = daysUntilIso(dueIso);
  if (days === null) return { text: 'No follow-up date set', tone: 'none', days: null };
  if (days < 0) {
    const n = Math.abs(days);
    return { text: n === 1 ? 'Overdue by 1 day' : `Overdue by ${n} days`, tone: 'overdue', days };
  }
  if (days === 0) return { text: 'Follow up today', tone: 'today', days };
  if (days === 1) return { text: 'Follow up in 1 day', tone: 'soon', days };
  return { text: `Follow up in ${days} days`, tone: 'later', days };
}

/* The single source of truth for what a logged call writes onto a lead —
   used by BOTH the Script Generator's Log This Call panel and the Client
   Hub's quick-log buttons, so a call logged from either place produces an
   identical document and lands in the same bucket.

   explicitDueDate lets the caller override the computed default with the
   exact date the person on the phone gave you — validated as a plain
   YYYY-MM-DD string so a stray malformed value can never silently corrupt
   the due date; anything that doesn't match falls back to the day-offset
   default exactly as if nothing had been passed. Ignored entirely for a
   terminal outcome, since those carry no follow-up date at all. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function followUpFieldsForCall(outcomes, days, explicitDueDate) {
  const status = statusFromOutcomes(outcomes);
  const terminal = isTerminalStatus(status);
  const hasValidExplicitDate = !terminal && typeof explicitDueDate === 'string' && ISO_DATE_RE.test(explicitDueDate);
  return {
    status: status,
    lastCallAt: Date.now(),
    lastCallOutcomes: outcomes ? outcomes.slice() : [],
    archivedAt: terminal ? todayIso() : null,
    // A terminal outcome ends the sequence, so it carries no next due date.
    followUpDueDate: terminal ? null : (hasValidExplicitDate ? explicitDueDate : addDaysIso(todayIso(), days || FOLLOWUP_DEFAULT_DAYS))
  };
}

export function formatCallTimestamp(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

// Client Hub business type -> the Script Generator's fixed <select> options.
// Anything absent falls back to "Other" plus the original label as customType.
export const SCRIPT_GEN_TYPE_MAP = {
  'Roofing': 'Roofing',
  'Plumbing': 'Plumbing',
  'HVAC': 'HVAC',
  'Electrician': 'Electrical',
  'Landscaping': 'Landscaping',
  'General Contractor / Remodeling': 'Contractor',
  'Auto Repair / Mechanic': 'Auto Repair',
  'Paving / Asphalt': 'Sealcoating / Asphalt'
};

/* Turns a raw lead document into the fields the Script Generator's form wants.
   This used to be encoded into the handoff URL by the Client Hub; now the
   Script Generator reads the lead straight from Firestore and shapes it here,
   so the script is always built from the CURRENT lead, not a stale snapshot
   captured whenever the link happened to be created. */
export function mapLeadToScriptFields(lead) {
  const mappedType = SCRIPT_GEN_TYPE_MAP[lead.businessType];
  const bizType = mappedType || 'Other';
  const customType = mappedType ? '' : (lead.businessType || '');

  let websiteField;
  if (lead.hasWebsite && lead.websiteUrl) {
    websiteField = lead.websiteUrl;
  } else {
    const links = [];
    if (lead.facebookUrl) links.push('Facebook: ' + lead.facebookUrl);
    if (lead.nextdoorUrl) links.push('Nextdoor: ' + lead.nextdoorUrl);
    websiteField = links.length ? ('No website — ' + links.join(' | ')) : 'No website';
  }

  const notesParts = [];
  if (lead.notes) notesParts.push(lead.notes);
  if (lead.city) notesParts.push('Located in ' + lead.city + '.');
  if (lead.sourcePlatform) notesParts.push('Spotted via ' + lead.sourcePlatform + '.');
  if (!lead.hasWebsite && lead.facebookUrl) notesParts.push('Facebook: ' + lead.facebookUrl);
  if (!lead.hasWebsite && lead.nextdoorUrl) notesParts.push('Nextdoor: ' + lead.nextdoorUrl);
  (lead.pitchNotes || []).slice(0, 2).forEach(p => notesParts.push(p));

  return {
    bizName: lead.businessName || '',
    ownerName: lead.ownerName || '',
    phone: lead.phone || '',
    city: lead.city || '',
    bizType: bizType,
    customType: customType,
    website: websiteField,
    problems: (lead.flaws || []).slice(0, 3).join(' '),
    notes: notesParts.join(' ')
  };
}

/* ------------------------------------------------------------
   UTILITIES
   ------------------------------------------------------------ */
/* Deliberately built from LOCAL date parts rather than toISOString(), which
   reports the UTC day. In US Eastern that flips over around 7–8pm — so a call
   logged at 8pm Monday would have been stamped Tuesday, pushing its +2 day
   follow-up to Thursday instead of Wednesday and showing "Follow up today" a
   day late. Evening calls are squarely in this app's recommended calling
   window, so that was a real miss rather than an edge case. */
export function todayIso() {
  const d = new Date();
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/* Firestore rejects any field whose value is `undefined`, and a partly-filled
   lead form produces those constantly. This converts them to null (and walks
   nested objects/arrays) so a write never fails on a blank optional field. */
export function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object' && typeof value.toMillis !== 'function' && !(value instanceof Date)) {
    const out = {};
    Object.keys(value).forEach(k => {
      if (value[k] !== undefined) out[k] = stripUndefined(value[k]);
    });
    return out;
  }
  return value === undefined ? null : value;
}

/* Firestore serverTimestamp() resolves to a Timestamp, but reads back as null
   for the brief moment between a local write and the server's acknowledgement.
   Falls back to the plain dateAdded string so ordering never collapses. */
export function leadTimeMillis(lead) {
  const t = lead && lead.createdAt;
  if (t && typeof t.toMillis === 'function') return t.toMillis();
  if (lead && lead.dateAdded) return Date.parse(lead.dateAdded) || 0;
  return 0;
}

/* ------------------------------------------------------------
   AUTH GATE
   Renders a full-screen sign-in overlay until a user on the
   allowlist is present, then calls onReady(user) exactly once.
   Styling hangs off --accent, which each page defines to its own
   colour (purple for the Client Hub, blue for the Script Generator).
   ------------------------------------------------------------ */
const GATE_CSS = `
.fd-gate{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
  padding:24px;background:var(--bg,#06060a);}
.fd-gate-card{width:100%;max-width:400px;text-align:center;
  background:linear-gradient(180deg,var(--panel,#141020),var(--bg-alt,#0b0912));
  border:1px solid var(--border,#2d2a44);border-radius:var(--radius,14px);padding:38px 30px;
  box-shadow:0 30px 80px rgba(0,0,0,0.55);}
.fd-gate-mark{width:52px;height:52px;border-radius:13px;margin:0 auto 18px;
  background:linear-gradient(135deg,var(--accent,#8b2fe0),#2a0f52);
  display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:22px;
  box-shadow:0 0 28px var(--glow,rgba(139,47,224,0.45));}
.fd-gate-card h1{font-size:20px;font-weight:800;color:var(--text,#f2eefb);margin-bottom:6px;}
.fd-gate-card .fd-sub{font-size:12px;letter-spacing:1.3px;text-transform:uppercase;
  color:var(--text-dim,#a89cc4);margin-bottom:20px;}
.fd-gate-msg{font-size:14px;color:var(--text-dim,#a89cc4);line-height:1.55;margin-bottom:22px;}
.fd-gate-msg.err{color:#ff8fa3;}
.fd-gate-btn{width:100%;border:none;cursor:pointer;border-radius:var(--radius-sm,9px);
  background:#fff;color:#1f1f24;font-size:14.5px;font-weight:700;padding:13px 18px;
  display:inline-flex;align-items:center;justify-content:center;gap:10px;transition:transform .15s ease,box-shadow .15s ease;}
.fd-gate-btn:hover{transform:translateY(-1px);box-shadow:0 10px 26px rgba(0,0,0,0.45);}
.fd-gate-btn:disabled{opacity:.6;cursor:not-allowed;transform:none;}
.fd-gate-btn svg{width:18px;height:18px;flex-shrink:0;}
.fd-gate-note{font-size:11.5px;color:var(--text-faint,#6b6288);margin-top:18px;line-height:1.5;}
.fd-gate-alt{background:none;border:none;color:var(--accent-bright,#c07bff);font-size:12.5px;
  font-weight:700;cursor:pointer;margin-top:14px;}
.fd-spin{width:22px;height:22px;border-radius:50%;margin:0 auto 18px;
  border:2.5px solid var(--border,#2d2a44);border-top-color:var(--accent,#8b2fe0);
  animation:fdspin .7s linear infinite;}
@keyframes fdspin{to{transform:rotate(360deg);}}
`;

const GOOGLE_ICON = '<svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

let gateEl = null;

function ensureGateStyles() {
  if (document.getElementById('fd-gate-styles')) return;
  const style = document.createElement('style');
  style.id = 'fd-gate-styles';
  style.textContent = GATE_CSS;
  document.head.appendChild(style);
}

function renderGate(state, detail) {
  ensureGateStyles();
  if (!gateEl) {
    gateEl = document.createElement('div');
    gateEl.className = 'fd-gate';
    document.body.appendChild(gateEl);
  }
  gateEl.style.display = 'flex';

  if (state === 'checking') {
    gateEl.innerHTML = `<div class="fd-gate-card">
      <div class="fd-spin"></div>
      <h1>Forge Digital</h1>
      <div class="fd-sub">Shared Workspace</div>
      <p class="fd-gate-msg">Checking your sign-in…</p>
    </div>`;
    return;
  }

  const isError = state === 'denied' || state === 'error';
  const message = state === 'denied'
    ? `<strong>${detail || 'That account'}</strong> isn't on the access list for this workspace. Sign in with an approved Google account, or add this address to <code>ALLOWED_EMAILS</code> in forge-shared.js and to firestore.rules.`
    : state === 'error'
      ? (detail || 'Sign-in failed. Please try again.')
      : 'This workspace is private. Sign in with your approved Google account to load the shared leads.';

  gateEl.innerHTML = `<div class="fd-gate-card">
    <div class="fd-gate-mark">FD</div>
    <h1>Forge Digital</h1>
    <div class="fd-sub">Shared Workspace</div>
    <p class="fd-gate-msg ${isError ? 'err' : ''}">${message}</p>
    <button class="fd-gate-btn" id="fd-gate-btn">${GOOGLE_ICON}<span>Sign in with Google</span></button>
    <p class="fd-gate-note">Leads, statuses, and call history are shared live between approved accounts.</p>
  </div>`;

  const btn = gateEl.querySelector('#fd-gate-btn');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Opening Google…';
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await signInWithPopup(auth, provider);
      // onAuthStateChanged takes over from here.
    } catch (err) {
      let msg = 'Sign-in failed. Please try again.';
      if (err && err.code === 'auth/popup-blocked') {
        msg = 'Your browser blocked the Google popup. Allow popups for this site and try again.';
      } else if (err && err.code === 'auth/popup-closed-by-user') {
        msg = 'Sign-in window was closed before finishing. Give it another go.';
      } else if (err && err.code === 'auth/unauthorized-domain') {
        msg = 'This domain is not authorised in Firebase Auth. Add it under Authentication → Settings → Authorized domains.';
      } else if (err && err.message) {
        msg = err.message;
      }
      renderGate('error', msg);
    }
  });
}

function hideGate() {
  if (gateEl) gateEl.style.display = 'none';
}

let readyFired = false;

/* Calls onReady(user) once an allowlisted user is signed in. If someone signs
   in with an account that isn't approved they're immediately signed back out
   and shown why — the app itself never starts, and Firestore would refuse the
   reads anyway thanks to the matching rule server-side. */
export function requireAuth(onReady) {
  renderGate('checking');
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      readyFired = false;
      renderGate('signin');
      return;
    }
    const email = (user.email || '').toLowerCase();
    const approved = ALLOWED_EMAILS.map(e => e.toLowerCase()).indexOf(email) !== -1;
    if (!approved) {
      await signOut(auth).catch(() => {});
      renderGate('denied', user.email);
      return;
    }
    hideGate();
    if (!readyFired) {
      readyFired = true;
      onReady(user);
    }
  });
}

export function currentUser() { return auth.currentUser; }
export function signOutUser() { return signOut(auth); }

/* ------------------------------------------------------------
   APP NAV DRAWER
   ------------------------------------------------------------
   The FD logo in each page's header doubles as the menu button.
   Clicking it slides out a slim rail of logo tiles only — no text
   labels, per spec — with each app's own colour identity:
     blue→purple  Workspace
     blue         Script Generator
     purple       Client Hub
   Deliberately self-contained (its own colours, not the host
   page's CSS variables) so the menu looks identical on all three
   pages rather than shifting between the blue and purple themes.
   ------------------------------------------------------------ */
const NAV_CSS = `
.fd-nav-scrim{position:fixed;inset:0;z-index:9000;background:rgba(4,6,14,0.66);
  backdrop-filter:blur(6px);opacity:0;pointer-events:none;transition:opacity .28s ease;}
.fd-nav-scrim.open{opacity:1;pointer-events:auto;}
.fd-nav-drawer{position:fixed;top:0;left:0;bottom:0;z-index:9001;width:92px;
  background:linear-gradient(180deg,#0c1122,#070a13);
  border-right:1px solid rgba(255,255,255,0.08);
  display:flex;flex-direction:column;align-items:center;gap:16px;padding:20px 0;
  transform:translateX(-102%);transition:transform .32s cubic-bezier(.22,1,.36,1);
  box-shadow:26px 0 70px rgba(0,0,0,0.55);}
.fd-nav-drawer.open{transform:none;}
.fd-nav-brandmark{width:44px;height:44px;border-radius:13px;flex-shrink:0;
  background:linear-gradient(135deg,#2f8fff,#8b2fe0);
  display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:16px;
  box-shadow:0 0 26px rgba(90,120,255,0.45);}
.fd-nav-sep{width:34px;height:1px;background:rgba(255,255,255,0.1);flex-shrink:0;}
.fd-nav-tile{width:56px;height:56px;border-radius:17px;flex-shrink:0;position:relative;
  display:flex;align-items:center;justify-content:center;text-decoration:none;
  color:#fff;font-weight:800;font-size:18px;letter-spacing:0.5px;
  transition:transform .2s cubic-bezier(.22,1,.36,1),box-shadow .2s ease,filter .2s ease;}
.fd-nav-tile:hover{transform:translateY(-3px) scale(1.05);filter:brightness(1.12);}
.fd-nav-tile:active{transform:translateY(-1px) scale(1.01);}
.fd-nav-tile.workspace{background:linear-gradient(135deg,#2f8fff,#8b2fe0);box-shadow:0 6px 22px rgba(90,120,255,0.45);}
.fd-nav-tile.script{background:linear-gradient(135deg,#5ab0ff,#1a5fc4);box-shadow:0 6px 22px rgba(47,143,255,0.45);}
.fd-nav-tile.hub{background:linear-gradient(135deg,#c07bff,#4c1d95);box-shadow:0 6px 22px rgba(139,47,224,0.45);}
.fd-nav-tile.current::before{content:"";position:absolute;left:-16px;top:50%;transform:translateY(-50%);
  width:4px;height:28px;border-radius:0 4px 4px 0;background:#fff;box-shadow:0 0 12px rgba(255,255,255,0.6);}
.fd-nav-close{margin-top:auto;background:none;border:1px solid rgba(255,255,255,0.12);
  color:rgba(255,255,255,0.55);width:36px;height:36px;border-radius:11px;cursor:pointer;
  font-size:17px;line-height:1;transition:all .2s ease;flex-shrink:0;}
.fd-nav-close:hover{color:#fff;border-color:rgba(255,255,255,0.3);background:rgba(255,255,255,0.06);}
/* The header logo, once it becomes the menu trigger. */
.fd-nav-trigger{background:none;border:none;padding:0;cursor:pointer;display:flex;align-items:center;gap:12px;
  border-radius:12px;transition:transform .18s ease,opacity .18s ease;
  font:inherit;color:inherit;text-align:left;}
.fd-nav-trigger:hover{transform:translateY(-1px);opacity:.92;}
.fd-nav-trigger:focus-visible{outline:2px solid rgba(255,255,255,.45);outline-offset:4px;}
`;

const NAV_APPS = [
  { key: 'workspace', href: 'index.html', cls: 'workspace', label: 'Forge Digital Workspace' },
  { key: 'script', href: 'script-generator.html', cls: 'script', label: 'Script Generator' },
  { key: 'hub', href: 'client-hub.html', cls: 'hub', label: 'Client Hub' }
];

let navScrim = null, navDrawer = null;

function ensureNavStyles() {
  if (document.getElementById('fd-nav-styles')) return;
  const style = document.createElement('style');
  style.id = 'fd-nav-styles';
  style.textContent = NAV_CSS;
  document.head.appendChild(style);
}

export function openAppNav() {
  if (navScrim) navScrim.classList.add('open');
  if (navDrawer) navDrawer.classList.add('open');
}
export function closeAppNav() {
  if (navScrim) navScrim.classList.remove('open');
  if (navDrawer) navDrawer.classList.remove('open');
}

/* Call once per page with which app is currently open, so its tile gets the
   active marker. Wires every [data-fd-nav-trigger] element on the page. */
export function initAppNav(activeKey) {
  ensureNavStyles();
  if (navDrawer) return;

  navScrim = document.createElement('div');
  navScrim.className = 'fd-nav-scrim';

  navDrawer = document.createElement('nav');
  navDrawer.className = 'fd-nav-drawer';
  navDrawer.setAttribute('aria-label', 'Forge Digital apps');
  navDrawer.innerHTML =
    '<div class="fd-nav-brandmark">FD</div><div class="fd-nav-sep"></div>' +
    NAV_APPS.map(a =>
      `<a class="fd-nav-tile ${a.cls}${a.key === activeKey ? ' current' : ''}" href="${a.href}" title="${a.label}" aria-label="${a.label}">FD</a>`
    ).join('') +
    '<button type="button" class="fd-nav-close" title="Close menu" aria-label="Close menu">✕</button>';

  document.body.appendChild(navScrim);
  document.body.appendChild(navDrawer);

  navScrim.addEventListener('click', closeAppNav);
  navDrawer.querySelector('.fd-nav-close').addEventListener('click', closeAppNav);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAppNav(); });

  document.querySelectorAll('[data-fd-nav-trigger]').forEach(el => {
    el.addEventListener('click', (e) => { e.preventDefault(); openAppNav(); });
  });
}

/* ------------------------------------------------------------
   CALL ACTION — shared by every "call this lead" affordance
   ------------------------------------------------------------
   Copies the number to the clipboard and opens Google Voice, rather
   than using a tel: link. On a desktop browser a tel: link just tries
   (and usually fails) to hand off to a native dialer app; Google Voice
   is where these calls actually get made.

   window.open() runs FIRST and synchronously, still inside the click
   handler's call stack. Popup blockers key off that direct user-gesture
   link and it can be lost once an awaited clipboard promise resolves,
   which would silently eat the new tab in some browsers. The clipboard
   write happens after and only decides which message is shown.

   `notify` is passed in because each page owns its own toast styling —
   the Client Hub's takes a (msg, type) pair, the Script Generator's
   takes just a message, and both work with the call below.
   ------------------------------------------------------------ */
export const GOOGLE_VOICE_CALLS_URL = 'https://voice.google.com/u/2/calls';

export function callViaGoogleVoice(phone, notify) {
  const say = typeof notify === 'function' ? notify : function () {};
  const number = (phone || '').trim();
  if (!number) { say('No phone number on this lead.', 'error'); return; }

  const win = window.open(GOOGLE_VOICE_CALLS_URL, '_blank');
  navigator.clipboard.writeText(number).then(() => {
    if (win) say('Number copied — opening Google Voice');
    else say('Number copied — allow popups to open Google Voice', 'error');
  }).catch(() => {
    if (win) say('Opened Google Voice — copy failed, paste manually', 'error');
    else say('Could not copy the number, and popups are blocked', 'error');
  });
}
