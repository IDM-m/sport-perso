// ============================================================
// Sport — logique de l'application
// ============================================================

// Remplacé par le faux client de demo.js le temps d'une démo.
let sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const state = {
  user: null,
  exercices: [],
  profil: null,
  poidsHistorique: [],
  seancesSemaine: [],
  chartPoids: null,
  chartForce: null,
  muscuSeries: [], // lignes en cours de saisie pour la séance muscu
  circuitExos: [], // exercices en cours de saisie pour le circuit cardio
  activiteJour: null, // pas / calories de marche du jour (synchro Santé)
  seancesJour: [], // séances du jour (chargées une fois, réutilisées par le dashboard)
  nutritionJour: null, // calories / protéines / eau du jour (synchro Santé ou saisie manuelle)
  histoJours: { nutrition: [], activite: [], seances: [] }, // 8 derniers jours, pour le bilan de la semaine
  dernieresPerfs: {}, // { [exerciceId]: {date, sets:[{poids,reps,pause}]} | null } — cache "la dernière fois"
  reprises: [], // dernières séances de muscu (avec leurs séries), rechargeables d'un tap
  programme: [], // programme de la semaine : [{jour (1 = lundi), nom, orientation, muscu:[…], cardio}]
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------------- MÉMOIRE LOCALE (dernières valeurs, exercices récents, modèles) ----------------
// Sert uniquement à préremplir les formulaires pour aller plus vite — aucune donnée de séance.
const LS_LAST_SERIE = "sport_last_serie";     // { [exerciceId]: {reps, poidsKg, pauseSec} }
const LS_RECENT_EXOS = "sport_recent_exos";   // [exerciceId, ...] du plus récent au plus ancien
const LS_LAST_CARDIO = "sport_last_cardio";   // { exerciceId, duree }
const LS_TEMPLATES = "sport_templates";       // [{ name, series: [{exerciceId, reps, poidsKg, pauseSec}] }]
const LS_SEANCE_TYPE = "sport_seance_type";   // "cardio" | "circuit" | "muscu" : le dernier type de séance saisi
const LS_DRAFT_MUSCU = "sport_draft_muscu";   // { savedAt, series } — saisie muscu en cours, pour survivre à une fermeture de l'app

// Les clés portaient autrefois le préfixe "s90_" : on les recopie une fois sous le nouveau
// nom pour ne perdre ni les modèles ni un brouillon en cours.
(function migrerAnciennesCles() {
  try {
    for (const key of [LS_LAST_SERIE, LS_RECENT_EXOS, LS_LAST_CARDIO, LS_TEMPLATES, LS_SEANCE_TYPE, LS_DRAFT_MUSCU]) {
      const ancienne = key.replace(/^sport_/, "s90_");
      const valeur = localStorage.getItem(ancienne);
      if (valeur !== null && localStorage.getItem(key) === null) localStorage.setItem(key, valeur);
      localStorage.removeItem(ancienne);
    }
  } catch {}
})();

function getLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function setLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function showToast(msg) {
  const toast = $("#toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("is-visible");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("is-visible"), 1800);
}

// Formate une date en AAAA-MM-JJ selon l'heure LOCALE (pas UTC), pour éviter
// tout décalage de jour la nuit chez les utilisateurs en avance sur UTC (ex: France).
function toDateStr(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Date locale à minuit depuis "AAAA-MM-JJ" (new Date("AAAA-MM-JJ") serait interprété en UTC).
function dateDe(ds) {
  const [y, m, d] = String(ds).split("-").map(Number);
  return new Date(y, m - 1, d);
}

// ---------------- FORMATS ----------------
// Postgres renvoie ses numeric en texte ("112.60", "0.75000000000000000000") : on passe
// toujours par ici avant d'afficher.
function fmtKg(v, decimals = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}
// Accepte "112,4" comme "112.4" (clavier iOS français).
function parseDecimal(str) {
  const n = Number(String(str ?? "").trim().replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

// ---------------- AUTH ----------------

// Connexion par identifiant, sans email. Supabase Auth exige une adresse : l'identifiant est
// donc converti en adresse factice sur un domaine réservé (.invalid, RFC 2606), qui ne reçoit
// jamais rien. Un identifiant contenant « @ » est pris tel quel.
// Les inscriptions sont fermées (trigger bloquer_inscriptions sur auth.users) : un seul compte,
// celui du propriétaire ; les visiteurs passent par la démo.
const DOMAINE_IDENTIFIANT = "sport.invalid";

function normaliserIdentifiant(brut) {
  return String(brut || "").trim().toLowerCase();
}
function identifiantVersEmail(id) {
  return id.includes("@") ? id : `${id}@${DOMAINE_IDENTIFIANT}`;
}
function estCompteDemo(user) {
  return !!user?.is_demo;
}

// Les messages de Supabase sont en anglais et parlent d'email : on les traduit en termes d'identifiant.
function messageAuth(error) {
  const m = String(error?.message || "");
  if (/invalid login credentials/i.test(m)) return "Identifiant ou mot de passe incorrect.";
  if (/password should be at least/i.test(m)) return "Le mot de passe doit faire au moins 6 caractères.";
  if (/same.*password|different from the old/i.test(m)) return "C'est déjà ton mot de passe actuel.";
  if (/rate limit|too many/i.test(m)) return "Trop de tentatives, réessaie dans quelques minutes.";
  return m || "Erreur inattendue, réessaie.";
}

$("#auth-password-toggle").addEventListener("click", () => {
  const input = $("#auth-password");
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  $("#auth-password-toggle").setAttribute("aria-pressed", String(!showing));
  $("#auth-password-toggle").setAttribute("aria-label", showing ? "Afficher le mot de passe" : "Masquer le mot de passe");
  $("#auth-password-toggle").textContent = showing ? "👁" : "🙈";
});

function setAuthError(message) {
  $("#auth-error").textContent = message || "";
  $("#auth-error").hidden = !message;
  $("#auth-id").setAttribute("aria-invalid", String(!!message));
  $("#auth-password").setAttribute("aria-invalid", String(!!message));
}

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = normaliserIdentifiant($("#auth-id").value);
  const password = $("#auth-password").value;
  setAuthError(null);

  $("#auth-submit").disabled = true;
  const { data, error } = await sb.auth.signInWithPassword({ email: identifiantVersEmail(id), password });
  $("#auth-submit").disabled = false;

  if (error) { setAuthError(messageAuth(error)); return; }
  await onAuthed(data.session.user);
});

// ---------------- MOT DE PASSE (Profil) ----------------
// Sans email de récupération, c'est le seul moyen d'en changer : il faut être connecté.

$("#mdp-save").addEventListener("click", async () => {
  const nouveau = $("#mdp-nouveau").value;
  const result = $("#mdp-result");
  const afficher = (texte, erreur) => {
    result.hidden = false;
    result.textContent = texte;
    result.classList.toggle("is-error", erreur);
  };
  if (state.user?.is_demo) return afficher("Pas de changement de mot de passe dans la démo.", true);
  if (nouveau.length < 6) return afficher("Au moins 6 caractères.", true);
  if (nouveau !== $("#mdp-confirmation").value) return afficher("Les deux mots de passe ne correspondent pas.", true);

  $("#mdp-save").disabled = true;
  const { error } = await sb.auth.updateUser({ password: nouveau });
  $("#mdp-save").disabled = false;
  if (error) return afficher(messageAuth(error), true);
  $("#mdp-nouveau").value = "";
  $("#mdp-confirmation").value = "";
  afficher("Mot de passe changé ✓ Il servira à ta prochaine connexion.", false);
});

// ---------------- DÉMO ----------------
// Tout se passe dans le navigateur (demo.js) : pas de compte, pas d'attente, rien d'écrit en
// base. Un lien en « ?demo » l'ouvre directement ; recharger la page relance une démo neuve.
// (L'ancienne démo créait un compte Supabase jetable, que la confirmation par email bloquait.)
const LS_DEMO = "sport_demo"; // sessionStorage : la démo survit à un rechargement de l'onglet

async function lancerDemo() {
  sb = creerClientDemo();
  try { sessionStorage.setItem(LS_DEMO, "1"); } catch {}
  await onAuthed(DEMO_USER);
  showToast("Démo : 10 semaines de données fictives");
}
$("#auth-demo").addEventListener("click", lancerDemo);

async function deconnecter() {
  if (state.user?.is_demo) {
    try { sessionStorage.removeItem(LS_DEMO); } catch {}
    history.replaceState(null, "", location.pathname); // retire « ?demo », sinon la page relancerait la démo
  } else {
    await sb.auth.signOut();
  }
  location.reload();
}
$("#logout-btn").addEventListener("click", deconnecter);
$("#demo-exit").addEventListener("click", deconnecter);

// ---------------- INSTALLATION (PWA) ----------------
// Chrome / Edge signalent par « beforeinstallprompt » que l'app peut s'installer : on garde
// l'événement et on affiche nos boutons « Installer », qui ouvrent la fenêtre d'installation.
// Safari (iPhone) n'a pas cet événement : là, c'est Partager → Sur l'écran d'accueil.
let invitationInstall = null;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  invitationInstall = e;
  $("#install-btn").hidden = false;
  $("#auth-install").hidden = false;
});
window.addEventListener("appinstalled", () => {
  invitationInstall = null;
  $("#install-btn").hidden = true;
  $("#auth-install").hidden = true;
  showToast("Application installée ✓");
});

async function installer() {
  if (!invitationInstall) return;
  invitationInstall.prompt();
  await invitationInstall.userChoice;
  invitationInstall = null;
  $("#install-btn").hidden = true;
  $("#auth-install").hidden = true;
}
$("#install-btn").addEventListener("click", installer);
$("#auth-install").addEventListener("click", installer);

// Raccourcis de l'icône installée (« Nouvelle séance », « Pesée ») : ?tab=… ouvre l'onglet voulu.
const ONGLET_DEMANDE = new URLSearchParams(location.search).get("tab");

async function onAuthed(user) {
  state.user = user;
  $("#auth-screen").hidden = true;
  $("#app").hidden = false;
  $("#demo-banner").hidden = !estCompteDemo(user);
  await loadExercices();
  await Promise.all([loadProfil(), loadProgramme()]);
  renderTemplateSelect();
  renderCircuitBlocks();
  await refreshAll();
  goToTab(ONGLET_DEMANDE && $(`#view-${ONGLET_DEMANDE}`) ? ONGLET_DEMANDE : "dashboard");
}

(async function init() {
  let demo = new URLSearchParams(location.search).has("demo");
  try { demo ||= sessionStorage.getItem(LS_DEMO) === "1"; } catch {}
  if (demo) { await lancerDemo(); return; }
  const { data } = await sb.auth.getSession();
  if (!data.session) return;
  // La session locale peut survivre à son compte (démo effacée après 24 h) : on la fait
  // valider par le serveur avant d'ouvrir l'app. Seul un refus explicite (4xx) déconnecte :
  // hors ligne, on garde la session telle quelle.
  const { data: u, error } = await sb.auth.getUser();
  if (error?.status >= 400 && error.status < 500) { await sb.auth.signOut({ scope: "local" }); return; }
  await onAuthed(u?.user || data.session.user);
})();

// ---------------- NAVIGATION ----------------

const TABS_PLUS = ["nutrition", "force", "profil"]; // rangés derrière « Plus » sur mobile

function goToTab(tab) {
  $$(".tab-btn").forEach((b) => {
    const active = b.dataset.tab === tab;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", String(active));
  });
  $$(".bn-btn").forEach((b) => {
    const active = b.dataset.tab ? b.dataset.tab === tab : TABS_PLUS.includes(tab);
    b.classList.toggle("is-active", active);
  });
  fermerPlus();
  $$(".view").forEach((v) => v.classList.remove("is-active"));
  $(`#view-${tab}`).classList.add("is-active");
  $("#fab-seance").hidden = tab === "seance";
  if (tab === "historique") { renderHeatmap(); renderHistoSeances(); }
  if (tab === "force") renderForceChart();
  if (tab === "dashboard") renderWeightChart(); // le canvas est masqué par défaut, il faut le redessiner à l'ouverture
  if (tab === "poids") {
    const input = $("#poids-input");
    if (!input.value && dernierPoids()) input.value = String(dernierPoids());
  }
}

function fermerPlus() {
  $("#more-sheet").hidden = true;
  $("#bn-more").setAttribute("aria-expanded", "false");
}

$("#bottom-nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".bn-btn");
  if (!btn) return;
  if (btn.id === "bn-more") {
    const ouvert = !$("#more-sheet").hidden;
    $("#more-sheet").hidden = ouvert;
    btn.setAttribute("aria-expanded", String(!ouvert));
    return;
  }
  goToTab(btn.dataset.tab);
});
$("#more-sheet").addEventListener("click", (e) => {
  const btn = e.target.closest(".ms-btn");
  if (btn) goToTab(btn.dataset.tab);
});
document.addEventListener("click", (e) => {
  if (!$("#more-sheet").hidden && !e.target.closest("#more-sheet, #bn-more")) fermerPlus();
});

$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  goToTab(btn.dataset.tab);
});

$("#fab-seance").addEventListener("click", () => goToTab("seance"));

// ---------------- CATALOGUE EXERCICES ----------------

let cardioPrevValue = "";

// Chaque compte a son propre catalogue (RLS par user_id). Un compte neuf reçoit une copie du
// catalogue de départ (table exercices_modele) au premier chargement.
async function loadExercices() {
  const lire = () => sb.from("exercices").select("*").order("nom");
  let { data, error } = await lire();
  if (!error && !data.length) {
    await sb.rpc("init_exercices");
    ({ data, error } = await lire());
  }
  if (error) { console.error(error); return; }
  state.exercices = data;
  renderAllExerciceSelects();
}

function renderAllExerciceSelects() {
  renderCardioSelect();
  renderForceSelect();
  renderMuscuAddSelect();
  renderCircuitAddSelect();
}

// Sélecteur cardio : "+ Nouvel exercice" puis groupé Cardio / Mixte (full body)
function renderCardioSelect() {
  const cardio = state.exercices.filter((x) => x.type === "cardio");
  const mixte = state.exercices.filter((x) => x.type === "mixte");
  const sel = $("#cardio-exercice");
  sel.innerHTML =
    `<option value="__new__">+ Nouvel exercice…</option>` +
    (cardio.length ? `<optgroup label="Cardio">${cardio.map((x) => `<option value="${x.id}" data-met="${x.met}">${x.nom}</option>`).join("")}</optgroup>` : "") +
    (mixte.length ? `<optgroup label="Mixte / Full body">${mixte.map((x) => `<option value="${x.id}" data-met="${x.met}">${x.nom}</option>`).join("")}</optgroup>` : "");

  // Préremplit avec le dernier exercice cardio utilisé pour aller plus vite
  const lastCardio = getLS(LS_LAST_CARDIO, null);
  if (lastCardio && [...sel.options].some((o) => o.value === lastCardio.exerciceId)) {
    sel.value = lastCardio.exerciceId;
    cardioPrevValue = lastCardio.exerciceId;
    if (lastCardio.duree) $("#cardio-duree").value = lastCardio.duree;
  } else if (![...sel.options].some((o) => o.value === cardioPrevValue)) {
    cardioPrevValue = "__new__";
  }
  updateCardioCalc();
}

// Sélecteur "Progression de force" : groupé par groupe musculaire, muscu uniquement
function renderForceSelect() {
  const muscu = state.exercices.filter((x) => x.type === "muscu");
  $("#force-exercice").innerHTML = muscu.length
    ? optgroupsParGroupeMusculaire(muscu)
    : `<option value="">Aucun exercice pour l'instant</option>`;
}

