import {
  eventSource, event_types, saveSettingsDebounced,
  setExtensionPrompt, extension_prompt_types
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const extensionName = "singe";
let pendingMark = null;
let wasSwipe = false;      // set by MESSAGE_SWIPED, consumed by MESSAGE_RECEIVED
let armedScene = null;     // scene waiting to be consumed by the next generation
let lastDelivered = null;  // scene the newest bot reply was given — re-applied on swipe

// After a scene fires, skip the dice entirely for this many bot replies. Two
// reasons: it makes back-to-back scenes impossible, and — more importantly —
// a scene now spans several messages, so these are exactly the replies where
// a fresh "initiate sex" injection would land in the middle of one already
// under way. Not user-configurable on purpose.
const SCENE_PAUSE = 5;

// Injection roles — literal values, so we don't depend on an import that may
// not exist in older SillyTavern builds.
// setExtensionPrompt(key, value, position, depth, scan, role, filter)
const ROLE_SYSTEM = 0;
const ROLE_USER = 1;

// ─── Settings ──────────────────────────────────────────────────────────────
const defaultSettings = {
  isEnabled: true,
  chance: 8,
  useGrowingChance: true,
  growingChanceStep: 5,
  selectedTypes: ["rough"],
  injectAsUser: true,   // USER role at depth 0 — obeyed far more reliably
  extraInstruction: '', // optional free-text appended to every injection
};

function loadSettings() {
  if (!extension_settings[extensionName]) {
    extension_settings[extensionName] = structuredClone(defaultSettings);
  }
  for (const key in defaultSettings) {
    if (extension_settings[extensionName][key] === undefined) {
      const d = defaultSettings[key];
      extension_settings[extensionName][key] =
        (d && typeof d === 'object') ? structuredClone(d) : d;
    }
  }
  if (!extension_settings[extensionName].chatStates) {
    extension_settings[extensionName].chatStates = {};
  }
  migrateSelectedTypes();
}

// Scene ids that were merged or renamed away. Anyone upgrading has these saved
// in their settings; without remapping, pickRandomType() would return a dead id
// and buildPrompt() would hand the bot an empty string.
// NOTE: petplay and bodywriting are VALID ids now — they must not appear as
// keys here or the migration would remap the very ids it should leave alone.
const idMigrations = {
  manual: 'handsmouth',
  rimming: 'handsmouth',
  facial: 'messy',
  ownership: 'petplay',
};

function migrateSelectedTypes() {
  const s = extension_settings[extensionName];
  if (!Array.isArray(s.selectedTypes)) { s.selectedTypes = ['rough']; return; }
  const valid = new Set(sceneTypes.map(t => t.id));
  const out = new Set();
  for (const id of s.selectedTypes) {
    const mapped = idMigrations[id] || id;
    if (valid.has(mapped)) out.add(mapped);
  }
  if (!out.size) out.add('rough');
  s.selectedTypes = [...out];
}
function getSettings() { return extension_settings[extensionName]; }

// ─── Runtime state ─────────────────────────────────────────────────────────
function getChatKey() {
  try {
    const ctx = SillyTavern.getContext();
    return ctx?.name2 || ctx?.characters?.[ctx?.characterId]?.name || '__default__';
  } catch (e) { return '__default__'; }
}

function getChatState(key) {
  const s = getSettings();
  if (!s.chatStates) s.chatStates = {};
  if (!s.chatStates[key]) {
    s.chatStates[key] = {
      messagesSinceLastTrigger: 0,
      messageCount: 0,
      triggerCount: 0,
      lastType: null,
    };
  }
  return s.chatStates[key];
}

function saveChatState() { saveSettingsDebounced(); }

// ─── Scene rows ────────────────────────────────────────────────────────────
// Rows exist only to split the pills into three swipeable strips instead of
// one very long one. They are not labelled in the UI and carry no meaning the
// user has to learn.
const sceneGroups = [{ id: 'row1' }, { id: 'row2' }, { id: 'row3' }];

// ─── Scene types ───────────────────────────────────────────────────────────
// `directive` is the one line describing what the scene is. It gets wrapped in
// a hard instruction frame by buildPrompt() — deliberately with no escape
// hatches, because soft phrasing ("let it emerge naturally") gives the model
// permission to ignore the whole thing.
//
// Icons are deliberately restricted to Unicode 8.0 and earlier. Newer emoji
// (🫣, 🫦, 😮‍💨, 👁️‍🗨️) fail to render on some phones and browsers and show
// as an empty box.
const sceneTypes = [
  // ── Row 1 ───────────────────────────────────────────────────────────────
  { id: 'rough', label: 'Rough', icon: '🔥', color: '#d04040', group: 'row1',
    directive: 'rough and dominant — forceful, demanding, physically assertive, no softness or hesitation' },
  { id: 'bdsm', label: 'BDSM', icon: '⛓️', color: '#7c6fcd', group: 'row1',
    directive: 'BDSM — explicit power exchange using restraints, toys, commands, and control. Sometimes a full BDSM session, sometimes just sex with BDSM elements' },
  { id: 'cnc', label: 'CNC', icon: '⚔️', color: '#8c3a3a', group: 'row1',
    directive: 'consensual non-consent — resistance, struggling, being pinned down and taken by force. This is agreed-upon play between them. One resists, the other overpowers. Write the physicality of the struggle' },
  { id: 'petplay', label: 'Pet Play', icon: '🐾', color: '#c47a3a', group: 'row1',
    directive: 'pet play — one is the owner, the other is the pet. Collar, leash, commands like sit, stay, and beg. Praise for obedience, punishment for disobedience. The pet does not speak in words unless permitted' },
  { id: 'bodywriting', label: 'Body Writing', icon: '✍️', color: '#6a8a6a', group: 'row1',
    directive: 'body writing — the dominant writes on the other\'s skin with a marker, lipstick, or eyeliner. Words, labels, arrows pointing at body parts, tally marks. Degrading, possessive, or vulgar. Describe what is written and where, and have the dominant demand it be acknowledged' },
  { id: 'gunplay', label: 'Gunplay', icon: '🔫', color: '#4a4a4a', group: 'row1',
    directive: 'a weapon is present and used as a tool of intimidation and arousal during the scene — pressed against skin, traced along the body, held as a threat. The danger is the point' },
  { id: 'directed', label: 'Directed', icon: '☝️', color: '#d4a843', group: 'row1',
    directive: 'directed masturbation — the dominant does not touch, only watches and gives explicit commands: touch yourself here, use this, slower, faster, do not stop. The dominant enjoys the control and keeps issuing instructions' },
  { id: 'gagging', label: 'Gagging', icon: '👄', color: '#b05070', group: 'row1',
    directive: 'the dominant makes the other go down on them — deepthroat, gagging, a hand on the back of the head setting the pace and the depth. The dominant is in charge of how far and how long' },

  // ── Row 2 ───────────────────────────────────────────────────────────────
  { id: 'spontaneous', label: 'Spontaneous', icon: '🚪', color: '#3ab8b8', group: 'row2',
    directive: 'sudden and unplanned — wherever they currently are, against furniture or a wall, no buildup' },
  { id: 'risky', label: 'Risky', icon: '👀', color: '#d97734', group: 'row2',
    directive: 'with a real risk of being caught — a place where someone could walk in, and that danger is part of it' },
  { id: 'clothed', label: 'Clothed', icon: '👗', color: '#a0785a', group: 'row2',
    directive: 'clothes mostly staying on — pushed aside or pulled up, too impatient to undress' },
  { id: 'sleepy', label: 'Sleepy / Lazy', icon: '😴', color: '#6b8aad', group: 'row2',
    directive: 'slow and drowsy — half-asleep, lazy, tangled in bedding, completely unhurried' },
  { id: 'phonesex', label: 'Phone Sex', icon: '📱', color: '#5ca0d3', group: 'row2',
    directive: 'sex over voice or text — the characters are NOT in the same room. One gives explicit instructions down the line and describes what they are doing to themselves while listening' },
  { id: 'cosplay', label: 'RP in RP', icon: '🎭', color: '#9b6fbf', group: 'row2',
    directive: 'roleplay inside the roleplay — they adopt a scenario and stay in those invented roles for the scene: strangers meeting, boss and employee, an interrogation, a stranger paying for it, whatever fits their dynamic. Pick one and commit' },

  // ── Row 3 ───────────────────────────────────────────────────────────────
  { id: 'tease', label: 'Tease', icon: '😏', color: '#c49a2a', group: 'row3',
    directive: 'teasing and denial — build arousal deliberately and withhold release, keep the other on edge' },
  { id: 'handsmouth', label: 'Hands & Mouth', icon: '🤚', color: '#e06c8c', group: 'row3',
    directive: 'focused entirely on hands and mouth — fingers, tongue, any part of the body including the ass. Deliberate, unhurried, one partner in complete control of the other' },
  { id: 'breeding', label: 'Breeding', icon: '🥀', color: '#c4456e', group: 'row3',
    directive: 'breeding kink — the dominant is fixated on finishing inside, filling up, impregnation talk. Possessive, primal, no pulling out' },
  { id: 'messy', label: 'Messy', icon: '💦', color: '#7a8aad', group: 'row3',
    directive: 'messy and uncontained — smeared saliva, ruined makeup, tears, fluids left on the face and body. Nothing gets wiped clean. If someone finishes on a face, it is the DOMINANT who pulls the other close and demands it on their own face, not the other way around. Describe what is dripping, smeared, and running' },
  { id: 'facesitting', label: 'Facesitting', icon: '💺', color: '#b5687f', group: 'row3',
    directive: 'facesitting — the dominant pulls the other down onto their own face and holds them there, controlling the position and how long it lasts. The dominant wants this and takes it. This is the dominant receiving, not the other way around' },
  { id: 'objects', label: 'Objects', icon: '🍾', color: '#8a7a5a', group: 'row3',
    directive: 'improvised objects, NOT purpose-made toys — household items, a bottle neck, a handle, ice, food, whatever happens to be within reach. The improvisation is the point' },
  { id: 'overstim', label: 'Overstim', icon: '⚡', color: '#d4c040', group: 'row3',
    directive: 'overstimulation and repeated forced orgasms — the dominant pushes well past the first climax and refuses to stop or let the other rest, regardless of protest. Write the dominant\'s relentlessness and their enjoyment of it' },
];

// ─── Prompt construction ───────────────────────────────────────────────────
// Names are left as SillyTavern macros ({{char}}, {{user}}) rather than
// resolved here. ST substitutes them when it assembles the prompt, so the
// extension never has to read or handle the persona name itself.
function buildPrompt(sceneType) {
  const scene = sceneTypes.find(s => s.id === sceneType);
  if (!scene) return '';
  const s = getSettings();

  const extra = (s.extraInstruction || '').trim()
    ? `\nAdditional direction: ${s.extraInstruction.trim()}`
    : '';

  return `[OOC — direction for this response only. Not story text, not to be quoted.]

In this response, {{char}} initiates sex with {{user}}. Type of scene: ${scene.directive}.

Rules for this response:
- {{char}} starts it here, in this response. Do not defer it or set it up for later.
- This response BEGINS the scene. It does not finish it. Stop while the scene is still unfolding, at a moment that hands the initiative back to {{user}}. Do not reach a conclusion, do not write an aftermath, do not resolve it.
- Write ONLY {{char}}. Never put words in {{user}}'s mouth and never decide what {{user}} does — no dialogue, no actions, no choices made on their behalf. You may write what {{char}} perceives of them, but {{user}}'s responses are {{user}}'s to give. Where the scene description above refers to the other person, that describes what {{char}} does and wants; it is NOT permission to narrate {{user}}.
- Do not fade to black, cut away, or time-skip.
- If the current moment does not lead there, {{char}} makes it lead there — closes the distance, changes the subject, acts on impulse. Bridge it in a line or two, then proceed.
- Keep your established voice, prose style, and characterization intact.${extra}

[/OOC]`;
}

function getCurrentChance() {
  const s = getSettings();
  if (!s.useGrowingChance) return s.chance;
  const state = getChatState(getChatKey());
  // Cap at 100, not 95 — a user who sets the slider to 100 must actually get 100.
  return Math.min(s.chance + Math.floor(state.messagesSinceLastTrigger / (s.growingChanceStep || 5)), 100);
}

// Never fire the same type twice running when there is more than one to choose
// from. Pure random repeats often enough to read as "it always picks the same
// one", which kills the surprise the whole feature exists for.
function pickRandomType() {
  const s = getSettings();
  const valid = new Set(sceneTypes.map(t => t.id));
  const active = (s.selectedTypes || []).filter(id => valid.has(id));
  if (!active.length) return 'rough';
  if (active.length === 1) return active[0];
  const last = getChatState(getChatKey()).lastType;
  const pool = active.filter(id => id !== last);
  const from = pool.length ? pool : active;
  return from[Math.floor(Math.random() * from.length)];
}

// ─── Injection ─────────────────────────────────────────────────────────────
// IN_CHAT at depth 0 = inserted after the last chat message, i.e. the very
// last thing the model reads before it writes. This is the strongest position
// available and it is what working extensions use. Do not change it to
// IN_PROMPT — that buries the instruction near the top of the context.
function applyInjection(prompt) {
  const role = getSettings().injectAsUser ? ROLE_USER : ROLE_SYSTEM;
  setExtensionPrompt(
    extensionName,
    prompt,
    extension_prompt_types.IN_CHAT,
    0,      // depth 0 — after the last message
    false,  // scan (world info)
    role
  );
}

function clearInjection() {
  const role = getSettings().injectAsUser ? ROLE_USER : ROLE_SYSTEM;
  setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0, false, role);
}

