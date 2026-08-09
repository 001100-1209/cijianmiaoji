/* 词间妙记 · Words in Bloom */
(function () {
  "use strict";

  /* ---------------- 数据与存储 ---------------- */
  const LS = {
    progress: "wbm_progress_v1",
    notes: "wbm_notes_v1",
    fav: "wbm_fav_v1",
    last: "wbm_last_v1",
    streak: "wbm_streak_v1",
    quiz: "wbm_quiz_v1",
    cards: "wbm_cards_v1",
    sync: "wbm_sync_v1",
    syncMeta: "wbm_sync_meta_v1",
    customPlan: "wbm_custom_plan_v1",
    settings: "wbm_settings_v1",
  };

  const store = {
    get(k, def) {
      try {
        const v = JSON.parse(localStorage.getItem(k));
        return v === null || v === undefined ? def : v;
      } catch {
        return def;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (e) {
        console.warn("存储失败", e);
      }
    },
  };

  const WORDS = window.WORDS || [];
  const LESSON_META = window.LESSON_META || [];
  const UNIT_META = window.UNIT_META || [];
  const GROUP_META = window.GROUP_META || [];
  const TOTAL = WORDS.length;
  const WORD_BY_KEY = new Map(WORDS.map((w) => [w.lesson + ":" + w.w, w]));

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const wKey = (w) => `${w.lesson}:${w.w}`;
  const unitOf = (lesson) => 1 + Math.floor((lesson - 1) / 4);
  const groupOf = (lesson) => 1 + Math.floor((lesson - 1) / 2);
  const lessonRangeOf = (unit) => `${(unit - 1) * 4 + 1}–${unit * 4}`;
  const groupLessons = (g) => `${g * 2 - 1}–${g * 2}`;
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const yesterdayStr = () => {
    const d = new Date(Date.now() - 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function getSetting(name) {
    const s = store.get(LS.settings, {});
    return s[name];
  }
  function setSetting(name, val) {
    const s = store.get(LS.settings, {});
    s[name] = val;
    store.set(LS.settings, s);
  }
  function applyTheme() {
    document.body.dataset.theme = getSetting("theme") || "pink";
  }

  /* ---------------- 语音 ---------------- */
  function speakText(text) {
    if (!("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text || ""));
      u.lang = "en-US";
      u.rate = Number(getSetting("speakRate") || 0.85);
      const voices = window.speechSynthesis.getVoices();
      const chosen = voices.find((v) => v.voiceURI === getSetting("voiceURI"));
      if (chosen) {
        u.voice = chosen;
      } else {
        const en =
          voices.find((v) => /^en[-_](US|GB|UK)/i.test(v.lang || "")) ||
          voices.find((v) => /^en/i.test(v.lang || ""));
        if (en) u.voice = en;
      }
      window.speechSynthesis.speak(u);
    } catch (e) {
      /* 忽略不支持的情况 */
    }
  }

  function populateVoiceOptions() {
    const sel = $("#setVoice");
    if (!sel || !("speechSynthesis" in window)) return;
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) {
      sel.innerHTML = `<option value="">（未检测到语音，试试刷新或检查系统语音设置）</option>`;
      return;
    }
    const prev = getSetting("voiceURI") || "";
    const q = ($("#voiceSearch")?.value || "").trim().toLowerCase();
    const offlineOnly = $("#voiceOfflineOnly")?.checked === true;
    let list = voices.slice();
    if (offlineOnly) list = list.filter((v) => !/online/i.test(v.name || ""));
    if (q) {
      list = list.filter(
        (v) => (v.name || "").toLowerCase().includes(q) || (v.lang || "").toLowerCase().includes(q)
      );
    }
    const en = list.filter((v) => /^en/i.test(v.lang || ""));
    const others = list.filter((v) => !/^en/i.test(v.lang || ""));
    const ordered = [...en, ...others];
    if (!ordered.length) {
      sel.innerHTML = `<option value="">（没有匹配的语音）</option>`;
      return;
    }
    const tag = (v) => (/online/i.test(v.name || "") ? "〔在线〕" : "〔本地〕");
    sel.innerHTML =
      `<option value="">默认（自动选择英文语音）</option>` +
      ordered
        .map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)}（${esc(v.lang)}）${tag(v)}</option>`)
        .join("");
    sel.value = ordered.some((v) => v.voiceURI === prev) ? prev : "";
  }

  /* ---------------- 云端同步（Supabase） ---------------- */
  let supabaseClient = null;
  let syncing = false;
  let autoSyncTimer = null;
  let authSession = null;

  function syncConfig() {
    return window.SUPABASE_CONFIG || store.get(LS.sync, null);
  }
  function setSyncStatus(text) {
    const el = $("#syncStatus");
    if (!el) return;
    el.textContent = text;
    el.style.color = /已同步|已保存|未配置/.test(text) ? "#2e9e5b" : "#cf4a5c";
  }
  function markDirty() {
    const m = store.get(LS.syncMeta, { dirty: false });
    m.dirty = true;
    store.set(LS.syncMeta, m);
    scheduleAutoSync();
  }
  function scheduleAutoSync() {
    clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(() => {
      if (navigator.onLine !== false && syncConfig() && syncConfig().url && syncConfig().key) {
        syncNow().catch(() => {});
      }
    }, 4000);
  }
  async function getSupabase() {
    if (supabaseClient) return supabaseClient;
    const cfg = syncConfig();
    if (!cfg || !cfg.url || !cfg.key) return null;
    const mod = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    supabaseClient = mod.createClient(cfg.url, cfg.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    return supabaseClient;
  }
  async function refreshAuth() {
    authSession = null;
    const sb = await getSupabase();
    if (!sb) return;
    try {
      const {
        data: { session },
      } = await sb.auth.getSession();
      authSession = session || null;
    } catch (e) {
      authSession = null;
    }
  }
  async function ensureUser() {
    if (!authSession || !authSession.user) throw new Error("请先登录");
    return authSession.user;
  }
  async function pullRemote(sb, uid) {
    const { data, error } = await sb
      .from("user_data")
      .select("data, updated_at")
      .eq("id", uid)
      .maybeSingle();
    if (error) throw error;
    return data ? { data: data.data, updated_at: data.updated_at } : null;
  }
  async function pushRemote(sb, uid, blob) {
    const { error } = await sb.from("user_data").upsert({
      id: uid,
      data: blob,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  }
  function atOfEntry(v) {
    return v && typeof v === "object" && v.at ? v.at : 0;
  }
  function mergeMap(localMap, remoteMap) {
    const out = { ...(remoteMap || {}) };
    for (const k of Object.keys(localMap || {})) {
      if (out[k] === undefined) {
        out[k] = localMap[k];
        continue;
      }
      if (atOfEntry(localMap[k]) > atOfEntry(out[k])) out[k] = localMap[k];
    }
    return out;
  }
  function mergeBlobs(local, remote) {
    const quiz = remote && remote.quiz && !local.quiz ? remote.quiz : local.quiz;
    return {
      progress: mergeMap(local.progress, remote && remote.progress),
      notes: mergeMap(local.notes, remote && remote.notes),
      fav: mergeMap(local.fav, remote && remote.fav),
      quiz,
    };
  }
  function buildBlob() {
    return {
      progress: getProgress(),
      notes: getNotes(),
      fav: getFav(),
      quiz: store.get(LS.quiz, null),
    };
  }
  function applyBlob(b) {
    if (!b) return;
    if (b.progress) store.set(LS.progress, b.progress);
    if (b.notes) store.set(LS.notes, b.notes);
    if (b.fav) store.set(LS.fav, b.fav);
    if (b.quiz) store.set(LS.quiz, b.quiz);
  }
  async function syncNow(opts) {
    if (syncing) return;
    const cfg = syncConfig();
    if (!cfg || !cfg.url || !cfg.key) {
      setSyncStatus("未配置同步服务");
      return;
    }
    syncing = true;
    setSyncStatus("正在同步…");
    try {
      const sb = await getSupabase();
      if (!sb) throw new Error("无法加载同步库，请检查网络");
      const user = await ensureUser();
      const remote = await pullRemote(sb, user.id);
      const localBlob = buildBlob();
      let merged = localBlob;
      if (opts && opts.forceLocal) {
        merged = localBlob;
      } else if (remote && remote.data) {
        merged = mergeBlobs(localBlob, remote.data);
      }
      applyBlob(merged);
      await pushRemote(sb, user.id, merged);
      store.set(LS.syncMeta, { lastSyncAt: Date.now(), dirty: false });
      setSyncStatus("已同步 " + new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
      renderSettings();
    } catch (e) {
      const msg = e && e.message ? e.message : "未知错误";
      setSyncStatus(msg === "请先登录" ? "未登录，登录后自动同步" : "同步失败：" + msg);
    } finally {
      syncing = false;
    }
  }

  /* ---------------- 登录 / 注册 ---------------- */
  async function authLogin() {
    const email = ($("#authEmail")?.value || "").trim();
    const pw = $("#authPw")?.value || "";
    if (!email || !pw) {
      setSyncStatus("请输入邮箱和密码");
      return;
    }
    const sb = await getSupabase();
    if (!sb) {
      setSyncStatus("同步服务未配置");
      return;
    }
    setSyncStatus("正在登录…");
    const { error } = await sb.auth.signInWithPassword({ email, password: pw });
    if (error) {
      setSyncStatus("登录失败：" + error.message);
      return;
    }
    await refreshAuth();
    renderSettings();
    go("home");
    showWelcomeModal();
    syncNow().catch(() => {});
  }
  async function authSignup() {
    const email = ($("#authEmail")?.value || "").trim();
    const pw = $("#authPw")?.value || "";
    if (!email || !pw) {
      setSyncStatus("请输入邮箱和密码");
      return;
    }
    if (pw.length < 6) {
      setSyncStatus("密码至少 6 位");
      return;
    }
    const sb = await getSupabase();
    if (!sb) {
      setSyncStatus("同步服务未配置");
      return;
    }
    setSyncStatus("正在注册…");
    const { data, error } = await sb.auth.signUp({ email, password: pw });
    if (error) {
      setSyncStatus("注册失败：" + error.message);
      return;
    }
    if (data && data.session) {
      await refreshAuth();
      setSyncStatus("注册成功");
      renderSettings();
      go("home");
      showWelcomeModal();
      syncNow().catch(() => {});
    } else {
      setSyncStatus("注册成功，请到邮箱点确认链接后再登录（或在 Supabase 中关闭邮件确认）");
    }
  }
  async function authLogout() {
    const sb = await getSupabase();
    if (sb) await sb.auth.signOut().catch(() => {});
    authSession = null;
    renderSettings();
  }
  function renderAuthArea() {
    const box = $("#authArea");
    if (!box) return;
    if (authSession && authSession.user) {
      box.innerHTML = `<div class="set-row">
        <div class="set-info">
          <b>当前账号</b>
          <span>${esc(authSession.user.email || authSession.user.id)}</span>
        </div>
        <button class="btn ghost sm" id="authLogoutBtn">退出登录</button>
      </div>`;
      const lo = $("#authLogoutBtn");
      if (lo) lo.addEventListener("click", () => authLogout());
    } else {
      box.innerHTML = `<div class="auth-form">
        <div class="auth-row"><input type="email" id="authEmail" class="text-input" placeholder="邮箱" autocomplete="email" /></div>
        <div class="auth-row"><input type="password" id="authPw" class="text-input" placeholder="密码（至少 6 位）" autocomplete="current-password" /></div>
        <div class="set-control">
          <button class="btn primary sm" id="authLoginBtn">登录</button>
          <button class="btn soft sm" id="authSignupBtn">注册新账号</button>
        </div>
      </div>`;
      const l = $("#authLoginBtn");
      if (l) l.addEventListener("click", () => authLogin());
      const s = $("#authSignupBtn");
      if (s) s.addEventListener("click", () => authSignup());
    }
  }

  function showWelcomeModal() {
    const m = $("#welcomeModal");
    if (m) m.style.display = "flex";
  }

  /* ---------------- 旧数据格式迁移 ---------------- */
  function migrateData() {
    const n = getNotes();
    let nc = false;
    for (const k of Object.keys(n)) {
      if (typeof n[k] === "string") {
        n[k] = { t: n[k], at: 0 };
        nc = true;
      }
    }
    if (nc) store.set(LS.notes, n);
    const f = getFav();
    let fc = false;
    for (const k of Object.keys(f)) {
      if (typeof f[k] !== "object" || f[k] === null) {
        f[k] = { at: 0 };
        fc = true;
      }
    }
    if (fc) store.set(LS.fav, f);
  }

  /* ---------------- Service Worker ---------------- */
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    const ok =
      location.protocol === "https:" ||
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1";
    if (ok) navigator.serviceWorker.register("./sw.js?v=3").catch(() => {});
  }

  /* ---------------- 学习状态 ---------------- */
  function getProgress() {
    return store.get(LS.progress, {});
  }
  function getNotes() {
    return store.get(LS.notes, {});
  }
  function getFav() {
    return store.get(LS.fav, {});
  }
  function setNote(key, text) {
    const n = getNotes();
    const t = String(text || "").trim();
    if (t) n[key] = { t, at: Date.now() };
    else delete n[key];
    store.set(LS.notes, n);
    markDirty();
  }
  function getNote(key) {
    const v = getNotes()[key];
    return v && typeof v === "object" ? v.t || "" : v || "";
  }
  function statusOf(key) {
    const p = getProgress()[key];
    return p ? p.s : null;
  }
  function isStale(key) {
    const p = getProgress()[key];
    if (!p || !p.at) return false;
    const DAY = 86400000;
    return Date.now() - p.at > 7 * DAY;
  }
  function markWord(w, s) {
    const key = wKey(w);
    const p = getProgress();
    const prev = p[key] || { seen: 0 };
    p[key] = { s, seen: (prev.seen || 0) + 1, at: Date.now() };
    store.set(LS.progress, p);
    markDirty();
    touchStreak();
  }
  function toggleFav(w) {
    const f = getFav();
    const key = wKey(w);
    if (f[key]) delete f[key];
    else f[key] = { at: Date.now() };
    store.set(LS.fav, f);
    markDirty();
    return !!f[key];
  }
  function touchStreak() {
    const s = store.get(LS.streak, { last: null, count: 0 });
    const t = todayStr();
    if (s.last === t) return;
    s.count = s.last === yesterdayStr() ? (s.count || 0) + 1 : 1;
    s.last = t;
    store.set(LS.streak, s);
  }

  function getStats() {
    const p = getProgress();
    const f = getFav();
    const s = store.get(LS.streak, { last: null, count: 0 });
    let mastered = 0,
      learning = 0,
      due = 0,
      studied = 0;
    for (const k of Object.keys(p)) {
      const rec = p[k];
      if (!rec || !rec.seen) continue;
      studied++;
      if (rec.s === "m") {
        mastered++;
        if (isStale(k)) due++;
      } else {
        learning++;
        due++;
      }
    }
    return {
      total: TOTAL,
      mastered,
      learning,
      due,
      studied,
      fav: Object.keys(f).length,
      streak: s.last === todayStr() ? s.count : 0,
    };
  }

  /* ---------------- 词集范围 ---------------- */
  function scopeWords(scope) {
    if (!scope || scope.type === "all") return WORDS;
    if (scope.type === "unit") return WORDS.filter((w) => w.unit === scope.id);
    if (scope.type === "group") return WORDS.filter((w) => w.group === scope.id);
    if (scope.type === "lesson") return WORDS.filter((w) => w.lesson === scope.id);
    if (scope.type === "fav") {
      const f = getFav();
      return WORDS.filter((w) => f[wKey(w)]);
    }
    if (scope.type === "due") return WORDS.filter((w) => {
      const s = statusOf(wKey(w));
      return s === "l" || (s === "m" && isStale(wKey(w)));
    });
    return WORDS;
  }
  function scopeLabel(scope) {
    if (!scope || scope.type === "all") return "全部词集";
    if (scope.type === "unit") {
      const u = UNIT_META.find((x) => x.unit === scope.id);
      return `Unit ${scope.id}（Lesson ${u ? lessonRangeOf(scope.id) : ""}）`;
    }
    if (scope.type === "group") return `第 ${scope.id} 组（Lesson ${groupLessons(scope.id)}）`;
    if (scope.type === "lesson") return `Lesson ${scope.id}`;
    if (scope.type === "fav") return "收藏夹";
    if (scope.type === "due") return "待复习";
    return "全部词集";
  }

  /* ---------------- 导航 ---------------- */
  const navState = { scope: { type: "all" }, immIndex: 0 };
  let activeView = "home";

  function go(view, opts) {
    activeView = view;
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
    if (opts) Object.assign(navState, opts);
    try {
      history.replaceState(null, "", "#" + view);
    } catch {}
    render(view);
    window.scrollTo({ top: 0 });
  }

  function render(view) {
    if (view === "home") renderHome();
    else if (view === "library") renderLibrary();
    else if (view === "immerse") renderImmerse();
    else if (view === "cards") renderCardsSetup();
    else if (view === "quiz") renderQuizSetup();
    else if (view === "fav") renderFav();
    else if (view === "notes") renderNotes();
    else if (view === "settings") renderSettings();
  }

  document.addEventListener("click", (e) => {
    const speakBtn = e.target.closest("[data-speak]");
    if (speakBtn) {
      speakText(speakBtn.dataset.speak);
      return;
    }
    const navBtn = e.target.closest("[data-view]");
    if (navBtn) {
      go(navBtn.dataset.view);
      return;
    }
    const libTab = e.target.closest("[data-libtab]");
    if (libTab) {
      $$("#libTabs .tab-btn").forEach((b) => b.classList.toggle("active", b === libTab));
      renderLibrary();
      return;
    }
  });

  /* ---------------- 首页 ---------------- */
  function fmtCell(arr) {
    return arr && arr.length ? arr.join("、") : "";
  }
  function parseCell(text) {
    return String(text || "")
      .split(/[、，,;\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map(Number);
  }
  function getCustomPlan() {
    return store.get(LS.customPlan, { groupSize: 2, rows: [] });
  }

  function renderHome() {
    const ht = $("#homeTheme");
    if (ht) ht.value = getSetting("theme") || "pink";
    const stats = getStats();
    const pct = stats.total ? Math.round((stats.mastered / stats.total) * 100) : 0;
    const ring = $("#ringFg");
    const C = 2 * Math.PI * 52;
    ring.style.strokeDasharray = C;
    ring.style.strokeDashoffset = C * (1 - stats.mastered / stats.total);
    $("#ringPct").textContent = pct + "%";

    $("#statGrid").innerHTML = [
      [stats.total, "累计单词"],
      [stats.mastered, "已掌握"],
      [stats.learning, "学习中"],
      [stats.due, "待复习"],
      [stats.fav, "收藏"],
      [stats.streak + "天", "连续学习"],
    ]
      .map(([v, l]) => `<div class="stat-cell"><b>${v}</b><span>${l}</span></div>`)
      .join("");

    const last = store.get(LS.last, null);
    const hintParts = [`累计进度 ${pct}%`, `收藏 ${stats.fav} 个单词`];
    const qz = store.get(LS.quiz, null);
    if (qz) hintParts.push(`最近测试 ${Math.round((qz.score / qz.total) * 100)}%`);
    $("#homeHint").textContent = hintParts.join(" · ");

    $("#quizSummaryCard").style.display = qz ? "block" : "none";
    if (qz) {
      $("#quizSummaryBody").innerHTML = `
        <div class="coll-line"><span>测试范围</span><b>${esc(scopeLabel(qz.scope))}</b></div>
        <div class="coll-line"><span>成绩</span><b>${qz.score} / ${qz.total}（${Math.round((qz.score / qz.total) * 100)}%）</b></div>
        <div class="coll-line"><span>时间</span><b>${esc(qz.date)}</b></div>`;
    }

    const collBody = $("#currentCollectionBody");
    if (last && last.scope) {
      const ws = scopeWords(last.scope);
      const mastered = ws.filter((w) => statusOf(wKey(w)) === "m").length;
      const unit = last.scope.type === "unit" ? UNIT_META.find((u) => u.unit === last.scope.id) : null;
      const tags = unit ? unit.groups : ws.slice(0, 6).map((w) => w.g).filter((g, i, a) => a.indexOf(g) === i).slice(0, 6);
      collBody.innerHTML = `
        <div class="coll-line"><span>词集</span><b>${esc(scopeLabel(last.scope))}</b></div>
        <div class="coll-line"><span>收录</span><b>${ws.length} 个单词</b></div>
        <div class="tag-wrap">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
        <div class="coll-line"><span>已掌握</span><b>${mastered} / ${ws.length}</b></div>
        <div class="bar"><i style="width:${ws.length ? Math.round((mastered / ws.length) * 100) : 0}%"></i></div>
        <button class="btn primary wide" id="btnOpenLast">翻开这期词单 →</button>`;
      $("#btnOpenLast").addEventListener("click", () => {
        navState.scope = { ...last.scope };
        navState.immIndex = Math.min(last.index || 0, scopeWords(last.scope).length - 1);
        go("immerse");
      });
    } else {
      collBody.innerHTML = `<p class="hint">还没有学习记录。从「词集库」选一个词集开始，或点击右上「沉浸学习」。</p>`;
    }

    renderRoutine();
  }

  function renderRoutine() {
    const PLAN_TEN = [
      { d: 1, am: [1], pm: [1] },
      { d: 2, am: [2], pm: [1, 2] },
      { d: 3, am: [3], pm: [2, 3] },
      { d: 4, am: [4], pm: [1, 3, 4] },
      { d: 5, am: [5], pm: [2, 4, 5] },
      { d: 6, am: [6], pm: [3, 5, 6] },
      { d: 7, am: [7], pm: [4, 6, 7] },
      { d: 8, am: [1, 8], pm: [5, 7, 8] },
      { d: 9, am: [2, 9], pm: [6, 8, 9] },
      { d: 10, am: [3, 10], pm: [7, 9, 10] },
      { d: 11, am: [4], pm: [8, 10] },
      { d: 12, am: [5], pm: [9] },
      { d: 13, am: [6], pm: [10] },
      { d: 14, am: [7], pm: [] },
      { d: 15, am: [1, 8], pm: [] },
      { d: 16, am: [2, 9], pm: [] },
      { d: 17, am: [3, 10], pm: [] },
      { d: 18, am: [4], pm: [] },
      { d: 19, am: [5], pm: [] },
      { d: 20, am: [6], pm: [] },
    ];
    const PLAN_TWENTY = [
      { d: 1, am: [1], pm: [1] },
      { d: 2, am: [2], pm: [1, 2] },
      { d: 3, am: [3], pm: [2, 3] },
      { d: 4, am: [4], pm: [1, 3, 4] },
      { d: 5, am: [5], pm: [2, 4, 5] },
      { d: 6, am: [6], pm: [3, 5, 6] },
      { d: 7, am: [7], pm: [4, 6, 7] },
      { d: 8, am: [1, 8], pm: [5, 7, 8] },
      { d: 9, am: [2, 9], pm: [6, 8, 9] },
      { d: 10, am: [3, 10], pm: [7, 9, 10] },
      { d: 11, am: [4, 11], pm: [8, 10, 11] },
      { d: 12, am: [5, 12], pm: [9, 11, 12] },
      { d: 13, am: [6, 13], pm: [10, 12, 13] },
      { d: 14, am: [7, 14], pm: [11, 13, 14] },
      { d: 15, am: [1, 8, 15], pm: [12, 14, 15] },
      { d: 16, am: [2, 9, 16], pm: [13, 15, 16] },
      { d: 17, am: [3, 10, 17], pm: [14, 16, 17] },
      { d: 18, am: [4, 11, 18], pm: [15, 17, 18] },
      { d: 19, am: [5, 12, 19], pm: [16, 18, 19] },
      { d: 20, am: [6, 13, 20], pm: [17, 19, 20] },
      { d: 21, am: [7, 14], pm: [18, 20] },
      { d: 22, am: [8, 15], pm: [19] },
      { d: 23, am: [9, 16], pm: [20] },
      { d: 24, am: [10, 17], pm: [] },
      { d: 25, am: [11, 18], pm: [] },
      { d: 26, am: [12, 19], pm: [] },
      { d: 27, am: [13, 20], pm: [] },
      { d: 28, am: [14], pm: [] },
      { d: 29, am: [15], pm: [] },
      { d: 30, am: [1, 16], pm: [] },
      { d: 31, am: [2, 17], pm: [] },
      { d: 32, am: [3, 18], pm: [] },
      { d: 33, am: [4, 19], pm: [] },
      { d: 34, am: [5, 20], pm: [] },
      { d: 35, am: [6], pm: [] },
      { d: 36, am: [7], pm: [] },
      { d: 37, am: [8], pm: [] },
      { d: 38, am: [9], pm: [] },
      { d: 39, am: [10], pm: [] },
      { d: 40, am: [11], pm: [] },
      { d: 41, am: [12], pm: [] },
      { d: 42, am: [13], pm: [] },
      { d: 43, am: [14], pm: [] },
      { d: 44, am: [15], pm: [] },
      { d: 45, am: [16], pm: [] },
      { d: 46, am: [17], pm: [] },
      { d: 47, am: [18], pm: [] },
      { d: 48, am: [19], pm: [] },
      { d: 49, am: [20], pm: [] },
      { d: 50, am: [], pm: [] },
    ];
    const fmt = (arr) => (arr && arr.length ? arr.join("、") : "—");

    function renderPlanBlocks(days) {
      const blocks = Math.ceil(days.length / 10);
      let html = "";
      for (let b = 0; b < blocks; b++) {
        const slice = days.slice(b * 10, b * 10 + 10);
        const dayNums = slice.map((x) => x.d).join("</th><th>");
        const am = slice.map((x) => `<td>${fmt(x.am)}</td>`).join("");
        const pm = slice.map((x) => `<td>${fmt(x.pm)}</td>`).join("");
        html += `<table class="routine-table plan-block">
          <tr><th>第 ${b * 10 + 1}–${Math.min(b * 10 + 10, days.length)} 天</th><th>${dayNums}</th></tr>
          <tr><td>上午</td>${am}</tr>
          <tr><td>晚上</td>${pm}</tr>
        </table>`;
      }
      $("#routineTable").innerHTML = html;
    }

    function renderCustomPlan() {
      const c = getCustomPlan();
      const rows = c.rows && c.rows.length ? c.rows : Array.from({ length: 30 }, () => ({ am: [], pm: [] }));
      let html = `<table class="routine-table plan-block"><tr><th>天数</th><th>上午（组号）</th><th>晚上（组号）</th></tr>`;
      rows.forEach((r, i) => {
        html += `<tr><td>第 ${i + 1} 天</td><td><input class="custom-cell" data-r="${i}" data-t="am" value="${esc(fmtCell(r.am))}"></td><td><input class="custom-cell" data-r="${i}" data-t="pm" value="${esc(fmtCell(r.pm))}"></td></tr>`;
      });
      html += `</table>`;
      $("#routineTable").innerHTML = html;
    }

    const type = getSetting("planType") || "twenty";
    $("#planType").value = type;
    const wrap = $("#planGroupSizeWrap");
    const saveBtn = $("#customSaveBtn");
    const hint = $("#routineHint");
    const sub = $("#routineSub");
    if (type === "ten") {
      wrap.style.display = "none";
      saveBtn.style.display = "none";
      sub.textContent = "十天计划";
      hint.textContent = "数字为组号（1–10），每组 = 4 个 lesson：第 1 组=Lesson 1–4 …… 第 10 组=Lesson 37–40。D1–D10 新背+复习，D11–D20 按艾宾浩斯间隔复习。";
      renderPlanBlocks(PLAN_TEN);
    } else if (type === "custom") {
      wrap.style.display = "";
      saveBtn.style.display = "";
      const c = getCustomPlan();
      $("#customGroupSize").value = String(c.groupSize || 2);
      const groups = Math.ceil(40 / (c.groupSize || 2));
      sub.textContent = "自定义计划";
      hint.textContent = `每组 ${c.groupSize || 2} 个 lesson，共 ${groups} 组。直接在表格里填写（数字为组号，多个用顿号分隔），点「保存自定义计划」生效。`;
      renderCustomPlan();
    } else {
      wrap.style.display = "none";
      saveBtn.style.display = "none";
      sub.textContent = "二十天计划";
      hint.textContent = "数字为组号（1–20），每组 = 2 个 lesson：第 1 组=Lesson 1–2 …… 第 20 组=Lesson 39–40。1–20 天新背+复习，21–50 天按艾宾浩斯间隔复习。";
      renderPlanBlocks(PLAN_TWENTY);
    }
  }

  /* ---------------- 词集库 ---------------- */
  function renderLibrary() {
    const q = ($("#libSearch").value || "").trim().toLowerCase();
    const tab = $("#libTabs .tab-btn.active")?.dataset.libtab || "unit";
    const grid = $("#libGrid");
    const sgrid = $("#libSearchGrid");
    if (q) {
      grid.style.display = "none";
      sgrid.style.display = "block";
      const notes = getNotes();
      const res = WORDS.filter(
        (w) => w.w.toLowerCase().includes(q) || w.m.toLowerCase().includes(q) || getNote(wKey(w)).toLowerCase().includes(q)
      ).slice(0, 200);
      $("#libSearchCount").textContent = `${res.length} 个结果`;
      sgrid.innerHTML = res
        .map(
          (w) => `<div class="lib-search-item" data-jump="${w.lesson}:${esc(w.w)}">
            <span class="w">${esc(w.w)}</span>
            <span class="m">${esc(w.m)}</span>
            <span class="meta">L${w.lesson} · U${w.unit}${notes[wKey(w)] ? " · ✍️" : ""}</span>
          </div>`
        )
        .join("");
      $$(".lib-search-item", sgrid).forEach((el) =>
        el.addEventListener("click", () => jumpToWord(el.dataset.jump))
      );
      return;
    }
    grid.style.display = "grid";
    sgrid.style.display = "none";
    $("#libSearchCount").textContent = "";

    const cards = [];
    if (tab === "unit") {
      for (const u of UNIT_META) {
        const ws = WORDS.filter((w) => w.unit === u.unit);
        const mastered = ws.filter((w) => statusOf(wKey(w)) === "m").length;
        cards.push(cardHTML(`Unit ${u.unit}`, `Lesson ${lessonRangeOf(u.unit)}`, `${ws.length} 词`, mastered, ws.length, u.groups, { type: "unit", id: u.unit }));
      }
    } else if (tab === "group") {
      for (const g of GROUP_META) {
        const ws = WORDS.filter((w) => w.group === g.group);
        const mastered = ws.filter((w) => statusOf(wKey(w)) === "m").length;
        const tags = g.lessons
          .flatMap((l) => (LESSON_META.find((x) => x.lesson === l)?.groups || []))
          .filter((t, i, a) => a.indexOf(t) === i)
          .slice(0, 5);
        cards.push(cardHTML(`第 ${g.group} 组`, `Lesson ${groupLessons(g.group)} · Unit ${g.unit}`, `${ws.length} 词`, mastered, ws.length, tags, { type: "group", id: g.group }));
      }
    } else {
      for (const m of LESSON_META) {
        const ws = WORDS.filter((w) => w.lesson === m.lesson);
        const mastered = ws.filter((w) => statusOf(wKey(w)) === "m").length;
        cards.push(cardHTML(`Lesson ${m.lesson}`, `Unit ${m.unit}`, `${ws.length} 词`, mastered, ws.length, m.groups.slice(0, 5), { type: "lesson", id: m.lesson }));
      }
    }
    grid.innerHTML = cards.join("");
    $$(".lib-card", grid).forEach((el) => {
      const scope = JSON.parse(el.dataset.scope);
      $(".lib-immersive", el).addEventListener("click", () => {
        navState.scope = scope;
        navState.immIndex = 0;
        go("immerse");
      });
      $(".lib-cards", el).addEventListener("click", () => {
        navState.scope = scope;
        go("cards");
        $("#cardStart").click();
      });
      $(".lib-quiz", el).addEventListener("click", () => {
        navState.scope = scope;
        go("quiz");
        $("#quizStart").click();
      });
    });
  }

  function cardHTML(name, sub, count, mastered, total, tags, scope) {
    const pct = total ? Math.round((mastered / total) * 100) : 0;
    return `<div class="card lib-card" data-scope='${JSON.stringify(scope)}'>
      <h3>${esc(name)}</h3>
      <div class="lib-sub">${esc(sub)}</div>
      <div class="lib-count">${esc(count)} · 已掌握 ${mastered}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="tag-wrap">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
      <div class="lib-actions">
        <button class="btn primary sm lib-immersive">沉浸学习</button>
        <button class="btn soft sm lib-cards">卡片</button>
        <button class="btn ghost sm lib-quiz">测试</button>
      </div>
    </div>`;
  }

  function jumpToWord(key) {
    const [lesson, word] = key.split(":");
    const idx = WORDS.findIndex((w) => w.lesson === Number(lesson) && w.w === word);
    if (idx < 0) return;
    navState.scope = { type: "lesson", id: Number(lesson) };
    const list = scopeWords(navState.scope);
    const rel = list.findIndex((w) => wKey(w) === key);
    navState.immIndex = rel >= 0 ? rel : 0;
    go("immerse");
  }

  /* ---------------- 沉浸学习 ---------------- */
  let immList = [];
  let noteTimer = null;
  let immLastSpoken = "";

  function renderImmerse() {
    const sel = $("#immScope");
    sel.innerHTML = scopeOptions();
    const cur = navState.scope || { type: "all" };
    sel.value = scopeValue(cur);
    sel.onchange = () => {
      navState.scope = scopeFromValue(sel.value);
      navState.immIndex = 0;
      renderImmerse();
    };
    const chk = $("#immUnmasteredFirst");
    chk.checked = getSetting("immUnmasteredFirst") === true;
    chk.onchange = () => {
      setSetting("immUnmasteredFirst", chk.checked);
      rebuildImmList();
    };
    immList = buildImmQueue();
    if (navState.immIndex >= immList.length) navState.immIndex = 0;
    buildImmList();
    renderImmWord();
  }

  function buildImmQueue() {
    let list = scopeWords(navState.scope);
    if (getSetting("immUnmasteredFirst") === true) {
      const isMastered = (w) => statusOf(wKey(w)) === "m";
      list = [...list.filter((w) => !isMastered(w)), ...list.filter(isMastered)];
    }
    return list;
  }

  function setImmSheet(open) {
    const side = document.querySelector(".immerse-side");
    if (!side) return;
    side.classList.toggle("open", !!open);
    const bd = document.getElementById("immBackdrop");
    if (bd) {
      bd.classList.toggle("show", !!open);
      bd.style.pointerEvents = open ? "auto" : "none";
    }
  }

  function rebuildImmList() {
    const key = immList[navState.immIndex] ? wKey(immList[navState.immIndex]) : null;
    immList = buildImmQueue();
    if (key) {
      const i = immList.findIndex((w) => wKey(w) === key);
      navState.immIndex = i >= 0 ? i : 0;
    } else {
      navState.immIndex = 0;
    }
    if (navState.immIndex >= immList.length) navState.immIndex = 0;
    buildImmList();
    renderImmWord();
  }

  function scopeOptions() {
    let html = `<option value="all">全部词集（${TOTAL}）</option>`;
    for (const g of GROUP_META)
      html += `<option value="group:${g.group}">第 ${g.group} 组（Lesson ${groupLessons(g.group)} · ${g.count}词）</option>`;
    for (const u of UNIT_META)
      html += `<option value="unit:${u.unit}">Unit ${u.unit}（Lesson ${lessonRangeOf(u.unit)} · ${u.count}词）</option>`;
    for (const m of LESSON_META)
      html += `<option value="lesson:${m.lesson}">Lesson ${m.lesson}（${m.count}词）</option>`;
    html += `<option value="due">待复习</option><option value="fav">收藏夹</option>`;
    return html;
  }
  function scopeValue(s) {
    if (!s || s.type === "all") return "all";
    return `${s.type}:${s.id}`;
  }
  function scopeFromValue(v) {
    if (v === "all" || !v) return { type: "all" };
    const [t, id] = v.split(":");
    return { type: t, id: Number(id) };
  }

  function buildImmList() {
    const list = $("#immList");
    const notes = getNotes();
    const progress = getProgress();
    list.innerHTML = immList
      .map((w, i) => {
        const st = progress[wKey(w)];
        const dot = st ? (st.s === "m" ? '<span class="wi-status">✓</span>' : '<span class="wi-status">△</span>') : "";
        return `<div class="word-item ${i === navState.immIndex ? "active" : ""}" data-i="${i}">
          <span>${esc(w.w)}</span><span>${notes[wKey(w)] ? "✍️" : ""}${dot}</span>
        </div>`;
      })
      .join("");
    $$(".word-item", list).forEach((el) =>
      el.addEventListener("click", () => {
        navState.immIndex = Number(el.dataset.i);
        setImmSheet(false);
        renderImmWord();
      })
    );
    const search = $("#immSearch");
    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      $$(".word-item", list).forEach((el) => {
        const w = immList[Number(el.dataset.i)];
        el.style.display = !q || w.w.toLowerCase().includes(q) || w.m.toLowerCase().includes(q) ? "" : "none";
      });
    };
    updateImmHighlight();
  }

  function updateImmHighlight() {
    const list = $("#immList");
    const total = immList.length;
    $("#immPosition").textContent = `${navState.immIndex + 1} / ${total}`;
    $("#immProgressBar").style.width = total ? ((navState.immIndex + 1) / total) * 100 + "%" : "0%";
    $$(".word-item", list).forEach((el) => {
      el.classList.toggle("active", Number(el.dataset.i) === navState.immIndex);
    });
  }

  function renderImmWord() {
    if (!immList.length) {
      $("#wordBig").textContent = "暂无单词";
      return;
    }
    const w = immList[navState.immIndex];
    const key = wKey(w);
    const notes = getNotes();
    const progress = getProgress();
    $("#wordMeta").innerHTML = [
      `<span class="tag">Lesson ${w.lesson}</span>`,
      `<span class="tag">Unit ${w.unit}</span>`,
      w.g ? `<span class="tag">${esc(w.g)}</span>` : "",
      progress[key] ? `<span class="tag">${progress[key].s === "m" ? "已掌握" : "学习中"}</span>` : "",
    ].join("");
    $("#wordBig").textContent = w.w;
    const prevW = navState.immIndex > 0 ? immList[navState.immIndex - 1] : null;
    const nextW = navState.immIndex < immList.length - 1 ? immList[navState.immIndex + 1] : null;
    $("#immWordPrev").textContent = prevW ? `← ${prevW.w}` : "← 上一个";
    $("#immWordNext").textContent = nextW ? `${nextW.w} →` : "下一个 →";
    if (getSetting("autoSpeakImmerse") !== false && key !== immLastSpoken) {
      speakText(w.w);
      immLastSpoken = key;
    }
    $("#meaningBox").textContent = w.m || "（无释义）";
    const noteInput = $("#noteInput");
    noteInput.value = getNote(key);
    $("#noteSave").textContent = notes[key] ? "已保存" : "未填写";
    $("#noteTip").textContent = notes[key]
      ? "妙计已保存到你的账号，可继续修改"
      : "例如：ambition 读起来像「俺必胜」→ 我有必胜的决心 → 野心、抱负";
    const favBtn = $("#btnFav");
    favBtn.textContent = getFav()[key] ? "♥ 已收藏" : "♡ 收藏";
    favBtn.classList.toggle("soft", !getFav()[key]);
    store.set(LS.last, { scope: navState.scope, index: navState.immIndex, at: Date.now() });
    updateImmHighlight();
  }

  function saveNoteDebounced() {
    const w = immList[navState.immIndex];
    if (!w) return;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      setNote(wKey(w), $("#noteInput").value);
      $("#noteSave").textContent = "已保存 ✓";
      $("#noteSave").style.color = "#2e9e5b";
      setTimeout(() => {
        $("#noteSave").style.color = "";
        $("#noteSave").textContent = "已保存";
      }, 1500);
      buildImmList();
    }, 450);
  }

  function immStep(delta) {
    if (!immList.length) return;
    navState.immIndex = (navState.immIndex + delta + immList.length) % immList.length;
    renderImmWord();
  }

  /* ---------------- 记忆卡片 ---------------- */
  let cardQueue = [];
  let cardIdx = 0;
  let cardFrontier = 0;
  let cardChoices = new Map(); // wordKey -> 'm' | 'f' | 'd'
  let cardStats = { known: 0, fuzzy: 0, dont: 0 };
  let cardLastSpoken = "";

  function statKey(s) {
    return s === "m" ? "known" : s === "f" ? "fuzzy" : "dont";
  }

  function buildCardQueue() {
    const scope = scopeFromValue($("#cardScope").value);
    navState.scope = scope;
    let list = scopeWords(scope);
    if ($("#cardDueFirst").checked) {
      const isDue = (w) => {
        const s = statusOf(wKey(w));
        return s === "l" || (s === "m" && isStale(wKey(w)));
      };
      list = [...list.filter(isDue), ...list.filter((w) => !isDue(w))];
    }
    if ($("#cardShuffle").checked) list = shuffle(list);
    return list;
  }

  function saveCardsSession() {
    store.set(LS.cards, {
      queue: cardQueue.map(wKey),
      idx: cardIdx,
      frontier: cardFrontier,
      choices: Object.fromEntries(cardChoices),
      stats: cardStats,
      at: Date.now(),
    });
  }
  function clearCardsSession() {
    localStorage.removeItem(LS.cards);
  }
  function loadCardsSession() {
    const s = store.get(LS.cards, null);
    if (!s || !Array.isArray(s.queue) || !s.queue.length) return null;
    const q = s.queue.map((k) => WORD_BY_KEY.get(k)).filter(Boolean);
    if (q.length !== s.queue.length) {
      clearCardsSession();
      return null;
    }
    if (s.frontier >= q.length) {
      clearCardsSession();
      return null;
    }
    return { ...s, queue: q };
  }

  function renderCardsSetup() {
    const sel = $("#cardScope");
    sel.innerHTML = scopeOptions();
    sel.value = scopeValue(navState.scope || { type: "all" });
    $("#cardArea").style.display = "none";
    $(".cards-setup").style.display = "";
    const s = loadCardsSession();
    const bar = $("#resumeBar");
    if (s) {
      bar.style.display = "flex";
      $("#resumeInfo").textContent = `上次背到第 ${s.idx + 1} / ${s.queue.length} 个单词（已答 ${Math.min(s.frontier, s.queue.length)} 个）· ${new Date(s.at || Date.now()).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
    } else {
      bar.style.display = "none";
    }
  }

  function startCards() {
    clearCardsSession();
    cardQueue = buildCardQueue();
    cardIdx = 0;
    cardFrontier = 0;
    cardChoices = new Map();
    cardStats = { known: 0, fuzzy: 0, dont: 0 };
    cardLastSpoken = "";
    $(".cards-setup").style.display = "none";
    $("#cardArea").style.display = "block";
    $("#cardDone").style.display = "none";
    $(".card-buttons").style.display = "";
    $("#flipCard").style.display = "";
    saveCardsSession();
    renderCard();
  }

  function resumeCards() {
    const s = loadCardsSession();
    if (!s) {
      renderCardsSetup();
      return;
    }
    cardQueue = s.queue;
    cardIdx = Math.min(s.idx, s.queue.length - 1);
    cardFrontier = Math.min(s.frontier, s.queue.length);
    cardChoices = new Map(Object.entries(s.choices || {}));
    cardStats = s.stats || { known: 0, fuzzy: 0, dont: 0 };
    cardLastSpoken = "";
    $(".cards-setup").style.display = "none";
    $("#cardArea").style.display = "block";
    $("#cardDone").style.display = "none";
    $(".card-buttons").style.display = "";
    $("#flipCard").style.display = "";
    renderCard();
  }

  function renderCard() {
    if (cardIdx >= cardQueue.length) {
      $("#flipCard").style.display = "none";
      $(".card-buttons").style.display = "none";
      clearCardsSession();
      const done = $("#cardDone");
      done.style.display = "block";
      $("#cardChoice").style.visibility = "hidden";
      $("#cardDoneText").innerHTML = `
        <b>本轮完成！</b> 共 ${cardQueue.length} 词 · 认识 ${cardStats.known} · 模糊 ${cardStats.fuzzy} · 不认识 ${cardStats.dont}
        <br /><span class="hint">不认识/模糊的词已加入「待复习」。</span>`;
      $("#cardWrongAgain").style.display = cardStats.fuzzy + cardStats.dont > 0 ? "" : "none";
      return;
    }
    $("#flipCard").style.display = "";
    $(".card-buttons").style.display = "";
    $("#cardDone").style.display = "none";
    $("#flipCard").classList.remove("flipped");
    const w = cardQueue[cardIdx];
    const key = wKey(w);
    $("#cardProgress").textContent = `${cardIdx + 1} / ${cardQueue.length}`;
    $("#cardMeta").textContent = `Lesson ${w.lesson} · Unit ${w.unit} · ${w.g || ""}`;
    $("#cardMetaBack").textContent = `Lesson ${w.lesson} · Unit ${w.unit}`;
    $("#cardWord").textContent = w.w;
    $("#cardMeaning").textContent = w.m || "（无释义）";
    $("#cardNote").textContent = getNote(key) ? "✍️ 我的妙计：" + getNote(key) : "";
    $("#cardNote").style.display = getNote(key) ? "" : "none";
    $("#cardFav").textContent = getFav()[key] ? "♥" : "♡";
    const choice = cardChoices.get(key);
    $("#cardChoice").textContent = choice ? `本轮已选：${choice === "m" ? "认识" : choice === "f" ? "有点模糊" : "不认识"}` : "";
    $("#cardChoice").style.visibility = choice ? "visible" : "hidden";
    if (getSetting("autoSpeakCards") !== false && key !== cardLastSpoken) {
      speakText(w.w);
      cardLastSpoken = key;
    }
    touchStreak();
  }

  function cardMark(s) {
    const w = cardQueue[cardIdx];
    if (!w) return;
    const key = wKey(w);
    const prev = cardChoices.get(key);
    if (prev) cardStats[statKey(prev)]--;
    cardStats[statKey(s)]++;
    if (!prev) cardFrontier = Math.max(cardFrontier, cardIdx + 1);
    cardChoices.set(key, s);
    markWord(w, s === "m" ? "m" : "l");
    cardIdx = Math.min(cardFrontier, cardIdx + 1);
    saveCardsSession();
    renderCard();
  }

  function cardNav(delta) {
    const target = cardIdx + delta;
    if (target < 0 || target > cardFrontier) return;
    cardIdx = target;
    saveCardsSession();
    renderCard();
  }

  function wrongAgain() {
    const wrong = cardQueue.filter((w) => {
      const s = cardChoices.get(wKey(w));
      return s === "f" || s === "d";
    });
    cardQueue = wrong;
    cardIdx = 0;
    cardFrontier = 0;
    cardChoices = new Map();
    cardStats = { known: 0, fuzzy: 0, dont: 0 };
    cardLastSpoken = "";
    $(".cards-setup").style.display = "none";
    $("#cardArea").style.display = "block";
    $("#cardDone").style.display = "none";
    $(".card-buttons").style.display = "";
    $("#flipCard").style.display = "";
    saveCardsSession();
    renderCard();
  }

  /* ---------------- 记忆测试 ---------------- */
  let quizQ = [];
  let quizIdx = 0;
  let quizScore = 0;
  let quizWrong = [];
  let quizChosen = []; // 每题作答记录：{ idx, isRight } | null
  let quizAutoTimer = null;

  function renderQuizSetup() {
    const sel = $("#quizScope");
    sel.innerHTML = scopeOptions();
    sel.value = scopeValue(navState.scope || { type: "all" });
    $("#quizBody").innerHTML = `<p class="hint" style="text-align:center;padding:60px 0">选择范围与题数，点击「开始测试」。</p>`;
  }

  function startQuiz() {
    const scope = scopeFromValue($("#quizScope").value);
    navState.scope = scope;
    const type = $("#quizType").value;
    const count = Number($("#quizCount").value);
    const pool = scopeWords(scope);
    if (!pool.length) return;
    const picked = shuffle(pool).slice(0, Math.min(count, pool.length));
    quizQ = picked.map((w) => {
      const distractors = shuffle(pool.filter((x) => x.w !== w.w)).slice(0, 3).map((x) => (type === "w2m" ? x.m : x.w));
      const correct = type === "w2m" ? w.m : w.w;
      const opts = shuffle([correct, ...distractors.filter((d, i, a) => d && a.indexOf(d) === i)].slice(0, 4));
      return { w, type, opts, answer: correct };
    });
    quizIdx = 0;
    quizScore = 0;
    quizWrong = [];
    quizChosen = new Array(quizQ.length).fill(null);
    renderQuizQ();
  }

  function renderQuizQ() {
    const body = $("#quizBody");
    if (quizIdx >= quizQ.length) {
      clearTimeout(quizAutoTimer);
      const pct = Math.round((quizScore / quizQ.length) * 100);
      store.set(LS.quiz, {
        scope: navState.scope,
        score: quizScore,
        total: quizQ.length,
        date: new Date().toLocaleDateString("zh-CN"),
      });
      markDirty();
      body.innerHTML = `
        <div class="quiz-end">
          <h3>完成！${quizScore} / ${quizQ.length}（${pct}%）</h3>
          ${quizWrong.length ? `<div class="wrong-list"><p class="sub" style="margin-bottom:8px">答错的单词（已标记为待复习）：</p>` + quizWrong.map((x) => `<div class="wrong-row"><span class="w">${esc(x.w)}</span><span class="m">${esc(x.m)}</span></div>`).join("") + `</div>` : `<p class="sub">全部答对，太棒了 🌸</p>`}
          <button class="btn primary" id="quizRetry">再来一次</button>
          <button class="btn soft" id="quizWrongRetry" style="display:${quizWrong.length ? "" : "none"}">只测错词</button>
        </div>`;
      $("#quizRetry").addEventListener("click", startQuiz);
      $("#quizWrongRetry").addEventListener("click", () => {
        const scope = { type: "all" };
        const pool = WORDS.filter((w) => quizWrong.some((x) => x.w === w.w));
        const type = "w2m";
        quizQ = pool.map((w) => {
          const distractors = shuffle(WORDS.filter((x) => x.w !== w.w)).slice(0, 3).map((x) => x.m);
          const opts = shuffle([w.m, ...distractors.filter((d, i, a) => d && a.indexOf(d) === i)].slice(0, 4));
          return { w, type, opts, answer: w.m };
        });
        quizIdx = 0;
        quizScore = 0;
        quizWrong = [];
        quizChosen = new Array(quizQ.length).fill(null);
        renderQuizQ();
      });
      return;
    }
    const q = quizQ[quizIdx];
    const answered = quizChosen[quizIdx];
    body.innerHTML = `
      <div class="quiz-hud">
        <span>第 ${quizIdx + 1} / ${quizQ.length} 题</span>
        <span class="quiz-score">得分 ${quizScore}</span>
      </div>
      <p class="quiz-q-sub">${q.type === "w2m" ? "请选出该单词的释义" : "请选出对应的单词"}</p>
      <div class="quiz-q">${esc(q.type === "w2m" ? q.w.w : q.w.m)}${q.type === "w2m" ? `<button class="speak-btn sm" data-speak="${esc(q.w.w)}">🔊</button>` : ""}</div>
      <div class="quiz-opts">${q.opts
        .map((o, i) => {
          let cls = "quiz-opt";
          let mark = "";
          if (answered) {
            if (i === answered.idx) {
              cls += answered.isRight ? " correct" : " wrong";
              mark = answered.isRight ? " ✓" : " ✗";
            } else if (o === q.answer) {
              cls += " correct";
              mark = " ✓";
            }
          }
          return `<button class="${cls}" data-i="${i}" ${answered ? "disabled" : ""}>${esc(o || "（空）")}${mark}</button>`;
        })
        .join("")}</div>
      ${answered ? `<div class="quiz-result ${answered.isRight ? "ok" : "bad"}">${answered.isRight ? "✓ 答对了" : "✗ 答错了，正确答案是：" + esc(q.answer)}</div>` : ""}
      <div class="quiz-nav">
        <button class="btn ghost" id="quizPrevBtn" ${quizIdx === 0 ? "disabled" : ""}>← 上一题</button>
        <button class="btn primary" id="quizNextBtn" ${answered ? "" : "disabled"}>${quizIdx === quizQ.length - 1 ? "查看结果" : "下一题 →"}</button>
      </div>`;
    $$(".quiz-opt", body).forEach((btn) =>
      btn.addEventListener("click", () => {
        if (quizChosen[quizIdx]) return;
        const i = Number(btn.dataset.i);
        const isRight = q.opts[i] === q.answer;
        quizChosen[quizIdx] = { idx: i, isRight };
        if (isRight) quizScore++;
        else {
          quizWrong.push(q.w);
          markWord(q.w, "l");
        }
        renderQuizQ();
        if (isRight) {
          clearTimeout(quizAutoTimer);
          quizAutoTimer = setTimeout(() => {
            quizIdx++;
            renderQuizQ();
          }, 1000);
        }
      })
    );
    const prevBtn = $("#quizPrevBtn");
    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        clearTimeout(quizAutoTimer);
        if (quizIdx > 0) {
          quizIdx--;
          renderQuizQ();
        }
      });
    }
    const nextBtn = $("#quizNextBtn");
    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        clearTimeout(quizAutoTimer);
        if (quizChosen[quizIdx]) {
          quizIdx++;
          renderQuizQ();
        }
      });
    }
  }

  /* ---------------- 收藏夹 ---------------- */
  function renderFav() {
    const f = getFav();
    const list = WORDS.filter((w) => f[wKey(w)]);
    const box = $("#favList");
    if (!list.length) {
      box.innerHTML = `<p class="hint" style="text-align:center;padding:40px 0">还没有收藏单词。在「沉浸学习」或「记忆卡片」中点 ♡ 收藏。</p>`;
      return;
    }
    box.innerHTML = list
      .map((w) => {
        const key = wKey(w);
        const st = statusOf(key);
        return `<div class="fav-row">
          <div>
            <div class="word-speak-line">
              <div class="fw" data-key="${esc(key)}">${esc(w.w)}</div>
              <button class="speak-btn sm" data-speak="${esc(w.w)}">🔊</button>
            </div>
            <div class="nm-tag">Lesson ${w.lesson} · Unit ${w.unit}</div>
            <span class="status-chip ${st === "m" ? "m" : ""}">${st === "m" ? "已掌握" : st === "l" ? "学习中" : "未标记"}</span>
          </div>
          <div class="fm">${esc(w.m)}</div>
          <textarea data-key="${esc(key)}" rows="2" placeholder="我的妙计…">${esc(getNote(key))}</textarea>
          <div class="note-meta">
            <button class="btn ghost sm" data-unfav="${esc(key)}">移除</button>
          </div>
        </div>`;
      })
      .join("");
    $$(".fw", box).forEach((el) => el.addEventListener("click", () => jumpToWord(el.dataset.key)));
    $$("[data-unfav]", box).forEach((el) =>
      el.addEventListener("click", () => {
        const [lesson, word] = el.dataset.unfav.split(":");
        const w = WORDS.find((x) => wKey(x) === el.dataset.unfav);
        if (w) toggleFav(w);
        renderFav();
      })
    );
    $$("textarea[data-key]", box).forEach((ta) => {
      let t = null;
      ta.addEventListener("input", () => {
        clearTimeout(t);
        t = setTimeout(() => setNote(ta.dataset.key, ta.value), 400);
      });
    });
  }

  /* ---------------- 妙计手账 ---------------- */
  const NOTE_PAGE = 150;
  let noteOffset = NOTE_PAGE;
  let noteRows = [];

  function renderNotes() {
    const unitSel = $("#noteUnit");
    if (unitSel.options.length <= 1) {
      for (const u of UNIT_META) unitSel.add(new Option(`Unit ${u.unit}`, String(u.unit)));
    }
    updateNotesStat();
    noteOffset = NOTE_PAGE;
    drawNotes();
  }

  function notesQuery() {
    const q = ($("#noteSearch").value || "").trim().toLowerCase();
    const filter = $("#noteFilter").value;
    const unit = Number($("#noteUnit").value || 0);
    let rows = WORDS;
    if (unit) rows = rows.filter((w) => w.unit === unit);
    if (filter === "filled") rows = rows.filter((w) => getNote(wKey(w)));
    if (filter === "empty") rows = rows.filter((w) => !getNote(wKey(w)));
    if (q) rows = rows.filter((w) => w.w.toLowerCase().includes(q) || w.m.toLowerCase().includes(q) || getNote(wKey(w)).toLowerCase().includes(q));
    return rows;
  }

  function updateNotesStat() {
    const filled = WORDS.filter((w) => getNote(wKey(w))).length;
    $("#notesStat").innerHTML = `已填妙计 <b>${filled}</b> / ${TOTAL} · 未填 <b>${TOTAL - filled}</b>`;
  }

  function drawNotes() {
    noteRows = notesQuery();
    const slice = noteRows.slice(0, noteOffset);
    const box = $("#notesList");
    if (!slice.length) {
      box.innerHTML = `<p class="hint" style="text-align:center;padding:40px 0">没有匹配的单词。</p>`;
      $("#notesMore").style.display = "none";
      return;
    }
    box.innerHTML = slice
      .map((w) => {
        const key = wKey(w);
        const has = !!getNote(key);
        return `<div class="note-row">
          <div>
            <div class="word-speak-line">
              <div class="nw" data-key="${esc(key)}">${esc(w.w)}</div>
              <button class="speak-btn sm" data-speak="${esc(w.w)}">🔊</button>
            </div>
            <div class="nm-tag">L${w.lesson} · U${w.unit} · ${has ? "✍️ 已填" : "未填"}</div>
          </div>
          <div class="nm">${esc(w.m)}</div>
          <textarea data-key="${esc(key)}" rows="2" placeholder="写下妙计…">${esc(getNote(key))}</textarea>
          <div class="note-meta">
            <span class="nm-tag">${esc(w.g || "")}</span>
          </div>
        </div>`;
      })
      .join("");
    $("#notesMore").style.display = noteOffset < noteRows.length ? "block" : "none";
    $$(".nw", box).forEach((el) => el.addEventListener("click", () => jumpToWord(el.dataset.key)));
    $$("textarea[data-key]", box).forEach((ta) => {
      let t = null;
      ta.addEventListener("input", () => {
        clearTimeout(t);
        t = setTimeout(() => {
          setNote(ta.dataset.key, ta.value);
          updateNotesStat();
          const meta = ta.closest(".note-row")?.querySelector(".nm-tag");
          if (meta) meta.textContent = ta.value.trim() ? "✍️ 已填" : "未填";
        }, 400);
      });
    });
  }

  /* ---------------- 专注计时器 ---------------- */
  const timer = { mode: "focus", total: 1500, left: 1500, running: false, tid: null };

  function setTimerDisplay() {
    const m = Math.floor(timer.left / 60);
    const s = timer.left % 60;
    $("#timerDisplay").textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    $("#timerMinLabel").textContent = `${Math.round(timer.total / 60)} 分钟`;
  }
  function setTimerMode(mode) {
    timer.mode = mode;
    $("#modeFocus").classList.toggle("active", mode === "focus");
    $("#modeRest").classList.toggle("active", mode === "rest");
    timer.total = mode === "focus" ? timer.total : 5 * 60;
    timer.left = timer.total;
    $("#timerStart").textContent = "开始";
    stopTick();
    setTimerDisplay();
  }
  function stopTick() {
    timer.running = false;
    if (timer.tid) {
      clearInterval(timer.tid);
      timer.tid = null;
    }
  }
  function tick() {
    if (timer.left <= 0) {
      stopTick();
      $("#timerStart").textContent = "完成 ✓";
      if (timer.mode === "focus") setTimerMode("rest");
      else setTimerMode("focus");
      return;
    }
    timer.left--;
    setTimerDisplay();
  }

  /* ---------------- 设置 ---------------- */
  function renderSettings() {
    $("#setTheme").value = getSetting("theme") || "pink";
    $("#setSpeakImm").checked = getSetting("autoSpeakImmerse") !== false;
    $("#setSpeakCard").checked = getSetting("autoSpeakCards") !== false;
    populateVoiceOptions();
    $("#setRate").value = String(getSetting("speakRate") || 0.85);
    renderAuthArea();
    const hint = $("#syncHint");
    if (hint) {
      hint.innerHTML = "注册/登录同一账号后，妙计、进度、收藏会自动同步到云端；任何设备登录同一账号即可取回数据。首次使用前需在 Supabase 的 SQL Editor 执行建表与策略 SQL（见 README「云端同步」一节）。";
    }
    const meta = store.get(LS.syncMeta, null);
    if (authSession && authSession.user) {
      if (meta && meta.lastSyncAt) setSyncStatus("上次同步 " + new Date(meta.lastSyncAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
      else setSyncStatus("已登录，等待同步");
    } else {
      setSyncStatus(syncConfig() ? "未登录" : "未配置同步服务");
    }
  }

  function exportData() {
    const data = {
      app: "词间妙记",
      version: 1,
      exportedAt: new Date().toISOString(),
      progress: getProgress(),
      notes: getNotes(),
      fav: getFav(),
      quiz: store.get(LS.quiz, null),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `词间妙记-备份-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data || typeof data !== "object") throw new Error("bad");
        const notes = { ...getNotes(), ...(data.notes || {}) };
        const progress = { ...getProgress(), ...(data.progress || {}) };
        const fav = { ...getFav(), ...(data.fav || {}) };
        store.set(LS.notes, notes);
        store.set(LS.progress, progress);
        store.set(LS.fav, fav);
        if (data.quiz) store.set(LS.quiz, data.quiz);
        alert("导入成功，已合并到当前数据。");
        location.reload();
      } catch {
        alert("导入失败：文件格式不正确。");
      }
    };
    reader.readAsText(file);
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    // 首页
    $("#homeTheme").addEventListener("change", () => {
      setSetting("theme", $("#homeTheme").value);
      applyTheme();
    });
    $("#btnContinue").addEventListener("click", () => {
      const last = store.get(LS.last, null);
      if (last && last.scope) {
        navState.scope = { ...last.scope };
        navState.immIndex = Math.min(last.index || 0, scopeWords(last.scope).length - 1);
        go("immerse");
      } else go("library");
    });
    $("#btnRandom").addEventListener("click", () => {
      navState.scope = { type: "all" };
      go("cards");
      $("#cardScope").value = "all";
      $("#cardShuffle").checked = true;
      $("#cardDueFirst").checked = false;
      $("#cardStart").click();
    });
    $("#btnLatest").addEventListener("click", () => {
      navState.scope = { type: "group", id: 20 };
      go("immerse");
    });
    $("#btnReviewDue").addEventListener("click", () => {
      navState.scope = { type: "due" };
      go("cards");
      $("#cardScope").value = "due";
      $("#cardDueFirst").checked = false;
      $("#cardStart").click();
    });

    // 计划
    $("#planType").addEventListener("change", () => {
      setSetting("planType", $("#planType").value);
      renderRoutine();
    });
    $("#customGroupSize").addEventListener("change", () => {
      const c = getCustomPlan();
      c.groupSize = Number($("#customGroupSize").value) || 2;
      store.set(LS.customPlan, c);
      renderRoutine();
    });
    $("#customSaveBtn").addEventListener("click", () => {
      const groupSize = Number($("#customGroupSize").value) || 2;
      const rows = [];
      $$(".custom-cell").forEach((inp) => {
        const r = Number(inp.dataset.r);
        const t = inp.dataset.t;
        if (!rows[r]) rows[r] = { am: [], pm: [] };
        rows[r][t] = parseCell(inp.value);
      });
      store.set(LS.customPlan, { groupSize, rows });
      renderRoutine();
    });
    const welcomeClose = $("#welcomeClose");
    if (welcomeClose) {
      welcomeClose.addEventListener("click", () => {
        $("#welcomeModal").style.display = "none";
      });
      $("#welcomeModal").addEventListener("click", (e) => {
        if (e.target === $("#welcomeModal")) $("#welcomeModal").style.display = "none";
      });
    }

    // 沉浸
    $("#immPrevBtn").addEventListener("click", () => immStep(-1));
    $("#immNextBtn").addEventListener("click", () => immStep(1));
    $("#immWordPrev").addEventListener("click", () => immStep(-1));
    $("#immWordNext").addEventListener("click", () => immStep(1));
    $("#immListToggle").addEventListener("click", () => {
      const side = document.querySelector(".immerse-side");
      setImmSheet(!(side && side.classList.contains("open")));
    });
    const immBackdrop = document.getElementById("immBackdrop");
    if (immBackdrop) immBackdrop.addEventListener("click", () => setImmSheet(false));
    $("#noteInput").addEventListener("input", saveNoteDebounced);
    $("#btnKnow").addEventListener("click", () => {
      const w = immList[navState.immIndex];
      if (w) {
        markWord(w, "m");
        renderImmWord();
      }
    });
    $("#btnFuzzy").addEventListener("click", () => {
      const w = immList[navState.immIndex];
      if (w) {
        markWord(w, "l");
        renderImmWord();
      }
    });
    $("#btnDont").addEventListener("click", () => {
      const w = immList[navState.immIndex];
      if (w) {
        markWord(w, "l");
        renderImmWord();
      }
    });
    $("#btnFav").addEventListener("click", () => {
      const w = immList[navState.immIndex];
      if (w) toggleFav(w);
      renderImmWord();
    });
    $("#speakImmerse").addEventListener("click", () => {
      const w = immList[navState.immIndex];
      if (w) speakText(w.w);
    });

    // 卡片
    $("#cardStart").addEventListener("click", startCards);
    $("#cardResume").addEventListener("click", resumeCards);
    $("#cardRestart").addEventListener("click", () => {
      clearCardsSession();
      startCards();
    });
    $("#flipCard").addEventListener("click", (e) => {
      if (e.target.closest("button")) return; // 点击朗读等按钮时不翻面
      $("#flipCard").classList.toggle("flipped");
    });
    $("#cardKnow").addEventListener("click", () => cardMark("m"));
    $("#cardFuzzy").addEventListener("click", () => cardMark("f"));
    $("#cardDont").addEventListener("click", () => cardMark("d"));
    $("#cardPrev").addEventListener("click", () => cardNav(-1));
    $("#cardNext").addEventListener("click", () => cardNav(1));
    $("#speakCard").addEventListener("click", () => {
      const w = cardQueue[cardIdx];
      if (w) speakText(w.w);
    });
    $("#cardFav").addEventListener("click", () => {
      const w = cardQueue[cardIdx];
      if (w) toggleFav(w);
      renderCard();
    });
    $("#cardAgain").addEventListener("click", startCards);
    $("#cardWrongAgain").addEventListener("click", wrongAgain);

    // 测试
    $("#quizStart").addEventListener("click", startQuiz);

    // 妙计页
    $("#noteSearch").addEventListener("input", () => {
      noteOffset = NOTE_PAGE;
      drawNotes();
    });
    $("#noteFilter").addEventListener("change", () => {
      noteOffset = NOTE_PAGE;
      drawNotes();
    });
    $("#noteUnit").addEventListener("change", () => {
      noteOffset = NOTE_PAGE;
      drawNotes();
    });
    $("#notesMore").addEventListener("click", () => {
      noteOffset += NOTE_PAGE;
      drawNotes();
    });
    $("#noteExport").addEventListener("click", exportData);
    $("#noteImportBtn").addEventListener("click", () => $("#noteImport").click());
    $("#noteImport").addEventListener("change", (e) => {
      if (e.target.files[0]) importData(e.target.files[0]);
      e.target.value = "";
    });

    // 设置
    $("#setTheme").addEventListener("change", () => {
      setSetting("theme", $("#setTheme").value);
      applyTheme();
    });
    $("#setSpeakImm").addEventListener("change", () => {
      setSetting("autoSpeakImmerse", $("#setSpeakImm").checked);
    });
    $("#setSpeakCard").addEventListener("change", () => {
      setSetting("autoSpeakCards", $("#setSpeakCard").checked);
    });
    $("#setVoice").addEventListener("change", () => {
      setSetting("voiceURI", $("#setVoice").value);
    });
    $("#voiceSearch").addEventListener("input", () => populateVoiceOptions());
    $("#voiceOfflineOnly").addEventListener("change", () => populateVoiceOptions());
    $("#setRate").addEventListener("change", () => {
      setSetting("speakRate", Number($("#setRate").value));
    });
    $("#voiceTest").addEventListener("click", () => {
      speakText("Hello, this is a pronunciation preview. Let the words you learn today settle into memory.");
    });
    $("#setExport").addEventListener("click", exportData);
    $("#setImportBtn").addEventListener("click", () => $("#setImport").click());
    $("#setImport").addEventListener("change", (e) => {
      if (e.target.files[0]) importData(e.target.files[0]);
      e.target.value = "";
    });
    $("#setReset").addEventListener("click", () => {
      if (!confirm("确定清空全部数据（妙计、进度、收藏、测试记录）？此操作不可恢复。")) return;
      Object.values(LS).forEach((k) => localStorage.removeItem(k));
      location.reload();
    });
    $("#syncNowBtn").addEventListener("click", () => syncNow().catch(() => {}));
    $("#syncPushBtn").addEventListener("click", () => syncNow({ forceLocal: true }).catch(() => {}));

    // 计时器
    $("#modeFocus").addEventListener("click", () => setTimerMode("focus"));
    $("#modeRest").addEventListener("click", () => setTimerMode("rest"));
    $("#timerPresets").addEventListener("click", (e) => {
      const b = e.target.closest("[data-min]");
      if (!b) return;
      $$("#timerPresets .chip-btn").forEach((x) => x.classList.toggle("active", x === b));
      timer.total = Number(b.dataset.min) * 60;
      timer.left = timer.total;
      stopTick();
      $("#timerStart").textContent = "开始";
      setTimerDisplay();
    });
    $("#timerMinus").addEventListener("click", () => {
      timer.total = Math.max(5, timer.total - 300);
      timer.left = timer.total;
      stopTick();
      $("#timerStart").textContent = "开始";
      $$("#timerPresets .chip-btn").forEach((x) => x.classList.remove("active"));
      setTimerDisplay();
    });
    $("#timerPlus").addEventListener("click", () => {
      timer.total = Math.min(120, timer.total + 300);
      timer.left = timer.total;
      stopTick();
      $("#timerStart").textContent = "开始";
      $$("#timerPresets .chip-btn").forEach((x) => x.classList.remove("active"));
      setTimerDisplay();
    });
    $("#timerStart").addEventListener("click", () => {
      if (timer.running) {
        stopTick();
        $("#timerStart").textContent = "继续";
      } else {
        timer.running = true;
        $("#timerStart").textContent = "暂停";
        timer.tid = setInterval(tick, 1000);
      }
    });
    $("#timerReset").addEventListener("click", () => {
      stopTick();
      timer.left = timer.total;
      $("#timerStart").textContent = "开始";
      setTimerDisplay();
    });

    // 键盘
    document.addEventListener("keydown", (e) => {
      if (activeView === "immerse" && !e.target.closest("textarea") && !e.target.closest("input")) {
        if (e.key === "ArrowLeft") immStep(-1);
        if (e.key === "ArrowRight") immStep(1);
      }
      if (activeView === "cards" && $("#cardArea").style.display !== "none") {
        const inInput = e.target.closest("input") || e.target.closest("select") || e.target.closest("textarea");
        if (e.key === " " && !inInput) {
          e.preventDefault();
          $("#flipCard").classList.toggle("flipped");
        }
        if (e.key === "ArrowLeft" && !inInput) cardNav(-1);
        if (e.key === "ArrowRight" && !inInput) cardNav(1);
        if (e.key === "1") cardMark("d");
        if (e.key === "2") cardMark("f");
        if (e.key === "3") cardMark("m");
      }
    });
  }

  /* ---------------- 时钟 ---------------- */
  function clock() {
    const now = new Date();
    const week = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][now.getDay()];
    const pad = (n) => String(n).padStart(2, "0");
    $("#nowChip").textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 · ${week} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    if (!WORDS.length) {
      document.body.innerHTML = "<p style='padding:60px;text-align:center'>词汇数据未加载，请检查 js/words.js 是否存在。</p>";
      return;
    }
    migrateData();
    // 预置书中「联想记忆法」妙计（仅填空，不覆盖用户自己写过的内容）
    if (window.BOOK_NOTES && typeof window.BOOK_NOTES === "object") {
      const n = getNotes();
      let changed = false;
      for (const [k, v] of Object.entries(window.BOOK_NOTES)) {
        if (v && !n[k]) {
          n[k] = { t: v, at: 0 };
          changed = true;
        }
      }
      if (changed) store.set(LS.notes, n);
    }
    bindEvents();
    registerSW();
    applyTheme();
    if (!("speechSynthesis" in window)) {
      document.body.classList.add("no-tts");
    } else {
      try {
        window.speechSynthesis.getVoices();
        window.speechSynthesis.onvoiceschanged = () => populateVoiceOptions();
      } catch (e) {}
    }
    setTimerDisplay();
    clock();
    setInterval(clock, 1000);
    const hash = location.hash.replace("#", "");
    go(hash && document.getElementById("view-" + hash) ? hash : "home");
    // 配置了同步服务时：恢复登录态，已登录则自动同步一次
    const cfg = syncConfig();
    if (cfg && cfg.url && cfg.key) {
      setTimeout(async () => {
        try {
          await refreshAuth();
          renderSettings();
          if (authSession) await syncNow();
        } catch (e) {
          /* 网络不可用时保持本地使用 */
        }
      }, 1800);
    }
    // 每日首次打开标记一下连续学习（不强制）
  }

  document.addEventListener("DOMContentLoaded", init);
})();
