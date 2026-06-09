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
const caseMeta  = $("caseMeta");

let state = {
  verdict: null,   // "KEEP" | "TOSS"
  reason: null,
  vision: null,
  photoDataUrl: null,
};
// Monotonic run id — bumped on cancel/retry so stale in-flight results are
// ignored when they finally come back.
let runId = 0;

init();

function init() {
  fileInput.addEventListener("change", onFilePicked);
  $("closeVerdict").addEventListener("click", closeVerdict);
  voteRow.addEventListener("click", onVote);
  nextBtn.addEventListener("click", () => {
    closeVerdict();
    fileInput.value = "";
    setTimeout(() => fileInput.click(), 60);
  });
  procCancel.addEventListener("click", cancelPipeline);
  $("errRetry").addEventListener("click", () => {
    hideError();
    runPipeline();
  });
  $("errDismiss").addEventListener("click", () => {
    hideError();
    cancelPipeline();
  });
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
  photoImg.src = state.photoDataUrl;
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
  nextBtn.classList.add("hidden");
  voteRow.classList.remove("hidden");
  for (const btn of voteRow.querySelectorAll(".vote-btn")) {
    btn.classList.remove("voted");
    btn.disabled = false;
  }
  caseMeta.textContent = `CASE #${nextCaseNo()}`;

  overlay.classList.add("show");
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
  nextBtn.classList.remove("hidden");
}

function closeVerdict() {
  overlay.classList.remove("show");
  state.verdict = null;
  state.reason = null;
  state.vision = null;
  state.photoDataUrl = null;
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
