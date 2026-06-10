// Trash or Treasure · main glue
// Tap shutter → upload → recognize → game-chat verdict → player votes →
// comeback line → next round.

const UPLOAD_URL    = "https://chat.aiwaves.tech/aigram/api/upload";
const RECOGNIZE_URL = "https://chat.aiwaves.tech/aigram/api/recognize";
const CHAT_URL      = "https://chat.aiwaves.tech/aigram/api/game-chat";

const $ = (id) => document.getElementById(id);
const fileInput = $("file");
const proc      = $("processing");
const procStep  = $("procStep");
const procMsg   = $("procMsg");
const procCancel= $("procCancel");
const errOver   = $("errorOverlay");
const errMsgEl  = $("errMsg");
const overlay   = $("verdictOverlay");
const photoImg  = $("verdictPhoto");
const stampEl   = $("verdictStamp");
const reasonEl  = $("verdictReason");
const comebackEl= $("comeback");
const voteRow   = $("voteRow");
const nextBtn   = $("nextBtn");
const askBtn    = $("askBtn");
const askBtnLbl = $("askBtnLabel");
const afterVote = $("afterVote");
const caseMeta  = $("caseMeta");
const juryHeader= $("juryHeader");
const juryAvatar= $("juryAvatar");
const juryName  = $("juryName");
const votePromptEl = document.querySelector(".vote-prompt");
const inboxChip = $("inboxChip");
const inboxCount= $("inboxCount");
const picker    = $("pickerOverlay");
const pickerList= $("pickerList");
const pickerClose = $("pickerClose");
const caseLog   = $("caseLog");
const caseLogTotal = $("caseLogTotal");
const caseLogToss  = $("caseLogToss");
const caseLogKeep  = $("caseLogKeep");

// Aigram bridge (set up by aigram-bridge.js before this module loads)
const A = window.Aigram || {};
const me = { id: A.telegramId || null, name: "" };

let state = {
  verdict: null,        // "KEEP" | "TOSS"
  reason: null,
  vision: null,
  photoDataUrl: null,   // data: URL used for instant local preview
  photoR2Url: null,     // R2 URL after upload, used for notify ref_url
  juryCase: null,       // when set: in jury mode (judging a friend's case)
  pending: [],          // cases sent by friends waiting for me to judge
};
// Monotonic run id — bumped on cancel/retry so stale in-flight results are
// ignored when they finally come back.
let runId = 0;

function init() {
  fileInput.addEventListener("change", onFilePicked);
  $("closeVerdict").addEventListener("click", closeVerdict);
  voteRow.addEventListener("click", onVote);
  nextBtn.addEventListener("click", onNextVictim);
  procCancel.addEventListener("click", cancelPipeline);
  $("errRetry").addEventListener("click", () => {
    hideError();
    runPipeline();
  });
  $("errDismiss").addEventListener("click", () => {
    hideError();
    cancelPipeline();
  });
  // ── L1 social wiring ────────────────────────────────────────────────
  askBtn.addEventListener("click", openPicker);
  inboxChip.addEventListener("click", onInboxChip);
  pickerClose.addEventListener("click", closePicker);
  juryHeader.addEventListener("click", onJuryHeader);

  // Render the running tally from localStorage. Hidden when 0 so the
  // splash stays clean for first-time players.
  renderCaseLog();

  // Boot social: fetch self name + scan for pending cases. Both deferred
  // so the splash + shutter render first.
  if (A.isInAigram && me.id) {
    setTimeout(initSocial, 60);
  }
}

function onNextVictim() {
  // In jury mode with more pending → judge the next one. Otherwise return
  // to home for solo flow.
  closeVerdict();
  if (state.pending && state.pending.length > 0) {
    enterJuryMode(state.pending[0]);
    return;
  }
  fileInput.value = "";
  setTimeout(() => fileInput.click(), 60);
}

async function onFilePicked(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  if (!f.type.startsWith("image/")) {
    toast("not an image");
    return;
  }
  state.photoDataUrl = await fileToDataURL(f);
  runPipeline();
}