// ─── Trigger ───────────────────────────────────────────────────────────────
function triggerScene(forceType = null) {
  const typeId = forceType || pickRandomType();
  const prompt = buildPrompt(typeId);
  if (!prompt) { console.warn('[Singe] unknown scene type, skipping:', typeId); return; }
  injectScene(prompt, typeId);
}

function injectScene(prompt, typeId) {
  const key = getChatKey();
  const state = getChatState(key);
  const scene = sceneTypes.find(s => s.id === typeId);

  applyInjection(prompt);

  state.messagesSinceLastTrigger = 0;
  state.triggerCount++;
  state.lastType = typeId;
  pendingMark = { typeId };
  armedScene = { prompt, typeId };
  saveChatState();
  updatePanelUI();
}

// ─── DOM helpers ───────────────────────────────────────────────────────────
function markLastBotMessage(typeId) {
  try {
    const all = document.querySelectorAll('.mes[is_user="false"]');
    if (!all.length) return;
    const last = all[all.length - 1];
    if (last.querySelector('.singe-msg-indicator')) return;
    const nameEl = last.querySelector('.name_text');
    if (!nameEl) return;
    const scene = sceneTypes.find(s => s.id === typeId);
    const ind = document.createElement('span');
    ind.className = 'singe-msg-indicator';
    ind.title = `Singe · ${scene?.label || typeId}`;
    ind.textContent = '🔻';
    ind.style.color = scene?.color || 'rgba(255,255,255,0.4)';
    nameEl.after(ind);
  } catch (e) { console.warn('[Singe]', e); }
}