function renderMuscuAddSelect() {
  const muscu = state.exercices.filter((x) => x.type === "muscu");
  $("#muscu-add-exercice-select").innerHTML =
    `<option value="">+ Ajouter un exercice…</option>` +
    `<option value="__new__">+ Nouvel exercice…</option>` +
    serieExerciceOptions(muscu);
}

// Circuit : tous types confondus (mouvements au poids du corps, cardio, mixte…)
function renderCircuitAddSelect() {
  $("#circuit-add-exercice-select").innerHTML =
    `<option value="">+ Ajouter un exercice…</option>` +
    `<option value="__new__">+ Nouvel exercice…</option>` +
    serieExerciceOptions(state.exercices);
}

const LABELS_GROUPE = {
  pecs: "Pecs", dos: "Dos", epaules: "Épaules",
  biceps: "Biceps", triceps: "Triceps", avant_bras: "Avant-bras", bras: "Bras",
  jambes: "Jambes", fessiers: "Fessiers", abdos: "Abdos", full_body: "Full body",
};

function optgroupsParGroupeMusculaire(liste, selectedId) {
  const groupes = {};
  liste.forEach((x) => {
    const g = x.groupe_musculaire || "autre";
    (groupes[g] = groupes[g] || []).push(x);
  });
  // "bras" n'est plus proposé à la saisie (éclaté en biceps/triceps/avant_bras),
  // mais reste listé pour qu'un ancien exercice ne disparaisse jamais du sélecteur.
  const ordre = ["pecs", "dos", "epaules", "biceps", "triceps", "avant_bras", "bras", "jambes", "fessiers", "abdos", "full_body"];
  return ordre.filter((g) => groupes[g]).map((g) =>
    `<optgroup label="${LABELS_GROUPE[g] || g}">${groupes[g].map((x) =>
      `<option value="${x.id}" ${x.id === selectedId ? "selected" : ""}>${x.nom}</option>`
    ).join("")}</optgroup>`
  ).join("");
}

// Ajoute un groupe "Récents" en tête de liste pour éviter de scroller dans tout le catalogue
function serieExerciceOptions(muscu, selectedId) {
  const recentIds = getLS(LS_RECENT_EXOS, []);
  const recents = recentIds.map((id) => muscu.find((x) => x.id === id)).filter(Boolean).slice(0, 6);
  const recentsHtml = recents.length
    ? `<optgroup label="Récents">${recents.map((x) =>
        `<option value="${x.id}" ${x.id === selectedId ? "selected" : ""}>${x.nom}</option>`
      ).join("")}</optgroup>`
    : "";
  return recentsHtml + optgroupsParGroupeMusculaire(muscu, selectedId);
}

// ---------------- NOUVEL EXERCICE (panneau partagé) ----------------
// Déclenché depuis n'importe lequel des 3 sélecteurs d'exercice ("+ Nouvel exercice…").
// newExoContext se souvient de qui a ouvert le panneau pour savoir quoi faire après l'ajout.
let newExoContext = null; // "cardio" | "muscu-add" | "circuit-add"

function openNewExoForm(context, defaultType) {
  newExoContext = context;
  $("#new-exo-nom").value = "";
  $("#new-exo-type").value = defaultType || "muscu";
  $("#new-exo-met").value = 5;
  $("#new-exercice-form").hidden = false;
  $("#new-exo-nom").focus();
}

function closeNewExoForm() {
  $("#new-exercice-form").hidden = true;
  newExoContext = null;
}

function cancelNewExo() {
  if (newExoContext === "cardio") $("#cardio-exercice").value = cardioPrevValue;
  if (newExoContext === "muscu-add") $("#muscu-add-exercice-select").value = "";
  if (newExoContext === "circuit-add") $("#circuit-add-exercice-select").value = "";
  closeNewExoForm();
}

$("#new-exo-cancel").addEventListener("click", cancelNewExo);

$("#new-exo-save").addEventListener("click", async () => {
  const nom = $("#new-exo-nom").value.trim();
  if (!nom) { $("#new-exo-nom").focus(); return; }
  const type = $("#new-exo-type").value;
  const groupe = $("#new-exo-groupe").value;
  const met = Number($("#new-exo-met").value) || 5;

  const { data, error } = await sb.from("exercices").insert({ user_id: state.user.id, nom, type, groupe_musculaire: groupe, met }).select().single();
  if (error) { showToast("Erreur : " + error.message); return; }

  state.exercices.push(data);
  state.exercices.sort((a, b) => a.nom.localeCompare(b.nom));

  const ctx = newExoContext;
  closeNewExoForm();
  showToast("Exercice ajouté ✓");
  renderAllExerciceSelects();

  if (ctx === "cardio") {
    $("#cardio-exercice").value = data.id;
    cardioPrevValue = data.id;
    updateCardioCalc();
  } else if (ctx === "muscu-add") {
    addMuscuBlock(data.id);
  } else if (ctx === "circuit-add") {
    addCircuitExo(data.id);
  }
});

// ---------------- PROFIL ----------------

async function loadProfil() {
  const { data } = await sb.from("profil").select("*").eq("user_id", state.user.id).maybeSingle();
  state.profil = data;
  if (data) {
    $("#profil-age").value = data.age ?? "";
    $("#profil-taille").value = data.taille_cm ?? "";
    $("#profil-sexe").value = data.sexe ?? "homme";
    $("#profil-depart").value = data.poids_depart_kg != null ? fmtKg(data.poids_depart_kg) : "";
    $("#profil-objectif").value = data.poids_objectif_kg != null ? fmtKg(data.poids_objectif_kg) : "";
    $("#profil-deficit").value = data.objectif_deficit_kcal ?? 500;
    $("#profil-seances").value = data.objectif_seances_semaine ?? SEANCES_SEMAINE_DEFAUT;
    $("#profil-activite").value = data.facteur_activite ?? 1.2;
    if (data.api_key) {
      $("#profil-api-key").textContent = data.api_key;
      renderShortcutConfig(data.api_key);
    }
  }
  $("#hdr-poids-objectif").textContent = poidsObjectif() ? fmtKg(poidsObjectif()) : "—";
}

// Départ et objectif viennent du Profil. Tant qu'ils manquent (nouveau compte), les cartes qui
// en dépendent invitent à compléter le profil plutôt que d'afficher une valeur inventée.
const SEANCES_SEMAINE_DEFAUT = 4;

function poidsObjectif() {
  const v = Number(state.profil?.poids_objectif_kg);
  return v > 0 ? v : null;
}

// Départ du parcours : celui du Profil, sinon la première pesée enregistrée.
function poidsDepart() {
  const v = Number(state.profil?.poids_depart_kg);
  if (v > 0) return v;
  const premiere = Number(state.poidsHistorique[0]?.valeur_kg);
  return premiere > 0 ? premiere : null;
}

function profilComplet() {
  const p = state.profil;
  return !!(p && p.age && p.taille_cm && poidsObjectif());
}

function renderProfilHint() {
  $("#profil-hint").hidden = profilComplet();
}
$("#profil-hint-btn").addEventListener("click", () => goToTab("profil"));

// ---------------- RACCOURCI iOS « Sync du jour » ----------------
// Affiche les valeurs exactes à recopier dans l'action « Obtenir le contenu de l'URL ».
// upsert_jour couvre nutrition et activité (toutes deux lues dans Santé) en un seul appel :
// un seul raccourci à maintenir sur le téléphone.

function renderShortcutConfig(apiKey) {
  $("#sc-url").textContent = `${SUPABASE_URL}/rest/v1/rpc/upsert_jour`;
  $("#sc-anon").textContent = SUPABASE_ANON_KEY;
  $("#sc-key").textContent = apiKey;
}

$$(".btn-copy").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const texte = $(`#${btn.dataset.copy}`)?.textContent?.trim();
    if (!texte || texte === "—") return;
    try {
      await navigator.clipboard.writeText(texte);
      const avant = btn.textContent;
      btn.textContent = "Copié ✓";
      setTimeout(() => (btn.textContent = avant), 1500);
    } catch {
      showToast("Copie impossible — sélectionne le texte à la main");
    }
  });
});

