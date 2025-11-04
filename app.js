const $ = (q, ctx = document) => ctx.querySelector(q);
const $$ = (q, ctx = document) => Array.from(ctx.querySelectorAll(q));

const STORAGE_KEYS = {
  tasks: 'abdt_tasks',
  settings: 'abdt_settings',
  sessions: 'abdt_sessions'
};

const PHASES = {
  HYPOTHESIZE: 'Hypothesize', // short priming
  FOCUS: 'Focus',             // deep work
  REFLECT: 'Reflect'          // quick review
};

const DEFAULTS = {
  durations: { HYPOTHESIZE: 120, FOCUS: 14*60, REFLECT: 90 }, // seconds
  microBreak: { enabled: true, duration: 20 }, // 20s reset window
  autoAdvance: true,
  sound: false,
  focusPresets: [7, 14, 21, 28], // minutes
};

const state = {
  phase: PHASES.HYPOTHESIZE,
  timeRemaining: DEFAULTS.durations.HYPOTHESIZE,
  running: false,
  startTs: null,
  targetFocusSeconds: DEFAULTS.durations.FOCUS,
  momentum: 0, // heuristic score updated by interactions
  tasks: [],
  sessions: [],
  settings: { ...DEFAULTS },
  ringLength: 2 * Math.PI * 54, // matches CSS stroke-dasharray
};

function loadState() {
  try {
    const tasks = JSON.parse(localStorage.getItem(STORAGE_KEYS.tasks) || '[]');
    const settings = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || 'null');
    const sessions = JSON.parse(localStorage.getItem(STORAGE_KEYS.sessions) || '[]');
    if (Array.isArray(tasks)) state.tasks = tasks;
    if (settings && typeof settings === 'object') state.settings = { ...DEFAULTS, ...settings };
    if (Array.isArray(sessions)) state.sessions = sessions;
  } catch {}
}

function persist() {
  localStorage.setItem(STORAGE_KEYS.tasks, JSON.stringify(state.tasks));
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
  localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(state.sessions));
}

function fmtTime(total) {
  total = Math.max(0, Math.round(total));
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = Math.floor(total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function setPhase(phase, customSeconds) {
  state.phase = phase;
  let seconds;
  if (typeof customSeconds === 'number') seconds = customSeconds;
  else if (phase === PHASES.HYPOTHESIZE) seconds = state.settings.durations?.HYPOTHESIZE ?? DEFAULTS.durations.HYPOTHESIZE;
  else if (phase === PHASES.FOCUS) seconds = state.targetFocusSeconds;
  else seconds = state.settings.durations?.REFLECT ?? DEFAULTS.durations.REFLECT;

  state.timeRemaining = seconds;
  state.startTs = null;
  state.running = false;
  updateUI();
}

function switchToNextPhase() {
  if (state.phase === PHASES.HYPOTHESIZE) setPhase(PHASES.FOCUS);
  else if (state.phase === PHASES.FOCUS) setPhase(PHASES.REFLECT);
  else {
    // choose next focus duration abductively
    const next = inferNextFocusSeconds();
    state.targetFocusSeconds = next;
    setPhase(PHASES.HYPOTHESIZE);
  }
  log(`? ${state.phase}`);
}

function start() {
  if (state.running) return;
  state.running = true;
  state.startTs = performance.now();
  tick();
  bumpMomentum(0.5); // starting is a positive action
  beep(300, 0.03);
}
function pause() { state.running = false; }

function nudge(seconds) {
  state.timeRemaining = Math.max(0, state.timeRemaining + seconds);
  updateUI();
}

let rafId = null;
function tick(now) {
  if (!state.running) return;
  if (!state.startTs) state.startTs = now || performance.now();
  const dt = ((now || performance.now()) - state.startTs) / 1000; // seconds
  state.startTs = now || performance.now();
  state.timeRemaining -= dt;
  if (state.timeRemaining <= 0) {
    state.timeRemaining = 0;
    state.running = false;
    // record session fragment
    state.sessions.push({ phase: state.phase, endedAt: Date.now(), momentum: state.momentum, focusSeconds: state.targetFocusSeconds });
    persist();
    beep(880, 0.07);
    if (state.phase === PHASES.FOCUS && state.settings.microBreak?.enabled) {
      // micro-break breathing
      microBreakAnimation(state.settings.microBreak.duration).then(() => { if (state.settings.autoAdvance) switchToNextPhase(); });
    } else if (state.settings.autoAdvance) {
      switchToNextPhase();
    }
    updateUI();
    return;
  }
  updateUI();
  rafId = requestAnimationFrame(tick);
}

function updateUI() {
  // text and ring
  $('#timeText').textContent = fmtTime(state.timeRemaining);
  $('#phaseLabel').textContent = state.phase;
  const total = state.phase === PHASES.FOCUS ? state.targetFocusSeconds : (state.phase === PHASES.HYPOTHESIZE ? (state.settings.durations?.HYPOTHESIZE ?? DEFAULTS.durations.HYPOTHESIZE) : (state.settings.durations?.REFLECT ?? DEFAULTS.durations.REFLECT));
  const progress = total > 0 ? (1 - state.timeRemaining / total) : 0;
  const offset = state.ringLength * (1 - progress);
  $('#ringFg').style.strokeDasharray = `${state.ringLength}`;
  $('#ringFg').style.strokeDashoffset = `${offset}`;
  $('#startPause').textContent = state.running ? 'Pause' : 'Start';
  $('#soundToggle').textContent = state.settings.sound ? '??' : '??';
  $('#soundToggle').setAttribute('aria-pressed', String(state.settings.sound));
  $('#distractionToggle').setAttribute('aria-pressed', String(document.body.classList.contains('df')));
  $('#microBreaks').checked = !!state.settings.microBreak?.enabled;
  $('#autoAdvance').checked = !!state.settings.autoAdvance;
  renderTasks();
  renderInsights();
  renderLog();
}

function renderTasks() {
  const list = $('#taskList');
  list.innerHTML = '';
  state.tasks.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'task';
    li.innerHTML = `
      <input type="checkbox" ${t.done ? 'checked' : ''} aria-label="Toggle done" />
      <div class="title" contenteditable="true" spellcheck="false">${escapeHtml(t.title)}</div>
      <span class="chip" title="size">${t.size}</span>
      <div class="row">
        <button class="icon" data-act="up" title="Move up">?</button>
        <button class="icon" data-act="down" title="Move down">?</button>
        <button class="icon" data-act="del" title="Delete">?</button>
      </div>`;
    const [cb, title, , row] = li.children;
    cb.addEventListener('change', () => { t.done = cb.checked; persist(); updateUI(); });
    title.addEventListener('input', () => { t.title = title.textContent.trim(); persist(); });
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      if (btn.dataset.act === 'del') state.tasks.splice(i, 1);
      if (btn.dataset.act === 'up' && i>0) [state.tasks[i-1], state.tasks[i]] = [state.tasks[i], state.tasks[i-1]];
      if (btn.dataset.act === 'down' && i<state.tasks.length-1) [state.tasks[i], state.tasks[i+1]] = [state.tasks[i+1], state.tasks[i]];
      persist(); updateUI();
    });
    list.appendChild(li);
  });
}