async function runPipeline() {
  const myRun = ++runId;
  hideError();
  state.juryCase = null; // any cancel/retry resets jury context

  showProcessing("UPLOADING", "sending the evidence…");
  let photoUrl;
  try {
    photoUrl = await uploadDataUrl(state.photoDataUrl);
  } catch (err) {
    if (myRun !== runId) return;
    console.error(err);
    showError("upload failed · check your connection");
    return;
  }
  if (myRun !== runId) return;
  state.photoR2Url = photoUrl;

  showProcessing("INSPECTING", "AI is judging you…");
  let vision = null;
  try {
    vision = await recognize(photoUrl);
  } catch (err) {
    console.warn("recognize failed", err);
  }
  if (myRun !== runId) return;
  state.vision = vision;

  // Reveal what was seen for a beat
  if (vision?.labels?.length) {
    showProcessing("WE SEE", "· " + vision.labels.slice(0, 2).join(" · ") + " ·");
    await sleep(800);
    if (myRun !== runId) return;
  }

  showProcessing("DELIBERATING", "weighing the verdict…");
  let verdict;
  try {
    verdict = await renderVerdict(vision);
  } catch (err) {
    if (myRun !== runId) return;
    console.error(err);
    showError("AI offline · try again");
    return;
  }
  if (myRun !== runId) return;

  state.verdict = verdict.verdict;
  state.reason  = verdict.reason;
  hideProcessing();
  showVerdict();
}

function cancelPipeline() {
  // Bump runId so any in-flight responses are ignored. The underlying
  // fetch still resolves in background but its result is dropped.
  runId++;
  hideProcessing();
  hideError();
  fileInput.value = "";
}

function showVerdict() {
  photoImg.src = state.photoDataUrl || state.photoR2Url || "";
  const isToss = state.verdict === "TOSS";
  stampEl.textContent = isToss ? "TOSS" : "KEEP";
  stampEl.classList.remove("toss", "keep");
  stampEl.classList.add(isToss ? "toss" : "keep");
  // Force animation restart
  stampEl.style.animation = "none";
  void stampEl.offsetWidth;
  stampEl.style.animation = "";

  reasonEl.innerHTML = `<span class="quote">“</span>${escapeHtml(state.reason)}<span class="quote">”</span>`;

  comebackEl.textContent = "";
  afterVote.classList.add("hidden");
  voteRow.classList.remove("hidden");
  if (votePromptEl) votePromptEl.classList.remove("hidden");
  for (const btn of voteRow.querySelectorAll(".vote-btn")) {
    btn.classList.remove("voted");
    btn.disabled = false;
  }

  // Jury mode: friend's case being judged by me. Header swaps in, ASK A
  // FRIEND button hides (you don't re-refer someone else's case), case
  // number is replaced by sender stamp.
  if (state.juryCase) {
    showJuryHeader(state.juryCase);
    askBtn.classList.add("hidden");
    nextBtn.textContent = state.pending.length > 1 ? "+ NEXT CASE" : "+ FILE YOUR OWN";
    caseMeta.textContent = "REFERRED BY " + (state.juryCase.sender_name || "FRIEND").toUpperCase();
  } else {
    juryHeader.classList.add("hidden");
    askBtn.classList.remove("hidden");
    askBtnLbl.textContent = A.isInAigram ? "ASK A FRIEND" : "ASK A FRIEND";
    nextBtn.textContent = "+ ANOTHER VICTIM";
    caseMeta.textContent = `CASE #${nextCaseNo()}`;
  }

  overlay.classList.add("show");
}

function showJuryHeader(c) {
  juryName.textContent = c.sender_name || "someone";
  if (c.sender_avatar) {
    juryAvatar.classList.remove("is-initial");
    juryAvatar.innerHTML = "";
    juryAvatar.style.backgroundImage = `url(${c.sender_avatar})`;
    juryAvatar.style.backgroundSize = "cover";
    juryAvatar.style.backgroundPosition = "center";
  } else {
    juryAvatar.classList.add("is-initial");
    juryAvatar.style.backgroundImage = "";
    juryAvatar.textContent = ((c.sender_name || "?")[0] || "?").toUpperCase();
  }
  juryHeader.classList.remove("hidden");
}

function onJuryHeader() {
  if (state.juryCase && state.juryCase.sender_id && A.openAigramProfile) {
    A.openAigramProfile(state.juryCase.sender_id);
  }
}