// Test de bout en bout du raccourci : appelle la RPC avec la seule clé, sans aucune valeur.
// Sans mesure, upsert_jour n'écrit dans aucune des deux tables : rien du jour n'est touché.
$("#sc-test").addEventListener("click", async () => {
  const apiKey = state.profil?.api_key;
  const result = $("#sc-test-result");
  result.hidden = false;
  if (state.user?.is_demo) {
    result.textContent = "Pas de synchronisation dans la démo : les données Santé y sont fictives.";
    result.classList.add("is-error");
    return;
  }
  result.textContent = "Test en cours…";
  result.classList.remove("is-error");

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_jour`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_api_key: apiKey }),
    });
    if (r.ok) {
      result.textContent = "Connexion OK ✓ — le raccourci pourra envoyer tes données.";
    } else {
      result.classList.add("is-error");
      result.textContent = `Échec (${r.status}) : ${await r.text()}`;
    }
  } catch (e) {
    result.classList.add("is-error");
    result.textContent = `Échec réseau : ${e.message}`;
  }
});

$("#profil-save").addEventListener("click", async () => {
  const objectif = parseDecimal($("#profil-objectif").value);
  if (!(objectif >= 30 && objectif <= 300)) {
    showToast("Renseigne ton poids objectif (30 à 300 kg)");
    $("#profil-objectif").focus();
    return;
  }
  // Départ laissé vide : on part de la première pesée ; sans aucune pesée, il faut le saisir.
  const departSaisi = parseDecimal($("#profil-depart").value);
  const depart = departSaisi > 0 ? departSaisi : Number(state.poidsHistorique[0]?.valeur_kg) || null;
  if (!(depart >= 30 && depart <= 300)) {
    showToast("Renseigne ton poids de départ (30 à 300 kg)");
    $("#profil-depart").focus();
    return;
  }
  const payload = {
    user_id: state.user.id,
    age: Number($("#profil-age").value) || null,
    taille_cm: Number($("#profil-taille").value) || null,
    sexe: $("#profil-sexe").value,
    poids_depart_kg: depart,
    poids_objectif_kg: objectif,
    objectif_deficit_kcal: Math.min(DEFICIT_MAX, Number($("#profil-deficit").value) || 500),
    objectif_seances_semaine: Number($("#profil-seances").value) || SEANCES_SEMAINE_DEFAUT,
    facteur_activite: Number($("#profil-activite").value) || 1.2,
    updated_at: new Date().toISOString(),
  };
  if (Number($("#profil-deficit").value) > DEFICIT_MAX) {
    showToast(`Déficit plafonné à ${DEFICIT_MAX} kcal/j — au-delà, le budget tomberait sous ton métabolisme`);
  }
  const { error } = await sb.from("profil").upsert(payload);
  if (error) { showToast("Erreur : " + error.message); return; }
  // Relecture plutôt que state.profil = payload : la ligne en base contient aussi
  // api_key (générée côté serveur), nécessaire au raccourci iOS.
  await loadProfil();
  $("#profil-saved").hidden = false;
  setTimeout(() => ($("#profil-saved").hidden = true), 2000);
  await refreshAll();
});

function bmr(poidsKg = dernierPoids()) {
  const p = state.profil;
  const poids = Number(poidsKg);
  if (!p || !p.age || !p.taille_cm || !poids) return null;
  const base = 10 * poids + 6.25 * p.taille_cm - 5 * p.age;
  return p.sexe === "femme" ? base - 161 : base + 5;
}

// ---------------- ACTIVITÉ DU JOUR : marche + sport, une seule source ----------------
// « Énergie active » de Santé couvre TOUTE l'activité de la journée, séances comprises.
// Pour ne jamais compter deux fois :
//   marche = pas × poids × KCAL_PAR_PAS_PAR_KG, bornée par l'énergie active mesurée
//   autre  = énergie active − marche : ce que Santé a capté en plus (la séance, le vélo…)
//   sport  = max(séances enregistrées dans l'app, autre)
// Si Santé a capté la séance, on garde sa mesure ; s'il l'a ratée (téléphone posé sur le
// banc), on garde l'estimation de l'app. Jamais l'addition des deux.
// Sans synchro Santé, la marche retombe sur le facteur d'activité du Profil (estimation).
const KCAL_PAR_PAS_PAR_KG = 0.0004; // ≈ 0,03 kcal/pas à 75 kg, 0,04 à 100 kg : l'ordre de grandeur mesuré par Santé
const AUTRE_SEUIL_KCAL = 30; // en dessous, l'écart énergie active − marche n'est que du bruit
// Un consommé sous ce seuil (en kcal) trahit une journée à moitié saisie, pas un jeûne :
// le jour est marqué « partiel ? » et exclu de la moyenne, sinon il gonflerait le déficit.
const CONSOMME_MIN_PLAUSIBLE = 800;

function activiteDuJour(activite, kcalSeances, poidsKg, facteur = state.profil?.facteur_activite ?? 1.2) {
  const actif = activite?.calories_marche != null ? Number(activite.calories_marche) : null;
  const pas = activite?.pas != null ? Number(activite.pas) : null;
  if (actif != null && pas != null) {
    let marche = Math.min(actif, pas * poidsKg * KCAL_PAR_PAS_PAR_KG);
    let autre = Math.max(0, actif - marche);
    // Sans séance enregistrée, quelques kcal d'écart ne sont que du bruit de mesure : tout est marche.
    if (kcalSeances === 0 && autre < AUTRE_SEUIL_KCAL) { marche = actif; autre = 0; }
    const sport = Math.max(kcalSeances, autre);
    return { source: "sante", marche, sport, total: marche + sport, pas, actif, autre, kcalSeances };
  }
  if (actif != null) {
    return { source: "sante_sans_pas", marche: actif, sport: kcalSeances, total: actif + kcalSeances, pas: null, actif, autre: null, kcalSeances };
  }
  const marche = (bmr(poidsKg) || 0) * (facteur - 1);
  return { source: "estimation", marche, sport: kcalSeances, total: marche + kcalSeances, pas: null, actif: null, autre: null, kcalSeances };
}

// Bilan calorique d'une journée. `consomme` reste null tant que rien n'a été reçu ni saisi :
// un jour sans donnée n'est jamais un jour à 0 kcal, il est simplement incomplet.
function bilanJour({ nutrition, activite, seances, poidsKg }) {
  const base = bmr(poidsKg) || 0;
  const kcalSeances = (seances || [])
    .filter((s) => s.statut === "faite")
    .reduce((s, x) => s + Number(x.calories_brulees || 0), 0);
  const act = activiteDuJour(activite, kcalSeances, poidsKg);
  const brule = base + act.total;
  const consomme = nutrition?.calories != null ? Number(nutrition.calories) : null;
  const objectif = objectifDeficit();
  const budget = Math.max(brule - objectif, base); // plancher de sécurité : jamais sous le métabolisme de base
  return {
    base, act, brule, consomme, objectif, budget,
    budgetPlancher: brule - objectif < base,
    complet: consomme != null,
    partiel: consomme != null && consomme < CONSOMME_MIN_PLAUSIBLE,
    deficit: consomme == null ? null : brule - consomme,
  };
}

// Nutrition, activité et séances des 8 derniers jours en trois requêtes : le jour courant
// en est extrait, le reste sert au bilan « 7 derniers jours ».
async function loadHistoJours() {
  const debut = new Date();
  debut.setDate(debut.getDate() - 7);
  const dStr = toDateStr(debut);
  const [n, a, s] = await Promise.all([
    sb.from("nutrition_jour").select("*").eq("user_id", state.user.id).gte("date", dStr),
    sb.from("activite_jour").select("*").eq("user_id", state.user.id).gte("date", dStr),
    sb.from("seances").select("*").eq("user_id", state.user.id).eq("statut", "faite").gte("date", dStr),
  ]);
  state.histoJours = { nutrition: n.data || [], activite: a.data || [], seances: s.data || [] };
  const today = toDateStr();
  state.activiteJour = state.histoJours.activite.find((x) => x.date === today) || null;
  state.nutritionJour = state.histoJours.nutrition.find((x) => x.date === today) || null;
}

// ---------------- POIDS ----------------

function dernierPoids() {
  if (!state.poidsHistorique.length) return null;
  return Number(state.poidsHistorique[state.poidsHistorique.length - 1].valeur_kg);
}

// Dernière pesée connue à une date donnée (pour le BMR des jours passés).
function poidsADate(dateStr) {
  let last = null;
  for (const p of state.poidsHistorique) {
    if (p.date <= dateStr) last = p.valeur_kg; else break;
  }
  return Number(last ?? state.poidsHistorique[0]?.valeur_kg ?? 80);
}

// Moyenne des pesées sur la fenêtre [fin − jours + 1, fin] ; null si aucune.
function moyennePoids(finStr, jours = 7) {
  const debut = dateDe(finStr); debut.setDate(debut.getDate() - (jours - 1));
  const debutStr = toDateStr(debut);
  const vals = state.poidsHistorique.filter((p) => p.date >= debutStr && p.date <= finStr).map((p) => Number(p.valeur_kg));
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
}

async function loadPoids() {
  const { data } = await sb.from("poids").select("*").eq("user_id", state.user.id).order("date");
  state.poidsHistorique = data || [];
  $("#hdr-poids-actuel").textContent = fmtKg(dernierPoids());
}

$("#poids-input").addEventListener("focus", (e) => e.target.select());
$("#poids-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("#poids-save").click(); }
});

// Une pesée par jour (index unique user + date) : ressaisir remplace celle du jour.
// Garde-fous : bornes physiques, et confirmation si l'écart avec la dernière pesée dépasse 5 %
// (une faute de frappe fausserait aussitôt BMR, budget, trajet et estimation).
$("#poids-save").addEventListener("click", async () => {
  const val = parseDecimal($("#poids-input").value);
  if (!Number.isFinite(val) || val <= 0) { showToast("Entre un poids, ex. 112,4"); $("#poids-input").focus(); return; }
  if (val < 30 || val > 300) { showToast("Poids hors limites (30 à 300 kg)"); return; }
  const dernier = dernierPoids();
  if (dernier && Math.abs(val - dernier) / dernier > 0.05) {
    const ecart = val - dernier;
    if (!confirm(`${fmtKg(val)} kg, soit ${ecart > 0 ? "+" : ""}${fmtKg(ecart)} kg par rapport à la dernière pesée (${fmtKg(dernier)} kg).\nConfirmer ?`)) return;
  }
  const today = toDateStr();
  const remplace = state.poidsHistorique.some((p) => p.date === today);
  const { error } = await sb.from("poids").upsert(
    { user_id: state.user.id, date: today, valeur_kg: val },
    { onConflict: "user_id,date" },
  );
  if (error) { showToast("Erreur : " + error.message); return; }
  $("#poids-input").value = "";
  showToast(remplace ? "Pesée du jour remplacée ✓" : "Pesée enregistrée ✓");
  await refreshAll();
});

function renderPoidsList() {
  const tout = [...state.poidsHistorique].reverse();
  const list = tout.slice(0, 20);
  $("#poids-list").innerHTML = list.length
    ? list.map((p, i) => {
        const prec = tout[i + 1];
        const ecart = prec ? Number(p.valeur_kg) - Number(prec.valeur_kg) : null;
        const ecartHtml = ecart == null || Math.abs(ecart) < 0.05 ? `<small class="poids-ecart">=</small>`
          : `<small class="poids-ecart ${ecart < 0 ? "ok" : "warn"}">${ecart < 0 ? "−" : "+"}${fmtKg(Math.abs(ecart))}</small>`;
        return `<li>${pastilleDate(p.date)}<span class="poids-val">${fmtKg(p.valeur_kg)}<small>kg</small></span><span class="row-end">${ecartHtml}<button type="button" class="row-del" data-id="${p.id}" aria-label="Supprimer la pesée du ${formatDate(p.date)}">✕</button></span></li>`;
      }).join("")
    : `<li class="empty-row">Aucune pesée enregistrée.</li>`;
  renderPoidsStats();
}

// Moyenne 7 jours et variation vs les 7 jours précédents : le poids brut bouge de 1 à 2 kg
// dans la journée (eau, glycogène), la moyenne est la seule lecture fiable.
function renderPoidsStats() {
  const el = $("#poids-stats");
  const today = toDateStr();
  const moy = moyennePoids(today, 7);
  const avant = new Date(); avant.setDate(avant.getDate() - 7);
  const moyAvant = moyennePoids(toDateStr(avant), 7);
  const conseil = "Pèse-toi le matin, à jeun, après être passé aux toilettes.";
  if (moy == null) { el.textContent = conseil; return; }
  let txt = `Moyenne 7 j : <b>${fmtKg(moy)} kg</b>`;
  if (moyAvant != null) {
    const d = moy - moyAvant;
    txt += ` · vs 7 j avant : <b class="${d < 0 ? "ok" : "warn"}">${d > 0 ? "+" : ""}${fmtKg(d)} kg</b>`;
  }
  el.innerHTML = `${txt}<br><span class="dim">${conseil}</span>`;
}

// ---------------- SUPPRESSION ----------------
// Une séance supprimée emporte ses séries et ses records (contrainte ON DELETE CASCADE) :
// un record né d'une saisie fautive disparaît avec elle, et le meilleur précédent
// redevient automatiquement le maximum.

async function supprimerSeance(id, label) {
  if (!confirm(`Supprimer cette séance (${label}) ?\nSes séries et les records qu'elle a produits seront effacés.`)) return;
  const { error } = await sb.from("seances").delete().eq("id", id);
  if (error) { showToast("Erreur : " + error.message); return; }
  state.dernieresPerfs = {};
  showToast("Séance supprimée");
  await refreshAll();
  if ($("#view-historique").classList.contains("is-active")) await renderHistoSeances();
}

async function supprimerPoids(id) {
  if (!confirm("Supprimer cette pesée ?")) return;
  const { error } = await sb.from("poids").delete().eq("id", id);
  if (error) { showToast("Erreur : " + error.message); return; }
  showToast("Pesée supprimée");
  await refreshAll();
}

$("#poids-list").addEventListener("click", (e) => {
  const btn = e.target.closest(".row-del");
  if (btn) supprimerPoids(btn.dataset.id);
});

$("#seances-jour").addEventListener("click", (e) => {
  const btn = e.target.closest(".row-del");
  if (btn) supprimerSeance(btn.dataset.id, btn.dataset.label);
});

// 1 kg de graisse ≈ 7700 kcal — conversion standard utilisée pour la projection théorique.
const KCAL_PAR_KG = 7700;
// Garde-fou : n'étend jamais la projection au-delà de 3 ans, même avec un déficit minime.
const PROJECTION_JOURS_MAX = 3 * 365;

function renderWeightChart() {
  const ctx = $("#chart-poids");
  const hist = state.poidsHistorique;
  const objectifPoids = poidsObjectif();
  const depart = poidsDepart();
  $("#chart-head-range").textContent = depart && objectifPoids ? `${fmtKg(depart)} kg → ${fmtKg(objectifPoids)} kg` : "";

  const labelsReel = hist.map((p) => formatDate(p.date));
  const valuesReel = hist.map((p) => Number(p.valeur_kg));
  // Moyenne glissante 7 jours : lisse les variations d'eau d'un jour à l'autre.
  const valuesMoy7 = hist.map((p) => Math.round(moyennePoids(p.date, 7) * 10) / 10);

  // Projection théorique : rythme de perte si l'objectif de déficit est tenu tous les jours,
  // extrapolé depuis la dernière pesée réelle jusqu'au poids objectif.
  const rythmeKgParJour = objectifDeficit() / KCAL_PAR_KG;
  let labelsProjection = [];
  let valuesProjection = [];
  let joursProjection = null;

  if (hist.length && objectifPoids && rythmeKgParJour > 0) {
    const dernier = hist[hist.length - 1];
    const kgRestants = Number(dernier.valeur_kg) - objectifPoids;
    if (kgRestants > 0) {
      joursProjection = Math.ceil(kgRestants / rythmeKgParJour);
      const cap = Math.min(joursProjection, PROJECTION_JOURS_MAX);
      const dateDepart = dateDe(dernier.date);
      for (let j = 0; j <= cap; j++) {
        const d = new Date(dateDepart);
        d.setDate(d.getDate() + j);
        labelsProjection.push(formatDate(toDateStr(d)));
        const poidsJ = Math.max(objectifPoids, Number(dernier.valeur_kg) - rythmeKgParJour * j);
        valuesProjection.push(Math.round(poidsJ * 10) / 10);
      }
    }
  }

  // Fusionne réel + projection sans dupliquer le point de jonction (dernière pesée)
  const labels = labelsProjection.length ? [...labelsReel, ...labelsProjection.slice(1)] : labelsReel;
  const values = [...valuesReel, ...new Array(Math.max(0, labels.length - valuesReel.length)).fill(null)];
  const projection = labelsProjection.length
    ? [...new Array(labelsReel.length - 1).fill(null), ...valuesProjection]
    : [];

  if (state.chartPoids) state.chartPoids.destroy();
  state.chartPoids = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Poids",
          data: values,
          borderColor: "#6EE7B7",
          backgroundColor: "rgba(110,231,183,0.08)",
          fill: true,
          tension: 0.3,
          pointRadius: 2,
        },
        {
          label: "Moyenne 7 j",
          data: [...valuesMoy7, ...new Array(Math.max(0, labels.length - valuesMoy7.length)).fill(null)],
          borderColor: "rgba(110,231,183,0.55)",
          borderDash: [6, 4],
          pointRadius: 0,
          tension: 0.3,
        },
        ...(objectifPoids ? [{
          label: "Objectif",
          data: labels.map(() => objectifPoids),
          borderColor: "#8A948F",
          borderDash: [4, 4],
          pointRadius: 0,
        }] : []),
        ...(projection.length ? [{
          label: "Projection (déficit constant)",
          data: projection,
          borderColor: "#FFC24B",
          borderDash: [2, 3],
          pointRadius: 0,
          tension: 0,
        }] : []),
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#8A948F", maxTicksLimit: 6 }, grid: { color: "#263230" } },
        y: { ticks: { color: "#8A948F" }, grid: { color: "#263230" } },
      },
    },
  });

  if (joursProjection !== null) {
    const dateEstim = dateDe(hist[hist.length - 1].date);
    dateEstim.setDate(dateEstim.getDate() + joursProjection);
    const dateLabel = dateEstim.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
    $("#projection-note").textContent = joursProjection > PROJECTION_JOURS_MAX
      ? `À ce rythme (${objectifDeficit()} kcal/j), l'objectif prendrait plus de 3 ans — vise un déficit plus soutenable.`
      : `Projection théorique (pointillés) : ${objectifDeficit()} kcal/j de déficit tenus chaque jour ≈ ${dateLabel} (${joursProjection} jours). La carte « Estimation » suit, elle, ton rythme réel.`;
  } else {
    $("#projection-note").textContent = "";
  }
}

// Rythme réel : régression linéaire sur les pesées des 21 derniers jours. Il faut au moins
// 3 pesées étalées sur 7 jours — deux points à 5 jours d'écart mesurent surtout l'eau perdue
// la première semaine, pas la graisse.
const ETA_MIN_PESEES = 3;
const ETA_MIN_JOURS = 7;

function estimationETA() {
  const h = state.poidsHistorique;
  const objectif = poidsObjectif();
  if (!objectif) {
    $("#eta-value").textContent = "—";
    $("#eta-sub").textContent = "Renseigne ton poids objectif dans Profil";
    return;
  }
  const recent = h.filter((p) => (Date.now() - dateDe(p.date)) / 86400000 <= 21);
  const base = recent.length >= ETA_MIN_PESEES ? recent : h;
  const jours = base.length ? (dateDe(base[base.length - 1].date) - dateDe(base[0].date)) / 86400000 : 0;

  if (base.length < ETA_MIN_PESEES || jours < ETA_MIN_JOURS) {
    $("#eta-value").textContent = "—";
    $("#eta-sub").textContent = `Il faut ${ETA_MIN_PESEES} pesées sur ${ETA_MIN_JOURS} jours (${base.length} pesée${base.length > 1 ? "s" : ""} sur ${Math.round(jours)} j)`;
    return;
  }

  const t0 = dateDe(base[0].date).getTime();
  const xs = base.map((p) => (dateDe(p.date).getTime() - t0) / 86400000);
  const ys = base.map((p) => Number(p.valeur_kg));
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  const varX = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const pente = varX > 0 ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / varX : 0;
  const perteParJour = -pente;
  const xNow = (Date.now() - t0) / 86400000;
  const poidsTendance = my + pente * (xNow - mx);

  if (perteParJour <= 0.005) {
    $("#eta-value").textContent = "—";
    $("#eta-sub").textContent = `Pas de tendance de perte sur ${base.length} pesées (${Math.round(jours)} j)`;
    return;
  }
  const kgRestants = poidsTendance - objectif;
  if (kgRestants <= 0) {
    $("#eta-value").textContent = "Objectif atteint 🎉";
    $("#eta-sub").textContent = "";
    return;
  }
  const joursRestants = Math.round(kgRestants / perteParJour);
  if (joursRestants > PROJECTION_JOURS_MAX) {
    $("#eta-value").textContent = "> 3 ans";
    $("#eta-sub").textContent = `Rythme actuel trop lent (${fmtKg(perteParJour * 7, 2)} kg/semaine)`;
    return;
  }
  const dateEstim = new Date(Date.now() + joursRestants * 86400000);
  $("#eta-value").textContent = `≈ ${dateEstim.toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}`;
  $("#eta-sub").textContent = `${joursRestants} jours au rythme réel : ${fmtKg(perteParJour * 7, 2)} kg/semaine (tendance sur ${base.length} pesées, ${Math.round(jours)} j)`;
}

// ---------------- NUTRITION (app de nutrition → Santé → Raccourcis, ou saisie manuelle) ----------------

// Saisie manuelle : seuls les champs remplis sont envoyés, pour ne jamais écraser avec un vide
// ce que le raccourci a déjà synchronisé (PostgREST ne met à jour que les colonnes présentes).
$("#nutrition-save").addEventListener("click", async () => {
  const cal = parseDecimal($("#nutrition-calories").value);
  const prot = parseDecimal($("#nutrition-proteines").value);
  const eau = parseDecimal($("#nutrition-eau").value);
  const payload = { user_id: state.user.id, date: toDateStr(), source: "manuel", updated_at: new Date().toISOString() };
  if (cal > 0) payload.calories = cal;
  if (prot > 0) payload.proteines_g = prot;
  if (eau > 0) payload.eau_litres = eau > 25 ? eau / 1000 : eau; // ml tolérés
  if (!("calories" in payload) && !("proteines_g" in payload) && !("eau_litres" in payload)) {
    showToast("Renseigne au moins une valeur");
    return;
  }
  const { error } = await sb.from("nutrition_jour").upsert(payload, { onConflict: "user_id,date" });
  if (error) { showToast("Erreur : " + error.message); return; }
  showToast("Nutrition enregistrée ✓");
  await refreshAll();
});

// Cible de protéines : 1,6 g par kg de poids OBJECTIF (pas de poids actuel), le repère
// courant pour préserver le muscle en déficit sans surestimer la cible quand le poids est élevé.
// Sans objectif renseigné, on retombe sur le dernier poids connu.
const PROT_G_PAR_KG_OBJECTIF = 1.6;
function poidsRefProteines() {
  return poidsObjectif() ?? dernierPoids();
}
function objectifProteines() {
  const ref = poidsRefProteines();
  return ref ? Math.round(PROT_G_PAR_KG_OBJECTIF * ref) : null;
}