// ─── Prompt preview ────────────────────────────────────────────────────────
function showPromptPreview(prompt, typeId) {
  document.getElementById('singe-preview-modal')?.remove();
  const scene = sceneTypes.find(s => s.id === typeId);

  const modal = document.createElement('div');
  modal.id = 'singe-preview-modal';
  modal.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:200000;background:rgba(0,0,0,0.6);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.22s ease;box-sizing:border-box;';

  const inner = document.createElement('div');
  inner.style.cssText = 'width:min(520px,92vw);max-height:80vh;overflow-y:auto;background:rgba(18,18,24,0.88);backdrop-filter:blur(28px);border:1px solid rgba(255,255,255,0.12);border-radius:14px;box-shadow:0 32px 72px rgba(0,0,0,0.65);display:flex;flex-direction:column;flex-shrink:0;transform:scale(0.97);transition:transform 0.26s cubic-bezier(0.22,1,0.36,1);margin:auto;';

  const header = document.createElement('div');
  header.className = 'singe-preview-header';
  header.innerHTML = `
    <div class="singe-preview-header-left">
      <span class="singe-preview-icon">${scene?.icon || '🔥'}</span>
      <span class="singe-preview-title">${scene?.label || typeId}</span>
    </div>
    <button class="singe-preview-close">✕</button>`;

  const hint = document.createElement('div');
  hint.className = 'singe-preview-hint';
  hint.textContent = 'Можно отредактировать перед отправкой';

  // textContent, not innerHTML — the prompt contains characters that would
  // break out of a template literal inside a <textarea>
  const ta = document.createElement('textarea');
  ta.className = 'singe-preview-textarea';
  ta.spellcheck = false;
  ta.value = prompt;

  const actions = document.createElement('div');
  actions.className = 'singe-preview-actions';
  actions.innerHTML = `
    <button class="singe-preview-cancel">Отмена</button>
    <button class="singe-preview-send">${scene?.icon || '🔥'} Зарядить</button>`;

  inner.append(header, hint, ta, actions);
  modal.appendChild(inner);
  document.documentElement.appendChild(modal);

  const close = () => {
    modal.style.opacity = '0';
    inner.style.transform = 'scale(0.97)';
    setTimeout(() => modal.remove(), 240);
  };

  header.querySelector('.singe-preview-close').addEventListener('click', close);
  actions.querySelector('.singe-preview-cancel').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  actions.querySelector('.singe-preview-send').addEventListener('click', () => {
    const edited = ta.value;
    modal.remove();
    injectScene(edited, typeId);
  });

  requestAnimationFrame(() => {
    modal.style.opacity = '1';
    inner.style.transform = 'scale(1)';
  });
}