function onVote(e) {
  const btn = e.target.closest(".vote-btn");
  if (!btn || btn.disabled) return;
  const userPick = btn.dataset.vote.toUpperCase(); // "KEEP" | "TOSS"

  for (const b of voteRow.querySelectorAll(".vote-btn")) {
    b.disabled = true;
    if (b !== btn) b.classList.add("voted");
  }

  const aiSaid = state.verdict;
  const agreed = aiSaid === userPick;
  comebackEl.textContent = pickComeback(aiSaid, agreed);
  if (votePromptEl) votePromptEl.classList.add("hidden");
  afterVote.classList.remove("hidden");
  incStats(userPick);

  // Jury mode: the vote IS the friend's verdict — notify the original
  // sender, dedupe this case locally, advance the pending queue.
  if (state.juryCase) {
    const c = state.juryCase;
    markJudged(c.case_id);
    state.pending = (state.pending || []).filter(p => p.case_id !== c.case_id);
    sendJurorVerdictBack(c, userPick);
    // Update next-btn label based on remaining pending
    nextBtn.textContent = state.pending.length > 0 ? "+ NEXT CASE" : "+ FILE YOUR OWN";
    renderInboxChip();
  }
}

function closeVerdict() {
  overlay.classList.remove("show");
  state.verdict = null;
  state.reason = null;
  state.vision = null;
  state.photoDataUrl = null;
  state.photoR2Url = null;
  state.juryCase = null;
  juryHeader.classList.add("hidden");
  fileInput.value = "";
}

// ─── Endpoints ──────────────────────────────────────────────────────────