function renderNutrition() {
  const n = state.nutritionJour;
  if (!n) {
    $("#nutrition-today").innerHTML = `<p class="empty-row">Aucune donnée pour aujourd'hui — la synchro passe chaque soir, ou saisis tes valeurs ci-dessous.</p>`;
    $("#nutrition-calories").value = "";
    $("#nutrition-proteines").value = "";
    $("#nutrition-eau").value = "";
  } else {
    const sourceLabel = n.source === "manuel" ? "✏️ Saisi manuellement" : "🔄 Synchronisé depuis Apple Santé";
    $("#nutrition-today").innerHTML = `
      <div class="nutrition-summary">
        <div><span class="nutrition-big">${n.calories != null ? Math.round(n.calories) : "—"}</span><span class="nutrition-unit">kcal</span></div>
        ${n.proteines_g ? `<div><span class="nutrition-big">${fmtKg(n.proteines_g, 0)}</span><span class="nutrition-unit">g protéines</span></div>` : ""}
        ${n.eau_litres ? `<div><span class="nutrition-big">${fmtKg(n.eau_litres, 2)}</span><span class="nutrition-unit">L eau</span></div>` : ""}
      </div>
      <p class="nutrition-source">${sourceLabel}</p>
    `;
    $("#nutrition-calories").value = n.calories != null ? Math.round(n.calories) : "";
    $("#nutrition-proteines").value = n.proteines_g != null ? Number(n.proteines_g) : "";
    $("#nutrition-eau").value = n.eau_litres != null ? Number(n.eau_litres) : "";
  }

  // Protéines du jour vs cible
  const prot = Number(n?.proteines_g || 0);
  const cible = objectifProteines();
  $("#prot-value").textContent = fmtKg(prot, 0);
  $("#prot-objectif").textContent = cible ?? "—";
  $("#prot-seg").style.width = cible ? `${Math.min(100, (prot / cible) * 100)}%` : "0%";
  $("#prot-note").textContent = !cible
    ? "Renseigne ton poids objectif dans Profil pour calculer ta cible de protéines."
    : !prot
    ? `Cible : ${fmtKg(PROT_G_PAR_KG_OBJECTIF)} g × ${fmtKg(poidsRefProteines())} kg (${poidsObjectif() ? "poids objectif" : "poids actuel"}) — le levier pour garder le muscle en déficit.`
    : prot >= cible
      ? "Cible de protéines atteinte 💪"
      : `Encore ${Math.round(cible - prot)} g pour atteindre la cible`;
}

// ---------------- HYDRATATION ----------------
// Objectif d'eau indicatif, recalculé chaque jour selon l'activité réelle :
//   base   : 30 ml par kg de poids de corps (repère courant en nutrition sportive)
//   sport  : +0,5 L par heure de séance enregistrée (muscu, cardio, circuit)
//   marche : +0,3 L par tranche de 5 000 pas au-delà des 5 000 premiers
// Borné entre 1,5 L et 4,5 L pour rester réaliste même en cas de très grosse journée.
const EAU_ML_PAR_KG = 0.03;
const EAU_L_PAR_HEURE_SPORT = 0.5;
const EAU_L_PAR_5000_PAS = 0.3;
const EAU_PAS_SEUIL = 5000;
const EAU_MIN_L = 1.5;
const EAU_MAX_L = 4.5;

function objectifEau() {
  const poids = dernierPoids() || 80;
  const base = poids * EAU_ML_PAR_KG;

  const minutesSport = state.seancesJour
    .filter((s) => s.statut === "faite")
    .reduce((s, x) => s + Number(x.duree_min || 0), 0);
  const sport = (minutesSport / 60) * EAU_L_PAR_HEURE_SPORT;

  const pas = state.activiteJour?.pas ?? null;
  const marche = pas ? Math.max(0, pas - EAU_PAS_SEUIL) / 5000 * EAU_L_PAR_5000_PAS : 0;

  const brut = base + sport + marche;
  const total = Math.min(EAU_MAX_L, Math.max(EAU_MIN_L, brut));
  const arrondi = (v) => Math.round(v * 10) / 10;
  return {
    total: arrondi(total),
    base: arrondi(base),
    sport: arrondi(sport),
    marche: arrondi(marche),
    plafonne: brut > EAU_MAX_L,
    pas,
    minutesSport,
  };
}

function renderHydratation() {
  const o = objectifEau();
  const bu = Number(state.nutritionJour?.eau_litres || 0);
  const pct = Math.min(100, (bu / (o.total || 1)) * 100);
  const fmt = (v) => v.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  const reste = Math.max(0, o.total - bu);
  const note = !state.nutritionJour?.eau_litres
    ? "Aucune donnée d'eau reçue aujourd'hui."
    : reste === 0
      ? "Objectif d'hydratation atteint 💧"
      : `Encore ${fmt(reste)} L pour atteindre l'objectif`;

  for (const [valueId, objectifId, segId, noteId] of [
    ["#hydra-value", "#hydra-objectif", "#hydra-seg", "#hydra-note"],
    ["#nutri-hydra-value", "#nutri-hydra-objectif", "#nutri-hydra-seg", "#nutri-hydra-note"],
  ]) {
    $(valueId).textContent = fmt(bu);
    $(objectifId).textContent = fmt(o.total);
    $(segId).style.width = `${pct}%`;
    $(noteId).textContent = note;
  }

  // Détail du calcul, seulement dans l'onglet Nutrition
  const parts = [`${fmt(o.base)} L de base (poids)`];
  if (o.sport > 0) parts.push(`+${fmt(o.sport)} L de sport (${Math.round(o.minutesSport)} min)`);
  if (o.marche > 0) parts.push(`+${fmt(o.marche)} L de marche (${o.pas.toLocaleString("fr-FR")} pas)`);
  $("#nutri-hydra-detail").textContent = parts.join(" ") + (o.plafonne ? ` — plafonné à ${fmt(EAU_MAX_L)} L` : "");
}

// ---------------- CALCUL CALORIES ----------------
// calories NETTES = (MET − 1) × poids(kg) × 3,5 / 200 × durée(min)
// Le MET brut inclut 1 MET de métabolisme de repos ; comme le BMR est déjà compté à part
// dans le bilan du jour, on retire ce 1 MET pour ne pas le compter deux fois.
function caloriesMET(met, poidsKg, dureeMin) {
  return Math.max(0, met - 1) * poidsKg * 3.5 / 200 * dureeMin;
}

// ---------------- SÉANCE : TOGGLE TYPE ----------------

// Le type choisi est mémorisé : on rouvre l'app sur le formulaire qu'on utilise vraiment.
function setSeanceType(type) {
  $$(".toggle-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.type === type));
  $("#form-cardio").hidden = type !== "cardio";
  $("#form-circuit").hidden = type !== "circuit";
  $("#form-muscu").hidden = type !== "muscu";
  setLS(LS_SEANCE_TYPE, type);
}
$$(".toggle-btn").forEach((btn) => btn.addEventListener("click", () => setSeanceType(btn.dataset.type)));
setSeanceType(getLS(LS_SEANCE_TYPE, "cardio"));

// ---------------- SÉANCE CARDIO ----------------

function updateCardioCalc() {
  const opt = $("#cardio-exercice").selectedOptions[0];
  const met = opt && opt.dataset.met ? Number(opt.dataset.met) : 0;
  const duree = Number($("#cardio-duree").value) || 0;
  const poids = dernierPoids() || 80;
  const cal = caloriesMET(met, poids, duree);
  $("#cardio-calc").textContent = `${Math.round(cal)} kcal`;
}
$("#cardio-exercice").addEventListener("change", (e) => {
  if (e.target.value === "__new__") { openNewExoForm("cardio", "cardio"); return; }
  cardioPrevValue = e.target.value;
  updateCardioCalc();
});
$("#cardio-duree").addEventListener("input", updateCardioCalc);
$("#cardio-duree").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("#cardio-save").click(); }
});

$("#cardio-save").addEventListener("click", async () => {
  const exerciceId = $("#cardio-exercice").value;
  const duree = Number($("#cardio-duree").value);
  if (!exerciceId || exerciceId === "__new__" || !duree) return;
  const opt = $("#cardio-exercice").selectedOptions[0];
  const met = Number(opt.dataset.met);
  const poids = dernierPoids() || 80;
  const cal = caloriesMET(met, poids, duree);

  const { data: seance, error } = await sb.from("seances").insert({
    user_id: state.user.id,
    date: toDateStr(),
    type: "cardio",
    statut: "faite",
    duree_min: duree,
    calories_brulees: cal,
  }).select().single();

  if (!error) {
    await checkPR(seance, "calories_seance", cal, exerciceId);
    setLS(LS_LAST_CARDIO, { exerciceId, duree });
    showToast("Séance enregistrée ✓");
    $("#cardio-duree").value = "";
    updateCardioCalc();
    await refreshAll();
  }
});

// ---------------- SÉANCE MUSCU ----------------
// state.muscuSeries reste une liste plate de {exerciceId, reps, poidsKg, pauseSec} (compatible
// avec les modèles déjà enregistrés) ; l'affichage la regroupe en "blocs" par exercice consécutif
// pour qu'on choisisse l'exercice une fois puis qu'on saisisse juste le nombre de séries.

// ---- Brouillon : la saisie en cours survit à une fermeture de l'app (iOS tue volontiers une
// PWA laissée en arrière-plan le temps de changer de musique). Rien n'est envoyé en base.
const DRAFT_MAX_AGE_MS = 20 * 3600 * 1000; // une séance ne dure pas plus longtemps : au-delà, le brouillon est abandonné

function persistMuscuDraft() {
  if (state.muscuSeries.length) setLS(LS_DRAFT_MUSCU, { savedAt: Date.now(), series: state.muscuSeries });
  else clearMuscuDraft();
}
function clearMuscuDraft() {
  try { localStorage.removeItem(LS_DRAFT_MUSCU); } catch {}
}
function lireMuscuDraft() {
  const d = getLS(LS_DRAFT_MUSCU, null);
  if (!d || !Array.isArray(d.series) || !d.series.length) return null;
  if (Date.now() - (d.savedAt || 0) > DRAFT_MAX_AGE_MS) { clearMuscuDraft(); return null; }
  const series = d.series.filter((s) => state.exercices.some((x) => x.id === s.exerciceId));
  return series.length ? series : null;
}
// Une saisie « qui compte » : plus d'une série, ou au moins une série validée. Le bloc de départ
// ajouté automatiquement n'en est pas une : on peut l'écraser sans demander.
function saisieEnCours() {
  return state.muscuSeries.length >= 2 || state.muscuSeries.some((s) => s.done);
}

// Ajoute un exercice avec TOUTES ses séries de la dernière fois (reps, charge, repos) : dans la
// plupart des cas il n'y a plus qu'à confirmer chaque série d'un ✓, ou à corriger un chiffre.
async function addMuscuBlock(exerciceId) {
  if (!(exerciceId in state.dernieresPerfs)) await chargerDernierePerf(exerciceId);
  const perf = state.dernieresPerfs[exerciceId];
  const remembered = getLS(LS_LAST_SERIE, {})[exerciceId];
  const rows = perf && perf.sets.length
    ? perf.sets.map((s) => ({ exerciceId, reps: s.reps, poidsKg: s.poids, pauseSec: s.pause ?? remembered?.pauseSec ?? 60 }))
    : [remembered ? { exerciceId, ...remembered } : { exerciceId, reps: 10, poidsKg: 20, pauseSec: 60 }];
  state.muscuSeries.push(...rows);
  renderSerieRows();
  const blockEl = [...$$("#muscu-series-list .exo-block")].reverse().find((el) => el.dataset.exo === exerciceId);
  blockEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  // Au clavier physique on enchaîne sur la saisie ; au doigt, pas de focus : ça ouvrirait le clavier
  // alors que les valeurs sont déjà les bonnes la plupart du temps.
  if (matchMedia("(hover: hover)").matches) {
    const input = blockEl?.querySelector(".serie-reps");
    if (input) { input.focus(); input.select(); }
  }
}

// Au chargement : reprend la saisie en cours s'il y en a une, sinon pré-remplit un premier
// exercice (le plus récent), seulement si le catalogue en contient déjà un.
function ensureInitialMuscuBlock() {
  if (state.muscuSeries.length) return; // des blocs existent déjà (saisie en cours) : on ne touche à rien
  const draft = lireMuscuDraft();
  if (draft) {
    state.muscuSeries = draft;
    if (saisieEnCours()) showToast("Saisie en cours restaurée");
  } else {
    const muscu = state.exercices.filter((x) => x.type === "muscu");
    if (muscu.length) {
      const remembered = getLS(LS_LAST_SERIE, {});
      const exerciceId = getLS(LS_RECENT_EXOS, []).find((id) => muscu.some((x) => x.id === id)) || muscu[0].id;
      const r = remembered[exerciceId];
      state.muscuSeries.push(r ? { exerciceId, ...r } : { exerciceId, reps: 10, poidsKg: 20, pauseSec: 60 });
    }
  }
  renderSerieRows(); // rien à perdre ici : soit on vient d'ajouter le bloc de départ, soit la liste reste vide (placeholder)
}

$("#muscu-add-exercice-select").addEventListener("change", (e) => {
  const val = e.target.value;
  if (!val) return;
  if (val === "__new__") { openNewExoForm("muscu-add", "muscu"); return; }
  addMuscuBlock(val);
  e.target.value = "";
});

// Regroupe state.muscuSeries en blocs par exercice consécutif : [{exerciceId, indices:[i,...]}, ...]
function groupMuscuBlocks() {
  const blocks = [];
  state.muscuSeries.forEach((row, i) => {
    const last = blocks[blocks.length - 1];
    if (last && last.exerciceId === row.exerciceId) last.indices.push(i);
    else blocks.push({ exerciceId: row.exerciceId, indices: [i] });
  });
  return blocks;
}

function renderSerieRows() {
  const blocks = groupMuscuBlocks();
  // Superset : un bloc dont la dernière série a 0 s de repos s'enchaîne avec le suivant ;
  // on les relie visuellement plutôt que de les laisser comme deux exercices indépendants.
  const enchaine = (k) => k >= 0 && k < blocks.length - 1 && Number(state.muscuSeries[blocks[k].indices.at(-1)].pauseSec) === 0;
  $("#muscu-series-list").innerHTML = blocks.length ? blocks.map((block, k) => {
    const ex = state.exercices.find((x) => x.id === block.exerciceId);
    const nom = ex ? ex.nom : "Exercice supprimé";
    const rowsHtml = block.indices.map((i, j) => {
      const row = state.muscuSeries[i];
      return `
        <div class="serie-row${row.done ? " is-done" : ""}" data-i="${i}">
          <label class="serie-field"><span>Série ${j + 1} · Reps</span><input type="number" class="serie-reps" aria-label="Répétitions, série ${j + 1}" value="${row.reps}" inputmode="numeric" enterkeyhint="next"></label>
          <label class="serie-field"><span>Charge (kg)</span><input type="number" class="serie-poids" aria-label="Charge en kilogrammes, série ${j + 1}" value="${row.poidsKg}" inputmode="decimal" enterkeyhint="next"></label>
          <label class="serie-field"><span>Repos (s)</span><input type="number" class="serie-pause" aria-label="Repos en secondes, série ${j + 1}" value="${row.pauseSec}" inputmode="numeric" enterkeyhint="done"></label>
          <button type="button" class="serie-done" aria-pressed="${row.done ? "true" : "false"}" aria-label="Série ${j + 1} faite : lancer le repos">✓</button>
        </div>`;
    }).join("");
    return `
      <div class="exo-block${enchaine(k) ? " ss-first" : ""}${enchaine(k - 1) ? " ss-next" : ""}" data-exo="${block.exerciceId}">
        <div class="exo-block-head">
          <b class="exo-block-name">${nom}</b>
          <div class="exo-block-sets-ctrl">
            <span>Séries</span>
            <button type="button" class="exo-sets-minus" aria-label="Retirer une série">–</button>
            <input type="number" class="exo-sets-count" min="1" value="${block.indices.length}" inputmode="numeric" aria-label="Nombre de séries pour ${nom}">
            <button type="button" class="exo-sets-plus" aria-label="Ajouter une série">+</button>
          </div>
          <button type="button" class="exo-rest-start" title="Lancer le repos" aria-label="Lancer le repos pour ${nom}">⏱</button>
          <button type="button" class="exo-block-remove" title="Retirer cet exercice" aria-label="Retirer cet exercice">✕</button>
        </div>
        <p class="exo-last" hidden></p>
        <div class="exo-block-rows">${rowsHtml}</div>
      </div>`;
  }).join("") : `<p class="empty-row">Ajoute un exercice pour commencer.</p>`;
  $("#muscu-clear").hidden = !blocks.length;

  wireMuscuBlockEvents(blocks);
  appliquerDernieresPerfs();
  updateMuscuCalc();
}