// ─── Panel UI update ───────────────────────────────────────────────────────
// Russian needs three plural forms: 1 сообщение, 2 сообщения, 5 сообщений.
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function updatePanelUI() {
  const key = getChatKey();
  const state = getChatState(key);
  const s = getSettings();
  const chance = getCurrentChance();

  const brand = document.getElementById('singe-brand');
  if (brand) brand.classList.toggle('singe-brand-off', !s.isEnabled);

  const num = document.getElementById('singe-chance-num');
  if (num) num.textContent = chance;

  const fill = document.getElementById('singe-bar-fill');
  if (fill) fill.style.width = Math.min(chance, 100) + '%';

  // Plain language beats percentage jargon: say how often it actually lands.
  const plain = document.getElementById('singe-chance-plain');
  if (plain) {
    const every = Math.max(1, Math.round(100 / Math.max(chance, 1)));
    const grown = s.useGrowingChance && chance > s.chance;
    plain.textContent = `≈ раз в ${every} ${plural(every, 'ответ', 'ответа', 'ответов')}`
      + (grown ? ` · выросло с ${s.chance}%` : '');
  }

  const st = document.getElementById('singe-chance-state');
  if (st) {
    const since = state.messagesSinceLastTrigger;
    if (state.triggerCount > 0 && since <= SCENE_PAUSE) {
      const left = SCENE_PAUSE - since + 1;
      st.textContent = `пауза после сцены · ещё ${left} ${plural(left, 'ответ', 'ответа', 'ответов')}`;
      st.classList.add('singe-state-paused');
    } else {
      st.textContent = `${since} ${plural(since, 'ответ', 'ответа', 'ответов')} без сцены`;
      st.classList.remove('singe-state-paused');
    }
  }

  const tracker = document.getElementById('singe-session-tracker');
  if (tracker) tracker.textContent = `${state.messageCount} · ${state.triggerCount}`;
}