async function uploadDataUrl(dataUrl) {
  const m = (dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("bad image data url");
  const mime = m[1];
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });

  const form = new FormData();
  form.append("file", blob, "photo." + (mime.split("/")[1] || "jpg"));
  const res = await fetch(UPLOAD_URL, { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload http ${res.status}`);
  const json = await res.json();
  if (!json.url) throw new Error("upload returned no url");
  return json.url;
}

async function recognize(imageUrl) {
  const res = await fetch(RECOGNIZE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image_url: imageUrl, mode: "object" }),
  });
  if (!res.ok) throw new Error(`recognize http ${res.status}`);
  const json = await res.json();
  return json?.ok ? json : null;
}

async function renderVerdict(vision) {
  const system = verdictSystemPrompt();
  const subject = vision?.labels?.[0] || "an unidentified household object";
  const caption = vision?.caption || "";
  const attrs   = (vision?.attributes || []).slice(0, 4).join(", ");

  const userMsg = [
    `SUBJECT: ${subject}`,
    caption ? `DESCRIPTION: ${caption}` : "",
    attrs   ? `ATTRIBUTES: ${attrs}` : "",
    "",
    "Render the verdict. Return JSON only.",
  ].filter(Boolean).join("\n");

  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: system },
        { role: "user",   content: userMsg },
      ],
    }),
  });
  if (!res.ok) throw new Error(`chat http ${res.status}`);
  const json = await res.json();
  const raw = json?.choices?.[0]?.message?.content ?? "";
  const parsed = safeParseVerdict(raw);
  if (!parsed) throw new Error("no verdict parsed");
  return parsed;
}

function verdictSystemPrompt() {
  return `You are the host of "Trash or Treasure", a snarky-but-affectionate household appraiser. A player has photographed something in their home. A vision system has already identified it.

Your job: deliver a one-word VERDICT (KEEP or TOSS) and ONE short, funny REASON.

Output STRICT JSON only — no markdown, no preamble:
{ "verdict": "KEEP" | "TOSS", "reason": "..." }

Rules:
- The verdict is theatrical, not life advice — you're playing a character. About 50/50 KEEP vs TOSS over time, but commit to whatever feels funnier for THIS subject.
- reason: ≤ 14 words, lowercase preferred, no exclamation marks, no emoji.
- Voice: dry, observant, slightly absurd. Like a loud honest friend at a flea market. Affectionate, never cruel.
- Good examples:
  - { "verdict": "TOSS", "reason": "this is no longer coffee. this is archaeology." }
  - { "verdict": "KEEP", "reason": "old reliable. they don't make these anymore." }
  - { "verdict": "TOSS", "reason": "one of these days has come. it was today." }
  - { "verdict": "KEEP", "reason": "still got fight in it." }
  - { "verdict": "TOSS", "reason": "you've been promising to fix this since 2019." }
  - { "verdict": "KEEP", "reason": "if marie kondo saw this she would lose." }
- Avoid: cruelty, gross-out, moralizing, advice, hygiene lectures, food safety warnings.
- Avoid generic openers like "this is a", "looks like", "i think". Just hit.`;
}

function safeParseVerdict(raw) {
  const cleaned = String(raw || "").replace(/```json/g, "").replace(/```/g, "").trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    const v = String(obj.verdict || "").toUpperCase();
    if (v !== "KEEP" && v !== "TOSS") return null;
    const reason = String(obj.reason || "").trim();
    if (!reason) return null;
    return { verdict: v, reason };
  } catch { return null; }
}

// ─── Comeback pool (static, no extra LLM call) ──────────────────────────

const COMEBACKS = {
  // AI said TOSS, user said KEEP IT → AI is petty
  "TOSS_KEEP": [
    "fine. enjoy your fungus.",
    "your funeral.",
    "we'll see in a month.",
    "noted for the record.",
    "good luck with that.",
    "the hoarders are clapping.",
    "okay, hoarder hour it is.",
  ],
  // AI said TOSS, user agreed → AI proud
  "TOSS_TOSS": [
    "smart. one of us.",
    "respect.",
    "minimalism wins.",
    "good call.",
    "the lord is pleased.",
    "freedom feels nice, doesn't it.",
  ],
  // AI said KEEP, user agreed → AI smug
  "KEEP_KEEP": [
    "see? we agree.",
    "champions of clutter.",
    "you have taste.",
    "vintage stays.",
    "no notes.",
    "couldn't have said it better.",
  ],
  // AI said KEEP, user said TOSS IT → AI confused
  "KEEP_TOSS": [
    "huh. brave.",
    "you'd regret it.",
    "marie kondo path, then?",
    "ok, cold-hearted.",
    "wait, really?",
    "throwing away history, but ok.",
  ],
};

function pickComeback(aiSaid, agreed) {
  const userSaid = agreed ? aiSaid : (aiSaid === "TOSS" ? "KEEP" : "TOSS");
  const key = `${aiSaid}_${userSaid}`;
  const pool = COMEBACKS[key] || [];
  return pool[Math.floor(Math.random() * pool.length)] || "";
}

// ─── UI helpers ─────────────────────────────────────────────────────────

function showProcessing(step, msg) {
  procStep.textContent = step;
  procMsg.textContent  = msg;
  proc.classList.add("show");
}
function hideProcessing() {
  proc.classList.remove("show");
}

function showError(msg) {
  errMsgEl.textContent = msg;
  hideProcessing();
  errOver.classList.add("show");
}
function hideError() {
  errOver.classList.remove("show");
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2400);
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function nextCaseNo() {
  const n = Number(localStorage.getItem("tot:case") || "0") + 1;
  localStorage.setItem("tot:case", String(n));
  return String(n).padStart(5, "0");
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── L1 social: "ASK A FRIEND" + inbox of cases referred to me ────────

const JUDGED_LS_KEY = "tot:judged";
const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000; // trim outbox older than 7 days

// Local mirror of my own save row. Aigram's get/data/list is eventually
// consistent — if I refer 2 cases back-to-back, a second refetch may
// still see the pre-first state. Keep the source of truth in memory.
let myMirror = null;

async function initSocial() {
  // Fetch self name (needed nowhere right now — sender name is filled in
  // by the platform via {sender_name} variable — but keeping it for the
  // inbox UI's "your turn" tone).
  try {
    const res = await A.callAigramAPI(
      `/note/telegram/user/get/info/by/telegram_id?telegram_id=${encodeURIComponent(me.id)}`,
      "GET"
    );
    me.name = res?.data?.name || "";
  } catch (e) {
    /* not fatal — keep going */
  }
  await scanInbox();
}

async function scanInbox() {
  if (!A.isInAigram || !A.gameUuid || !me.id) return;
  let rows = [];
  try {
    const res = await A.callAigramAPI(
      `/note/aigram/ai/game/get/data/list?session_id=${encodeURIComponent(A.gameUuid)}`,
      "GET"
    );
    rows = res?.data || [];
  } catch (e) {
    console.warn("scanInbox: data/list failed", e);
    return;
  }

  const judged = new Set(getJudgedIds());
  const pending = [];
  for (const row of rows) {
    if (!row || !row.resource_data) continue;
    // Capture my own row into the local mirror on first sight so
    // persistOutboxAppend below doesn't need to refetch.
    if (String(row.user_id) === String(me.id)) {
      if (!myMirror) {
        try { myMirror = JSON.parse(row.resource_data) || {}; } catch { myMirror = {}; }
      }
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(row.resource_data); } catch { continue; }
    const outbox = (parsed && parsed.outbox) || [];
    for (const c of outbox) {
      if (!c || !c.case_id) continue;
      if (String(c.target_user_id) !== String(me.id)) continue;
      if (judged.has(c.case_id)) continue;
      pending.push({
        case_id: c.case_id,
        sender_id: row.user_id,
        sender_name: row.user_name || "friend",
        sender_avatar: row.head_url || "",
        photo_url: c.photo_url,
        verdict: c.verdict,
        reason: c.reason,
        ts: c.ts || 0,
      });
    }
  }
  if (!myMirror) myMirror = {};
  pending.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  state.pending = pending;
  renderInboxChip();
}

function renderInboxChip() {
  const n = state.pending.length;
  if (n > 0) {
    inboxCount.textContent = String(n);
    inboxChip.classList.remove("hidden");
  } else {
    inboxChip.classList.add("hidden");
  }
}

function onInboxChip() {
  if (!state.pending.length) return;
  enterJuryMode(state.pending[0]);
}

function enterJuryMode(c) {
  state.juryCase = c;
  state.verdict = c.verdict;
  state.reason = c.reason;
  state.photoDataUrl = null;
  state.photoR2Url = c.photo_url;
  showVerdict();
}

// ── Picker ───────────────────────────────────────────────────────────

async function openPicker() {
  if (!A.isInAigram || !me.id) {
    toast("open inside Aigram to send to a friend");
    return;
  }
  picker.classList.add("show");
  pickerList.innerHTML = `<div class="picker-loading">loading the jury pool…</div>`;
  let friends = [];
  try {
    const res = await A.callAigramAPI(
      `/note/telegram/user/contact/list?telegram_id=${encodeURIComponent(me.id)}`,
      "GET"
    );
    friends = (res?.data || []).filter(f =>
      f && f.telegram_id && String(f.telegram_id) !== String(me.id)
    );
  } catch (e) {
    pickerList.innerHTML = `<div class="picker-empty">couldn't load friends · try again</div>`;
    return;
  }
  if (!friends.length) {
    pickerList.innerHTML = `<div class="picker-empty">no friends yet · add some in Aigram</div>`;
    return;
  }
  pickerList.innerHTML = "";
  for (const f of friends) {
    const item = document.createElement("button");
    item.className = "picker-item";
    item.type = "button";
    const name = escapeHtml(f.user_name || f.name || "friend");
    const av = f.head_url
      ? `<img class="picker-avatar" src="${escapeAttr(f.head_url)}" alt="" referrerpolicy="no-referrer">`
      : `<div class="picker-avatar is-initial">${escapeHtml((f.user_name || "?")[0] || "?").toUpperCase()}</div>`;
    item.innerHTML = av + `<span class="picker-name">${name}</span>`;
    // onClick (not pointerdown) — picker is a scrollable list; pointerdown
    // would fire while user is mid-swipe trying to scroll past.
    item.addEventListener("click", () => sendCaseToFriend(f));
    pickerList.appendChild(item);
  }
}