// ---------------- « LA DERNIÈRE FOIS » ----------------
// Une ligne sous le nom de l'exercice : ce qu'il y a à battre, au moment où on le tape.
// Les résultats sont mis en cache par exercice et vidés dès qu'une séance est enregistrée
// ou supprimée.

async function chargerDernierePerf(exerciceId) {
  if (exerciceId in state.dernieresPerfs) return;
  state.dernieresPerfs[exerciceId] = null; // pose le marqueur tout de suite : pas d'appel en boucle
  const { data } = await sb.from("series")
    .select("repetitions, poids_kg, pause_sec, numero_serie, seances!inner(user_id, date)")
    .eq("exercice_id", exerciceId)
    .eq("seances.user_id", state.user.id);
  if (!data || !data.length) { appliquerDernieresPerfs(); return; }

  const dernierJour = data.reduce((max, s) => (s.seances.date > max ? s.seances.date : max), "");
  const sets = data
    .filter((s) => s.seances.date === dernierJour)
    .sort((a, b) => a.numero_serie - b.numero_serie)
    .map((s) => ({ poids: Number(s.poids_kg || 0), reps: Number(s.repetitions || 0), pause: s.pause_sec == null ? null : Number(s.pause_sec) }));
  state.dernieresPerfs[exerciceId] = { date: dernierJour, sets };
  appliquerDernieresPerfs();
}

function ilYA(dateStr) {
  const jours = Math.round((new Date(toDateStr()) - new Date(dateStr)) / 86400000);
  if (jours <= 0) return "aujourd'hui";
  if (jours === 1) return "hier";
  return `il y a ${jours} j`;
}

function dernierePerfHtml(exerciceId) {
  const perf = state.dernieresPerfs[exerciceId];
  if (!perf || !perf.sets.length) return "";
  const poids = perf.sets.map((s) => s.poids);
  const memeCharge = poids.every((p) => p === poids[0]);
  const detail = !poids[0]
    ? `${perf.sets.map((s) => s.reps).join(", ")} reps`          // poids de corps
    : memeCharge
      ? `<b>${poids[0]} kg</b> · ${perf.sets.map((s) => s.reps).join(", ")}`
      : perf.sets.map((s) => `${s.poids}×${s.reps}`).join(" · ");
  return `<span class="ago">${ilYA(perf.date)}</span><span class="sets">${detail}</span>`;
}

function appliquerDernieresPerfs() {
  $$("#muscu-series-list .exo-block").forEach((el) => {
    const slot = el.querySelector(".exo-last");
    if (!slot) return;
    const id = el.dataset.exo;
    if (!(id in state.dernieresPerfs)) { chargerDernierePerf(id); return; }
    const html = dernierePerfHtml(id);
    slot.innerHTML = html;
    slot.hidden = !html;
  });
}

// ---------------- CHRONO DE REPOS ----------------
// Démarre au moment où une série est validée (Entrée), ou à la demande via ⏱.
// Il continue en négatif après zéro, puis s'efface seul si on l'a oublié.

let restInterval = null;

