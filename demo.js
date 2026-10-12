// ============================================================
// Démo — l'app entière sur des données fictives, sans compte ni serveur
// ============================================================
// creerClientDemo() renvoie un faux client Supabase : mêmes appels (from/select/insert/…,
// rpc, auth) que ceux de app.js, servis depuis une base en mémoire. Rien ne quitte le
// navigateur, rien n'est enregistré : recharger la page relance une démo neuve. Elle
// fonctionne donc aussi quand le projet Supabase est en pause.

const DEMO_USER = { id: "demo", email: "demo@sport.invalid", is_demo: true };

// Catalogue de départ (copie de la table exercices_modele) : [nom, type, groupe, MET, suivi des records]
const DEMO_CATALOGUE = [
  ["Corde à sauter", "cardio", "full_body", 11, false], ["Course", "cardio", "full_body", 9, false],
  ["Escalier", "cardio", "full_body", 8, false], ["Marche", "cardio", "full_body", 3.5, false],
  ["Burpees", "mixte", "full_body", 8, false], ["Corde ondulatoire", "mixte", "full_body", 8, false],
  ["Planche", "muscu", "abdos", 3, false],
  ["Curl poignets à la barre", "muscu", "avant_bras", 3, false], ["Curl poignets inversé", "muscu", "avant_bras", 3, false],
  ["Marche du fermier", "muscu", "avant_bras", 5, false], ["Pince à main", "muscu", "avant_bras", 3, false],
  ["Reverse curl", "muscu", "avant_bras", 3.5, false], ["Rotation de poignet", "muscu", "avant_bras", 3, false],
  ["Rouleau à poignet", "muscu", "avant_bras", 3, false], ["Suspension à la barre", "muscu", "avant_bras", 3.5, false],
  ["Curl à la poulie", "muscu", "biceps", 3.5, false], ["Curl barre", "muscu", "biceps", 3.5, false],
  ["Curl haltères", "muscu", "biceps", 3.5, false], ["Curl marteau", "muscu", "biceps", 3.5, false],
  ["Rowing", "muscu", "dos", 5, false], ["Soulevé de terre", "muscu", "dos", 6, true], ["T-bar row", "muscu", "dos", 5, false],
  ["Tirage horizontal bilatéral", "muscu", "dos", 4.5, false], ["Tirage horizontal unilatéral", "muscu", "dos", 4, false],
  ["Tirage vertical bilatéral", "muscu", "dos", 4.5, false], ["Tirage vertical unilatéral", "muscu", "dos", 4, false],
  ["Développé Arnold", "muscu", "epaules", 5, false], ["Développé militaire", "muscu", "epaules", 5, true],
  ["Élévation latérale", "muscu", "epaules", 3.5, false], ["Oiseau haltères", "muscu", "epaules", 3.5, false],
  ["Développé couché barre", "muscu", "pecs", 6, true], ["Développé couché haltères", "muscu", "pecs", 6, true],
  ["Développé couché incliné", "muscu", "pecs", 6, false], ["Dips assistées", "muscu", "pecs", 4.5, false],
  ["Dips au corps", "muscu", "pecs", 5, false], ["Dips machine", "muscu", "pecs", 4, false], ["Pec fly", "muscu", "pecs", 3.5, false],
  ["Pompes", "muscu", "pecs", 8, false], ["Barre au front", "muscu", "triceps", 3.5, false], ["Dips sur banc", "muscu", "triceps", 4, false],
  ["Triceps poulie barre droite", "muscu", "triceps", 3.5, false], ["Triceps poulie corde", "muscu", "triceps", 3.5, false],
];