// ─── Main event ────────────────────────────────────────────────────────────
// Fires after the bot's message lands. The injection set here stays in place
// until the next generation consumes it, then gets cleared at the top of the
// following MESSAGE_RECEIVED. This is the ordering that actually works.
function onMessageReceived() {
  // Clear FIRST, unconditionally. If this sat behind the isEnabled check, then
  // switching the extension off while a scene was armed would leave that prompt
  // stuck in the slot forever — it would ride along with every future
  // generation and the off switch would appear to do nothing.
  clearInjection();

  const s = getSettings();
  if (!s.isEnabled) { wasSwipe = false; armedScene = null; lastDelivered = null; return; }

  // A swipe re-rolls the same turn. Counting it would inflate the message
  // count and give an extra dice roll per swipe, which makes the configured
  // percentage bear no relation to how often scenes actually fire.
  // lastDelivered survives this branch so a second and third swipe still get
  // the scene back.
  if (wasSwipe) {
    wasSwipe = false;
    if (pendingMark) {
      const m = pendingMark; pendingMark = null;
      setTimeout(() => markLastBotMessage(m.typeId), 600);
    }
    return;
  }

  // Whatever was armed has now been consumed by the generation that produced
  // this reply. Remember it for one turn only: if she swipes this reply, the
  // scene is re-applied instead of vanishing. It is nulled here on every
  // ordinary reply, so swiping an older message never resurrects an old scene.
  lastDelivered = armedScene;
  armedScene = null;

  const key = getChatKey();
  const state = getChatState(key);
  state.messageCount++;
  state.messagesSinceLastTrigger++;
  saveChatState();

  if (pendingMark) {
    const m = pendingMark; pendingMark = null;
    setTimeout(() => markLastBotMessage(m.typeId), 600);
  }

  // Post-scene pause. Guarded on triggerCount so a fresh chat — or a chat
  // just after the reset button — is not silent for its first five replies.
  if (state.triggerCount > 0 && state.messagesSinceLastTrigger <= SCENE_PAUSE) {
    updatePanelUI();
    return;
  }

  if (Math.random() * 100 < getCurrentChance()) {
    triggerScene();
  }
  updatePanelUI();
}