function startRest(secondes) {
  const total = Math.max(1, Math.round(Number(secondes) || 0));
  stopRest(false);
  let restant = total;
  const el = $("#rest-timer");
  el.hidden = false;
  document.body.classList.add("rest-on");

  const peindre = () => {
    const abs = Math.abs(restant);
    const signe = restant < 0 ? "−" : "";
    $("#rest-time").textContent = `${signe}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
    $("#rest-progress").style.width = `${Math.max(0, (restant / total) * 100)}%`;
    el.classList.toggle("is-over", restant <= 0);
  };
  peindre();

  restInterval = setInterval(() => {
    restant--;
    if (restant === 0) {
      navigator.vibrate?.([200, 80, 200]);
      showToast("Repos terminé");
    }
    if (restant <= -90) { stopRest(); return; }
    peindre();
  }, 1000);
}

function stopRest(masquer = true) {
  clearInterval(restInterval);
  restInterval = null;
  if (masquer) {
    $("#rest-timer").hidden = true;
    document.body.classList.remove("rest-on");
  }
}

$("#rest-stop").addEventListener("click", () => stopRest());

// Repos de la dernière série saisie sur cet exercice — c'est celle qu'on vient de faire.
function reposDuBloc(block) {
  return state.muscuSeries[block.indices[block.indices.length - 1]]?.pauseSec;
}

function setMuscuBlockCount(block, n, { focus = false } = {}) {
  n = Math.max(1, Math.floor(n) || 1);
  const cur = block.indices.length;
  if (n > cur) {
    const lastRow = state.muscuSeries[block.indices[block.indices.length - 1]];
    const insertAt = block.indices[block.indices.length - 1] + 1;
    for (let k = 0; k < n - cur; k++) state.muscuSeries.splice(insertAt + k, 0, { ...lastRow, done: false });
  } else if (n < cur) {
    block.indices.slice(n).sort((a, b) => b - a).forEach((i) => state.muscuSeries.splice(i, 1));
  }
  renderSerieRows();
  if (focus) {
    const blockEl = [...$$("#muscu-series-list .exo-block")].find((el) => el.dataset.exo === block.exerciceId);
    const inputs = blockEl?.querySelectorAll(".serie-reps");
    const lastInput = inputs?.[inputs.length - 1];
    if (lastInput) { lastInput.focus(); lastInput.select(); }
  }
}

// « Série faite » : la ligne passe en vert et le repos de cette série démarre (0 s = superset, on
// enchaîne sans chrono). Un second appui annule. Le bouton ✓ existe parce que le pavé numérique
// d'iOS n'a pas de touche Entrée ; au clavier physique, Entrée fait la même chose.
function validerSerie(i, rowEl) {
  const row = state.muscuSeries[i];
  if (!row) return;
  row.done = !row.done;
  rowEl.classList.toggle("is-done", row.done);
  rowEl.querySelector(".serie-done").setAttribute("aria-pressed", String(row.done));
  if (row.done && Number(row.pauseSec) > 0) startRest(row.pauseSec);
  persistMuscuDraft();
}

function wireMuscuBlockEvents(blocks) {
  $$("#muscu-series-list .exo-block").forEach((blockEl, bi) => {
    const block = blocks[bi];

    blockEl.querySelectorAll(".serie-row").forEach((rowEl) => {
      const i = Number(rowEl.dataset.i);
      const repsEl = rowEl.querySelector(".serie-reps");
      const poidsEl = rowEl.querySelector(".serie-poids");
      const pauseEl = rowEl.querySelector(".serie-pause");
      repsEl.addEventListener("input", (e) => { state.muscuSeries[i].reps = Number(e.target.value); updateMuscuCalc(); });
      poidsEl.addEventListener("input", (e) => { state.muscuSeries[i].poidsKg = Number(e.target.value); updateMuscuCalc(); });
      pauseEl.addEventListener("input", (e) => { state.muscuSeries[i].pauseSec = Number(e.target.value); updateMuscuCalc(); });
      const onEnter = (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (!state.muscuSeries[i].done) validerSerie(i, rowEl);
      };
      [repsEl, poidsEl, pauseEl].forEach((el) => el.addEventListener("keydown", onEnter));
      rowEl.querySelector(".serie-done").addEventListener("click", () => validerSerie(i, rowEl));
    });

    blockEl.querySelector(".exo-rest-start").addEventListener("click", () => startRest(reposDuBloc(block)));

    blockEl.querySelector(".exo-block-remove").addEventListener("click", () => {
      [...block.indices].sort((a, b) => b - a).forEach((i) => state.muscuSeries.splice(i, 1));
      renderSerieRows();
    });

    const countInput = blockEl.querySelector(".exo-sets-count");
    blockEl.querySelector(".exo-sets-plus").addEventListener("click", () => setMuscuBlockCount(block, block.indices.length + 1));
    blockEl.querySelector(".exo-sets-minus").addEventListener("click", () => setMuscuBlockCount(block, block.indices.length - 1));
    countInput.addEventListener("change", (e) => setMuscuBlockCount(block, Number(e.target.value)));
  });
}

// Tonnage : somme des reps × charge. C'est la mesure de progression qui bouge encore
// quand la charge max, elle, stagne (passer de 3×8 à 4×10 ne bat aucun record).
function volumeMuscu(series = state.muscuSeries) {
  return series.reduce((s, r) => s + (Number(r.reps) || 0) * (Number(r.poidsKg) || 0), 0);
}

function formatVolume(kg) {
  return kg >= 1000
    ? `${(kg / 1000).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} t`
    : `${Math.round(kg)} kg`;
}

function updateMuscuCalc() {
  const poidsCorps = dernierPoids() || 80;
  let total = 0;
  // Le MET d'un exercice de force (Compendium) est une moyenne sur la séance, repos entre les
  // séries compris : on l'applique donc à l'effort (~3 s par répétition) ET au repos qui suit.
  for (const row of state.muscuSeries) {
    const ex = state.exercices.find((x) => x.id === row.exerciceId);
    if (!ex) continue;
    const minutes = ((row.reps || 0) * 3 + (row.pauseSec || 0)) / 60;
    total += caloriesMET(ex.met, poidsCorps, minutes);
  }
  const volume = volumeMuscu();
  $("#muscu-calc").innerHTML = volume > 0
    ? `<span class="calc-vol">${formatVolume(volume)}</span> · ${Math.round(total)} kcal`
    : `${Math.round(total)} kcal`;
  persistMuscuDraft(); // appelé à chaque frappe et à chaque re-rendu : c'est l'entonnoir de tous les changements
  return total;
}

$("#muscu-save").addEventListener("click", async () => {
  if (!state.muscuSeries.length) return;
  const cal = updateMuscuCalc();
  const dureeMin = state.muscuSeries.reduce((s, r) => s + (r.reps * 3) / 60 + (r.pauseSec || 0) / 60, 0);

  const { data: seance, error } = await sb.from("seances").insert({
    user_id: state.user.id,
    date: toDateStr(),
    type: "muscu",
    statut: "faite",
    duree_min: dureeMin,
    calories_brulees: cal,
    volume_kg: volumeMuscu(),
  }).select().single();
  if (error) { showToast("Erreur : " + error.message); return; }

  const rows = state.muscuSeries.map((row, i) => ({
    seance_id: seance.id,
    exercice_id: row.exerciceId,
    numero_serie: i + 1,
    repetitions: row.reps,
    poids_kg: row.poidsKg,
    pause_sec: row.pauseSec,
  }));
  await sb.from("series").insert(rows);

  // Détection de PR sur les exercices suivis (charge max + reps tenues à cette charge) + calories de la séance
  for (const row of state.muscuSeries) {
    await checkPR(seance, "poids_max", row.poidsKg, row.exerciceId, row.reps);
  }
  await checkPR(seance, "calories_seance", cal, null);

  // Mémorise les valeurs et exercices utilisés pour préremplir la prochaine séance
  const lastMap = getLS(LS_LAST_SERIE, {});
  const recent = getLS(LS_RECENT_EXOS, []);
  for (const row of state.muscuSeries) {
    lastMap[row.exerciceId] = { reps: row.reps, poidsKg: row.poidsKg, pauseSec: row.pauseSec };
    const idx = recent.indexOf(row.exerciceId);
    if (idx !== -1) recent.splice(idx, 1);
    recent.unshift(row.exerciceId);
  }
  setLS(LS_LAST_SERIE, lastMap);
  setLS(LS_RECENT_EXOS, recent.slice(0, 15));

  showToast("Séance enregistrée ✓");
  state.dernieresPerfs = {};
  state.muscuSeries = [];
  clearMuscuDraft();
  stopRest();
  renderSerieRows();
  await refreshAll();
});

// ---------------- SÉANCE CIRCUIT (cardio en rounds : ex burpees → pompes → planche) ----------------

function addCircuitExo(exerciceId) {
  state.circuitExos.push({ exerciceId, reps: 15 });
  renderCircuitBlocks();
}

$("#circuit-add-exercice-select").addEventListener("change", (e) => {
  const val = e.target.value;
  if (!val) return;
  if (val === "__new__") { openNewExoForm("circuit-add", "mixte"); return; }
  addCircuitExo(val);
  e.target.value = "";
});

function renderCircuitBlocks() {
  $("#circuit-blocks").innerHTML = state.circuitExos.length ? state.circuitExos.map((item, i) => {
    const ex = state.exercices.find((x) => x.id === item.exerciceId);
    const nom = ex ? ex.nom : "Exercice supprimé";
    return `
      <div class="exo-block" data-i="${i}">
        <div class="exo-block-head">
          <b class="exo-block-name">${nom}</b>
          <label class="serie-field circuit-reps-field"><span>Reps / tour</span><input type="number" class="circuit-reps" aria-label="Répétitions par tour pour ${nom}" value="${item.reps}" inputmode="numeric"></label>
          <button type="button" class="exo-block-remove" title="Retirer cet exercice" aria-label="Retirer cet exercice">✕</button>
        </div>
      </div>`;
  }).join("") : `<p class="empty-row">Ajoute des exercices pour construire ton circuit.</p>`;

  $$("#circuit-blocks .circuit-reps").forEach((el) => {
    const i = Number(el.closest(".exo-block").dataset.i);
    el.addEventListener("input", (e) => { state.circuitExos[i].reps = Number(e.target.value) || 0; updateCircuitCalc(); });
  });
  $$("#circuit-blocks .exo-block-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.closest(".exo-block").dataset.i);
      state.circuitExos.splice(i, 1);
      renderCircuitBlocks();
    });
  });
  updateCircuitCalc();
}

function updateCircuitCalc() {
  const poidsCorps = dernierPoids() || 80;
  const rounds = Number($("#circuit-rounds").value) || 1;
  const reposExo = Number($("#circuit-repos-exo").value) || 0;
  const reposTour = Number($("#circuit-repos-tour").value) || 0;
  let perRound = 0;
  for (const item of state.circuitExos) {
    const ex = state.exercices.find((x) => x.id === item.exerciceId);
    if (!ex) continue;
    perRound += caloriesMET(ex.met, poidsCorps, (item.reps * 3 + reposExo) / 60); // effort + repos qui suit
  }
  const caloriesReposTours = state.circuitExos.length ? caloriesMET(1.5, poidsCorps, (reposTour * Math.max(0, rounds - 1)) / 60) : 0;
  const total = perRound * rounds + caloriesReposTours;
  $("#circuit-calc").textContent = `${Math.round(total)} kcal`;
  return total;
}
$("#circuit-rounds").addEventListener("input", updateCircuitCalc);
$("#circuit-repos-exo").addEventListener("input", updateCircuitCalc);
$("#circuit-repos-tour").addEventListener("input", updateCircuitCalc);

$("#circuit-save").addEventListener("click", async () => {
  if (!state.circuitExos.length) return;
  const rounds = Number($("#circuit-rounds").value) || 1;
  const reposExo = Number($("#circuit-repos-exo").value) || 0;
  const reposTour = Number($("#circuit-repos-tour").value) || 0;
  const cal = updateCircuitCalc();
  const tempsEffortTotalMin = state.circuitExos.reduce((s, item) => s + (item.reps * 3) / 60, 0);
  const dureeMin = rounds * (tempsEffortTotalMin + (reposExo * state.circuitExos.length) / 60)
    + (reposTour * Math.max(0, rounds - 1)) / 60;

  const { data: seance, error } = await sb.from("seances").insert({
    user_id: state.user.id,
    date: toDateStr(),
    type: "cardio",
    statut: "faite",
    duree_min: dureeMin,
    calories_brulees: cal,
    notes: "circuit",
  }).select().single();
  if (error) return;

  const rows = [];
  let numero = 1;
  for (let r = 0; r < rounds; r++) {
    for (const item of state.circuitExos) {
      rows.push({
        seance_id: seance.id,
        exercice_id: item.exerciceId,
        numero_serie: numero++,
        repetitions: item.reps,
        poids_kg: null,
        pause_sec: reposExo,
      });
    }
  }
  await sb.from("series").insert(rows);

  // Pas de record par exercice sur les circuits : ils portent sur du poids de corps, sans charge.
  await checkPR(seance, "calories_seance", cal, null);

  showToast("Circuit enregistré ✓");
  state.dernieresPerfs = {};
  state.circuitExos = [];
  renderCircuitBlocks();
  await refreshAll();
});

// ---------------- PROGRAMME DE LA SEMAINE ----------------
// Une ligne par jour (1 = lundi … 7 = dimanche) dans programme_jours : la muscu prévue
// (exercice, reps, repos — la charge vient de la dernière fois) et le cardio qui suit.
// Un compte sans programme ne voit simplement ni la carte « Aujourd'hui » ni le groupe
// « Programme » des modèles.

async function loadProgramme() {
  const { data, error } = await sb.from("programme_jours").select("*").eq("user_id", state.user.id).order("jour");
  if (error) { console.error(error); state.programme = []; return; }
  const existe = (id) => state.exercices.some((x) => x.id === id);
  state.programme = (data || []).map((p) => ({ ...p, muscu: (p.muscu || []).filter((r) => existe(r.exercice_id)) }));
}

const jourSemaine = (d = new Date()) => d.getDay() || 7; // getDay() : 0 = dimanche
const programmeDuJour = (jour) => state.programme.find((p) => p.jour === jour);

// Résumé lisible : « Développé couché barre 4 × 5 », et les supersets (repos 0 s puis l'exercice
// suivant) en une seule ligne « Élévation latérale + Élévation frontale 3 × 12 + 12 ».
function resumeProgrammeMuscu(muscu) {
  const entrees = [];
  for (const r of muscu) {
    let e = entrees.find((x) => x.id === r.exercice_id);
    if (!e) entrees.push(e = { id: r.exercice_id, series: 0, reps: r.reps, superset: false });
    e.series++;
    if (Number(r.pause_sec) === 0) e.superset = true;
  }
  const nom = (id) => state.exercices.find((x) => x.id === id)?.nom || "?";
  const lignes = [];
  for (let i = 0; i < entrees.length; i++) {
    const e = entrees[i], suivant = entrees[i + 1];
    if (e.superset && suivant) {
      lignes.push({ nom: `${nom(e.id)} + ${nom(suivant.id)}`, detail: `${e.series} × ${e.reps} + ${suivant.reps}`, superset: true });
      i++;
    } else {
      lignes.push({ nom: nom(e.id), detail: `${e.series} × ${e.reps}` });
    }
  }
  return lignes;
}

function libelleCardio(c) {
  if (!c) return "";
  if (c.type === "cardio") return `${state.exercices.find((x) => x.id === c.exercice_id)?.nom || "Cardio"} · ${c.duree} min`;
  if (c.type === "circuit") return c.nom;
  return c.texte || "";
}

// Le jour affiché dans la carte : aujourd'hui par défaut, ou celui touché dans la bande de la semaine.
let programmeJourVu = null;
const jourVu = () => programmeJourVu ?? jourSemaine();

// Ce qui a déjà été fait ce jour-là de la semaine en cours (muscu / cardio-circuit).
function faitLeJour(jour) {
  const d = startOfWeek(new Date());
  d.setDate(d.getDate() + jour - 1);
  const dStr = toDateStr(d);
  const seances = state.seancesSemaine.filter((s) => s.date === dStr);
  return { muscu: seances.some((s) => s.type === "muscu"), cardio: seances.some((s) => s.type === "cardio") };
}

// Durée de la muscu prévue : 3 s par répétition + le repos de chaque série.
const dureeProgrammeMin = (muscu) => Math.round(muscu.reduce((t, r) => t + Number(r.reps) * 3 + Number(r.pause_sec), 0) / 60);

function renderProgrammeSemaine() {
  const aujourdHui = jourSemaine();
  const lettres = ["L", "M", "M", "J", "V", "S", "D"];
  $("#programme-semaine").innerHTML = lettres.map((lettre, i) => {
    const jour = i + 1;
    const p = programmeDuJour(jour);
    const fait = faitLeJour(jour);
    const complet = p && (p.muscu.length ? fait.muscu : fait.cardio);
    const classes = [
      "ps-jour",
      jour === aujourdHui && "is-today",
      jour === jourVu() && "is-selected",
      complet && "is-done",
      jour < aujourdHui && !complet && "is-past",
      (!p || !p.muscu.length) && "is-rest",
    ].filter(Boolean).join(" ");
    return `<button type="button" class="${classes}" data-jour="${jour}" aria-pressed="${jour === jourVu()}" aria-label="${NOMS_JOURS[jour]} : ${p ? p.nom : "rien de prévu"}${complet ? ", faite" : ""}">
      <span class="ps-lettre">${lettre}</span>
      <span class="ps-nom">${complet ? "✓" : p ? p.nom.replace(" ", "<br>") : "–"}</span>
    </button>`;
  }).join("");
}

function renderProgrammeJour() {
  renderHeroSeance();
  $("#programme-jour").hidden = !state.programme.length;
  if (!state.programme.length) return;
  renderProgrammeSemaine();

  const jour = jourVu();
  const p = programmeDuJour(jour);
  const fait = faitLeJour(jour);
  const nomJour = NOMS_JOURS[jour].charAt(0).toUpperCase() + NOMS_JOURS[jour].slice(1);
  $("#programme-label").textContent = jour === jourSemaine() ? `Aujourd'hui · ${nomJour}` : jour === jourSemaine() % 7 + 1 ? `Demain · ${nomJour}` : nomJour;

  const muscu = p?.muscu || [];
  const lignes = resumeProgrammeMuscu(muscu); // un superset compte pour une ligne, comme à l'écran
  $("#programme-meta").textContent = muscu.length ? `${lignes.length} exos · ${muscu.length} séries · ~${dureeProgrammeMin(muscu)} min` : "";
  $("#programme-nom").textContent = p ? p.nom : "Rien de prévu";
  $("#programme-orientation").textContent = p?.orientation || "";
  $("#programme-orientation").hidden = !p?.orientation;
  $("#programme-fait-muscu").hidden = !(muscu.length && fait.muscu);

  $("#programme-exos").innerHTML = lignes.map((l, i) => `
    <li${l.superset ? ` class="is-superset"` : ""}>
      <i>${i + 1}</i>
      <span>${l.nom}${l.superset ? `<small>Superset</small>` : ""}</span>
      <b>${l.detail}</b>
    </li>`).join("");
  $("#programme-exos").hidden = !muscu.length;

  const cardio = libelleCardio(p?.cardio);
  const type = p?.cardio?.type;
  const icone = type === "circuit" ? "⚡" : type === "cardio" ? "🚶" : "🧘";
  $("#programme-cardio").innerHTML = cardio ? `
    <span class="pc-icone" aria-hidden="true">${icone}</span>
    <span class="pc-texte"><small>${muscu.length ? "Puis" : "Au programme"}</small>${cardio}</span>
    ${type !== "libre" && fait.cardio ? `<span class="programme-fait">✓ Fait</span>` : ""}` : "";
  $("#programme-cardio").hidden = !cardio;
  $("#programme-cardio").classList.toggle("is-libre", type === "libre");

  $("#programme-load-muscu").hidden = !muscu.length;
  const cardioChargeable = type === "cardio" || type === "circuit";
  $("#programme-load-cardio").hidden = !cardioChargeable;
  if (cardioChargeable) $("#programme-load-cardio").textContent = type === "circuit" ? "Charger le circuit" : "Charger le cardio";
  // Un seul bouton (cardio seul) : il devient le bouton principal.
  $("#programme-load-cardio").classList.toggle("btn-primary", cardioChargeable && !muscu.length);
  $("#programme-load-cardio").classList.toggle("btn-ghost", !(cardioChargeable && !muscu.length));
}

// Sur le dashboard : la séance prévue aujourd'hui, un tap pour aller la faire.
function renderHeroSeance() {
  const brut = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  $("#hero-date").textContent = brut.charAt(0).toUpperCase() + brut.slice(1);
  const p = programmeDuJour(jourSemaine());
  const btn = $("#hero-seance");
  btn.hidden = !p;
  if (!p) return;
  const fait = faitLeJour(jourSemaine());
  const complet = p.muscu.length ? fait.muscu : fait.cardio;
  $("#hero-seance-label").textContent = complet ? "Séance du jour · faite ✓" : "Séance du jour";
  $("#hero-seance-nom").textContent = p.orientation ? `${p.nom} · ${p.orientation}` : p.nom;
  $("#hero-seance-meta").textContent = p.muscu.length
    ? `${resumeProgrammeMuscu(p.muscu).length} exos · ~${dureeProgrammeMin(p.muscu)} min`
    : libelleCardio(p.cardio);
  btn.classList.toggle("is-done", !!complet);
}
$("#hero-seance").addEventListener("click", () => {
  programmeJourVu = null;
  renderProgrammeJour();
  goToTab("seance");
  window.scrollTo({ top: 0 });
});

$("#programme-semaine").addEventListener("click", (e) => {
  const btn = e.target.closest(".ps-jour");
  if (!btn) return;
  const jour = Number(btn.dataset.jour);
  programmeJourVu = jour === jourSemaine() ? null : jour;
  renderProgrammeJour();
});

// Séries du programme avec la charge de la dernière fois (série par série), pour n'avoir
// qu'à valider d'un ✓ ; un exercice jamais fait part à 0 kg.
async function seriesDepuisProgramme(p) {
  const ids = [...new Set(p.muscu.map((r) => r.exercice_id))];
  await Promise.all(ids.map(chargerDernierePerf));
  const remembered = getLS(LS_LAST_SERIE, {});
  const rang = {};
  return p.muscu.map((r) => {
    const k = rang[r.exercice_id] = (rang[r.exercice_id] ?? -1) + 1;
    const sets = state.dernieresPerfs[r.exercice_id]?.sets || [];
    const poidsKg = (sets[k] ?? sets[sets.length - 1])?.poids ?? remembered[r.exercice_id]?.poidsKg ?? 0;
    return { exerciceId: r.exercice_id, reps: Number(r.reps), poidsKg, pauseSec: Number(r.pause_sec) };
  });
}

async function chargerProgrammeMuscu(p) {
  const series = await seriesDepuisProgramme(p);
  if (!series.length) return false;
  if (!chargerSeriesDansFormulaire(series, `${p.nom} chargé`)) return false;
  setSeanceType("muscu");
  return true;
}

function chargerProgrammeCardio(c) {
  if (c.type === "cardio") {
    const sel = $("#cardio-exercice");
    if (![...sel.options].some((o) => o.value === c.exercice_id)) return;
    sel.value = cardioPrevValue = c.exercice_id;
    $("#cardio-duree").value = c.duree;
    updateCardioCalc();
    setSeanceType("cardio");
    showToast(`${libelleCardio(c)} chargé`);
  } else if (c.type === "circuit") {
    if (state.circuitExos.length && !confirm("Remplacer le circuit en cours ?")) return;
    state.circuitExos = c.exos
      .filter((e) => state.exercices.some((x) => x.id === e.exercice_id))
      .map((e) => ({ exerciceId: e.exercice_id, reps: Number(e.reps) }));
    $("#circuit-rounds").value = c.rounds;
    $("#circuit-repos-exo").value = c.repos_exo;
    $("#circuit-repos-tour").value = c.repos_tour;
    renderCircuitBlocks();
    setSeanceType("circuit");
    showToast(`${c.nom} chargé`);
  }
}

$("#programme-load-muscu").addEventListener("click", async () => {
  const p = programmeDuJour(jourVu());
  if (p && await chargerProgrammeMuscu(p)) $("#seance-form-card").scrollIntoView({ block: "start", behavior: "smooth" });
});
$("#programme-load-cardio").addEventListener("click", () => {
  const p = programmeDuJour(jourVu());
  if (!p?.cardio) return;
  chargerProgrammeCardio(p.cardio);
  $("#seance-form-card").scrollIntoView({ block: "start", behavior: "smooth" });
});

// ---------------- MODÈLES DE SÉANCE (muscu) ----------------
// Deux sources dans le même sélecteur : les séances du programme (en base, « p:<jour> ») et
// les modèles enregistrés sur cet appareil (« l:<index> »). Seuls ces derniers se suppriment ici.

const NOMS_JOURS = ["", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

function renderTemplateSelect() {
  const templates = getLS(LS_TEMPLATES, []);
  const programme = state.programme.filter((p) => p.muscu.length);
  const locaux = templates.map((t, i) => `<option value="l:${i}">${t.name}</option>`).join("");
  $("#muscu-template-select").innerHTML =
    `<option value="">Charger un modèle…</option>` +
    (programme.length
      ? `<optgroup label="Programme">${programme.map((p) => `<option value="p:${p.jour}">${p.nom} (${NOMS_JOURS[p.jour]})</option>`).join("")}</optgroup>` +
        (locaux ? `<optgroup label="Mes modèles">${locaux}</optgroup>` : "")
      : locaux);
}

// Le sélecteur garde le modèle chargé affiché : c'est lui que « 🗑 » supprime.
$("#muscu-template-select").addEventListener("change", async (e) => {
  const [source, cle] = e.target.value.split(":");
  if (source === "p") {
    const p = programmeDuJour(Number(cle));
    if (!p || !(await chargerProgrammeMuscu(p))) e.target.value = "";
    return;
  }
  if (source !== "l") return;
  const t = getLS(LS_TEMPLATES, [])[Number(cle)];
  if (!t) return;
  if (!chargerSeriesDansFormulaire(t.series, `Modèle « ${t.name} » chargé`)) e.target.value = "";
});

$("#muscu-template-save").addEventListener("click", () => {
  if (!state.muscuSeries.length) return;
  const name = prompt("Nom du modèle :");
  if (!name) return;
  const templates = getLS(LS_TEMPLATES, []);
  templates.push({ name, series: state.muscuSeries.map(({ exerciceId, reps, poidsKg, pauseSec }) => ({ exerciceId, reps, poidsKg, pauseSec })) });
  setLS(LS_TEMPLATES, templates);
  renderTemplateSelect();
  showToast("Modèle enregistré ✓");
});

$("#muscu-template-delete").addEventListener("click", () => {
  const [source, idx] = $("#muscu-template-select").value.split(":");
  if (source === "p") { showToast("Les séances du programme ne se suppriment pas ici"); return; }
  if (source !== "l") return;
  const templates = getLS(LS_TEMPLATES, []);
  templates.splice(Number(idx), 1);
  setLS(LS_TEMPLATES, templates);
  renderTemplateSelect();
  showToast("Modèle supprimé");
});

// ---------------- REPRENDRE UNE SÉANCE ----------------
// Les dernières séances de muscu, rechargeables d'un tap avec toutes leurs séries. On ne garde
// qu'une séance par « type » (à peu près le même enchaînement d'exercices : PUSH, PULL…), la
// plus récente, pour proposer PUSH et PULL plutôt que trois PUSH.

function seriesDepuisLignes(rows) {
  return (rows || [])
    .slice().sort((a, b) => a.numero_serie - b.numero_serie)
    .filter((r) => state.exercices.some((x) => x.id === r.exercice_id))
    .map((r) => ({ exerciceId: r.exercice_id, reps: Number(r.repetitions || 0), poidsKg: Number(r.poids_kg || 0), pauseSec: Number(r.pause_sec ?? 60) }));
}

async function loadReprises() {
  const { data } = await sb.from("seances")
    .select("id, date, series(exercice_id, numero_serie, repetitions, poids_kg, pause_sec)")
    .eq("user_id", state.user.id)
    .eq("type", "muscu")
    .order("date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(12);
  const ressemble = (a, b) => { const inter = a.filter((x) => b.includes(x)).length; return inter / (a.length + b.length - inter) >= 0.6; };
  state.reprises = [];
  for (const s of data || []) {
    const series = seriesDepuisLignes(s.series);
    if (!series.length) continue;
    const exoIds = [...new Set(series.map((r) => r.exerciceId))];
    if (state.reprises.some((r) => ressemble(r.exoIds, exoIds))) continue;
    state.reprises.push({ id: s.id, date: s.date, series, exoIds, noms: exoIds.map((id) => state.exercices.find((x) => x.id === id).nom) });
    if (state.reprises.length === 3) break;
  }
}

function renderReprises() {
  $("#muscu-reprises").hidden = !state.reprises.length;
  $("#muscu-reprises-chips").innerHTML = state.reprises.map((r, i) => {
    const noms = r.noms.slice(0, 3).join(", ") + (r.noms.length > 3 ? `, +${r.noms.length - 3}` : "");
    const brut = new Date(r.date).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
    const jour = brut.charAt(0).toUpperCase() + brut.slice(1); // « mar. 8 sept. » → « Mar. 8 sept. »
    return `<button type="button" class="reprise-chip" data-i="${i}" aria-label="Reprendre la séance du ${jour}">
      <b>${jour}<i>${ilYA(r.date)}</i></b>
      <span>${noms}</span>
      <small>${r.noms.length} exo${r.noms.length > 1 ? "s" : ""} · ${r.series.length} séries</small>
    </button>`;
  }).join("");
}

// Remplace la saisie par ces séries (séance passée, modèle…), après confirmation si on écrase du travail.
function chargerSeriesDansFormulaire(series, message) {
  if (saisieEnCours() && !confirm("Remplacer la saisie en cours ?")) return false;
  state.muscuSeries = series.map(({ exerciceId, reps, poidsKg, pauseSec }) => ({ exerciceId, reps, poidsKg, pauseSec }));
  stopRest();
  renderSerieRows();
  if (message) showToast(message);
  return true;
}

$("#muscu-reprises-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".reprise-chip");
  const r = chip && state.reprises[Number(chip.dataset.i)];
  if (!r) return;
  if (chargerSeriesDansFormulaire(r.series, `Séance du ${formatDate(r.date)} chargée`)) {
    $("#muscu-series-list").scrollIntoView({ block: "start", behavior: "smooth" });
  }
});

// Depuis l'historique : recharge n'importe quelle séance de muscu passée dans le formulaire.
async function refaireSeance(seanceId, dateStr) {
  const { data } = await sb.from("series")
    .select("exercice_id, numero_serie, repetitions, poids_kg, pause_sec")
    .eq("seance_id", seanceId);
  const series = seriesDepuisLignes(data);
  if (!series.length) { showToast("Pas de série à reprendre"); return; }
  if (!chargerSeriesDansFormulaire(series, `Séance du ${formatDate(dateStr)} chargée`)) return;
  setSeanceType("muscu");
  goToTab("seance");
  window.scrollTo({ top: 0 });
}

$("#muscu-clear").addEventListener("click", () => {
  if (saisieEnCours() && !confirm("Vider la séance en cours ?")) return;
  state.muscuSeries = [];
  clearMuscuDraft();
  stopRest();
  renderSerieRows();
});

// ---------------- PR (RECORDS) ----------------

// Les records par exercice ne sont suivis que sur les exercices marqués `suivi_record`
// (les gros mouvements de force), pour garder la liste lisible.
function suitLesRecords(exerciceId) {
  const exo = state.exercices.find((x) => x.id === exerciceId);
  return !!(exo && exo.suivi_record);
}

// `reps` = répétitions réalisées À cette charge (pour un poids_max), pas le max de reps tous poids confondus.
async function checkPR(seance, typeRecord, valeur, exerciceId, reps = null) {
  // Le filtre ne vaut que pour les records de charge. `calories_seance` passe toujours,
  // y compris côté cardio où il est rattaché à un exercice.
  if (typeRecord !== "calories_seance" && !suitLesRecords(exerciceId)) return;

  let q = sb.from("records").select("*").eq("type_record", typeRecord).order("valeur", { ascending: false }).limit(1);
  q = exerciceId ? q.eq("exercice_id", exerciceId) : q.is("exercice_id", null);
  const { data } = await q;
  const meilleur = data && data[0];

  // Record si la charge augmente, ou si on tient plus de reps à la même charge.
  const estPR = !meilleur
    || Number(valeur) > Number(meilleur.valeur)
    || (reps !== null && Number(valeur) === Number(meilleur.valeur) && Number(reps) > Number(meilleur.reps ?? 0));

  if (estPR) {
    await sb.from("records").insert({
      exercice_id: exerciceId,
      type_record: typeRecord,
      valeur,
      reps,
      date: seance.date,
      seance_id: seance.id,
    });
  }
}

async function renderPRList() {
  const { data } = await sb.from("records").select("*, exercices(nom)").order("date", { ascending: false }).limit(6);
  if (!data || !data.length) {
    $("#pr-list").innerHTML = `<li class="empty-row">Aucun record pour l'instant.</li>`;
    return;
  }
  const labels = { poids_max: "Charge max", reps_max: "Reps max", calories_seance: "Calories sur une séance" };
  $("#pr-list").innerHTML = data.map((r) => {
    // Un record de charge s'affiche avec les reps tenues à cette charge : "24 kg × 9 reps"
    // Number() retire les décimales inutiles du numeric Postgres ("24.00" → 24)
    const v = Number(r.valeur);
    const valeur = r.type_record === "calories_seance"
      ? `${Math.round(v)}<small>kcal</small>`
      : r.type_record === "poids_max"
        ? `${v} kg${r.reps ? `<small>× ${r.reps} reps</small>` : ""}`
        : `${v}`;
    const titre = r.exercices ? r.exercices.nom : labels[r.type_record];
    const sous = r.exercices ? `${labels[r.type_record]} · ${ilYA(r.date)}` : ilYA(r.date);
    return `
    <li>
      <span class="pr-ico"><svg class="ico" aria-hidden="true"><use href="#i-trophy"/></svg></span>
      <span class="pr-txt"><span>${titre}</span><small>${sous}</small></span>
      <b class="pr-val">${valeur}</b>
    </li>
  `;
  }).join("");
}

// ---------------- SÉANCES DU JOUR ----------------

async function loadSeancesJour() {
  const { data } = await sb.from("seances").select("*").eq("user_id", state.user.id).eq("date", toDateStr()).order("created_at");
  state.seancesJour = data || [];
}

function labelSeance(s) {
  return s.type === "cardio" ? (s.notes === "circuit" ? "Circuit" : "Cardio") : "Musculation";
}

// Couleur d'une séance dans les listes : muscu (vert), circuit (jaune), cardio (orange).
const typeVisuel = (s) => s.type === "muscu" ? "muscu" : s.notes === "circuit" ? "circuit" : "cardio";

// Pavé de date des listes : le jour en gros, le mois abrégé dessous.
function pastilleDate(dStr) {
  const d = new Date(dStr);
  return `<span class="date-pill"><b>${d.getDate()}</b><small>${d.toLocaleDateString("fr-FR", { month: "short" }).replace(".", "")}</small></span>`;
}

// Mêmes chiffres que chiffresSeance, empilés : les calories en tête, le tonnage dessous.
function chiffresSeanceHtml(s) {
  const vol = Number(s.volume_kg || 0);
  return `<span class="histo-num"><b>${Math.round(s.calories_brulees)} kcal</b>${vol > 0 ? `<small>${formatVolume(vol)}</small>` : ""}</span>`;
}

// Chiffres d'une séance : le tonnage d'abord quand il existe, sinon les calories seules.
function chiffresSeance(s) {
  const vol = Number(s.volume_kg || 0);
  return `${vol > 0 ? formatVolume(vol) + " · " : ""}${Math.round(s.calories_brulees)} kcal`;
}

function renderSeancesJour() {
  const data = state.seancesJour;
  $("#seances-jour").innerHTML = data && data.length
    ? data.map((s) => {
        const label = labelSeance(s);
        return `<li class="seance-row is-${typeVisuel(s)}"><span class="histo-type">${label}<small>${Math.round(s.duree_min)} min</small></span><span class="row-end">${chiffresSeanceHtml(s)}<button type="button" class="row-del" data-id="${s.id}" data-label="${label}" aria-label="Supprimer cette séance de ${label.toLowerCase()}">✕</button></span></li>`;
      }).join("")
    : `<li class="empty-row">Aucune séance aujourd'hui.</li>`;
}

// ---------------- STREAK / SEMAINE ----------------

function startOfWeek(d) {
  const date = new Date(d);
  const day = (date.getDay() + 6) % 7; // lundi = 0
  date.setDate(date.getDate() - day);
  date.setHours(0, 0, 0, 0);
  return date;
}

async function loadSeancesSemaine() {
  const start = startOfWeek(new Date());
  const { data } = await sb.from("seances")
    .select("*")
    .eq("user_id", state.user.id)
    .gte("date", toDateStr(start))
    .eq("statut", "faite");
  state.seancesSemaine = data || [];
}

function renderStreak() {
  const start = startOfWeek(new Date());
  const joursFaits = new Set(state.seancesSemaine.map((s) => s.date));
  const todayStr = toDateStr();
  const labels = ["L", "M", "M", "J", "V", "S", "D"];
  let html = "";
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dStr = toDateStr(d);
    const done = joursFaits.has(dStr);
    const isToday = dStr === todayStr;
    html += `<div class="streak-dot ${done ? "done" : ""} ${isToday ? "today" : ""}">${labels[i]}</div>`;
  }
  $("#streak-dots").innerHTML = html;

  const fait = joursFaits.size;
  $("#streak-fait").textContent = fait;
  const objectif = Number(state.profil?.objectif_seances_semaine ?? SEANCES_SEMAINE_DEFAUT);
  $("#streak-objectif").textContent = objectif;

  // Tonnage de la semaine : la métrique qui bouge même quand la charge max, elle, ne bouge pas.
  const volume = state.seancesSemaine.reduce((s, x) => s + Number(x.volume_kg || 0), 0);
  $("#streak-volume").textContent = volume > 0 ? ` · ${formatVolume(volume)}` : "";

  const joursEcoules = ((new Date() - start) / 86400000) + 1;
  const joursRestants = 7 - joursEcoules;
  const msg = fait >= objectif
    ? "Objectif de la semaine atteint 💪"
    : (objectif - fait) > joursRestants
      ? "Le rythme prend du retard, resserre les séances"
      : "Continue comme ça.";
  $("#streak-message").textContent = msg;
}

// ---------------- CALORIES DU JOUR (brûlé métabolisme+sport / consommé / déficit) ----------------

// Au-delà de 1000 kcal/j, le budget plafonné au BMR rend l'objectif inatteignable par
// construction : on borne ici (et dans le Profil) plutôt que d'afficher une cible impossible.
const DEFICIT_MAX = 1000;
function objectifDeficit() {
  return Math.min(DEFICIT_MAX, Number(state.profil?.objectif_deficit_kcal ?? 500) || 500);
}

function noteActivite(act) {
  const r = Math.round;
  if (act.source === "sante") {
    if (act.kcalSeances > 0 && act.autre >= act.kcalSeances) {
      return `Santé a mesuré ${r(act.actif)} kcal d'énergie active : la séance de l'app (${r(act.kcalSeances)} kcal) y est déjà comprise, elle n'est pas ajoutée en plus.`;
    }
    if (act.kcalSeances > 0) {
      return `Santé a mesuré ${r(act.actif)} kcal d'énergie active sans capter toute la séance : l'estimation de l'app (${r(act.kcalSeances)} kcal) est retenue à la place.`;
    }
    return act.autre > 30
      ? `Santé : ${r(act.actif)} kcal d'énergie active, dont ${r(act.autre)} kcal hors marche.`
      : `Santé : ${r(act.actif)} kcal d'énergie active.`;
  }
  if (act.source === "sante_sans_pas") return `Santé : ${r(act.actif)} kcal sans le nombre de pas — la séance de l'app est ajoutée telle quelle.`;
  return "Marche estimée depuis ton niveau d'activité (Profil) — la mesure Santé arrive avec la synchro du soir.";
}

// L'anneau se remplit vers l'objectif de déficit ; un surplus le colore en entier, en orange.
function setDeficitRing(pct, surplus) {
  $("#deficit-ring").style.strokeDashoffset = String(100 - Math.max(0, Math.min(100, pct)));
  $("#hero-ring").classList.toggle("is-surplus", surplus);
  $("#hero-ring").classList.toggle("is-done", !surplus && pct >= 100);
  $("#hero-ring").classList.toggle("is-empty", pct <= 0); // sinon le bout arrondi laisse un point
}

function renderGauge() {
  renderNutrition();
  const b = bilanJour({
    nutrition: state.nutritionJour,
    activite: state.activiteJour,
    seances: state.seancesJour,
    poidsKg: dernierPoids() || 80,
  });
  const { base, act, brule, consomme, objectif, budget } = b;

  // Barre "Brûlé" : segments empilés métabolisme + marche + sport
  const scaleMax = Math.max(brule, 200) * 1.15;
  $("#brule-meta-seg").style.width = `${(base / scaleMax) * 100}%`;
  $("#brule-marche-seg").style.width = `${(act.marche / scaleMax) * 100}%`;
  $("#brule-sport-seg").style.width = `${(act.sport / scaleMax) * 100}%`;
  $("#brule-total-value").textContent = `${Math.round(brule)} kcal`;
  $("#leg-meta").textContent = `${Math.round(base)} kcal`;
  const pasNote = act.pas != null ? ` (${act.pas.toLocaleString("fr-FR")} pas)` : act.source === "estimation" ? " (estimé)" : "";
  $("#leg-marche").textContent = `${Math.round(act.marche)} kcal${pasNote}`;
  $("#leg-sport").textContent = `${Math.round(act.sport)} kcal`;
  $("#brule-note").textContent = noteActivite(act);

  $("#budget-value").textContent = Math.round(budget);
  $("#deficit-objectif-label").textContent = objectif;
  $("#hero-brule").textContent = Math.round(brule).toLocaleString("fr-FR");
  $("#hero-mange").textContent = consomme == null ? "—" : Math.round(consomme).toLocaleString("fr-FR");
  $("#hero-pas").textContent = act.pas != null ? act.pas.toLocaleString("fr-FR") : "—";

  if (consomme == null) {
    // Pas de donnée = pas de bilan. Surtout pas « 0 kcal mangé, objectif atteint ».
    $("#consomme-seg").style.width = "0%";
    $("#consomme-seg").classList.remove("over-budget");
    $("#consomme-value").textContent = "—";
    $("#budget-note").textContent = "En attente de la synchro du soir. Tu peux aussi saisir tes calories dans l'onglet Nutrition.";
    setDeficitRing(0, false);
    $("#gauge-value").textContent = "—";
    $("#hero-ring-label").textContent = "kcal de déficit";
    $("#deficit-note").textContent = "Bilan du jour indisponible tant que le consommé n'est pas connu.";
    return;
  }

  // Barre "Consommé" : comparée à un budget = brûlé − objectif de déficit, plancher au BMR.
  const deficit = brule - consomme;
  $("#consomme-seg").style.width = `${Math.min(100, (consomme / (budget || 1)) * 100)}%`;
  $("#consomme-seg").classList.toggle("over-budget", consomme > budget);
  $("#consomme-value").textContent = Math.round(consomme);
  $("#budget-note").textContent = b.budgetPlancher
    ? "Budget limité à ton métabolisme de base par sécurité"
    : act.sport > 0
      ? `Budget ajusté grâce au sport : +${Math.round(act.sport)} kcal`
      : "";

  // Barre "Déficit du jour" : progression vers l'objectif (réglable dans Profil, plafonné)
  const deficitPct = Math.max(0, Math.min(100, (deficit / objectif) * 100));
  setDeficitRing(deficit < 0 ? 100 : deficitPct, deficit < 0);
  $("#gauge-value").textContent = Math.abs(Math.round(deficit)).toLocaleString("fr-FR");
  $("#hero-ring-label").textContent = deficit < 0 ? "kcal de surplus" : "kcal de déficit";
  $("#deficit-note").textContent = b.partiel
    ? `Seulement ${Math.round(consomme)} kcal saisies : journée probablement saisie à moitié, le déficit affiché n'est pas fiable.`
    : deficit < 0
      ? `Surplus de ${Math.round(-deficit)} kcal aujourd'hui`
      : deficit >= objectif
        ? "Objectif de déficit atteint 🎯"
        : `Encore ${Math.round(objectif - deficit)} kcal pour atteindre l'objectif`;
}

// ---------------- BILAN DES 7 DERNIERS JOURS ----------------
// Le bilan « du jour » n'est juste qu'après la synchro du soir ; c'est la moyenne sur la
// semaine, sur les seuls jours complets, qui dit vraiment si le poids va bouger.

function renderBilan7() {
  const { nutrition, activite, seances } = state.histoJours;
  const lignes = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const ds = toDateStr(d);
    const b = bilanJour({
      nutrition: nutrition.find((x) => x.date === ds),
      activite: activite.find((x) => x.date === ds),
      seances: seances.filter((x) => x.date === ds),
      poidsKg: poidsADate(ds),
    });
    lignes.push({ ds, d, b });
  }
  const complets = lignes.filter((l) => l.b.complet && !l.b.partiel);
  const partiels = lignes.filter((l) => l.b.partiel).length;
  const moyenne = complets.length ? complets.reduce((s, l) => s + l.b.deficit, 0) / complets.length : null;
  const n = complets.length, manquants = 7 - n - partiels;

  $("#bilan7-moyenne").textContent = moyenne == null ? "—" : `${moyenne >= 0 ? "−" : "+"}${Math.abs(Math.round(moyenne))} kcal/j`;
  $("#bilan7-moyenne").classList.toggle("is-surplus", moyenne != null && moyenne < 0);
  $("#bilan7-sub").textContent = moyenne == null
    ? "Aucun jour complet sur les 7 derniers : sans calories consommées, pas de bilan."
    : `Déficit moyen sur ${n} jour${n > 1 ? "s" : ""} renseigné${n > 1 ? "s" : ""} ≈ ${fmtKg(moyenne * 7 / KCAL_PAR_KG, 2)} kg/semaine théorique`
      + (manquants ? ` · ${manquants} jour${manquants > 1 ? "s" : ""} sans donnée nutrition` : "")
      + (partiels ? ` · ${partiels} jour${partiels > 1 ? "s" : ""} à saisie partielle (< ${CONSOMME_MIN_PLAUSIBLE} kcal)` : "")
      + (manquants || partiels ? ", exclus de la moyenne" : "");

  // Les barres partagent une même échelle : le plus gros écart de la semaine fait toute la largeur.
  const echelle = Math.max(1, ...complets.map((l) => Math.abs(l.b.deficit)));
  $("#bilan7-list").innerHTML = lignes.map(({ d, b }, i) => {
    const jour = i === 0 ? "Hier" : d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" });
    const sport = b.act.sport > 0 ? ` · sport ${Math.round(b.act.sport)}` : "";
    const fiable = b.complet && !b.partiel;
    const classe = fiable ? (b.deficit >= 0 ? "ok" : "warn") : "incomplet";
    const val = !b.complet ? "incomplet" : b.partiel ? "partiel ?" : `${b.deficit >= 0 ? "−" : "+"}${Math.abs(Math.round(b.deficit))}`;
    const largeur = fiable ? Math.max(4, (Math.abs(b.deficit) / echelle) * 100) : 0;
    return `<li>
      <span class="b7-jour">${jour}</span>
      <span class="b7-bar"><i class="${classe}" style="width:${largeur}%"></i></span>
      <b class="${classe}">${val}</b>
      <small class="b7-detail">brûlé ${Math.round(b.brule)}${sport} · mangé ${b.complet ? Math.round(b.consomme) : "—"}</small>
    </li>`;
  }).join("");
}

