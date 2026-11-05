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
    view: "home",        // home | pole:<id> | events | account | admin
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
    const [poles, profiles, mems, tasks, events] = await Promise.all([
      sb.from("poles").select("*").order("sort").order("name"),
      sb.from("profiles").select("id, full_name, title, global_role"),
      sb.from("memberships").select("*"),
      sb.from("tasks").select("*"),
      sb.from("events").select("*"),
    ]);
    for (const r of [poles, profiles, mems, tasks, events]) if (r.error) throw r.error;
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
          if (S.view !== "admin" && S.view !== "account") render();
        } catch (_) { /* silencieux */ }
      }, 400);
    };
    channel = sb.channel("bde-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "events" }, onChange)
      .subscribe();
  }
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
      return h("div", null, head, onboarding());
    }

    // Cartes de progression par pôle
    const cards = h("div", { class: "grid" }, poles.map((p) => {
      const all = S.tasks.filter((t) => t.pole_id === p.id);
      const done = all.filter((t) => t.done).length;
      const late = all.filter(isLate).length;
      const pct = all.length ? Math.round((done / all.length) * 100) : 0;
      return h("button", { class: "pole-card", style: { "--c": p.color }, onclick: () => go("pole:" + p.id) },
        h("div", { class: "row" }, h("h3", null, p.name), accessLabel(p.id) && h("span", { class: "badge" }, accessLabel(p.id))),
        h("div", { class: "progress" }, h("span", { style: { width: pct + "%" } })),
        h("div", { class: "row" },
          h("span", { class: "muted" }, all.length ? `${done}/${all.length} faites` : "Aucune tâche"),
          late > 0 && h("span", { class: "badge late" }, `${late} en retard`)));
    }));

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
    const responsables = S.memberships.filter((m) => m.pole_id === id && m.role === "responsable").map((m) => nameOf(m.user_id));

    const seg = h("div", { class: "seg" }, [["todo", "À faire"], ["done", "Faites"], ["all", "Toutes"]].map(([k, l]) =>
      h("button", { class: S.filter === k ? "on" : "", onclick: () => { S.filter = k; render(); } }, `${l} (${counts[k]})`)));

    return h("div", null,
      h("div", { class: "page-head" },
        h("div", null,
          h("h1", null, h("span", { class: "dot", style: { background: p.color, width: "14px", height: "14px", display: "inline-block", marginRight: "10px", verticalAlign: "middle" } }), p.name),
          h("div", { class: "sub" },
            responsables.length ? `Responsable${responsables.length > 1 ? "s" : ""} : ${responsables.join(", ")}` : "Aucun responsable désigné",
            accessLabel(id) && " · ", accessLabel(id) && h("span", { class: "badge" }, accessLabel(id))))),
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
        h("td", null, name, h("div", { class: "muted" }, `${nb} tâche${nb > 1 ? "s" : ""}`)),
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