function closePicker() {
  picker.classList.remove("show");
}

async function sendCaseToFriend(friend) {
  closePicker();
  if (!state.photoR2Url) {
    toast("photo not uploaded yet");
    return;
  }
  const caseObj = {
    case_id: "c_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
    target_user_id: String(friend.telegram_id),
    photo_url: state.photoR2Url,
    verdict: state.verdict,
    reason: state.reason,
    ts: Date.now(),
  };
  persistOutboxAppend(caseObj);

  // Notify the friend. Image carries the photo (4-element notification),
  // text invites them to weigh in. Voice keeps the snarky register.
  A.postAigramAPI("/note/aigram/ai/game/record/play", {
    session_id: A.gameUuid,
    event: "case_referred",
    config_json: JSON.stringify({
      actions: [
        {
          type: "notify",
          target_user_id: String(friend.telegram_id),
          image: {
            ref_url: state.photoR2Url,
            prompt: "household object on trial · second opinion needed",
          },
          message: {
            template: "{sender_name} calls for your verdict on this junk.",
            variables: ["sender_name"],
          },
        },
      ],
    }),
  });

  toast("sent to " + (friend.user_name || friend.name || "friend"));
}

function sendJurorVerdictBack(caseObj, friendVote) {
  if (!A.isInAigram) return;
  const aiSaid = caseObj.verdict;            // "KEEP" | "TOSS"
  const friendSaid = friendVote;             // "KEEP" | "TOSS"
  const agreed = aiSaid === friendSaid;

  let tmpl;
  if (agreed && aiSaid === "TOSS")        tmpl = "{sender_name} agreed · toss it.";
  else if (agreed && aiSaid === "KEEP")   tmpl = "{sender_name} agreed · it stays.";
  else if (!agreed && aiSaid === "TOSS")  tmpl = "{sender_name} overruled — they say KEEP.";
  else                                    tmpl = "{sender_name} overruled — they say TOSS.";

  A.postAigramAPI("/note/aigram/ai/game/record/play", {
    session_id: A.gameUuid,
    event: "case_judged",
    config_json: JSON.stringify({
      actions: [
        {
          type: "notify",
          target_user_id: String(caseObj.sender_id),
          image: {
            ref_url: caseObj.photo_url,
            prompt: "your object · the verdict came back",
          },
          message: {
            template: tmpl,
            variables: ["sender_name"],
          },
        },
      ],
    }),
  });
}