function renderJourney() {
  const objectif = poidsObjectif();
  const depart = poidsDepart();
  const poids = dernierPoids() ?? depart;
  const totalAPerdre = depart && objectif ? depart - objectif : 0;
  const perdu = depart && poids ? depart - poids : 0;
  const pct = totalAPerdre > 0 ? Math.max(0, Math.min(100, (perdu / totalAPerdre) * 100)) : 0;

  $("#journey-fill").style.width = `${pct}%`;
  $("#journey-marker").style.left = `${pct}%`;
  $("#journey-marker-value").textContent = poids ? fmtKg(poids) : "—";
  $("#journey-pct").textContent = objectif ? `${Math.round(pct)}%` : "—";
  $("#journey-depart-label").textContent = `${depart ? fmtKg(depart) : "—"} kg`;
  $("#journey-objectif-label").textContent = `${objectif ? fmtKg(objectif) : "—"} kg`;
}

// ---------------- HEATMAP (12 semaines) ----------------

async function renderHeatmap() {
  const start = new Date();
  start.setDate(start.getDate() - 12 * 7);
  const { data } = await sb.from("seances")
    .select("date")
    .eq("user_id", state.user.id)
    .eq("statut", "faite")
    .gte("date", toDateStr(start));

  const counts = {};
  (data || []).forEach((s) => { counts[s.date] = (counts[s.date] || 0) + 1; });

  const weekStart = startOfWeek(start);
  let html = "";
  for (let w = 0; w < 12; w++) {
    html += `<div class="hm-week">`;
    for (let d = 0; d < 7; d++) {
      const day = new Date(weekStart);
      day.setDate(day.getDate() + w * 7 + d);
      const key = toDateStr(day);
      const c = counts[key] || 0;
      const level = c === 0 ? 0 : c === 1 ? 1 : c === 2 ? 2 : 3;
      html += `<div class="hm-cell hm-${level}" title="${key} — ${c} séance(s)"></div>`;
    }
    html += `</div>`;
  }
  $("#heatmap").innerHTML = html;
}