// Séances de muscu de la démo : [nom, séries, reps, charge au début, charge à la fin, pas de charge, repos (s)]
const DEMO_MUSCU = {
  push: [
    ["Développé couché barre", 4, 8, 60, 72.5, 2.5, 150], ["Développé couché incliné", 3, 10, 16, 20, 2, 120],
    ["Développé militaire", 3, 8, 30, 37.5, 2.5, 120], ["Élévation latérale", 3, 12, 8, 10, 1, 90],
    ["Triceps poulie corde", 3, 12, 20, 25, 2.5, 90],
  ],
  pull: [
    ["Soulevé de terre", 3, 5, 90, 110, 5, 180], ["Tirage vertical bilatéral", 4, 10, 50, 60, 5, 120],
    ["Rowing", 3, 10, 50, 60, 2.5, 120], ["Curl barre", 3, 10, 25, 30, 2.5, 90], ["Curl marteau", 3, 12, 12, 14, 2, 60],
  ],
  haut: [
    ["Développé couché haltères", 4, 10, 24, 28, 2, 120], ["Tirage horizontal bilatéral", 4, 12, 45, 55, 5, 120],
    ["Développé Arnold", 3, 10, 16, 20, 2, 90], ["Dips au corps", 3, 8, 0, 0, 1, 90], ["Oiseau haltères", 3, 12, 8, 10, 1, 60],
  ],
};
const DEMO_CIRCUIT = { tours: 4, reposExo: 15, reposTour: 60, exos: [["Burpees", 12], ["Pompes", 15], ["Corde ondulatoire", 30]] };