// Small transient toast at the bottom of the screen, reused by the hotkey and
// by actions that are refused (e.g. pressing the button while disabled).
function flashHint(text) {
  const f = document.createElement('div');
  f.className = 'singe-hotkey-flash';
  f.textContent = text;
  document.body.appendChild(f);
  requestAnimationFrame(() => f.classList.add('singe-hotkey-show'));
  setTimeout(() => { f.classList.remove('singe-hotkey-show'); setTimeout(() => f.remove(), 300); }, 2200);
}

// ─── Hotkey ────────────────────────────────────────────────────────────────
// e.code, not e.key — e.key returns 'Ы' on a Cyrillic layout and the hotkey
// would silently never fire.
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyS') {
    e.preventDefault();
    if (!getSettings().isEnabled) { flashHint('Расширение выключено'); return; }
    triggerScene();
    flashHint('🔥 Singe · заряжено');
  }
});

// ─── Settings HTML ─────────────────────────────────────────────────────────
function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildSettingsHTML() {
  const rowBlocks = sceneGroups.map(g => {
    const words = sceneTypes.filter(t => t.group === g.id).map(t => `
        <button class="singe-type-pill" data-type="${t.id}" style="--type-color:${t.color}" title="${escapeAttr(t.directive)}">${t.label}</button>`).join('');
    return `
    <div class="singe-group" data-group="${g.id}">
      <div class="singe-strip-wrap">
        <button class="singe-arrow singe-arrow-l" data-scroll="${g.id}" data-dir="-1" aria-label="Влево">‹</button>
        <div class="singe-strip" data-strip="${g.id}">${words}</div>
        <button class="singe-arrow singe-arrow-r" data-scroll="${g.id}" data-dir="1" aria-label="Вправо">›</button>
      </div>
    </div>`;
  }).join('');

  return `
<div class="singe-panel">

  <div class="singe-eyebrow">
    <span class="singe-brand" id="singe-brand">Singe</span>
    <span class="singe-rule"></span>
    <span class="singe-eyebrow-meta" id="singe-session-tracker">0 · 0</span>
  </div>

  <div class="singe-readout">
    <div class="singe-readout-top">
      <span class="singe-figure" id="singe-chance-num">8</span>
      <span class="singe-figure-unit">% на каждый ответ бота</span>
    </div>
    <div class="singe-readout-plain" id="singe-chance-plain">≈ раз в 13 ответов</div>
    <div class="singe-gauge"><span class="singe-gauge-fill" id="singe-bar-fill"></span></div>
    <input type="range" class="singe-slider" id="singe-chance-slider" min="1" max="100" step="1">
    <div class="singe-readout-state" id="singe-chance-state">0 ответов без сцены</div>
  </div>

  <div class="singe-actions">
    <button class="singe-act" id="singe-manual-trigger-btn">Зарядить</button>
    <button class="singe-act singe-act-slim" id="singe-preview-btn" title="Показать промпт">Промпт</button>
  </div>
  <div class="singe-hint">Сработает на следующий ответ бота</div>

  <div class="singe-eyebrow singe-eyebrow-sub">
    <span class="singe-eyebrow-label">Типы сцен</span>
    <span class="singe-rule"></span>
    <span class="singe-eyebrow-meta" id="singe-total-count">0/21</span>
  </div>
  <div id="singe-type-groups">${rowBlocks}</div>

  <div class="singe-sub" id="singe-sub-settings">
    <button class="singe-sub-header" data-target="singe-sub-settings">
      <span class="singe-eyebrow-label">Настройки</span>
      <span class="singe-rule"></span>
      <span class="singe-sub-chevron">+</span>
    </button>
    <div class="singe-sub-body"><div>

      <label class="singe-row">
        <input type="checkbox" id="singe-enabled-toggle">
        <span class="singe-row-text">Расширение включено</span>
      </label>

      <label class="singe-row">
        <input type="checkbox" id="singe-growing-chance-toggle">
        <span class="singe-row-text">Нарастающий шанс</span>
      </label>
      <div class="singe-field" id="singe-growing-step-row" style="display:none">
        <span class="singe-field-label">+1% каждые N ответов</span>
        <div class="singe-field-ctrl">
          <input type="range" class="singe-slider" id="singe-step-slider" min="1" max="15" step="1">
          <span class="singe-num" id="singe-step-badge">5</span>
        </div>
      </div>

      <label class="singe-row">
        <input type="checkbox" id="singe-userrole-toggle">
        <span class="singe-row-text">Инжект как User</span>
      </label>

      <div class="singe-field">
        <span class="singe-field-label">Своя добавка к промпту</span>
        <textarea id="singe-extra-input" rows="3" class="singe-textarea" placeholder="Необязательно"></textarea>
      </div>

      <button class="singe-act singe-act-slim singe-act-wide" id="singe-reset-btn">Сбросить счётчики</button>
    </div></div>
  </div>

  <div class="singe-foot">Ctrl+Shift+S — зарядить · 🔻 метка в чате · пауза ${SCENE_PAUSE} ответов после сцены · свайп сохраняет сцену</div>
</div>`;
}

