// =====================================================================
//  BDE — Calendrier à abonnement (format iCalendar / .ics)
//
//  URL : https://<projet>.supabase.co/functions/v1/calendar?token=<lien perso>
//  Le jeton secret identifie la personne ; la base ne renvoie que les
//  réunions et événements qu'elle a le droit de voir (calendar_feed).
//  Déployée avec verify_jwt = false : les applis agenda n'envoient pas
//  de jeton de connexion, c'est le lien secret qui protège l'accès.
// =====================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://jkrfjasmhmlytchqjsbl.supabase.co";
const KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "sb_publishable_76sI7bFjfm7tk0nI3hQdSA_EmBhHD9v";

type Meeting = { id: string; title: string; starts_at: string; ends_at: string | null; location: string | null; agenda: string | null; updated_at: string };
type BdeEvent = { id: string; title: string; event_date: string; description: string | null };

const enc = new TextEncoder();

// Échappement des textes iCalendar
function esc(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Lignes de 75 octets max (règle iCalendar), sans couper un caractère accentué
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // les suites commencent par un espace
    if (bytes + b > limit) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const utc = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const day = (d: string) => d.replace(/-/g, "");
const nextDay = (d: string) => {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10).replace(/-/g, "");
};

function buildIcs(meetings: Meeting[], events: BdeEvent[]): string {
  const now = utc(new Date().toISOString());
  const L: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//BDE//Organisation//FR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:BDE",
    "X-WR-CALDESC:Réunions et événements du BDE",
    "X-WR-TIMEZONE:Europe/Paris",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];

  for (const m of meetings) {
    const start = m.starts_at;
    const end = m.ends_at ?? new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();
    L.push(
      "BEGIN:VEVENT",
      `UID:reunion-${m.id}@bde`,
      `DTSTAMP:${now}`,
      `LAST-MODIFIED:${utc(m.updated_at)}`,
      `DTSTART:${utc(start)}`,
      `DTEND:${utc(end)}`,
      `SUMMARY:${esc(m.title)}`,
    );
    if (m.location) L.push(`LOCATION:${esc(m.location)}`);
    L.push(`DESCRIPTION:${esc((m.agenda ? "Ordre du jour :\n" + m.agenda + "\n\n" : "") + "Réunion du BDE")}`);
    L.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${esc(m.title)}`,
      "TRIGGER:-PT1H",
      "END:VALARM",
      "END:VEVENT",
    );
  }

  for (const e of events) {
    L.push(
      "BEGIN:VEVENT",
      `UID:evenement-${e.id}@bde`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${day(e.event_date)}`,
      `DTEND;VALUE=DATE:${nextDay(e.event_date)}`,
      `SUMMARY:${esc("🎉 " + e.title)}`,
      `DESCRIPTION:${esc(e.description || "Événement du BDE")}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }

  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n") + "\r\n";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Méthode non autorisée", { status: 405 });
  }
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!/^[a-f0-9]{40,128}$/.test(token)) {
    return new Response("Lien de calendrier invalide", { status: 404 });
  }

  const headers: Record<string, string> = { apikey: KEY, "Content-Type": "application/json" };
  if (KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${KEY}`;

  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/calendar_feed`, {
    method: "POST",
    headers,
    body: JSON.stringify({ p_token: token }),
  });
  if (!r.ok) {
    return new Response("Calendrier momentanément indisponible", { status: 502 });
  }
  const data = await r.json();
  if (!data?.valid) {
    return new Response("Lien de calendrier invalide ou réinitialisé", { status: 404 });
  }

  const ics = buildIcs(data.meetings ?? [], data.events ?? []);
  return new Response(req.method === "HEAD" ? null : ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="bde.ics"',
      "Cache-Control": "private, max-age=300",
    },
  });
});