// Générateur pseudo-aléatoire à graine fixe : la même démo pour tout le monde.
function demoAleatoire(graine) {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function demoDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 10 semaines d'entraînement, de pesées et de nutrition, dans les tables de l'app.
function genererDonneesDemo() {
  const random = demoAleatoire(42);
  const U = DEMO_USER.id;
  let n = 0;
  const id = (prefixe) => `${prefixe}-${++n}`;
  const db = { exercices: [], profil: [], poids: [], seances: [], series: [], records: [], nutrition_jour: [], activite_jour: [], programme_jours: [] };

  for (const [nom, type, groupe_musculaire, met, suivi_record] of DEMO_CATALOGUE) {
    db.exercices.push({ id: id("ex"), user_id: U, nom, type, groupe_musculaire, met, suivi_record, created_at: new Date().toISOString() });
  }
  const exo = (nom) => db.exercices.find((x) => x.nom === nom);

  const NB_JOURS = 70, POIDS_DEPART = 94, PERTE = 6.3, KCAL = (met, pc, min) => (met - 1) * pc * 3.5 / 200 * min;
  db.profil.push({
    user_id: U, age: 29, taille_cm: 178, sexe: "homme", poids_depart_kg: POIDS_DEPART, poids_objectif_kg: 82,
    objectif_deficit_kcal: 500, objectif_seances_semaine: 5, facteur_activite: 1.375, api_key: "cle-de-demonstration",
  });

  const aujourdhui = new Date(); aujourdhui.setHours(0, 0, 0, 0);
  const jourJ = (d) => { const x = new Date(aujourdhui); x.setDate(x.getDate() - d); return x; };
  const poidsCorps = (d) => POIDS_DEPART - PERTE * (NB_JOURS - 1 - d) / (NB_JOURS - 1);

  function record(seance, exerciceId, type_record, valeur, reps = null) {
    const meilleurs = db.records.filter((r) => r.type_record === type_record && r.exercice_id === exerciceId);
    const bat = !meilleurs.length || meilleurs.every((r) => valeur > r.valeur || (reps != null && valeur === r.valeur && reps > (r.reps ?? 0)));
    if (bat) db.records.push({ id: id("rec"), user_id: U, exercice_id: exerciceId, type_record, valeur, reps, date: seance.date, seance_id: seance.id, created_at: seance.created_at });
  }

  for (let d = NB_JOURS - 1; d >= 0; d--) {
    const jour = jourJ(d);
    const date = demoDateStr(jour);
    const prog = (NB_JOURS - 1 - d) / (NB_JOURS - 1);
    const pc = poidsCorps(d);
    const ts = new Date(jour.getTime() + 18.5 * 3600 * 1000).toISOString();

    // Pesée environ 2 jours sur 3, avec le bruit habituel (eau, glycogène).
    if (d === 0 || random() >= 0.3) db.poids.push({ id: id("p"), user_id: U, date, valeur_kg: Math.round((pc + (random() - 0.5) * 0.9) * 10) / 10 });

    // La séance du jour reste à faire : c'est elle que la démo propose de lancer.
    if (d === 0) continue;
    const programme = { 1: "push", 2: "cardio", 4: "pull", 5: "circuit", 6: "haut" }[jour.getDay() || 7];
    if (!programme || random() < 0.08) continue; // quelques séances sautées, comme en vrai

    const seance = { id: id("s"), user_id: U, date, statut: "faite", created_at: ts, notes: null, volume_kg: 0 };
    db.seances.push(seance);

    if (programme === "cardio") {
      const corde = Math.floor(d / 7) % 3 === 0;
      const ex = exo(corde ? "Corde à sauter" : "Course");
      const duree = corde ? 12 + Math.floor(random() * 7) : 26 + Math.floor(random() * 15);
      Object.assign(seance, { type: "cardio", duree_min: duree, calories_brulees: Math.round(KCAL(ex.met, pc, duree)) });
      record(seance, ex.id, "calories_seance", seance.calories_brulees);
      continue;
    }

    let cal = 0, duree = 0, volume = 0, num = 0;
    if (programme === "circuit") {
      for (let t = 0; t < DEMO_CIRCUIT.tours; t++) {
        for (const [nom, reps] of DEMO_CIRCUIT.exos) {
          const ex = exo(nom);
          db.series.push({ id: id("se"), seance_id: seance.id, exercice_id: ex.id, numero_serie: ++num, repetitions: reps, poids_kg: null, pause_sec: DEMO_CIRCUIT.reposExo, created_at: ts });
          const min = (reps * 3 + DEMO_CIRCUIT.reposExo) / 60;
          cal += KCAL(ex.met, pc, min); duree += min;
        }
      }
      const reposTours = DEMO_CIRCUIT.reposTour * (DEMO_CIRCUIT.tours - 1) / 60;
      cal += KCAL(1.5, pc, reposTours); duree += reposTours;
      Object.assign(seance, { type: "cardio", notes: "circuit" });
    } else {
      // Musculation : charges en progression régulière sur les 10 semaines.
      for (const [nom, nb, repsBase, c0, c1, pas, pause] of DEMO_MUSCU[programme]) {
        const ex = exo(nom);
        const charge = Math.floor((c0 + (c1 - c0) * prog) / pas) * pas;
        let repsCharge = 0;
        for (let s = 1; s <= nb; s++) {
          // Au poids du corps, on progresse en répétitions ; la dernière série flanche parfois.
          const r = repsBase + (charge === 0 ? Math.floor(4 * prog) : 0) - (s === nb && random() < 0.5 ? 1 + Math.floor(random() * 2) : 0);
          repsCharge = Math.max(repsCharge, r);
          db.series.push({ id: id("se"), seance_id: seance.id, exercice_id: ex.id, numero_serie: ++num, repetitions: r, poids_kg: charge, pause_sec: pause, created_at: ts });
          const min = (r * 3 + pause) / 60;
          cal += KCAL(ex.met, pc, min); duree += min; volume += r * charge;
        }
        if (ex.suivi_record && charge > 0) record(seance, ex.id, "poids_max", charge, repsCharge);
      }
      seance.type = "muscu";
    }
    Object.assign(seance, { duree_min: Math.round(duree * 100) / 100, calories_brulees: Math.round(cal), volume_kg: volume });
    record(seance, null, "calories_seance", seance.calories_brulees);
  }

  // Nutrition et activité des 14 derniers jours, comme si le raccourci iOS tournait chaque soir.
  // Il y a 4 jours : rien de saisi (jour « incomplet ») ; il y a 6 jours : un écart.
  for (let d = 0; d <= 13; d++) {
    const date = demoDateStr(jourJ(d));
    const pc = poidsCorps(d);
    const sport = db.seances.filter((s) => s.date === date).reduce((t, s) => t + s.calories_brulees, 0);
    const pas = d === 0 ? 7400 : 6500 + Math.floor(random() * 6000);
    db.activite_jour.push({
      user_id: U, date, pas, distance_km: Math.round(pas * 0.075) / 100, source: "sante_shortcut",
      calories_marche: Math.round(pas * pc * 0.0004 + sport * (0.55 + random() * 0.6) + random() * 25),
    });
    if (d === 4) continue;
    db.nutrition_jour.push({
      user_id: U, date, source: "yazio_shortcut",
      calories: d === 0 ? 1680 : d === 6 ? 2640 : Math.round(1900 + (random() - 0.5) * 400),
      proteines_g: d === 0 ? 112 : Math.round(115 + random() * 50),
      eau_litres: d === 0 ? 1.7 : Math.round((1.8 + random() * 1.1) * 10) / 10,
    });
  }

  // Programme de la semaine, calqué sur l'historique ci-dessus.
  const series = (prog) => DEMO_MUSCU[prog].flatMap(([nom, nb, reps, , , , pause]) =>
    Array.from({ length: nb }, () => ({ exercice_id: exo(nom).id, reps, pause_sec: pause })));
  const repos = { type: "libre", texte: "Marche ou mobilité (optionnel)" };
  db.programme_jours.push(
    { id: id("pj"), user_id: U, jour: 1, nom: "Push", orientation: "Force", muscu: series("push"), cardio: { type: "cardio", exercice_id: exo("Marche").id, duree: 15 } },
    { id: id("pj"), user_id: U, jour: 2, nom: "Cardio", orientation: "Endurance", muscu: [], cardio: { type: "cardio", exercice_id: exo("Course").id, duree: 30 } },
    { id: id("pj"), user_id: U, jour: 3, nom: "Repos", orientation: null, muscu: [], cardio: repos },
    { id: id("pj"), user_id: U, jour: 4, nom: "Pull", orientation: "Force", muscu: series("pull"), cardio: { type: "cardio", exercice_id: exo("Marche").id, duree: 15 } },
    { id: id("pj"), user_id: U, jour: 5, nom: "Circuit", orientation: "Cardio", muscu: [], cardio: {
      type: "circuit", nom: "Circuit · 4 tours", rounds: DEMO_CIRCUIT.tours, repos_exo: DEMO_CIRCUIT.reposExo, repos_tour: DEMO_CIRCUIT.reposTour,
      exos: DEMO_CIRCUIT.exos.map(([nom, reps]) => ({ exercice_id: exo(nom).id, reps })),
    } },
    { id: id("pj"), user_id: U, jour: 6, nom: "Haut du corps", orientation: "Volume", muscu: series("haut"), cardio: repos },
    { id: id("pj"), user_id: U, jour: 7, nom: "Repos", orientation: null, muscu: [], cardio: repos },
  );
  return db;
}

// ---------------- Faux client Supabase ----------------

function creerClientDemo() {
  const db = genererDonneesDemo();
  let n = 0;
  const nouvelId = () => `demo-${Date.now().toString(36)}-${++n}`;

  // Jointures utilisées par app.js : « exercices(nom) », « seances!inner(date) », « series(…) »
  const RELATIONS = {
    records: { exercices: ["un", "exercices", "exercice_id"] },
    series: { seances: ["un", "seances", "seance_id"], exercices: ["un", "exercices", "exercice_id"] },
    seances: { series: ["plusieurs", "series", "seance_id"] },
  };
  const CLES_UPSERT = { profil: ["user_id"], poids: ["user_id", "date"], nutrition_jour: ["user_id", "date"], activite_jour: ["user_id", "date"] };
  const SANS_USER_ID = ["series"];

  class Requete {
    constructor(table) {
      this.table = table; this.op = "select"; this.colonnes = "*"; this.renvoie = false;
      this.filtres = []; this.tris = []; this.max = null; this.unique = null;
    }
    select(colonnes = "*") { if (this.op === "select") this.colonnes = colonnes; else { this.renvoie = true; this.colonnes = colonnes; } return this; }
    insert(v) { this.op = "insert"; this.valeurs = [].concat(v); return this; }
    upsert(v, opts) { this.op = "upsert"; this.valeurs = [].concat(v); this.conflit = opts?.onConflict?.split(",") || CLES_UPSERT[this.table] || ["id"]; return this; }
    update(v) { this.op = "update"; this.patch = v; return this; }
    delete() { this.op = "delete"; return this; }
    // Un filtre sur une table jointe (« seances.user_id ») est toujours vrai : tout appartient à la démo.
    eq(k, v) { if (!k.includes(".")) this.filtres.push((r) => String(r[k]) === String(v)); return this; }
    neq(k, v) { this.filtres.push((r) => String(r[k]) !== String(v)); return this; }
    is(k, v) { this.filtres.push((r) => (v === null ? r[k] == null : r[k] === v)); return this; }
    in(k, vs) { this.filtres.push((r) => vs.map(String).includes(String(r[k]))); return this; }
    gte(k, v) { this.filtres.push((r) => r[k] >= v); return this; }
    lte(k, v) { this.filtres.push((r) => r[k] <= v); return this; }
    gt(k, v) { this.filtres.push((r) => r[k] > v); return this; }
    lt(k, v) { this.filtres.push((r) => r[k] < v); return this; }
    order(k, { ascending = true } = {}) { this.tris.push([k, ascending ? 1 : -1]); return this; }
    limit(nb) { this.max = nb; return this; }
    single() { this.unique = "single"; return this; }
    maybeSingle() { this.unique = "maybe"; return this; }
    then(ok, ko) { return Promise.resolve().then(() => this.executer()).then(ok, ko); }

    lignes() { return (db[this.table] ||= []); }
    trouve() { return this.lignes().filter((r) => this.filtres.every((f) => f(r))); }
    completer(v) {
      const r = { id: nouvelId(), created_at: new Date().toISOString(), ...v };
      if (!SANS_USER_ID.includes(this.table) && r.user_id == null) r.user_id = DEMO_USER.id;
      if (this.table === "exercices" && r.suivi_record == null) r.suivi_record = false;
      return r;
    }
    projeter(r) {
      const copie = { ...r };
      const relations = RELATIONS[this.table] || {};
      for (const [, nom] of this.colonnes.matchAll(/(\w+)(?:!inner)?\(/g)) {
        const rel = relations[nom];
        if (!rel) continue;
        const [genre, cible, cle] = rel;
        copie[nom] = genre === "un"
          ? ((db[cible] || []).find((x) => x.id === r[cle]) ? { ...(db[cible] || []).find((x) => x.id === r[cle]) } : null)
          : (db[cible] || []).filter((x) => x[cle] === r.id).map((x) => ({ ...x }));
      }
      return copie;
    }
    executer() {
      let res;
      if (this.op === "insert") {
        res = this.valeurs.map((v) => this.completer(v));
        this.lignes().push(...res);
      } else if (this.op === "upsert") {
        res = this.valeurs.map((v) => {
          const neuf = this.completer(v);
          const existant = this.lignes().find((r) => this.conflit.every((k) => String(r[k]) === String(neuf[k])));
          if (existant) { Object.assign(existant, v); return existant; }
          this.lignes().push(neuf);
          return neuf;
        });
      } else if (this.op === "update") {
        res = this.trouve();
        res.forEach((r) => Object.assign(r, this.patch));
      } else if (this.op === "delete") {
        res = this.trouve();
        db[this.table] = this.lignes().filter((r) => !res.includes(r));
        if (this.table === "seances") { // même cascade qu'en base : séries et records suivent
          const ids = new Set(res.map((r) => r.id));
          db.series = db.series.filter((r) => !ids.has(r.seance_id));
          db.records = db.records.filter((r) => !ids.has(r.seance_id));
        }
      } else {
        res = this.trouve();
      }

      if (this.op !== "select" && !this.renvoie) return { data: null, error: null };
      if (this.tris.length) {
        res = [...res].sort((a, b) => {
          for (const [k, sens] of this.tris) {
            if (a[k] === b[k]) continue;
            if (a[k] == null) return 1;
            if (b[k] == null) return -1;
            return (a[k] > b[k] ? 1 : -1) * sens;
          }
          return 0;
        });
      }
      if (this.max != null) res = res.slice(0, this.max);
      const data = res.map((r) => this.projeter(r));
      if (this.unique === "single") return data.length ? { data: data[0], error: null } : { data: null, error: { message: "Aucune ligne" } };
      if (this.unique === "maybe") return { data: data[0] ?? null, error: null };
      return { data, error: null };
    }
  }

  const session = { user: DEMO_USER };
  return {
    from: (table) => new Requete(table),
    rpc: async () => ({ data: null, error: null }), // init_exercices : catalogue déjà copié
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      getUser: async () => ({ data: { user: DEMO_USER }, error: null }),
      signOut: async () => ({ error: null }),
    },
  };
}
