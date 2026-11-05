/* =====================================================================
   BDE — Organisation · application
   Site statique : aucune étape de build. La sécurité réelle est assurée
   par les règles de la base (supabase/schema.sql) ; les contrôles de
   droits ici ne servent qu'à afficher les bons boutons.
   ===================================================================== */
(() => {
  "use strict";

  const CFG = window.BDE_CONFIG || {};
  const appEl = document.getElementById("app");
  const modalRoot = document.getElementById("modal-root");
  const toastRoot = document.getElementById("toast-root");
  const BDE = CFG.NOM_BDE || "BDE";

  // ------------------------------------------------------------------
  // Petit utilitaire DOM (textContent partout : pas d'injection HTML)
  // ------------------------------------------------------------------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let value;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "value") value = v;
        else if (k === "checked") el.checked = !!v;
        else if (k === "style" && typeof v === "object") {
          for (const [sk, sv] of Object.entries(v)) {
            if (sk.startsWith("--")) el.style.setProperty(sk, sv); else el.style[sk] = sv;
          }
        }
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, "");
        else el.setAttribute(k, String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    if (value !== undefined) el.value = value;
    return el;
  }

  // ------------------------------------------------------------------
  // Configuration manquante
  // ------------------------------------------------------------------
  if (!window.supabase || !CFG.SUPABASE_URL || /VOTRE/.test(CFG.SUPABASE_URL + CFG.SUPABASE_ANON_KEY)) {
    appEl.replaceChildren(
      h("div", { class: "auth" },
        h("div", { class: "auth-card" },
          h("h2", null, "Configuration nécessaire"),
          h("p", null, "Renseigne l'URL et la clé publique (anon) de ton projet Supabase dans le fichier config.js, puis recharge la page."),
          !window.supabase && h("p", { class: "error-text" }, "La bibliothèque Supabase n'a pas pu être chargée (connexion internet ?)."))));
    return;
  }

  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

  // ------------------------------------------------------------------
  // État
  // ------------------------------------------------------------------
  const S = {
    user: null,
    me: null,
    loaded: false,
    poles: [],
    profiles: new Map(),
    memberships: [],
    tasks: [],
    events: [],
    posts: [],
    replies: [],
    votes: [],
    meetings: [],
    meetingFiles: [],
    drafts: {},          // réponses en cours d'écriture, par publication
    pollEdit: new Set(), // sondages dont on modifie le vote
    expanded: new Set(), // fils de réponses dépliés
    dFilter: "all",      // all | sondage | question
    seenAtOpen: "",
    pendingRender: false,
    view: "home",        // home | pole:<id> | events | discussions | account | admin
    filter: "todo",      // todo | done | all
    navOpen: false,
    recovery: false,
  };

  // Droits (affichage uniquement — la base fait foi)
  const isAdmin = () => S.me?.global_role === "admin";
  const seesAll = () => S.me?.global_role === "admin" || S.me?.global_role === "overview";
  const myRole = (poleId) => S.memberships.find((m) => m.user_id === S.user?.id && m.pole_id === poleId)?.role;
  const canView = (poleId) => seesAll() || !!myRole(poleId);
  const canEdit = (poleId) => isAdmin() || myRole(poleId) === "responsable";
  const visiblePoles = () => S.poles.filter((p) => canView(p.id));
  const editablePoles = () => S.poles.filter((p) => canEdit(p.id));
  const poleById = (id) => S.poles.find((p) => p.id === id);
  const nameOf = (id) => (id && S.profiles.get(id)?.full_name) || "Quelqu'un";

  // Effectifs d'un pôle : responsables + membres, sans la présidence
  const polePeople = (poleId) => S.memberships.filter((m) =>
    m.pole_id === poleId && S.profiles.get(m.user_id)?.global_role !== "admin");
  const peopleLabel = (n) => `${n} personne${n > 1 ? "s" : ""}`;

  // Discussions
  const canSeeAnswers = (p) => p.replies_public || p.created_by === S.user?.id || isAdmin();
  const canManagePost = (p) => p.created_by === S.user?.id || isAdmin();
  const seenKey = () => "bde_seen_posts_" + (S.user?.id || "");
  function getSeen() { try { return localStorage.getItem(seenKey()) || "1970-01-01"; } catch (_) { return "1970-01-01"; } }
  function markSeen() { try { localStorage.setItem(seenKey(), new Date().toISOString()); } catch (_) { /* navigation privée */ } }
  function postHasNews(p, since) {
    if (p.created_by !== S.user.id && p.created_at > since) return true;
    return S.replies.some((r) => r.post_id === p.id && r.created_by !== S.user.id && r.created_at > since);
  }
  const unreadPosts = () => { const s = getSeen(); return S.posts.filter((p) => postHasNews(p, s)).length; };
  // Réunions
  const isSecretary = () => myRole("secretariat") === "responsable";
  const canCreateMeeting = () => isAdmin() || isSecretary() || editablePoles().length > 0;
  const canManageMeeting = (m) => isAdmin() || isSecretary() || m.created_by === S.user?.id;
  const meetingEnd = (m) => m.ends_at || new Date(new Date(m.starts_at).getTime() + 3600e3).toISOString();
  const upcomingMeetings = () => S.meetings
    .filter((m) => new Date(meetingEnd(m)) >= new Date())
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const pollsToVote = () => S.posts.filter((p) => p.kind === "sondage" && !p.closed &&
    !S.votes.some((v) => v.post_id === p.id && v.user_id === S.user.id));

  function accessLabel(poleId) {
    if (isAdmin()) return "Accès complet";
    const r = myRole(poleId);
    if (r === "responsable") return "Responsable";
    if (S.me?.global_role === "overview") return "Lecture seule";
    if (r === "membre") return "Lecture seule";
    return "";
  }

  function globalRoleLabel(r) {
    return { admin: "Présidence — accès complet", overview: "Vue d'ensemble — lecture seule", none: "Accès par pôle" }[r] || r;
  }

  // ------------------------------------------------------------------
  // Dates
  // ------------------------------------------------------------------
  const pad = (n) => String(n).padStart(2, "0");
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);
  const fmtDate = (d) => new Date(d + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
  const fmtLongDate = (d) => new Date(d + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const fmtDateTime = (ts) => {
    const d = new Date(ts);
    return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) +
      " à " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  };

  function dueBadge(t) {
    if (!t.due_date) return null;
    const diff = dayDiff(t.due_date, todayStr());
    if (t.done) return h("span", { class: "badge" }, "Échéance " + fmtDate(t.due_date));
    if (diff < 0) return h("span", { class: "badge late" }, `En retard · ${fmtDate(t.due_date)}`);
    if (diff === 0) return h("span", { class: "badge soon" }, "Aujourd'hui");
    if (diff === 1) return h("span", { class: "badge soon" }, "Demain");
    if (diff <= 3) return h("span", { class: "badge soon" }, fmtDate(t.due_date));
    return h("span", { class: "badge" }, fmtDate(t.due_date));
  }

  const isLate = (t) => !t.done && t.due_date && t.due_date < todayStr();

  function sortTasks(list) {
    return [...list].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.done && b.done) return (b.done_at || "").localeCompare(a.done_at || "");
      const da = a.due_date || "9999-12-31", db = b.due_date || "9999-12-31";
      return da.localeCompare(db) || (a.created_at || "").localeCompare(b.created_at || "");
    });
  }

  // ------------------------------------------------------------------
  // Notifications & modales
  // ------------------------------------------------------------------
  function toast(msg, err = false) {
    const el = h("div", { class: "toast" + (err ? " err" : "") }, msg);
    toastRoot.append(el);
    setTimeout(() => el.remove(), err ? 6000 : 3000);
  }

  function friendlyError(e) {
    const m = (e && (e.message || e.error_description)) || String(e);
    if (/row-level security|permission denied/i.test(m)) return "Action refusée : tu n'as pas les droits pour faire ça.";
    if (/Invalid login credentials/i.test(m)) return "E-mail ou mot de passe incorrect.";
    if (/Email not confirmed/i.test(m)) return "Confirme d'abord ton adresse e-mail (lien reçu par mail).";
    if (/already registered/i.test(m)) return "Un compte existe déjà avec cette adresse.";
    if (/Password should be/i.test(m)) return "Mot de passe trop court (8 caractères minimum).";
    if (/rate limit/i.test(m)) return "Trop de tentatives, réessaie dans quelques minutes.";
    return m;
  }

  function openModal(build, onClose) {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true; overlay.remove(); document.removeEventListener("keydown", onKey);
      if (onClose) onClose();
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    const box = h("div", { class: "modal", role: "dialog", "aria-modal": "true" });
    const overlay = h("div", { class: "overlay", onmousedown: (e) => { if (e.target === overlay) close(); } }, box);
    box.append(...[].concat(build(close)));
    modalRoot.append(overlay);
    document.addEventListener("keydown", onKey);
    const first = box.querySelector("input:not([type=checkbox]), textarea, select");
    if (first) first.focus();
    return close;
  }

  function confirmModal({ title, body, confirm = "Confirmer", danger = false }) {
    return new Promise((resolve) => {
      let result = false;
      // Échap, clic à l'extérieur ou « Annuler » = false
      openModal((close) => [
        h("h2", null, title),
        body && h("p", { style: { margin: 0, color: "var(--ink-2)" } }, body),
        h("div", { class: "modal-actions" },
          h("button", { class: "btn", onclick: close }, "Annuler"),
          h("button", { class: "btn " + (danger ? "danger solid" : "primary"), onclick: () => { result = true; close(); } }, confirm)),
      ], () => resolve(result));
    });
  }

  // ------------------------------------------------------------------
  // Données
  // ------------------------------------------------------------------
  async function loadAll() {
    const [poles, profiles, mems, tasks, events, posts, replies, votes, meetings, mfiles] = await Promise.all([
      sb.from("poles").select("*").order("sort").order("name"),
      sb.from("profiles").select("id, full_name, title, global_role"),
      sb.from("memberships").select("*"),
      sb.from("tasks").select("*"),
      sb.from("events").select("*"),
      sb.from("posts").select("*").order("created_at", { ascending: false }),
      sb.from("post_replies").select("*").order("created_at"),
      sb.from("post_votes").select("*"),
      sb.from("meetings").select("*").order("starts_at"),
      sb.from("meeting_files").select("*").order("uploaded_at"),
    ]);
    for (const r of [poles, profiles, mems, tasks, events, posts, replies, votes, meetings, mfiles]) if (r.error) throw r.error;
    S.meetings = meetings.data;
    S.meetingFiles = mfiles.data;
    S.posts = posts.data;
    S.replies = replies.data;
    S.votes = votes.data;
    S.poles = poles.data;
    S.profiles = new Map(profiles.data.map((p) => [p.id, p]));
    S.memberships = mems.data;
    S.tasks = tasks.data;
    S.events = events.data.sort((a, b) => (a.event_date || "9999").localeCompare(b.event_date || "9999"));
    S.me = S.profiles.get(S.user.id) || null;
    S.loaded = true;
  }

  async function refresh() {
    try {
      await loadAll();
      render();
    } catch (e) {
      toast(friendlyError(e), true);
    }
  }

  // Temps réel : quand quelqu'un coche ailleurs, on recharge
  let channel = null, rtTimer = null;
  function startRealtime() {
    stopRealtime();
    const onChange = () => {
      clearTimeout(rtTimer);
      rtTimer = setTimeout(async () => {
        try {
          await loadAll();
          // On évite de redessiner la page d'administration en pleine saisie
          if (S.view === "admin" || S.view === "account") return;
          if (isTyping()) { S.pendingRender = true; return; }
          render();
        } catch (_) { /* silencieux */ }
      }, 400);
    };
    channel = sb.channel("bde-live");
    for (const table of ["tasks", "events", "posts", "post_replies", "post_votes", "meetings", "meeting_files"]) {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, onChange);
    }
    channel.subscribe();
  }

  // Quelqu'un est en train d'écrire dans la page : on ne redessine pas sous ses doigts
  function isTyping() {
    const a = document.activeElement;
    return !!a && !!a.closest && !!a.closest(".main") && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  }
  document.addEventListener("focusout", () => {
    if (!S.pendingRender) return;
    setTimeout(() => {
      if (S.pendingRender && !isTyping() && !modalRoot.childElementCount) { S.pendingRender = false; render(); }
    }, 350);
  });
  function stopRealtime() {
    if (channel) { sb.removeChannel(channel); channel = null; }
  }

  // ------------------------------------------------------------------
  // Authentification
  // ------------------------------------------------------------------
  sb.auth.onAuthStateChange((event, session) => {
    // Ne jamais appeler Supabase directement dans ce callback
    setTimeout(() => onAuth(event, session), 0);
  });

  async function onAuth(event, session) {
    if (event === "PASSWORD_RECOVERY") {
      S.recovery = true;
      S.user = session?.user || null;
      renderRecovery();
      return;
    }
    if (!session) {
      S.user = null; S.me = null; S.loaded = false;
      stopRealtime();
      renderAuth();
      return;
    }
    if (S.recovery) return;
    if (S.user?.id === session.user.id && S.loaded) return; // simple rafraîchissement du jeton
    S.user = session.user;
    S.view = "home";
    await refresh();
    if (S.loaded) startRealtime();
  }

  function renderAuth(mode = "login", notice = null) {
    const err = h("div", { class: "error-text", role: "alert" });
    const setErr = (m) => { err.textContent = m || ""; };

    const tabs = h("div", { class: "tabs" },
      h("button", { class: mode === "login" ? "on" : "", onclick: () => renderAuth("login") }, "Connexion"),
      h("button", { class: mode === "signup" ? "on" : "", onclick: () => renderAuth("signup") }, "Inscription"));

    let form;
    if (mode === "login") {
      const email = h("input", { class: "input", type: "email", required: true, autocomplete: "email" });
      const pwd = h("input", { class: "input", type: "password", required: true, autocomplete: "current-password" });
      const btn = h("button", { class: "btn primary", type: "submit" }, "Se connecter");
      form = h("form", {
        onsubmit: async (e) => {
          e.preventDefault(); setErr(""); btn.disabled = true;
          const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pwd.value });
          btn.disabled = false;
          if (error) setErr(friendlyError(error));
        },
      },
        h("label", { class: "field" }, "E-mail", email),
        h("label", { class: "field" }, "Mot de passe", pwd),
        err, btn,
        h("button", { class: "linklike", type: "button", onclick: () => renderAuth("forgot") }, "Mot de passe oublié ?"));
    } else if (mode === "signup") {
      const name = h("input", { class: "input", required: true, maxlength: 60, autocomplete: "name", placeholder: "Prénom Nom" });
      const email = h("input", { class: "input", type: "email", required: true, autocomplete: "email" });
      const pwd = h("input", { class: "input", type: "password", required: true, minlength: 8, autocomplete: "new-password" });
      const pwd2 = h("input", { class: "input", type: "password", required: true, minlength: 8, autocomplete: "new-password" });
      const btn = h("button", { class: "btn primary", type: "submit" }, "Créer mon compte");
      form = h("form", {
        onsubmit: async (e) => {
          e.preventDefault(); setErr("");
          if (pwd.value !== pwd2.value) return setErr("Les deux mots de passe ne correspondent pas.");
          btn.disabled = true;
          const { data, error } = await sb.auth.signUp({
            email: email.value.trim(),
            password: pwd.value,
            options: { data: { full_name: name.value.trim() }, emailRedirectTo: location.origin + location.pathname },
          });
          btn.disabled = false;
          if (error) return setErr(friendlyError(error));
          if (!data.session) renderAuth("login", "Compte créé ! Clique sur le lien reçu par e-mail pour l'activer, puis connecte-toi.");
        },
      },
        h("label", { class: "field" }, "Nom complet", name),
        h("label", { class: "field" }, "E-mail", email),
        h("label", { class: "field" }, "Mot de passe (8 caractères min.)", pwd),
        h("label", { class: "field" }, "Confirmer le mot de passe", pwd2),
        err, btn,
        h("p", { class: "hint", style: { margin: 0 } },
          "Après l'inscription, la présidence t'attribue ton rôle. Tu peux aussi rejoindre un pôle en lecture seule."));
    } else {
      const email = h("input", { class: "input", type: "email", required: true, autocomplete: "email" });
      const btn = h("button", { class: "btn primary", type: "submit" }, "Recevoir un lien");
      form = h("form", {
        onsubmit: async (e) => {
          e.preventDefault(); setErr(""); btn.disabled = true;
          const { error } = await sb.auth.resetPasswordForEmail(email.value.trim(), { redirectTo: location.origin + location.pathname });
          btn.disabled = false;
          if (error) return setErr(friendlyError(error));
          renderAuth("login", "Si un compte existe, un lien de réinitialisation vient d'être envoyé.");
        },
      },
        h("label", { class: "field" }, "E-mail du compte", email),
        err, btn,
        h("button", { class: "linklike", type: "button", onclick: () => renderAuth("login") }, "Retour à la connexion"));
    }

    appEl.replaceChildren(
      h("div", { class: "auth" },
        h("div", { class: "auth-card" },
          h("div", { class: "auth-brand" },
            h("div", { class: "logo" }, BDE.slice(0, 3).toUpperCase()),
            h("div", null, h("div", { class: "brand-name" }, BDE), h("div", { class: "muted" }, "Organisation du bureau"))),
          mode !== "forgot" && tabs,
          mode === "forgot" && h("h2", null, "Mot de passe oublié"),
          notice && h("div", { class: "notice" }, notice),
          form)));
    appEl.querySelector("input")?.focus();
  }

  function renderRecovery() {
    const pwd = h("input", { class: "input", type: "password", required: true, minlength: 8, autocomplete: "new-password" });
    const err = h("div", { class: "error-text" });
    const btn = h("button", { class: "btn primary", type: "submit" }, "Enregistrer");
    appEl.replaceChildren(
      h("div", { class: "auth" },
        h("div", { class: "auth-card" },
          h("h2", null, "Nouveau mot de passe"),
          h("form", {
            onsubmit: async (e) => {
              e.preventDefault(); btn.disabled = true;
              const { error } = await sb.auth.updateUser({ password: pwd.value });
              btn.disabled = false;
              if (error) { err.textContent = friendlyError(error); return; }
              S.recovery = false;
              toast("Mot de passe modifié.");
              const { data } = await sb.auth.getSession();
              S.loaded = false;
              onAuth("SIGNED_IN", data.session);
            },
          }, h("label", { class: "field" }, "Mot de passe (8 caractères min.)", pwd), err, btn))));
  }

  // ------------------------------------------------------------------
  // Mise en page générale
  // ------------------------------------------------------------------
  function go(view) {
    S.view = view;
    S.navOpen = false;
    if (view.startsWith("pole:")) S.filter = "todo";
    if (view === "discussions") S.seenAtOpen = getSeen();
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    if (!S.user) return renderAuth();
    if (!S.me) {
      appEl.replaceChildren(h("div", { class: "auth" }, h("div", { class: "auth-card" },
        h("h2", null, "Profil introuvable"),
        h("p", null, "Ton compte existe mais son profil n'a pas été créé. Vérifie que le script schema.sql a bien été exécuté dans Supabase."),
        h("button", { class: "btn", onclick: () => sb.auth.signOut() }, "Se déconnecter"))));
      return;
    }
    // Vue devenue inaccessible (droits retirés) -> accueil
    if (S.view.startsWith("pole:") && !canView(S.view.slice(5))) S.view = "home";
    if (S.view === "admin" && !isAdmin()) S.view = "home";
    S.pendingRender = false;
    // Tout ce qui est affiché dans Discussions est considéré comme lu
    if (S.view === "discussions") markSeen();

    const content = h("div", { class: "content" },
      h("div", { class: "topbar" },
        h("button", { class: "btn ghost", "aria-label": "Menu", onclick: () => { S.navOpen = true; render(); } }, "☰"),
        h("span", { class: "brand-name" }, BDE)),
      h("main", { class: "main" }, viewContent()));

    appEl.replaceChildren(
      h("div", { class: "shell" },
        sidebar(),
        S.navOpen && h("div", { class: "scrim", onclick: () => { S.navOpen = false; render(); } }),
        content));
  }

  function sidebar() {
    const item = (view, icon, label, extra) =>
      h("button", { class: "nav-item" + (S.view === view ? " on" : ""), onclick: () => go(view) },
        icon, h("span", { class: "grow" }, label), extra);

    const poles = visiblePoles();
    return h("aside", { class: "sidebar" + (S.navOpen ? " open" : "") },
      h("div", { class: "brand" },
        h("div", { class: "logo" }, BDE.slice(0, 3).toUpperCase()),
        h("div", { class: "brand-name" }, BDE)),
      item("home", h("span", { class: "nav-icon" }, "⌂"), "Accueil"),
      item("events", h("span", { class: "nav-icon" }, "◷"), "Événements"),
      item("meetings", h("span", { class: "nav-icon" }, "◫"), "Réunions", (() => {
        const soon = upcomingMeetings().filter((m) => new Date(m.starts_at) - new Date() < 7 * 864e5).length;
        return soon > 0 && h("span", { class: "count" }, soon);
      })()),
      item("discussions", h("span", { class: "nav-icon" }, "✎"), "Discussions",
        S.view !== "discussions" && unreadPosts() > 0 && h("span", { class: "count new" }, unreadPosts())),
      poles.length > 0 && h("div", { class: "nav-label" }, "Pôles"),
      poles.map((p) => {
        const open = S.tasks.filter((t) => t.pole_id === p.id && !t.done);
        const late = open.filter(isLate).length;
        return item("pole:" + p.id, h("span", { class: "dot", style: { background: p.color } }), p.name,
          open.length > 0 && h("span", { class: "count" + (late ? " late" : "") }, open.length));
      }),
      h("div", { class: "spacer" }),
      h("div", { class: "nav-label" }, "Compte"),
      item("account", h("span", { class: "nav-icon" }, "○"), "Mon compte"),
      isAdmin() && item("admin", h("span", { class: "nav-icon" }, "⚙"), "Administration"),
      h("button", { class: "nav-item", onclick: () => sb.auth.signOut() }, h("span", { class: "nav-icon" }, "↩"), h("span", { class: "grow" }, "Se déconnecter")),
      h("div", { class: "me-box" },
        h("strong", null, S.me.full_name || "Sans nom"),
        h("span", { class: "muted" }, S.me.title || globalRoleLabel(S.me.global_role))));
  }

  function viewContent() {
    if (S.view === "home") return viewHome();
    if (S.view === "events") return viewEvents();
    if (S.view === "discussions") return viewDiscussions();
    if (S.view === "meetings") return viewMeetings();
    if (S.view === "account") return viewAccount();
    if (S.view === "admin") return viewAdmin();
    if (S.view.startsWith("pole:")) return viewPole(S.view.slice(5));
    return viewHome();
  }

  // ------------------------------------------------------------------
  // Carte de tâche
  // ------------------------------------------------------------------
  function taskCard(t, { showPole = false } = {}) {
    const pole = poleById(t.pole_id);
    const editable = canEdit(t.pole_id);
    const ev = t.event_id && S.events.find((e) => e.id === t.event_id);

    const box = h("input", {
      type: "checkbox", class: "check", checked: t.done, disabled: !editable,
      title: editable ? (t.done ? "Décocher" : "Marquer comme faite") : "Seul le responsable du pôle peut cocher",
      "aria-label": "Tâche faite",
      onchange: (e) => toggleTask(t, e.target.checked, e.target),
    });

    return h("div", { class: "task" + (t.done ? " done" : "") },
      box,
      h("div", { class: "task-body" },
        h("div", { class: "task-top" },
          h("span", { class: "task-title" }, t.title),
          showPole && pole && h("span", { class: "badge pole" }, h("span", { class: "dot", style: { background: pole.color } }), pole.name),
          ev && h("span", { class: "badge accent" }, "◷ " + ev.title)),
        t.description && h("div", { class: "task-desc" }, t.description),
        h("div", { class: "task-meta" },
          dueBadge(t),
          t.done && t.done_at
            ? h("span", { class: "doneby" }, `✓ Faite par ${nameOf(t.done_by)} le ${fmtDateTime(t.done_at)}`)
            : h("span", null, `Ajoutée par ${nameOf(t.created_by)}`),
          h("span", { class: "task-actions" },
            h("button", { class: "btn ghost sm", onclick: () => showHistory(t) }, "Historique"),
            editable && h("button", { class: "btn ghost sm", onclick: () => taskForm(t) }, "Modifier"),
            editable && h("button", { class: "btn ghost sm danger", onclick: () => deleteTask(t) }, "Supprimer")))));
  }

  async function toggleTask(t, checked, input) {
    const ok = await confirmModal(checked
      ? {
        title: "Valider cette tâche ?",
        body: `En cochant « ${t.title} », tu confirmes l'avoir réalisée et tu en prends la responsabilité. Ton nom, la date et l'heure seront enregistrés.`,
        confirm: "Je confirme",
      }
      : {
        title: "Décocher cette tâche ?",
        body: "Elle repassera « à faire ». Cette action est elle aussi enregistrée dans l'historique.",
        confirm: "Décocher",
      });
    if (!ok) { input.checked = !checked; return; }
    input.disabled = true;
    const { data, error } = await sb.from("tasks").update({ done: checked }).eq("id", t.id).select().maybeSingle();
    if (error || !data) {
      input.checked = !checked; input.disabled = false;
      return toast(error ? friendlyError(error) : "Action refusée : tu n'as pas les droits pour faire ça.", true);
    }
    Object.assign(t, data);
    toast(checked ? "Tâche validée ✓" : "Tâche repassée à faire");
    render();
  }

  async function deleteTask(t) {
    const ok = await confirmModal({ title: "Supprimer la tâche ?", body: `« ${t.title} » sera supprimée. La suppression reste visible dans l'historique.`, confirm: "Supprimer", danger: true });
    if (!ok) return;
    const { error } = await sb.from("tasks").delete().eq("id", t.id);
    if (error) return toast(friendlyError(error), true);
    S.tasks = S.tasks.filter((x) => x.id !== t.id);
    toast("Tâche supprimée");
    render();
  }

  function taskForm(task = null, defaults = {}) {
    const poles = editablePoles();
    if (!poles.length) return toast("Tu n'es responsable d'aucun pôle.", true);
    const t = task || {};
    const title = h("input", { class: "input", required: true, maxlength: 200, value: t.title || "", placeholder: "Ex. Envoyer le mail de relance à Red Bull" });
    const desc = h("textarea", { class: "input", value: t.description || "", placeholder: "Détails, contacts, liens… (facultatif)" });
    const pole = h("select", { class: "input", value: t.pole_id || defaults.pole_id || poles[0].id },
      poles.map((p) => h("option", { value: p.id }, p.name)));
    const due = h("input", { class: "input", type: "date", value: t.due_date || defaults.due_date || "" });
    const evSel = h("select", { class: "input" });
    const fillEvents = () => {
      const keep = evSel.value || t.event_id || defaults.event_id || "";
      const list = S.events.filter((e) => e.poles.includes(pole.value) || e.id === keep);
      evSel.replaceChildren(h("option", { value: "" }, "— Aucun —"), ...list.map((e) => h("option", { value: e.id }, e.title + (e.event_date ? " · " + fmtDate(e.event_date) : ""))));
      evSel.value = list.some((e) => e.id === keep) ? keep : "";
    };
    pole.addEventListener("change", fillEvents);
    fillEvents();
    const err = h("div", { class: "error-text" });

    openModal((close) => {
      const save = h("button", { class: "btn primary", type: "submit" }, task ? "Enregistrer" : "Ajouter la tâche");
      return [
        h("h2", null, task ? "Modifier la tâche" : "Nouvelle tâche"),
        h("form", {
          onsubmit: async (e) => {
            e.preventDefault(); save.disabled = true; err.textContent = "";
            const payload = {
              title: title.value.trim(),
              description: desc.value.trim() || null,
              pole_id: pole.value,
              due_date: due.value || null,
              event_id: evSel.value || null,
            };
            const q = task
              ? sb.from("tasks").update(payload).eq("id", task.id).select().maybeSingle()
              : sb.from("tasks").insert(payload).select().single();
            const { data, error } = await q;
            save.disabled = false;
            if (error || !data) { err.textContent = error ? friendlyError(error) : "Action refusée."; return; }
            if (task) Object.assign(task, data); else S.tasks.push(data);
            close();
            toast(task ? "Tâche modifiée" : "Tâche ajoutée");
            render();
          },
        },
          h("label", { class: "field" }, "Intitulé", title),
          h("label", { class: "field" }, "Pôle", pole),
          h("label", { class: "field" }, "Date limite", due),
          h("label", { class: "field" }, "Événement lié", evSel),
          h("label", { class: "field" }, "Description", desc),
          err,
          h("div", { class: "modal-actions" },
            h("button", { class: "btn", type: "button", onclick: close }, "Annuler"),
            save)),
      ];
    });
  }

  const ACTIONS = {
    creation: "a créé la tâche",
    cochee: "a coché la tâche",
    decochee: "a décoché la tâche",
    modification: "a modifié la tâche",
    suppression: "a supprimé la tâche",
  };

  async function showHistory(t) {
    const list = h("div", { class: "activity card" }, h("div", { class: "activity-row muted" }, "Chargement…"));
    openModal((close) => [
      h("h2", null, "Historique"),
      h("div", { class: "muted" }, t.title),
      list,
      h("div", { class: "modal-actions" }, h("button", { class: "btn", onclick: close }, "Fermer")),
    ]);
    const { data, error } = await sb.from("task_log").select("*").eq("task_id", t.id).order("at", { ascending: false });
    if (error) { list.replaceChildren(h("div", { class: "activity-row error-text" }, friendlyError(error))); return; }
    list.replaceChildren(...(data.length ? data.map((l) =>
      h("div", { class: "activity-row" },
        h("span", null, h("strong", null, nameOf(l.user_id)), " ", ACTIONS[l.action] || l.action),
        h("span", { class: "when" }, fmtDateTime(l.at))))
      : [h("div", { class: "activity-row muted" }, "Aucun historique.")]));
  }

  // ------------------------------------------------------------------
  // Vue : Accueil
  // ------------------------------------------------------------------
  function viewHome() {
    const poles = visiblePoles();
    const first = (S.me.full_name || "").split(" ")[0];
    const head = h("div", { class: "page-head" },
      h("div", null,
        h("h1", null, first ? `Bonjour ${first} 👋` : "Bonjour 👋"),
        h("div", { class: "sub" }, fmtLongDate(todayStr()))),
      editablePoles().length > 0 && h("button", { class: "btn primary", onclick: () => taskForm() }, "+ Nouvelle tâche"));

    if (!poles.length) {
      const n = pollsToVote().length;
      return h("div", null, head,
        nextMeetingNotice(),
        n > 0 && h("div", { class: "notice row-notice" },
          h("span", null, `🗳️ ${n} sondage${n > 1 ? "s attendent" : " attend"} ton vote`),
          h("button", { class: "btn sm", onclick: () => go("discussions") }, "Voir")),
        onboarding());
    }

    // Cartes de progression par pôle
    const cards = h("div", { class: "grid" }, poles.map((p) => {
      const all = S.tasks.filter((t) => t.pole_id === p.id);
      const done = all.filter((t) => t.done).length;
      const late = all.filter(isLate).length;
      const pct = all.length ? Math.round((done / all.length) * 100) : 0;
      const n = polePeople(p.id).length;
      return h("button", { class: "pole-card", style: { "--c": p.color }, onclick: () => go("pole:" + p.id) },
        h("div", { class: "row" }, h("h3", null, p.name), accessLabel(p.id) && h("span", { class: "badge" }, accessLabel(p.id))),
        h("div", { class: "progress" }, h("span", { style: { width: pct + "%" } })),
        h("div", { class: "row" },
          h("span", { class: "muted" }, all.length ? `${done}/${all.length} faites` : "Aucune tâche"),
          late > 0 && h("span", { class: "badge late" }, `${late} en retard`)),
        h("div", { class: "muted" }, "👥 " + peopleLabel(n)));
    }));

    const toVote = pollsToVote();
    const pollNotice = toVote.length > 0 && h("div", { class: "notice row-notice" },
      h("span", null, `🗳️ ${toVote.length} sondage${toVote.length > 1 ? "s attendent" : " attend"} ton vote`),
      h("button", { class: "btn sm", onclick: () => go("discussions") }, "Voir"));

    // Agenda des tâches à faire
    const open = sortTasks(S.tasks.filter((t) => !t.done && canView(t.pole_id)));
    const today = todayStr();
    const groups = [
      ["En retard", (t) => t.due_date && t.due_date < today, "late"],
      ["Aujourd'hui", (t) => t.due_date === today],
      ["7 prochains jours", (t) => t.due_date && t.due_date > today && dayDiff(t.due_date, today) <= 7],
      ["Plus tard", (t) => t.due_date && dayDiff(t.due_date, today) > 7],
      ["Sans date limite", (t) => !t.due_date],
    ];
    const agenda = open.length
      ? groups.map(([label, test, cls]) => {
        const items = open.filter(test);
        return items.length ? [h("div", { class: "group-label" + (cls ? " " + cls : "") }, `${label} · ${items.length}`), items.map((t) => taskCard(t, { showPole: true }))] : null;
      })
      : h("div", { class: "empty" }, "Rien à faire pour l'instant 🎉");

    const activity = seesAll() ? activitySection() : null;

    return h("div", null, head,
      nextMeetingNotice(),
      pollNotice,
      cards,
      h("div", { class: "section" }, h("h2", null, "À faire"), h("div", { class: "tasks" }, agenda)),
      activity);
  }

  function activitySection() {
    const list = h("div", { class: "activity card" }, h("div", { class: "activity-row muted" }, "Chargement…"));
    sb.from("task_log").select("*").order("at", { ascending: false }).limit(15).then(({ data, error }) => {
      if (error) return list.replaceChildren(h("div", { class: "activity-row error-text" }, friendlyError(error)));
      if (!data.length) return list.replaceChildren(h("div", { class: "activity-row muted" }, "Pas encore d'activité."));
      list.replaceChildren(...data.map((l) => {
        const p = poleById(l.pole_id);
        return h("div", { class: "activity-row" },
          h("span", { class: "dot", style: { background: p?.color || "var(--ink-3)", alignSelf: "center" } }),
          h("span", null, h("strong", null, nameOf(l.user_id)), " ", ACTIONS[l.action] || l.action, " « ", l.task_title, " »"),
          h("span", { class: "when" }, fmtDateTime(l.at)));
      }));
    });
    return h("div", { class: "section" }, h("h2", null, "Activité récente"), list);
  }

  function onboarding() {
    const joinable = S.poles.filter((p) => p.open_to_members && !myRole(p.id));
    return h("div", { class: "card", style: { padding: "22px", display: "grid", gap: "14px" } },
      h("h2", null, "Bienvenue !"),
      h("p", { style: { margin: 0, color: "var(--ink-2)" } },
        "Tu n'as encore accès à aucun pôle. Si tu fais partie du bureau, la présidence va t'attribuer ton rôle de responsable. ",
        "En attendant, tu peux suivre un pôle en lecture seule :"),
      joinable.length
        ? h("div", { class: "chips" }, joinable.map((p) => h("button", { class: "btn", onclick: () => joinPole(p) },
          h("span", { class: "dot", style: { background: p.color } }), p.name)))
        : h("div", { class: "muted" }, "Aucun pôle n'est ouvert aux membres pour le moment."));
  }

  async function joinPole(p) {
    const ok = await confirmModal({ title: `Suivre le pôle ${p.name} ?`, body: "Tu verras ses tâches en lecture seule. Seul le responsable peut les cocher.", confirm: "Rejoindre" });
    if (!ok) return;
    const { error } = await sb.from("memberships").insert({ user_id: S.user.id, pole_id: p.id, role: "membre" });
    if (error) return toast(friendlyError(error), true);
    toast(`Tu suis maintenant ${p.name}`);
    await refresh();
  }

  async function leavePole(p) {
    const ok = await confirmModal({ title: `Quitter ${p.name} ?`, body: "Tu ne verras plus les tâches de ce pôle.", confirm: "Quitter", danger: true });
    if (!ok) return;
    const { error } = await sb.from("memberships").delete().eq("user_id", S.user.id).eq("pole_id", p.id);
    if (error) return toast(friendlyError(error), true);
    await refresh();
  }

  // ------------------------------------------------------------------
  // Vue : Pôle
  // ------------------------------------------------------------------
  function viewPole(id) {
    const p = poleById(id);
    if (!p) return h("div", { class: "empty" }, "Pôle introuvable.");
    const all = S.tasks.filter((t) => t.pole_id === id);
    const counts = { todo: all.filter((t) => !t.done).length, done: all.filter((t) => t.done).length, all: all.length };
    const list = sortTasks(S.filter === "all" ? all : all.filter((t) => (S.filter === "done" ? t.done : !t.done)));
    const people = polePeople(id);
    const responsables = people.filter((m) => m.role === "responsable").map((m) => nameOf(m.user_id));
    const membres = people.filter((m) => m.role === "membre").map((m) => nameOf(m.user_id));

    const seg = h("div", { class: "seg" }, [["todo", "À faire"], ["done", "Faites"], ["all", "Toutes"]].map(([k, l]) =>
      h("button", { class: S.filter === k ? "on" : "", onclick: () => { S.filter = k; render(); } }, `${l} (${counts[k]})`)));

    return h("div", null,
      h("div", { class: "page-head" },
        h("div", null,
          h("h1", null, h("span", { class: "dot", style: { background: p.color, width: "14px", height: "14px", display: "inline-block", marginRight: "10px", verticalAlign: "middle" } }), p.name),
          h("div", { class: "sub" },
            h("span", { class: "badge" }, "👥 " + peopleLabel(people.length)), " ",
            accessLabel(id) && h("span", { class: "badge" }, accessLabel(id))),
          h("div", { class: "sub" },
            responsables.length ? `Responsable${responsables.length > 1 ? "s" : ""} : ${responsables.join(", ")}` : "Aucun responsable désigné"),
          membres.length > 0 && h("div", { class: "sub" }, `Membre${membres.length > 1 ? "s" : ""} : ${membres.join(", ")}`))),
      h("div", { class: "toolbar" },
        seg,
        h("span", { class: "spacer" }),
        canEdit(id) && h("button", { class: "btn primary", onclick: () => taskForm(null, { pole_id: id }) }, "+ Nouvelle tâche")),
      !canEdit(id) && h("div", { class: "notice", style: { marginBottom: "14px" } }, "Tu consultes ce pôle en lecture seule : seul le responsable peut ajouter ou cocher des tâches."),
      h("div", { class: "tasks" }, list.length ? list.map((t) => taskCard(t)) :
        h("div", { class: "empty" }, S.filter === "done" ? "Aucune tâche faite pour l'instant." : S.filter === "todo" ? "Aucune tâche en attente 🎉" : "Aucune tâche.")));
  }

  // ------------------------------------------------------------------
  // Vue : Événements
  // ------------------------------------------------------------------
  function viewEvents() {
    const head = h("div", { class: "page-head" },
      h("div", null, h("h1", null, "Événements"), h("div", { class: "sub" }, "Les tâches de chaque pôle pour un même événement.")),
      isAdmin() && h("button", { class: "btn primary", onclick: () => eventForm() }, "+ Nouvel événement"));

    if (!S.events.length) return h("div", null, head, h("div", { class: "empty" }, "Aucun événement pour l'instant."));

    return h("div", null, head, h("div", { class: "tasks", style: { gap: "14px" } }, S.events.map((ev) => {
      const tasks = sortTasks(S.tasks.filter((t) => t.event_id === ev.id));
      const done = tasks.filter((t) => t.done).length;
      const addable = ev.poles.filter((p) => canEdit(p));
      const past = ev.event_date && ev.event_date < todayStr();
      return h("div", { class: "event" },
        h("div", { class: "event-head" },
          h("div", { style: { display: "grid", gap: "6px" } },
            h("h2", null, ev.title),
            h("div", { class: "chips" },
              ev.event_date && h("span", { class: "badge" + (past ? "" : " accent") }, fmtLongDate(ev.event_date)),
              ev.poles.map((pid) => { const p = poleById(pid); return p && h("span", { class: "badge pole" }, h("span", { class: "dot", style: { background: p.color } }), p.name); }))),
          h("div", { class: "chips" },
            tasks.length > 0 && h("span", { class: "badge" + (done === tasks.length ? " ok" : "") }, `${done}/${tasks.length} tâches faites`),
            addable.length > 0 && h("button", { class: "btn sm", onclick: () => taskForm(null, { pole_id: addable[0], event_id: ev.id, due_date: ev.event_date }) }, "+ Tâche"),
            isAdmin() && h("button", { class: "btn sm ghost", onclick: () => eventForm(ev) }, "Modifier"),
            isAdmin() && h("button", { class: "btn sm ghost danger", onclick: () => deleteEvent(ev) }, "Supprimer"))),
        ev.description && h("div", { class: "task-desc" }, ev.description),
        tasks.length ? h("div", { class: "tasks" }, tasks.map((t) => taskCard(t, { showPole: true })))
          : h("div", { class: "muted" }, "Aucune tâche visible pour toi sur cet événement."));
    })));
  }

  function eventForm(ev = null) {
    const e0 = ev || { poles: [] };
    const title = h("input", { class: "input", required: true, maxlength: 120, value: e0.title || "", placeholder: "Ex. Gala de fin d'année" });
    const date = h("input", { class: "input", type: "date", value: e0.event_date || "" });
    const desc = h("textarea", { class: "input", value: e0.description || "" });
    const boxes = S.poles.map((p) => ({ p, el: h("input", { type: "checkbox", checked: e0.poles.includes(p.id) }) }));
    const err = h("div", { class: "error-text" });

    openModal((close) => {
      const save = h("button", { class: "btn primary", type: "submit" }, ev ? "Enregistrer" : "Créer l'événement");
      return [
        h("h2", null, ev ? "Modifier l'événement" : "Nouvel événement"),
        h("form", {
          onsubmit: async (e) => {
            e.preventDefault(); err.textContent = "";
            const poles = boxes.filter((b) => b.el.checked).map((b) => b.p.id);
            if (!poles.length) { err.textContent = "Coche au moins un pôle concerné."; return; }
            save.disabled = true;
            const payload = { title: title.value.trim(), event_date: date.value || null, description: desc.value.trim() || null, poles };
            const { error } = ev
              ? await sb.from("events").update(payload).eq("id", ev.id)
              : await sb.from("events").insert(payload);
            save.disabled = false;
            if (error) { err.textContent = friendlyError(error); return; }
            close();
            toast(ev ? "Événement modifié" : "Événement créé");
            await refresh();
          },
        },
          h("label", { class: "field" }, "Nom", title),
          h("label", { class: "field" }, "Date", date),
          h("div", { class: "field" }, "Pôles concernés",
            h("div", { class: "check-list" }, boxes.map((b) => h("label", null, b.el, h("span", { class: "dot", style: { background: b.p.color } }), b.p.name))),
            h("span", { class: "hint" }, "Seuls les membres de ces pôles verront l'événement.")),
          h("label", { class: "field" }, "Description", desc),
          err,
          h("div", { class: "modal-actions" }, h("button", { class: "btn", type: "button", onclick: close }, "Annuler"), save)),
      ];
    });
  }

  async function deleteEvent(ev) {
    const ok = await confirmModal({ title: "Supprimer l'événement ?", body: "Les tâches liées sont conservées, elles ne seront simplement plus rattachées à cet événement.", confirm: "Supprimer", danger: true });
    if (!ok) return;
    const { error } = await sb.from("events").delete().eq("id", ev.id);
    if (error) return toast(friendlyError(error), true);
    await refresh();
  }

  // ------------------------------------------------------------------
  // Vue : Réunions
  // ------------------------------------------------------------------
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const fmtMeetingWhen = (m) => {
    const d = new Date(m.starts_at);
    const date = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    return `${date} · ${fmtTime(m.starts_at)}${m.ends_at ? " – " + fmtTime(m.ends_at) : ""}`;
  };
  const localParts = (iso) => {
    const d = new Date(iso);
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  };
  const fmtSize = (n) => (n == null ? "" : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} Ko` : `${(n / 1024 / 1024).toFixed(1)} Mo`);
  const BUCKET = "comptes-rendus";

  function nextMeetingNotice() {
    const m = upcomingMeetings()[0];
    if (!m) return null;
    return h("div", { class: "notice row-notice" },
      h("span", null, "📅 Prochaine réunion : ", h("strong", null, m.title), ` — ${fmtMeetingWhen(m)}`, m.location ? ` · ${m.location}` : ""),
      h("button", { class: "btn sm", onclick: () => go("meetings") }, "Voir"));
  }

  function meetingAudience(m) {
    if (m.bureau_only) return [h("span", { class: "badge" }, "🔒 Bureau uniquement")];
    if (!m.audience.length) return [h("span", { class: "badge pole" }, "Tout le monde")];
    return m.audience.map((pid) => {
      const p = poleById(pid);
      return p && h("span", { class: "badge pole" }, h("span", { class: "dot", style: { background: p.color } }), p.name);
    });
  }

  function viewMeetings() {
    const upcoming = upcomingMeetings();
    const past = S.meetings.filter((m) => !upcoming.includes(m)).sort((a, b) => b.starts_at.localeCompare(a.starts_at));
    return h("div", null,
      h("div", { class: "page-head" },
        h("div", null,
          h("h1", null, "Réunions"),
          h("div", { class: "sub" }, "Les prochaines réunions et les comptes rendus des précédentes.")),
        h("div", { class: "chips" },
          h("button", { class: "btn", onclick: syncModal }, "📅 Synchroniser mon agenda"),
          canCreateMeeting() && h("button", { class: "btn primary", onclick: () => meetingForm() }, "+ Planifier une réunion"))),
      h("div", { class: "section", style: { marginTop: "0" } },
        h("h2", null, "À venir"),
        h("div", { class: "tasks", style: { gap: "12px" } },
          upcoming.length ? upcoming.map((m) => meetingCard(m, false)) : h("div", { class: "empty" }, "Aucune réunion prévue."))),
      h("div", { class: "section" },
        h("h2", null, "Passées & comptes rendus"),
        h("div", { class: "tasks", style: { gap: "12px" } },
          past.length ? past.map((m) => meetingCard(m, true)) : h("div", { class: "empty" }, "Aucune réunion passée pour l'instant."))));
  }

  function meetingCard(m, past) {
    const d = new Date(m.starts_at);
    const files = S.meetingFiles.filter((f) => f.meeting_id === m.id);
    const hasCR = !!m.minutes || files.length > 0;
    const manage = canManageMeeting(m);
    const key = "m-" + m.id;
    const expanded = S.expanded.has(key);
    const longText = m.minutes && (m.minutes.length > 500 || m.minutes.split("\n").length > 8);

    return h("article", { class: "meeting" + (past ? " past" : "") },
      h("div", { class: "date-box" },
        h("span", { class: "dow" }, d.toLocaleDateString("fr-FR", { weekday: "short" })),
        h("span", { class: "dnum" }, d.getDate()),
        h("span", { class: "mon" }, d.toLocaleDateString("fr-FR", { month: "short" }))),
      h("div", { class: "meeting-body" },
        h("div", { class: "post-head" },
          h("h2", { class: "post-title" }, m.title),
          h("div", { class: "task-actions" },
            !past && h("button", { class: "btn ghost sm", onclick: () => downloadIcs(m) }, "＋ Mon agenda"),
            manage && h("button", { class: "btn ghost sm", onclick: () => meetingForm(m) }, "Modifier"),
            manage && h("button", { class: "btn ghost sm danger", onclick: () => deleteMeeting(m) }, "Supprimer"))),
        h("div", { class: "task-meta", style: { fontSize: "14px", color: "var(--ink-2)" } },
          h("span", null, "🕒 " + fmtMeetingWhen(m)),
          m.location && h("span", null, "📍 " + m.location)),
        h("div", { class: "chips" }, meetingAudience(m), h("span", { class: "muted" }, "Organisée par " + nameOf(m.created_by))),
        m.agenda && h("div", { class: "block" },
          h("div", { class: "block-label" }, "Ordre du jour"),
          h("div", { class: "task-desc" }, m.agenda)),
        (hasCR || past) && h("div", { class: "block cr" },
          h("div", { class: "block-label" }, "Compte rendu",
            m.minutes_at && h("span", { class: "muted", style: { fontWeight: 400 } }, ` · ${nameOf(m.minutes_by)}, ${fmtDateTime(m.minutes_at)}`)),
          m.minutes && h("div", { class: "task-desc" + (longText && !expanded ? " clamp" : "") }, m.minutes),
          longText && h("button", { class: "linklike", onclick: () => { expanded ? S.expanded.delete(key) : S.expanded.add(key); render(); } },
            expanded ? "Réduire" : "Lire tout le compte rendu"),
          files.length > 0 && h("div", { class: "chips" }, files.map((f) =>
            h("button", { class: "file-chip", title: "Télécharger", onclick: () => downloadFile(f) }, "📄 ", f.name, h("span", { class: "muted" }, " " + fmtSize(f.size))))),
          !hasCR && h("div", { class: "muted" }, past ? "Pas encore de compte rendu." : "Le compte rendu pourra être ajouté après la réunion."),
          manage && h("div", null, h("button", { class: "btn sm" + (past && !hasCR ? " primary" : ""), onclick: () => minutesForm(m) },
            hasCR ? "Modifier le compte rendu" : "Ajouter le compte rendu")))));
  }

  function icsText(m) {
    const esc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
    const utc = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//BDE//Organisation//FR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:reunion-${m.id}@bde`,
      `DTSTAMP:${utc(new Date().toISOString())}`,
      `DTSTART:${utc(m.starts_at)}`,
      `DTEND:${utc(meetingEnd(m))}`,
      `SUMMARY:${esc(m.title)}`,
      m.location && `LOCATION:${esc(m.location)}`,
      `DESCRIPTION:${esc((m.agenda ? "Ordre du jour :\n" + m.agenda + "\n\n" : "") + "Réunion du " + BDE)}`,
      "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(m.title)}`, "TRIGGER:-PT1H", "END:VALARM",
      "END:VEVENT", "END:VCALENDAR",
    ].filter(Boolean);
    return lines.join("\r\n") + "\r\n";
  }

  function downloadIcs(m) {
    const blob = new Blob([icsText(m)], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: slugify(m.title) + ".ics" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function meetingForm(m = null) {
    const full = isAdmin() || isSecretary();
    const now = new Date(); now.setDate(now.getDate() + 1);
    const start = m ? localParts(m.starts_at) : { date: localParts(now.toISOString()).date, time: "18:00" };
    const end = m?.ends_at ? localParts(m.ends_at).time : "";

    const title = h("input", { class: "input", required: true, maxlength: 150, value: m?.title || "", placeholder: "Ex. Réunion de bureau" });
    const date = h("input", { class: "input", type: "date", required: true, value: start.date });
    const t1 = h("input", { class: "input", type: "time", required: true, value: start.time });
    const t2 = h("input", { class: "input", type: "time", value: end });
    const place = h("input", { class: "input", maxlength: 200, value: m?.location || "", placeholder: "Ex. Salle B12, ou lien Teams / Discord" });
    const agenda = h("textarea", { class: "input", maxlength: 8000, value: m?.agenda || "", placeholder: "Un point par ligne :\nBudget du gala\nChoix du thème\nQuestions diverses" });

    // Invités
    const choosable = full ? S.poles : editablePoles();
    const mode0 = m ? (m.bureau_only ? "bureau" : m.audience.length ? "poles" : "all") : (full ? "bureau" : "poles");
    const rAll = h("input", { type: "radio", name: "maud", checked: mode0 === "all" });
    const rBureau = h("input", { type: "radio", name: "maud", checked: mode0 === "bureau" });
    const rPoles = h("input", { type: "radio", name: "maud", checked: mode0 === "poles" });
    const boxes = choosable.map((p) => ({ p, el: h("input", { type: "checkbox", checked: !!m?.audience.includes(p.id) || (!m && !full && choosable.length === 1) }) }));
    const list = h("div", { class: "check-list" }, boxes.map((b) => h("label", null, b.el, h("span", { class: "dot", style: { background: b.p.color } }), b.p.name)));
    const sync = () => { list.style.display = rPoles.checked ? "" : "none"; };
    [rAll, rBureau, rPoles].forEach((r) => r.addEventListener("change", sync));
    sync();

    const err = h("div", { class: "error-text" });
    openModal((close) => {
      const save = h("button", { class: "btn primary", type: "submit" }, m ? "Enregistrer" : "Planifier");
      return [
        h("h2", null, m ? "Modifier la réunion" : "Planifier une réunion"),
        h("form", {
          onsubmit: async (e) => {
            e.preventDefault(); err.textContent = "";
            const s = new Date(`${date.value}T${t1.value}`);
            let en = null;
            if (t2.value) {
              en = new Date(`${date.value}T${t2.value}`);
              if (en <= s) { err.textContent = "L'heure de fin doit être après l'heure de début."; return; }
            }
            const payload = {
              title: title.value.trim(),
              starts_at: s.toISOString(),
              ends_at: en ? en.toISOString() : null,
              location: place.value.trim() || null,
              agenda: agenda.value.trim() || null,
              bureau_only: full && rBureau.checked,
              audience: rPoles.checked ? boxes.filter((b) => b.el.checked).map((b) => b.p.id) : [],
            };
            if (rPoles.checked && !payload.audience.length) { err.textContent = "Coche au moins un pôle."; return; }
            save.disabled = true;
            const { error } = m
              ? await sb.from("meetings").update(payload).eq("id", m.id)
              : await sb.from("meetings").insert(payload);
            save.disabled = false;
            if (error) { err.textContent = friendlyError(error); return; }
            close();
            toast(m ? "Réunion modifiée" : "Réunion planifiée");
            await refresh();
          },
        },
          h("label", { class: "field" }, "Titre", title),
          h("div", { class: "form-row" },
            h("label", { class: "field" }, "Date", date),
            h("label", { class: "field" }, "Début", t1),
            h("label", { class: "field" }, "Fin (facultatif)", t2)),
          h("label", { class: "field" }, "Lieu", place),
          h("label", { class: "field" }, "Ordre du jour", agenda),
          h("div", { class: "field" }, "Qui est invité ?",
            full && h("label", { class: "radio-line" }, rBureau, "Le bureau (présidence, secrétariat, responsables)"),
            full && h("label", { class: "radio-line" }, rAll, "Tout le monde (bureau et membres)"),
            h("label", { class: "radio-line", style: full ? null : { display: "none" } }, rPoles, "Certains pôles"),
            list),
          err,
          h("div", { class: "modal-actions" },
            h("button", { class: "btn", type: "button", onclick: close }, "Annuler"),
            save)),
      ];
    });
  }

  async function deleteMeeting(m) {
    const files = S.meetingFiles.filter((f) => f.meeting_id === m.id);
    const ok = await confirmModal({
      title: "Supprimer la réunion ?",
      body: files.length ? `Le compte rendu et ${files.length} fichier(s) seront supprimés aussi.` : "Cette action est définitive.",
      confirm: "Supprimer", danger: true,
    });
    if (!ok) return;
    if (files.length) await sb.storage.from(BUCKET).remove(files.map((f) => f.path));
    const { error } = await sb.from("meetings").delete().eq("id", m.id);
    if (error) return toast(friendlyError(error), true);
    toast("Réunion supprimée");
    await refresh();
  }

  async function downloadFile(f) {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(f.path, 120, { download: f.name });
    if (error || !data) return toast(error ? friendlyError(error) : "Fichier introuvable.", true);
    window.location.href = data.signedUrl;
  }

  function safeFileName(name) {
    const base = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    return (base || "fichier").slice(-100);
  }

  function minutesForm(m) {
    const text = h("textarea", { class: "input", maxlength: 100000, value: m.minutes || "", style: { minHeight: "260px" },
      placeholder: "Présents :\nExcusés :\n\n1. Budget du gala\n- …\n\nDécisions :\n- …" });
    const fileList = h("div", { class: "thread" });
    const status = h("div", { class: "hint" });
    const picker = h("input", { type: "file", multiple: true, accept: ".pdf,.doc,.docx,.odt,.txt,.rtf,.ppt,.pptx,.xls,.xlsx,image/*", style: { display: "none" } });

    const renderFiles = () => {
      const files = S.meetingFiles.filter((f) => f.meeting_id === m.id);
      fileList.replaceChildren(...(files.length ? files.map((f) =>
        h("div", { class: "reply", style: { gridTemplateColumns: "1fr auto", display: "grid", alignItems: "center" } },
          h("span", null, "📄 ", f.name, h("span", { class: "muted" }, ` · ${fmtSize(f.size)} · ${nameOf(f.uploaded_by)}`)),
          h("button", {
            class: "btn ghost sm danger", type: "button", onclick: async () => {
              const ok = await confirmModal({ title: "Supprimer ce fichier ?", body: f.name, confirm: "Supprimer", danger: true });
              if (!ok) return;
              await sb.storage.from(BUCKET).remove([f.path]);
              const { error } = await sb.from("meeting_files").delete().eq("id", f.id);
              if (error) return toast(friendlyError(error), true);
              await loadAll(); renderFiles(); render();
            },
          }, "Supprimer")))
        : [h("div", { class: "muted" }, "Aucun fichier.")]));
    };

    picker.addEventListener("change", async () => {
      const files = [...picker.files];
      picker.value = "";
      for (const [i, file] of files.entries()) {
        if (file.size > 20 * 1024 * 1024) { toast(`« ${file.name} » dépasse 20 Mo.`, true); continue; }
        status.textContent = `Envoi ${i + 1}/${files.length} : ${file.name}…`;
        const rid = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2)).slice(0, 13);
        const path = `${m.id}/${rid}-${safeFileName(file.name)}`;
        const up = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || "application/octet-stream" });
        if (up.error) { toast(`Échec de l'envoi de « ${file.name} » : ${friendlyError(up.error)}`, true); continue; }
        const { error } = await sb.from("meeting_files").insert({ meeting_id: m.id, name: file.name, path, size: file.size, mime: file.type || null });
        if (error) { await sb.storage.from(BUCKET).remove([path]); toast(friendlyError(error), true); }
      }
      status.textContent = "";
      await loadAll(); renderFiles(); render();
    });
    renderFiles();

    openModal((close) => {
      const save = h("button", { class: "btn primary" }, "Enregistrer le texte");
      save.addEventListener("click", async () => {
        save.disabled = true;
        const { error } = await sb.from("meetings").update({ minutes: text.value }).eq("id", m.id);
        save.disabled = false;
        if (error) return toast(friendlyError(error), true);
        close();
        toast("Compte rendu enregistré");
        await refresh();
      });
      return [
        h("h2", null, "Compte rendu"),
        h("div", { class: "muted" }, `${m.title} — ${fmtMeetingWhen(m)}`),
        h("div", { class: "field" }, "Texte", text,
          h("span", { class: "hint" }, "Écris ou colle le compte rendu ici, et/ou dépose le fichier du secrétaire ci-dessous.")),
        h("div", { class: "field" }, "Fichiers (Word, PDF… 20 Mo max)",
          fileList,
          h("div", { class: "chips" }, h("button", { class: "btn sm", type: "button", onclick: () => picker.click() }, "📎 Ajouter un fichier"), picker),
          status),
        h("div", { class: "modal-actions" }, h("button", { class: "btn", onclick: close }, "Fermer"), save),
      ];
    });
  }

  async function syncModal() {
    const box = h("div", { style: { display: "grid", gap: "12px" } }, h("div", { class: "muted" }, "Préparation de ton lien…"));
    openModal((close) => [
      h("h2", null, "📅 Synchroniser avec ton agenda"),
      h("p", { style: { margin: 0, color: "var(--ink-2)" } },
        "Abonne l'agenda de ton téléphone au calendrier du BDE : les réunions et événements que tu peux voir s'y ajoutent tout seuls, et les changements suivent."),
      box,
      h("div", { class: "modal-actions" }, h("button", { class: "btn", onclick: close }, "Fermer")),
    ]);

    const fill = (token) => {
      const https = `${CFG.SUPABASE_URL}/functions/v1/calendar?token=${token}`;
      const webcal = https.replace(/^https:/, "webcal:");
      const google = "https://calendar.google.com/calendar/render?cid=" + encodeURIComponent(webcal);
      box.replaceChildren(
        h("div", { class: "sync-grid" },
          h("a", { class: "btn primary", href: webcal }, "iPhone / iPad / Mac"),
          h("a", { class: "btn primary", href: google, target: "_blank", rel: "noopener" }, "Google Agenda (Android)"),
          h("button", {
            class: "btn", onclick: async () => {
              try { await navigator.clipboard.writeText(https); toast("Lien copié"); }
              catch (_) { prompt("Copie ce lien :", https); }
            },
          }, "Copier le lien")),
        h("div", { class: "hint", style: { display: "grid", gap: "6px" } },
          h("div", null, h("strong", null, "iPhone : "), "touche le bouton puis « S'abonner ». Les mises à jour arrivent toutes les heures environ (Réglages → Calendrier → Comptes → Récupération)."),
          h("div", null, h("strong", null, "Android : "), "touche « Google Agenda », connecte-toi puis « Ajouter ». Dans l'appli Agenda, va dans Paramètres → « BDE » et active la synchronisation. Google peut mettre quelques heures à afficher une nouvelle réunion."),
          h("div", null, h("strong", null, "Outlook ou autre : "), "« Ajouter un calendrier » → « À partir d'Internet » → colle le lien."),
          h("div", null, "Besoin d'une réunion tout de suite dans ton agenda ? Utilise « ＋ Mon agenda » sur la réunion.")),
        h("div", { class: "notice", style: { fontSize: "13px" } },
          "🔒 Ce lien est personnel : il donne accès à tes réunions. Ne le partage pas. ",
          h("button", {
            class: "linklike", style: { fontSize: "13px" }, onclick: async () => {
              const ok = await confirmModal({ title: "Réinitialiser ton lien ?", body: "L'ancien lien cessera de fonctionner : il faudra te réabonner sur tes appareils.", confirm: "Réinitialiser", danger: true });
              if (!ok) return;
              const { data, error } = await sb.rpc("reset_calendar_token");
              if (error) return toast(friendlyError(error), true);
              fill(data); toast("Nouveau lien créé");
            },
          }, "Réinitialiser le lien")));
    };

    const { data, error } = await sb.rpc("my_calendar_token");
    if (error) { box.replaceChildren(h("div", { class: "error-text" }, friendlyError(error))); return; }
    fill(data);
  }

  // ------------------------------------------------------------------
  // Vue : Discussions (questions & sondages)
  // ------------------------------------------------------------------
  function lastActivity(p) {
    const reps = S.replies.filter((r) => r.post_id === p.id);
    return reps.length ? reps[reps.length - 1].created_at : p.created_at;
  }

  function viewDiscussions() {
    const counts = {
      all: S.posts.length,
      sondage: S.posts.filter((p) => p.kind === "sondage").length,
      question: S.posts.filter((p) => p.kind === "question").length,
    };
    const list = S.posts
      .filter((p) => S.dFilter === "all" || p.kind === S.dFilter)
      .sort((a, b) => (a.closed - b.closed) || lastActivity(b).localeCompare(lastActivity(a)));

    return h("div", null,
      h("div", { class: "page-head" },
        h("div", null,
          h("h1", null, "Discussions"),
          h("div", { class: "sub" }, "Pose une question ou lance un sondage au bureau.")),
        h("div", { class: "chips" },
          h("button", { class: "btn", onclick: () => postForm("question") }, "+ Question"),
          h("button", { class: "btn primary", onclick: () => postForm("sondage") }, "+ Sondage"))),
      h("div", { class: "toolbar" },
        h("div", { class: "seg" }, [["all", "Tout"], ["sondage", "Sondages"], ["question", "Questions"]].map(([k, l]) =>
          h("button", { class: S.dFilter === k ? "on" : "", onclick: () => { S.dFilter = k; render(); } }, `${l} (${counts[k]})`)))),
      h("div", { class: "tasks", style: { gap: "14px" } },
        list.length ? list.map(postCard)
          : h("div", { class: "empty" }, "Rien pour l'instant. Lance la première discussion !")));
  }

  function audienceChips(p) {
    if (!p.audience.length) return [h("span", { class: "badge pole" }, "Tout le bureau")];
    return p.audience.map((pid) => {
      const pole = poleById(pid);
      return pole && h("span", { class: "badge pole" }, h("span", { class: "dot", style: { background: pole.color } }), pole.name);
    });
  }

  function postCard(p) {
    const isPoll = p.kind === "sondage";
    const isNew = postHasNews(p, S.seenAtOpen || getSeen());
    return h("article", { class: "post" + (p.closed ? " closed" : "") },
      h("div", { class: "post-head" },
        h("div", { class: "chips" },
          h("span", { class: "badge " + (isPoll ? "accent" : "ok") }, isPoll ? "🗳️ Sondage" : "💬 Question"),
          audienceChips(p),
          !p.replies_public && h("span", { class: "badge", title: "Réponses et résultats visibles uniquement par l'auteur et la présidence" }, "🔒 Réponses privées"),
          p.closed && h("span", { class: "badge" }, "Clos"),
          isNew && h("span", { class: "badge late" }, "Nouveau")),
        canManagePost(p) && h("div", { class: "task-actions" },
          h("button", { class: "btn ghost sm", onclick: () => toggleClosed(p) }, p.closed ? "Rouvrir" : "Clore"),
          h("button", { class: "btn ghost sm danger", onclick: () => deletePost(p) }, "Supprimer"))),
      h("h2", { class: "post-title" }, p.title),
      h("div", { class: "muted" }, `${nameOf(p.created_by)} · ${fmtDateTime(p.created_at)}`),
      p.body && h("div", { class: "task-desc" }, p.body),
      isPoll && pollBlock(p),
      repliesBlock(p));
  }

  function pollBlock(p) {
    const votes = S.votes.filter((v) => v.post_id === p.id);
    const mine = new Set(votes.filter((v) => v.user_id === S.user.id).map((v) => v.option_idx));
    const hasVoted = mine.size > 0;
    const showResults = canSeeAnswers(p) && (hasVoted || p.closed || canManagePost(p));
    const voting = !p.closed && (!hasVoted || S.pollEdit.has(p.id));
    const box = h("div", { class: "poll" });

    if (voting) {
      const type = p.allow_multiple ? "checkbox" : "radio";
      const inputs = p.options.map((_, i) => h("input", { type, name: "poll-" + p.id, value: i, checked: mine.has(i) }));
      const btn = h("button", { class: "btn primary sm" }, hasVoted ? "Enregistrer mon vote" : "Voter");
      btn.addEventListener("click", async () => {
        const chosen = inputs.filter((x) => x.checked).map((x) => Number(x.value));
        if (!chosen.length) return toast("Choisis au moins une réponse.", true);
        btn.disabled = true;
        const { error } = await sb.rpc("vote", { p_post: p.id, p_options: chosen });
        btn.disabled = false;
        if (error) return toast(friendlyError(error), true);
        S.pollEdit.delete(p.id);
        toast("Vote enregistré ✓");
        await refresh();
      });
      box.append(
        h("div", { class: "hint" }, p.allow_multiple ? "Plusieurs choix possibles" : "Un seul choix"),
        ...p.options.map((opt, i) => h("label", { class: "poll-choice" }, inputs[i], h("span", null, opt))),
        h("div", { class: "chips" }, btn,
          hasVoted && h("button", { class: "btn ghost sm", onclick: () => { S.pollEdit.delete(p.id); render(); } }, "Annuler")));
    }

    if (showResults) {
      const voters = new Set(votes.map((v) => v.user_id)).size;
      box.append(h("div", { class: "results" },
        p.options.map((opt, i) => {
          const who = votes.filter((v) => v.option_idx === i).map((v) => v.user_id);
          const pct = voters ? Math.round((who.length / voters) * 100) : 0;
          return h("div", { class: "result" + (mine.has(i) ? " mine" : "") },
            h("div", { class: "result-row" },
              h("span", null, mine.has(i) ? "✓ " : "", opt),
              h("span", { class: "muted" }, `${who.length} · ${pct} %`)),
            h("div", { class: "progress" }, h("span", { style: { width: pct + "%" } })),
            who.length > 0 && h("div", { class: "voters" }, who.map(nameOf).join(", ")));
        }),
        h("div", { class: "muted" }, `${voters} votant${voters > 1 ? "s" : ""}`)));
    } else if (hasVoted && !voting) {
      box.append(h("div", { class: "notice" },
        "Ton vote : ", h("strong", null, [...mine].map((i) => p.options[i]).join(", ")),
        !canSeeAnswers(p) && h("div", { class: "hint" }, "Les résultats sont visibles par l'auteur et la présidence.")));
    }

    if (hasVoted && !voting && !p.closed) {
      box.append(h("div", null, h("button", { class: "btn ghost sm", onclick: () => { S.pollEdit.add(p.id); render(); } }, "Modifier mon vote")));
    }
    return box;
  }

  function repliesBlock(p) {
    const isPoll = p.kind === "sondage";
    const all = S.replies.filter((r) => r.post_id === p.id);
    const privileged = canSeeAnswers(p);
    const expanded = S.expanded.has(p.id);
    const shown = expanded || all.length <= 3 ? all : all.slice(-3);
    const word = isPoll ? "commentaire" : "réponse";

    const thread = h("div", { class: "thread" },
      all.length > shown.length && h("button", { class: "linklike", onclick: () => { S.expanded.add(p.id); render(); } },
        `Voir les ${all.length - shown.length} ${word}s précédent${isPoll ? "s" : "es"}`),
      shown.map((r) => h("div", { class: "reply" },
        h("div", { class: "reply-head" },
          h("strong", null, nameOf(r.created_by)),
          h("span", { class: "muted" }, fmtDateTime(r.created_at)),
          (r.created_by === S.user.id || isAdmin()) && h("button", {
            class: "x", title: "Supprimer", onclick: async () => {
              const ok = await confirmModal({ title: "Supprimer ce message ?", confirm: "Supprimer", danger: true });
              if (!ok) return;
              const { error } = await sb.from("post_replies").delete().eq("id", r.id);
              if (error) return toast(friendlyError(error), true);
              await refresh();
            },
          }, "×")),
        h("div", { class: "task-desc" }, r.body))));

    let form = null;
    if (!p.closed) {
      const ta = h("textarea", {
        class: "input reply-input", rows: 2, maxlength: 4000,
        placeholder: isPoll ? "Ajouter un commentaire…" : "Écrire une réponse…",
        value: S.drafts[p.id] || "",
      });
      const send = h("button", { class: "btn primary sm" }, "Envoyer");
      const submit = async () => {
        const body = ta.value.trim();
        if (!body) return;
        send.disabled = true;
        const { error } = await sb.from("post_replies").insert({ post_id: p.id, body });
        send.disabled = false;
        if (error) return toast(friendlyError(error), true);
        delete S.drafts[p.id];
        ta.value = "";
        ta.blur();
        await refresh();
      };
      ta.addEventListener("input", () => { S.drafts[p.id] = ta.value; });
      ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
      send.addEventListener("click", submit);
      form = h("div", { class: "reply-form" }, ta, send);
    }

    const label = privileged
      ? (all.length ? `${all.length} ${word}${all.length > 1 ? "s" : ""}` : "")
      : (all.length ? `Ta ${word}${all.length > 1 ? "s" : ""}` : "");

    return h("div", { class: "replies" },
      label && h("div", { class: "group-label", style: { margin: "0" } }, label),
      !privileged && h("div", { class: "hint" }, `🔒 Ta ${word} ne sera visible que par toi, ${nameOf(p.created_by)} et la présidence.`),
      all.length > 0 && thread,
      form);
  }

  async function toggleClosed(p) {
    const { error } = await sb.from("posts").update({ closed: !p.closed }).eq("id", p.id);
    if (error) return toast(friendlyError(error), true);
    toast(p.closed ? "Rouvert" : "Clos : plus de réponses ni de votes");
    await refresh();
  }

  async function deletePost(p) {
    const ok = await confirmModal({ title: "Supprimer cette publication ?", body: "Les réponses et les votes seront supprimés aussi.", confirm: "Supprimer", danger: true });
    if (!ok) return;
    const { error } = await sb.from("posts").delete().eq("id", p.id);
    if (error) return toast(friendlyError(error), true);
    toast("Publication supprimée");
    await refresh();
  }

  function postForm(kind) {
    const isPoll = kind === "sondage";
    const title = h("input", { class: "input", required: true, maxlength: 200,
      placeholder: isPoll ? "Ex. Quel thème pour le gala ?" : "Ex. Qui est dispo jeudi pour installer la salle ?" });
    const body = h("textarea", { class: "input", maxlength: 4000, placeholder: "Détails (facultatif)" });

    // Choix du sondage
    const optBox = h("div", { style: { display: "grid", gap: "6px" } });
    const addOpt = (v = "") => {
      if (optBox.children.length >= 10) return toast("10 choix maximum.", true);
      const inp = h("input", { class: "input", maxlength: 120, value: v, placeholder: `Choix ${optBox.children.length + 1}` });
      const row = h("div", { class: "inline-form", style: { marginTop: 0, flexWrap: "nowrap" } }, inp,
        h("button", { class: "btn ghost sm", type: "button", onclick: () => { if (optBox.children.length > 2) row.remove(); } }, "×"));
      inp.style.width = "100%";
      optBox.append(row);
    };
    if (isPoll) { addOpt(); addOpt(); }
    const multi = h("input", { type: "checkbox" });

    // Audience
    const choosable = seesAll() ? S.poles : visiblePoles();
    const audAll = h("input", { type: "radio", name: "aud", checked: true });
    const audPoles = h("input", { type: "radio", name: "aud", disabled: !choosable.length });
    const poleBoxes = choosable.map((p) => ({ p, el: h("input", { type: "checkbox" }) }));
    const poleList = h("div", { class: "check-list", style: { display: "none" } },
      poleBoxes.map((b) => h("label", null, b.el, h("span", { class: "dot", style: { background: b.p.color } }), b.p.name)));
    const syncAud = () => { poleList.style.display = audPoles.checked ? "" : "none"; };
    audAll.addEventListener("change", syncAud);
    audPoles.addEventListener("change", syncAud);

    // Visibilité des réponses
    const vis = h("select", { class: "input" },
      h("option", { value: "public" }, isPoll ? "Tous ceux qui voient le sondage" : "Tous ceux qui voient la question"),
      h("option", { value: "private" }, "Seulement moi et la présidence"));

    const err = h("div", { class: "error-text" });

    openModal((close) => {
      const save = h("button", { class: "btn primary", type: "submit" }, "Publier");
      return [
        h("h2", null, isPoll ? "Nouveau sondage" : "Nouvelle question"),
        h("form", {
          onsubmit: async (e) => {
            e.preventDefault(); err.textContent = "";
            const payload = {
              kind,
              title: title.value.trim(),
              body: body.value.trim() || null,
              replies_public: vis.value === "public",
              audience: audPoles.checked ? poleBoxes.filter((b) => b.el.checked).map((b) => b.p.id) : [],
            };
            if (audPoles.checked && !payload.audience.length) { err.textContent = "Coche au moins un pôle."; return; }
            if (isPoll) {
              const opts = [...optBox.querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
              if (opts.length < 2) { err.textContent = "Il faut au moins deux choix."; return; }
              if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) { err.textContent = "Deux choix sont identiques."; return; }
              payload.options = opts;
              payload.allow_multiple = multi.checked;
            }
            save.disabled = true;
            const { error } = await sb.from("posts").insert(payload);
            save.disabled = false;
            if (error) { err.textContent = friendlyError(error); return; }
            close();
            toast(isPoll ? "Sondage publié" : "Question publiée");
            S.dFilter = "all";
            await refresh();
          },
        },
          h("label", { class: "field" }, isPoll ? "Question du sondage" : "Ta question", title),
          h("label", { class: "field" }, "Détails", body),
          isPoll && h("div", { class: "field" }, "Choix",
            optBox,
            h("div", { class: "chips" },
              h("button", { class: "btn sm", type: "button", onclick: () => addOpt() }, "+ Ajouter un choix"),
              h("label", { style: { display: "flex", gap: "6px", alignItems: "center", color: "var(--ink)", fontWeight: 400 } }, multi, "Plusieurs choix possibles"))),
          h("div", { class: "field" }, "Qui peut voir et répondre ?",
            h("label", { class: "radio-line" }, audAll, "Tout le bureau"),
            h("label", { class: "radio-line" }, audPoles, "Seulement certains pôles"),
            poleList),
          h("label", { class: "field" }, isPoll ? "Qui voit les résultats ?" : "Qui voit les réponses ?", vis,
            h("span", { class: "hint" }, "La présidence voit toujours tout.")),
          err,
          h("div", { class: "modal-actions" },
            h("button", { class: "btn", type: "button", onclick: close }, "Annuler"),
            save)),
      ];
    });
  }

  // ------------------------------------------------------------------
  // Vue : Mon compte
  // ------------------------------------------------------------------
  function viewAccount() {
    const name = h("input", { class: "input", value: S.me.full_name, maxlength: 60, style: { maxWidth: "320px" } });
    const mine = S.memberships.filter((m) => m.user_id === S.user.id);
    const joinable = S.poles.filter((p) => p.open_to_members && !myRole(p.id));

    return h("div", null,
      h("div", { class: "page-head" }, h("div", null, h("h1", null, "Mon compte"), h("div", { class: "sub" }, S.user.email))),
      h("div", { class: "card", style: { padding: "20px", display: "grid", gap: "14px" } },
        h("label", { class: "field" }, "Nom affiché", h("div", { class: "inline-form", style: { marginTop: 0 } }, name,
          h("button", {
            class: "btn", onclick: async () => {
              const v = name.value.trim();
              if (!v) return;
              const { error } = await sb.from("profiles").update({ full_name: v }).eq("id", S.user.id);
              if (error) return toast(friendlyError(error), true);
              toast("Nom mis à jour"); await refresh();
            },
          }, "Enregistrer"))),
        h("div", null, h("div", { class: "muted" }, "Rôle"), h("strong", null, S.me.title || globalRoleLabel(S.me.global_role)))),

      h("div", { class: "section" }, h("h2", null, "Mes pôles"),
        mine.length ? h("div", { class: "card activity" }, mine.map((m) => {
          const p = poleById(m.pole_id);
          return p && h("div", { class: "activity-row", style: { alignItems: "center" } },
            h("span", { class: "dot", style: { background: p.color } }),
            h("span", null, p.name),
            h("span", { class: "badge" + (m.role === "responsable" ? " accent" : "") }, m.role === "responsable" ? "Responsable" : "Lecture seule"),
            h("span", { style: { marginLeft: "auto" } }, m.role === "membre" && h("button", { class: "btn sm ghost danger", onclick: () => leavePole(p) }, "Quitter")));
        })) : h("div", { class: "empty" }, seesAll() ? "Ton rôle te donne accès à tous les pôles." : "Tu n'es dans aucun pôle pour l'instant.")),

      joinable.length > 0 && h("div", { class: "section" }, h("h2", null, "Suivre un pôle en lecture seule"),
        h("div", { class: "chips" }, joinable.map((p) => h("button", { class: "btn", onclick: () => joinPole(p) }, h("span", { class: "dot", style: { background: p.color } }), p.name))),
        h("p", { class: "hint" }, "Pour devenir responsable d'un pôle, demande à la présidence.")),

      h("div", { class: "section" }, h("button", {
        class: "btn", onclick: async () => {
          const { error } = await sb.auth.resetPasswordForEmail(S.user.email, { redirectTo: location.origin + location.pathname });
          toast(error ? friendlyError(error) : "Lien de changement de mot de passe envoyé par e-mail.", !!error);
        },
      }, "Changer mon mot de passe")));
  }

  // ------------------------------------------------------------------
  // Vue : Administration (présidence)
  // ------------------------------------------------------------------
  function viewAdmin() {
    const usersBox = h("div", { class: "card table-wrap" }, h("div", { class: "activity-row muted" }, "Chargement…"));
    sb.rpc("admin_list_users").then(({ data, error }) => {
      if (error) return usersBox.replaceChildren(h("div", { class: "activity-row error-text" }, friendlyError(error)));
      usersBox.replaceChildren(usersTable(data));
    });

    return h("div", null,
      h("div", { class: "page-head" }, h("div", null, h("h1", null, "Administration"),
        h("div", { class: "sub" }, "Attribue les rôles et les pôles de chaque compte."))),
      h("div", { class: "notice" },
        h("strong", null, "Rappel des rôles. "),
        "Présidence : voit et modifie tout. Vue d'ensemble : voit tout, sans rien modifier (idéal pour le secrétaire général). ",
        "Responsable d'un pôle : crée et coche les tâches de ce pôle. Membre : lecture seule."),
      h("div", { class: "section" }, h("h2", null, "Comptes"), usersBox),
      h("div", { class: "section" }, h("h2", null, "Pôles"), polesAdmin()));
  }

  function usersTable(users) {
    const rows = users.map((u) => {
      const mems = S.memberships.filter((m) => m.user_id === u.id);
      const roleSel = h("select", { class: "input", value: u.global_role, style: { minWidth: "190px" } },
        h("option", { value: "none" }, "Accès par pôle"),
        h("option", { value: "overview" }, "Vue d'ensemble (lecture)"),
        h("option", { value: "admin" }, "Présidence (tout)"));
      roleSel.addEventListener("change", async () => {
        const v = roleSel.value;
        if (v === "admin") {
          const ok = await confirmModal({ title: `Donner l'accès complet à ${u.full_name} ?`, body: "Il ou elle pourra tout voir (y compris la trésorerie), tout modifier et gérer les rôles.", confirm: "Confirmer" });
          if (!ok) { roleSel.value = u.global_role; return; }
        }
        const { error } = await sb.from("profiles").update({ global_role: v }).eq("id", u.id);
        if (error) { roleSel.value = u.global_role; return toast(friendlyError(error), true); }
        u.global_role = v; toast("Rôle mis à jour"); await loadAll();
        if (u.id === S.user.id) render();
      });

      const titleIn = h("input", { class: "input", value: u.title || "", placeholder: "Ex. Vice-président", maxlength: 60, style: { minWidth: "150px" } });
      titleIn.addEventListener("change", async () => {
        const { error } = await sb.from("profiles").update({ title: titleIn.value.trim() || null }).eq("id", u.id);
        if (error) return toast(friendlyError(error), true);
        toast("Titre enregistré"); await loadAll();
      });

      const poleSel = h("select", { class: "input" }, h("option", { value: "" }, "Ajouter un pôle…"),
        S.poles.filter((p) => !mems.some((m) => m.pole_id === p.id)).map((p) => h("option", { value: p.id }, p.name)));
      const roleNew = h("select", { class: "input" }, h("option", { value: "responsable" }, "Responsable"), h("option", { value: "membre" }, "Membre (lecture)"));
      const addBtn = h("button", {
        class: "btn sm", onclick: async () => {
          if (!poleSel.value) return;
          const { error } = await sb.from("memberships").insert({ user_id: u.id, pole_id: poleSel.value, role: roleNew.value });
          if (error) return toast(friendlyError(error), true);
          toast("Accès ajouté"); await loadAll(); usersBoxRefresh();
        },
      }, "Ajouter");

      return h("tr", null,
        h("td", null, h("strong", null, u.full_name || "—"), h("div", { class: "muted" }, u.email),
          h("div", { class: "muted" }, u.last_sign_in_at ? "Vu le " + fmtDateTime(u.last_sign_in_at) : "Jamais connecté")),
        h("td", null, roleSel),
        h("td", null, titleIn),
        h("td", null,
          mems.length ? mems.map((m) => {
            const p = poleById(m.pole_id);
            return h("span", { class: "member-chip" },
              h("span", { class: "dot", style: { background: p?.color } }), p?.name || m.pole_id,
              h("span", { class: "muted" }, m.role === "responsable" ? "· resp." : "· lecture"),
              h("button", {
                class: "x", title: "Retirer", onclick: async () => {
                  const ok = await confirmModal({ title: "Retirer l'accès ?", body: `${u.full_name} n'aura plus accès au pôle ${p?.name}.`, confirm: "Retirer", danger: true });
                  if (!ok) return;
                  const { error } = await sb.from("memberships").delete().eq("user_id", u.id).eq("pole_id", m.pole_id);
                  if (error) return toast(friendlyError(error), true);
                  await loadAll(); usersBoxRefresh();
                },
              }, "×"));
          }) : h("span", { class: "muted" }, "Aucun pôle"),
          h("div", { class: "inline-form" }, poleSel, roleNew, addBtn)));
    });

    return h("table", null,
      h("thead", null, h("tr", null, h("th", null, "Compte"), h("th", null, "Accès global"), h("th", null, "Titre"), h("th", null, "Pôles"))),
      h("tbody", null, rows));
  }

  function usersBoxRefresh() { if (S.view === "admin") render(); }

  function slugify(s) {
    const slug = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    return slug || "pole-" + Date.now();
  }

  function polesAdmin() {
    const rows = S.poles.map((p) => {
      const name = h("input", { class: "input", value: p.name, maxlength: 60 });
      const color = h("input", { type: "color", value: p.color, style: { width: "42px", height: "34px", border: 0, background: "none", padding: 0, cursor: "pointer" } });
      const open = h("input", { type: "checkbox", checked: p.open_to_members });
      const sort = h("input", { class: "input", type: "number", value: p.sort, style: { width: "80px" } });
      const save = async (patch) => {
        const { error } = await sb.from("poles").update(patch).eq("id", p.id);
        if (error) return toast(friendlyError(error), true);
        Object.assign(p, patch); toast("Pôle mis à jour"); render();
      };
      name.addEventListener("change", () => name.value.trim() && save({ name: name.value.trim() }));
      color.addEventListener("change", () => save({ color: color.value }));
      open.addEventListener("change", () => save({ open_to_members: open.checked }));
      sort.addEventListener("change", () => save({ sort: parseInt(sort.value, 10) || 0 }));
      const nb = S.tasks.filter((t) => t.pole_id === p.id).length;
      return h("tr", null,
        h("td", null, color),
        h("td", null, name, h("div", { class: "muted" }, `${nb} tâche${nb > 1 ? "s" : ""} · ${peopleLabel(polePeople(p.id).length)}`)),
        h("td", null, h("label", { style: { display: "flex", gap: "8px", alignItems: "center" } }, open, "Membres autorisés")),
        h("td", null, sort),
        h("td", null, h("button", {
          class: "btn sm ghost danger", onclick: async () => {
            const ok = await confirmModal({ title: `Supprimer le pôle ${p.name} ?`, body: `Ses ${nb} tâche(s) et tous les accès à ce pôle seront définitivement supprimés.`, confirm: "Supprimer définitivement", danger: true });
            if (!ok) return;
            const { error } = await sb.from("poles").delete().eq("id", p.id);
            if (error) return toast(friendlyError(error), true);
            toast("Pôle supprimé"); await refresh();
          },
        }, "Supprimer")));
    });

    const newName = h("input", { class: "input", placeholder: "Nom du nouveau pôle", maxlength: 60 });
    const newColor = h("input", { type: "color", value: "#0ea5e9", style: { width: "42px", height: "34px", border: 0, background: "none", padding: 0 } });
    const add = h("button", {
      class: "btn primary sm", onclick: async () => {
        const n = newName.value.trim();
        if (!n) return;
        let id = slugify(n);
        if (poleById(id)) id += "-" + Math.random().toString(36).slice(2, 6);
        const { error } = await sb.from("poles").insert({ id, name: n, color: newColor.value, sort: (Math.max(0, ...S.poles.map((p) => p.sort)) + 10) });
        if (error) return toast(friendlyError(error), true);
        toast("Pôle créé"); await refresh();
      },
    }, "Créer");

    return h("div", null,
      h("div", { class: "card table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, h("th", null, "Couleur"), h("th", null, "Nom"), h("th", null, "Inscription libre"), h("th", null, "Ordre"), h("th", null, ""))),
        h("tbody", null, rows))),
      h("p", { class: "hint" }, "« Membres autorisés » : n'importe quel compte peut suivre ce pôle en lecture seule. Laisse décoché pour Présidence et Trésorerie."),
      h("div", { class: "inline-form" }, newColor, newName, add));
  }
})();