function renderInsights() {
  const box = $('#insightBox');
  const last = state.sessions.slice(-5);
  const momentumAvg = last.length ? (last.reduce((a,s)=>a+s.momentum,0)/last.length).toFixed(2) : '?';
  const nextFocusMin = Math.round(inferNextFocusSeconds()/60);
  const topTask = state.tasks.find(t=>!t.done);
  const msg = [
    `Momentum: ${momentumAvg}`,
    `Next focus suggestion: ${nextFocusMin}m`,
    topTask ? `Try: ${escapeHtml(topTask.title)} (${topTask.size})` : 'Add a task to focus on',
  ];
  box.innerHTML = msg.map(m=>`<div>? ${m}</div>`).join('');
}

function renderLog() {
  const ul = $('#logList');
  ul.innerHTML = '';
  state.sessions.slice(-10).reverse().forEach(s=>{
    const li = document.createElement('li');
    li.className = 'log';
    const when = new Date(s.endedAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    li.textContent = `${when} ? ${s.phase} ? momentum ${s.momentum.toFixed ? s.momentum.toFixed(2): s.momentum}`;
    ul.appendChild(li);
  });
}

function inferNextFocusSeconds() {
  // abductive heuristic using last sessions + live momentum
  const history = state.sessions.slice(-6);
  const histMomentum = history.length ? history.reduce((a,s)=>a+s.momentum,0)/history.length : 0;
  const combined = 0.6*clamp(state.momentum, -2, 4) + 0.4*clamp(histMomentum, -2, 4);
  const presets = state.settings.focusPresets || DEFAULTS.focusPresets;
  // Map combined score to preset index 0..n-1
  const idx = clamp(Math.round(mapRange(combined, -2, 4, 0, presets.length-1)), 0, presets.length-1);
  return presets[idx] * 60;
}

function bumpMomentum(amount) {
  state.momentum = clamp(state.momentum + amount, -2, 4);
}

// Utils
function clamp(v, a, b){ return Math.min(b, Math.max(a, v)); }
function mapRange(v, inMin, inMax, outMin, outMax){ return outMin + (outMax-outMin)*(v-inMin)/(inMax-inMin); }
function escapeHtml(s){ return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c])); }