// ---------------- HISTORIQUE DES SÉANCES ----------------
// Une ligne par séance, dépliable pour retrouver ce qui a été fait ce jour-là.
// Le détail n'est chargé qu'à l'ouverture, et une seule fois.

async function renderHistoSeances() {
  const { data } = await sb.from("seances")
    .select("*")
    .eq("user_id", state.user.id)
    .order("date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(40);

  $("#histo-seances").innerHTML = data && data.length
    ? data.map((s) => `
      <li data-id="${s.id}" data-type="${s.type}" data-date="${s.date}" data-label="${labelSeance(s)}" class="is-${typeVisuel(s)}">
        <button type="button" class="histo-head" aria-expanded="false">
          ${pastilleDate(s.date)}
          <span class="histo-type">${labelSeance(s)}<small>${Math.round(s.duree_min)} min</small></span>
          ${chiffresSeanceHtml(s)}
          <svg class="ico histo-caret" aria-hidden="true"><use href="#i-chevron"/></svg>
        </button>
        <div class="histo-detail" hidden></div>
      </li>`).join("")
    : `<li class="empty-row">Aucune séance enregistrée.</li>`;
}

$("#histo-seances").addEventListener("click", async (e) => {
  const head = e.target.closest(".histo-head");
  if (head) return ouvrirHistoDetail(head);
  const del = e.target.closest(".hd-del");
  if (del) supprimerSeance(del.dataset.id, del.dataset.label);
  const redo = e.target.closest(".hd-redo");
  if (redo) refaireSeance(redo.dataset.id, redo.dataset.date);
});

async function ouvrirHistoDetail(head) {
  const li = head.closest("li");
  const detail = li.querySelector(".histo-detail");
  const ouvert = head.getAttribute("aria-expanded") === "true";
  head.setAttribute("aria-expanded", String(!ouvert));
  detail.hidden = ouvert;
  if (ouvert || detail.dataset.loaded) return;
  detail.dataset.loaded = "1";

  const seanceId = li.dataset.id;
  const label = li.dataset.label;
  const { data } = await sb.from("series")
    .select("repetitions, poids_kg, numero_serie, exercices(nom)")
    .eq("seance_id", seanceId)
    .order("numero_serie");

  // Regroupé par exercice : sur un circuit ou un superset, les séries alternent,
  // et une ligne par exercice se lit bien mieux qu'une ligne par série.
  const parExercice = new Map();
  (data || []).forEach((s) => {
    const nom = s.exercices?.nom || "Exercice";
    const set = s.poids_kg ? `${Number(s.poids_kg)}×${s.repetitions}` : `${s.repetitions}`;
    if (!parExercice.has(nom)) parExercice.set(nom, []);
    parExercice.get(nom).push(set);
  });

  const lignes = [...parExercice].map(([nom, sets]) =>
    `<div class="hd-row"><span>${nom}</span><b>${sets.join(", ")}</b></div>`).join("");

  const peutRefaire = li.dataset.type === "muscu" && (data || []).length > 0;
  detail.innerHTML = (lignes || `<div class="hd-row"><span>Pas de série détaillée</span></div>`) +
    `<div class="hd-foot">` +
      (peutRefaire ? `<button type="button" class="hd-redo" data-id="${seanceId}" data-date="${li.dataset.date}">Refaire cette séance</button>` : "") +
      `<button type="button" class="hd-del" data-id="${seanceId}" data-label="${label}">Supprimer la séance</button>` +
    `</div>`;
}

// ---------------- PROGRESSION DE FORCE ----------------

$("#force-exercice").addEventListener("change", renderForceChart);

// Le suivi des records se règle ici, sur l'exercice qu'on est en train de regarder :
// c'est le seul écran où la question « est-ce que je veux suivre ma force là-dessus ? » se pose.
function renderForceSuivi() {
  const ex = state.exercices.find((x) => x.id === $("#force-exercice").value);
  const btn = $("#force-suivi");
  btn.hidden = !ex;
  if (!ex) return;
  const actif = !!ex.suivi_record;
  btn.setAttribute("aria-pressed", String(actif));
  btn.querySelector(".suivi-star").textContent = actif ? "★" : "☆";
  $("#force-suivi-label").textContent = actif ? "Records suivis" : "Suivre les records";
}

$("#force-suivi").addEventListener("click", async () => {
  const ex = state.exercices.find((x) => x.id === $("#force-exercice").value);
  if (!ex) return;
  const actif = !ex.suivi_record;
  const { error } = await sb.from("exercices").update({ suivi_record: actif }).eq("id", ex.id);
  if (error) { showToast("Erreur : " + error.message); return; }
  ex.suivi_record = actif;
  renderForceSuivi();
  showToast(actif ? "Records suivis sur cet exercice ★" : "Suivi des records désactivé");
});

async function renderForceChart() {
  renderForceSuivi();
  const exerciceId = $("#force-exercice").value;
  if (!exerciceId) return;
  const { data } = await sb.from("series")
    .select("poids_kg, repetitions, created_at, seances!inner(user_id, date)")
    .eq("exercice_id", exerciceId)
    .eq("seances.user_id", state.user.id)
    .order("created_at");

  // Par jour : charge max, 1RM estimé (Epley : charge × (1 + reps/30)) et tonnage.
  // Le tonnage bouge quand la charge max stagne (3×8 → 4×10) ; le 1RM estimé récompense
  // les reps gagnées à charge égale.
  const parJour = {};
  (data || []).forEach((s) => {
    const jour = s.seances.date;
    const w = Number(s.poids_kg || 0), r = Number(s.repetitions || 0);
    const d = (parJour[jour] = parJour[jour] || { max: 0, e1rm: 0, tonnage: 0 });
    d.max = Math.max(d.max, w);
    d.e1rm = Math.max(d.e1rm, w * (1 + r / 30));
    d.tonnage += w * r;
  });
  const labels = Object.keys(parJour).sort();
  const r1 = (v) => Math.round(v * 10) / 10;

  if (state.chartForce) state.chartForce.destroy();
  state.chartForce = new Chart($("#chart-force"), {
    type: "line",
    data: {
      labels: labels.map(formatDate),
      datasets: [
        { label: "Charge max (kg)", data: labels.map((d) => parJour[d].max), borderColor: "#FF5A36", backgroundColor: "rgba(255,90,54,0.08)", fill: true, tension: 0.3, yAxisID: "y" },
        { label: "1RM estimé (kg)", data: labels.map((d) => r1(parJour[d].e1rm)), borderColor: "#FFC24B", borderDash: [4, 4], pointRadius: 2, tension: 0.3, yAxisID: "y" },
        { label: "Tonnage (kg)", data: labels.map((d) => Math.round(parJour[d].tonnage)), borderColor: "#6EE7B7", pointRadius: 2, tension: 0.3, yAxisID: "y1" },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: true, labels: { color: "#8A948F", boxWidth: 10, font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: "#8A948F", maxTicksLimit: 6 }, grid: { color: "#263230" } },
        y: { position: "left", ticks: { color: "#8A948F" }, grid: { color: "#263230" } },
        y1: { position: "right", ticks: { color: "#6EE7B7" }, grid: { drawOnChartArea: false } },
      },
    },
  });
}

// ---------------- UTILS ----------------

function formatDate(dStr) {
  return new Date(dStr).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

// ---------------- REFRESH GLOBAL ----------------

async function refreshAll() {
  await loadPoids();
  await Promise.all([loadSeancesSemaine(), loadSeancesJour(), loadHistoJours(), loadReprises()]);
  renderProfilHint();
  renderPoidsList();
  renderWeightChart();
  renderJourney();
  estimationETA();
  renderStreak();
  renderGauge();
  renderHydratation();
  renderBilan7();
  await renderPRList();
  renderSeancesJour();
  renderReprises();
  renderProgrammeJour();
  ensureInitialMuscuBlock();
  updateCardioCalc();
  updateCircuitCalc();
}