// ─── Init UI ───────────────────────────────────────────────────────────────
function initUI() {
  const s = getSettings();

  document.querySelectorAll('.singe-sub-header').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.singe-sub').classList.toggle('open'));
  });

  const root = document.getElementById('singe-type-groups');

  // Sync s.selectedTypes from the DOM, then refresh every counter.
  function syncTypes() {
    if (!root) return;
    const s2 = getSettings();
    s2.selectedTypes = [...root.querySelectorAll('.singe-type-pill.singe-type-active')].map(p => p.dataset.type);
    refreshCounts();
    saveSettingsDebounced();
  }

  function refreshCounts() {
    if (!root) return;
    const on = root.querySelectorAll('.singe-type-pill.singe-type-active').length;
    const total = document.getElementById('singe-total-count');
    if (total) total.textContent = `${on}/${sceneTypes.length}`;
  }

  // Show or hide the desktop arrows depending on how far the strip is scrolled.
  function refreshArrows(strip) {
    const wrap = strip.closest('.singe-strip-wrap');
    if (!wrap) return;
    const l = wrap.querySelector('.singe-arrow-l');
    const r = wrap.querySelector('.singe-arrow-r');
    // 2px tolerance: browsers report fractional scroll positions at the ends.
    const canL = strip.scrollLeft > 2;
    const canR = strip.scrollLeft < strip.scrollWidth - strip.clientWidth - 2;
    if (l) l.classList.toggle('singe-arrow-off', !canL);
    if (r) r.classList.toggle('singe-arrow-off', !canR);
    wrap.classList.toggle('singe-fade-l', canL);
    wrap.classList.toggle('singe-fade-r', canR);
  }

  function refreshAllArrows() {
    if (!root) return;
    root.querySelectorAll('.singe-strip').forEach(refreshArrows);
  }

  if (root) {
    root.querySelectorAll('.singe-type-pill').forEach(pill => {
      if (s.selectedTypes.includes(pill.dataset.type)) pill.classList.add('singe-type-active');
      pill.addEventListener('click', () => {
        // A click that ends a drag must not also toggle the pill.
        if (pill.closest('.singe-strip')?.dataset.dragged === '1') return;
        pill.classList.toggle('singe-type-active');
        syncTypes();
      });
    });

    root.querySelectorAll('.singe-strip').forEach(strip => {
      // Vertical wheel scrolls the strip horizontally, but only while the strip
      // still has somewhere to go — otherwise the page stops scrolling.
      strip.addEventListener('wheel', e => {
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        const atStart = strip.scrollLeft <= 0;
        const atEnd = strip.scrollLeft >= strip.scrollWidth - strip.clientWidth - 1;
        if ((e.deltaY < 0 && atStart) || (e.deltaY > 0 && atEnd)) return;
        e.preventDefault();
        strip.scrollLeft += e.deltaY;
      }, { passive: false });

      // Click-and-drag to scroll, for mice without a horizontal wheel.
      let down = false, startX = 0, startScroll = 0;
      strip.addEventListener('pointerdown', e => {
        if (e.pointerType === 'touch') return; // native touch scrolling is better
        down = true; startX = e.clientX; startScroll = strip.scrollLeft;
        strip.dataset.dragged = '0';
      });
      strip.addEventListener('pointermove', e => {
        if (!down) return;
        const dx = e.clientX - startX;
        if (Math.abs(dx) > 4) strip.dataset.dragged = '1';
        strip.scrollLeft = startScroll - dx;
      });
      const release = () => {
        down = false;
        // Clear the drag flag after the click event has already fired.
        setTimeout(() => { strip.dataset.dragged = '0'; }, 0);
      };
      strip.addEventListener('pointerup', release);
      strip.addEventListener('pointercancel', release);
      strip.addEventListener('pointerleave', release);

      strip.addEventListener('scroll', () => refreshArrows(strip), { passive: true });
    });

    root.querySelectorAll('.singe-arrow').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const strip = root.querySelector(`.singe-strip[data-strip="${btn.dataset.scroll}"]`);
        if (!strip) return;
        const step = Math.max(120, Math.round(strip.clientWidth * 0.7));
        strip.scrollBy({ left: step * Number(btn.dataset.dir), behavior: 'smooth' });
      });
    });

    refreshCounts();
    // The panel starts collapsed inside ST's drawer, so widths are 0 until it
    // is opened. Recheck on open, on resize, and once after layout settles.
    refreshAllArrows();
    setTimeout(refreshAllArrows, 300);
    window.addEventListener('resize', refreshAllArrows);
    document.querySelector('.singe_settings .inline-drawer-toggle')
      ?.addEventListener('click', () => setTimeout(refreshAllArrows, 320));
  }

  const cs = document.getElementById('singe-chance-slider');
  if (cs) {
    cs.value = s.chance;
    cs.addEventListener('input', () => {
      s.chance = parseInt(cs.value);
      updatePanelUI(); saveSettingsDebounced();
    });
  }

  const gt = document.getElementById('singe-growing-chance-toggle');
  const gr = document.getElementById('singe-growing-step-row');
  if (gt && gr) {
    gt.checked = s.useGrowingChance;
    gr.style.display = s.useGrowingChance ? 'flex' : 'none';
    gt.addEventListener('change', () => {
      s.useGrowingChance = gt.checked;
      gr.style.display = gt.checked ? 'flex' : 'none';
      updatePanelUI(); saveSettingsDebounced();
    });
  }

  const ss = document.getElementById('singe-step-slider');
  const sb = document.getElementById('singe-step-badge');
  if (ss && sb) {
    ss.value = s.growingChanceStep; sb.textContent = s.growingChanceStep;
    ss.addEventListener('input', () => {
      s.growingChanceStep = parseInt(ss.value); sb.textContent = s.growingChanceStep;
      updatePanelUI(); saveSettingsDebounced();
    });
  }

  [
    ['singe-enabled-toggle', 'isEnabled'],
    ['singe-userrole-toggle', 'injectAsUser'],
  ].forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.checked = s[key];
    el.addEventListener('change', () => {
      s[key] = el.checked;
      // Switching the extension off must take effect immediately, not on the
      // next message — otherwise an already-armed scene still gets delivered.
      if (key === 'isEnabled' && !el.checked) {
        clearInjection(); wasSwipe = false; armedScene = null; lastDelivered = null;
      }
      saveSettingsDebounced();
      updatePanelUI();
    });
  });

  const extra = document.getElementById('singe-extra-input');
  if (extra) {
    extra.value = s.extraInstruction || '';
    extra.addEventListener('input', () => { s.extraInstruction = extra.value; saveSettingsDebounced(); });
  }

  document.getElementById('singe-manual-trigger-btn')?.addEventListener('click', () => {
    if (!getSettings().isEnabled) { flashHint('Расширение выключено'); return; }
    triggerScene();
  });
  document.getElementById('singe-preview-btn')?.addEventListener('click', () => {
    const typeId = pickRandomType();
    showPromptPreview(buildPrompt(typeId), typeId);
  });
  document.getElementById('singe-reset-btn')?.addEventListener('click', () => {
    // Reset everything the panel displays for this character. Zeroing only the
    // hidden growth counter looked like the button did nothing, because the
    // header stats and the percentage both stayed put.
    const state = getChatState(getChatKey());
    state.messagesSinceLastTrigger = 0;
    state.messageCount = 0;
    state.triggerCount = 0;
    state.lastType = null;
    armedScene = null;
    lastDelivered = null;
    clearInjection();
    saveChatState();
    updatePanelUI();
    flashHint('Сброшено · счётчики и заряд');
  });

  updatePanelUI();
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────
jQuery(async () => {
  loadSettings();
  $('#extensions_settings').append(`
    <div class="singe_settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>🔥 Singe</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">${buildSettingsHTML()}</div>
      </div>
    </div>`);
  initUI();
  eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
  if (event_types.MESSAGE_SWIPED) {
    eventSource.on(event_types.MESSAGE_SWIPED, () => {
      wasSwipe = true;
      // Re-arm the scene the current reply was built from, so swiping to retry
      // a badly written scene keeps the scene instead of losing it.
      if (getSettings().isEnabled && lastDelivered) applyInjection(lastDelivered.prompt);
    });
  }
  eventSource.on(event_types.CHAT_CHANGED, () => {
    wasSwipe = false; armedScene = null; lastDelivered = null;
    clearInjection(); updatePanelUI();
  });
  console.log('[Singe] loaded');
});
