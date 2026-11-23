// Redirection des QR codes : /q/ (QR des jetons) ou /q/?c=<code>
(function () {
  "use strict";
  var CFG = window.BDE_CONFIG || {};
  var msg = document.getElementById("msg");

  function show(title, text) {
    var t = document.createElement("p");
    t.style.fontWeight = "600";
    t.textContent = title;
    var s = document.createElement("p");
    s.className = "muted";
    s.textContent = text;
    msg.replaceChildren(t, s);
  }

  var params = new URLSearchParams(location.search);
  var code = (params.get("c") || "jetons").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "jetons";

  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) {
    show("QR code indisponible", "Le site n'est pas configuré.");
    return;
  }

  fetch(CFG.SUPABASE_URL + "/rest/v1/rpc/qr_resolve", {
    method: "POST",
    headers: { "apikey": CFG.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ p_id: code }),
    cache: "no-store",
  })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (url) {
      if (typeof url === "string" && /^https?:\/\/\S+$/i.test(url)) {
        location.replace(url);
      } else {
        show("Ce QR code n'est pas encore actif", "Reviens un peu plus tard !");
      }
    })
    .catch(function () {
      show("Connexion impossible", "Vérifie ta connexion internet puis réessaie.");
    });
})();