// ── Outbox persistence (own save) ────────────────────────────────────

function persistOutboxAppend(caseObj) {
  if (!A.isInAigram || !A.gameUuid || !me.id) return;
  // Mirror is the source of truth (the cloud save is write-only echo
  // from the game's perspective — get/data/list lags behind writes by
  // an unbounded RTT). Seeded in scanInbox; default-empty here so we
  // still work when initSocial hasn't completed.
  if (!myMirror) myMirror = {};

  const now = Date.now();
  myMirror.outbox = (myMirror.outbox || [])
    .filter(c => c && c.ts && (now - c.ts) < OUTBOX_TTL_MS);
  myMirror.outbox.push(caseObj);
  if (myMirror.outbox.length > 50) myMirror.outbox = myMirror.outbox.slice(-50);

  A.postAigramAPI("/note/aigram/ai/game/save/data", {
    session_id: A.gameUuid,
    resource_data: JSON.stringify(myMirror),
  });
}

// ── Local de-dup of cases I've already judged ────────────────────────

function getJudgedIds() {
  try {
    const raw = localStorage.getItem(JUDGED_LS_KEY);
    if (!raw) return [];
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
function markJudged(caseId) {
  const ids = getJudgedIds();
  if (ids.indexOf(caseId) >= 0) return;
  ids.push(caseId);
  // Trim to last 200 to bound localStorage growth.
  const trimmed = ids.slice(-200);
  try { localStorage.setItem(JUDGED_LS_KEY, JSON.stringify(trimmed)); } catch { /* full */ }
}

// HTML-attribute-safe escape (for src="...").
function escapeAttr(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

// ─── CASE LOG · per-device running tally rendered on home ──────────────

const STATS_LS_KEY = "tot:stats";

function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_LS_KEY);
    if (!raw) return { total: 0, toss: 0, keep: 0 };
    const s = JSON.parse(raw);
    return {
      total: Number(s.total) || 0,
      toss:  Number(s.toss)  || 0,
      keep:  Number(s.keep)  || 0,
    };
  } catch {
    return { total: 0, toss: 0, keep: 0 };
  }
}

function incStats(pick) {
  const s = loadStats();
  s.total += 1;
  if (pick === "TOSS")      s.toss += 1;
  else if (pick === "KEEP") s.keep += 1;
  try { localStorage.setItem(STATS_LS_KEY, JSON.stringify(s)); } catch { /* full */ }
  renderCaseLog(s);
}

function renderCaseLog(s) {
  s = s || loadStats();
  if (!s.total) {
    caseLog.classList.add("hidden");
    return;
  }
  caseLogTotal.textContent = String(s.total);
  caseLogToss.textContent  = String(s.toss);
  caseLogKeep.textContent  = String(s.keep);
  caseLog.classList.remove("hidden");
}

// Kick everything off AFTER all module-level const/lets above are initialized.
// (Function decls hoist; const/let live in the TDZ until execution reaches
// them — calling init() at the top of the file made loadStats() throw a
// silent ReferenceError on STATS_LS_KEY, caught by its own try/catch.)
init();