// Micro-break: simple breathing pulse on the ring
function microBreakAnimation(sec) {
  return new Promise(resolve => {
    let t = 0; const total = sec;
    function pulse() {
      const p = 0.5 + 0.5*Math.sin((t/total)*Math.PI*2);
      $('#ringFg').style.stroke = `hsl(${190 + 20*Math.sin(t*2)}, 90%, ${40 + 10*p}%)`;
      t += 0.016;
      if (t < total) requestAnimationFrame(pulse); else { $('#ringFg').style.stroke = ''; resolve(); }
    }
    pulse();
  });
}

// Audio
let audioCtx = null;
function beep(freq, dur){
  if (!state.settings.sound) return;
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq; o.type = 'sine';
    g.gain.value = 0.05; o.connect(g); g.connect(audioCtx.destination);
    o.start(); setTimeout(()=>{ o.stop(); }, dur*1000);
  }catch{}
}

// Event wiring
function setup() {
  loadState();
  // restore theme
  document.body.classList.toggle('df', false);

  // Inputs
  $('#taskForm').addEventListener('submit', (e)=>{
    e.preventDefault();
    const title = $('#taskInput').value.trim();
    const size = $('#taskSize').value;
    if (!title) return;
    state.tasks.push({ id: crypto.randomUUID(), title, size, done:false });
    $('#taskInput').value = '';
    persist(); updateUI(); bumpMomentum(0.1);
  });

  $('#startPause').addEventListener('click', ()=> state.running ? (pause(), beep(200, 0.03)) : start());
  $('#nextPhase').addEventListener('click', ()=> { switchToNextPhase(); });
  $('#nudgeMinus').addEventListener('click', ()=> nudge(-60));
  $('#nudgePlus').addEventListener('click', ()=> nudge(+60));

  $$('.focus-presets .chip').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const m = Number(btn.dataset.focus);
      state.targetFocusSeconds = m*60; 
      if (state.phase === PHASES.FOCUS) setPhase(PHASES.FOCUS, m*60);
      updateUI();
    });
  });

  $('#microBreaks').addEventListener('change', (e)=>{ state.settings.microBreak.enabled = e.target.checked; persist(); });
  $('#autoAdvance').addEventListener('change', (e)=>{ state.settings.autoAdvance = e.target.checked; persist(); });

  $('#themeToggle').addEventListener('click', ()=>{
    const root = document.documentElement;
    if (root.getAttribute('data-theme') === 'dark') root.setAttribute('data-theme','dark'); // locked dark per request
  });

  $('#soundToggle').addEventListener('click', ()=>{ state.settings.sound = !state.settings.sound; persist(); updateUI(); });
  $('#distractionToggle').addEventListener('click', ()=>{ document.body.classList.toggle('df'); updateUI(); });

  // Momentum heuristics: keyboard/mouse activity during Focus increases momentum
  let lastActivity = Date.now();
  ['keydown','mousedown','touchstart'].forEach(ev=>{
    document.addEventListener(ev, ()=>{
      const now = Date.now();
      const dt = (now - lastActivity)/1000;
      lastActivity = now;
      if (state.phase === PHASES.FOCUS) bumpMomentum(dt < 3 ? 0.05 : -0.02);
    }, {passive:true});
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e)=>{
    if (e.target.isContentEditable || /input|textarea|select/i.test(e.target.tagName)) return;
    if (e.code === 'Space'){ e.preventDefault(); state.running ? pause() : start(); }
    if (e.key === 'n' || e.key === 'N'){ switchToNextPhase(); }
    if (e.key === '+'){ nudge(+60); }
    if (e.key === '-'){ nudge(-60); }
    if (e.key === 'a' || e.key === 'A'){ $('#taskInput').focus(); }
    if (e.key === '1'){ state.targetFocusSeconds = (state.settings.focusPresets?.[0]||7)*60; updateUI(); }
    if (e.key === '2'){ state.targetFocusSeconds = (state.settings.focusPresets?.[1]||14)*60; updateUI(); }
    if (e.key === '3'){ state.targetFocusSeconds = (state.settings.focusPresets?.[2]||21)*60; updateUI(); }
    if (e.key === '4'){ state.targetFocusSeconds = (state.settings.focusPresets?.[3]||28)*60; updateUI(); }
  });

  // Initial phase and UI
  if (!state.targetFocusSeconds) state.targetFocusSeconds = DEFAULTS.durations.FOCUS;
  setPhase(PHASES.HYPOTHESIZE);
  updateUI();
}

// Start loop only when running
const obs = new MutationObserver(()=>{}); // placeholder to keep context active when needed

window.addEventListener('load', setup);

// Accessibility improvements
(function reduceMotion(){
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (mq.matches) {
    const el = $('#ringFg');
    if (el) el.style.transition = 'none';
  }
})();
