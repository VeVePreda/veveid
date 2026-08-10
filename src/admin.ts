// ⚠️ DEPOT : VeVePreda/veveid   ·   CHEMIN : src/admin.ts
/**
 * 🔥 LOT 108 — REGARDER LE SERVICE. Rien d'autre.
 *
 * ⭐⭐ POURQUOI CE MODULE EXISTE. Le 07/08, il a fallu **reproduire** un
 * incident pour le comprendre, parce qu'on ne pouvait pas MESURER : ni
 * combien de comptes existaient, ni lequel portait un portefeuille, ni si la
 * migration du lot 107 avait eu lieu. Un service qu'on ne peut pas regarder
 * coûte à CHAQUE incident, pas une fois.
 *
 * ⛔⛔ CE MODULE NE FAIT AUCUNE ÉCRITURE, ET C'EST STRUCTUREL. Pas de
 *    suppression de compte, pas de déliaison, pas de « rattacher ce
 *    portefeuille ». Une page qui regarde et une page qui agit n'ont pas le
 *    même coût le jour où son jeton fuite. L'action viendra quand un
 *    incident l'aura réclamée deux fois — pas avant.
 *
 * ⛔⛔ ET IL NE REND JAMAIS UNE ADRESSE EN CLAIR. Ni e-mail, ni portefeuille,
 *    nulle part, même sous le cookie d'administration. Les blocs de synthèse
 *    COMPTENT ; la recherche RÉPOND à une adresse qu'on lui donne déjà, et
 *    ne rend l'autre identifiant que MASQUÉ. Ce qui n'est pas rendu ne peut
 *    pas fuir.
 */
import { q, q1 } from './db.ts';
import { masquerEmail } from './defi.ts';

// ── LA FORME DE LA BASE ───────────────────────────────────────────────
/**
 * ⭐⭐⭐ LA QUESTION QUI A COÛTÉ LA JOURNÉE DU 07/08 : « la base a-t-elle
 * changé de forme ? ». On y répond ici par ce que SQLite déclare lui-même,
 * jamais par ce que le code source promet.
 *
 * ⚠️ `PRAGMA index_list` donne `partial: 1` pour un index partiel mais ne
 *    dit PAS sur quelle condition. La condition vit dans le SQL d'origine,
 *    qu'on relit dans `sqlite_master` — c'est la seule source qui distingue
 *    « unique sur (site, wallet) » de « unique sur (site, wallet) SAUF quand
 *    wallet est nul ». Les deux se ressemblent et l'un des deux interdirait
 *    à deux visiteurs sans portefeuille de coexister.
 */
export interface Colonne { nom: string; type: string; obligatoire: boolean; defaut: string | null }
export interface Index { nom: string; unique: boolean; partiel: boolean; sql: string | null }
export interface Forme {
  colonnes: Colonne[];
  index: Index[];
  site_present: boolean;
  migrations: { cle: string; valeur: string; maj: string }[];
  dernier_demarrage: string | null;
}

export function forme(): Forme {
  const colonnes = (q<{ name: string; type: string; notnull: number; dflt_value: string | null }>(
    'PRAGMA table_info(comptes)')).map((c) => ({
      nom: c.name, type: c.type, obligatoire: c.notnull === 1, defaut: c.dflt_value,
    }));

  const sqls = new Map((q<{ name: string; sql: string | null }>(
    "SELECT name, sql FROM sqlite_master WHERE type='index'")).map((x) => [x.name, x.sql]));
  const index = (q<{ name: string; unique: number; partial: number }>(
    'PRAGMA index_list(comptes)')).map((i) => ({
      nom: i.name, unique: i.unique === 1, partiel: i.partial === 1, sql: sqls.get(i.name) ?? null,
    }));

  const migrations = q<{ cle: string; valeur: string; maj: string }>(
    "SELECT cle, valeur, maj FROM reglages WHERE cle LIKE 'migration.%' ORDER BY cle");
  const dem = q1<{ valeur: string }>("SELECT valeur FROM reglages WHERE cle='base.dernier_demarrage'");

  return {
    colonnes, index,
    site_present: colonnes.some((c) => c.nom === 'site'),
    migrations,
    dernier_demarrage: dem?.valeur ?? null,
  };
}

/**
 * ⭐ CE QUE `/sante` PEUT DIRE SANS RIEN RÉVÉLER. Des booléens et un
 * comptage : « la base est-elle ouverte, a-t-elle la colonne `site`, combien
 * de migrations sont consignées ». Assez pour répondre DE L'EXTÉRIEUR, en une
 * requête, à la question qu'on n'a pas pu se poser le 07/08.
 * ⛔ Jamais de contenu : ni un nom d'index, ni un comptage de comptes. Même
 *    règle que pour les secrets au lot 95 — `cle: true`, jamais laquelle.
 * ⚠️ Elle ne lève pas : une sonde qui tombe quand le service va mal est une
 *    sonde qui se tait au seul moment où on la lit.
 */
export function santeDeLaBase(): { ouverte: boolean; site_present: boolean; migrations: number } {
  try {
    const f = forme();
    return { ouverte: true, site_present: f.site_present, migrations: f.migrations.length };
  } catch {
    return { ouverte: false, site_present: false, migrations: 0 };
  }
}

// ── LES COMPTAGES ─────────────────────────────────────────────────────
/**
 * ⭐ PAR SITE, PARCE QUE C'EST LE CLOISONNEMENT (lot 107). Un total global
 * ne dirait plus rien d'utile le jour où un second site a un espace membre —
 * et c'est ce jour-là qu'on regardera cette page.
 * ⚠️ `GROUP BY site` et pas une liste tirée de `JEUX` : si un compte est
 *    rangé sous un site qui n'est plus déclaré, on veut le VOIR, pas le
 *    perdre. Un contrôle qui ne regarde que ce qui existe ne voit jamais ce
 *    qui manque.
 */
export interface LigneSite {
  site: string; total: number; verifies: number;
  avec_portefeuille: number; sans_portefeuille: number; en_grace: number;
}

export const parSite = (): LigneSite[] => q<LigneSite>(`
  SELECT site,
         COUNT(*)                                                AS total,
         SUM(CASE WHEN verifie = 1 THEN 1 ELSE 0 END)            AS verifies,
         SUM(CASE WHEN wallet IS NOT NULL THEN 1 ELSE 0 END)     AS avec_portefeuille,
         SUM(CASE WHEN wallet IS NULL THEN 1 ELSE 0 END)         AS sans_portefeuille,
         SUM(CASE WHEN supprime_le IS NOT NULL THEN 1 ELSE 0 END) AS en_grace
    FROM comptes GROUP BY site ORDER BY site`);

/**
 * L'activité des deux parcours de preuve, et des portes ouvertes.
 * ⭐ `decouvertes_aujourdhui` existe pour une raison précise : le plafond de
 *   5 par jour est ce qui empêche de recopier le flux public de quelqu'un
 *   d'autre. Un plafond qu'on ne peut pas lire est un plafond qu'on finira
 *   par croire trop bas et « assouplir ».
 */
export interface Activite {
  decouvertes: { en_attente: number; abouties: number; autres: number; aujourdhui: number };
  defis: { en_attente: number; verifies: number; autres: number };
  sessions_actives: number;
  liens_en_cours: number;
  avoirs: number;
}

export function activite(maintenant = new Date()): Activite {
  const jour = maintenant.toISOString().slice(0, 10);
  const instant = maintenant.toISOString();
  const n = (sql: string, ...p: unknown[]) =>
    Number(q1<{ n: number }>(sql, ...(p as never[]))?.n ?? 0);
  return {
    decouvertes: {
      en_attente: n("SELECT COUNT(*) AS n FROM decouvertes WHERE etat='en_attente'"),
      abouties: n("SELECT COUNT(*) AS n FROM decouvertes WHERE etat='verifie'"),
      autres: n("SELECT COUNT(*) AS n FROM decouvertes WHERE etat NOT IN ('en_attente','verifie')"),
      // ⚠️ Comparaison de PRÉFIXE sur la date ISO : `cree` est une chaîne
      //    complète, `substr` la ramène au jour. Pas de fonction de date
      //    SQLite ici — elles supposent un format, et le nôtre est déjà ISO.
      aujourdhui: n('SELECT COUNT(*) AS n FROM decouvertes WHERE substr(cree,1,10)=?', jour),
    },
    defis: {
      en_attente: n("SELECT COUNT(*) AS n FROM defis WHERE etat='en_attente'"),
      verifies: n("SELECT COUNT(*) AS n FROM defis WHERE etat='verifie'"),
      autres: n("SELECT COUNT(*) AS n FROM defis WHERE etat NOT IN ('en_attente','verifie')"),
    },
    sessions_actives: n(
      'SELECT COUNT(*) AS n FROM sessions WHERE revoquee_le IS NULL AND expire > ?', instant),
    liens_en_cours: n(
      'SELECT COUNT(*) AS n FROM liens WHERE consomme_le IS NULL AND expire > ?', instant),
    avoirs: n('SELECT COUNT(*) AS n FROM avoirs'),
  };
}

// ── LA RECHERCHE ──────────────────────────────────────────────────────
/**
 * 🔴🔴 CE QU'ELLE EST, ET CE QU'ELLE N'EST PAS.
 *
 * Elle NE LISTE RIEN. La page n'affiche aucune identité par défaut ; on lui
 * donne une adresse — e-mail ou portefeuille — et elle répond « oui, sur tel
 * site, créé le tant, avec/sans portefeuille vérifié ».
 *
 * ⭐⭐ C'EST EXACTEMENT LA QUESTION DU 07/08 : « quel compte détient mon
 *    portefeuille ? ». Aujourd'hui la seule façon d'y répondre était de
 *    REJOUER le parcours de découverte en entier.
 *
 * ⚠️ C'EST UN ORACLE D'EXISTENCE, ET IL FAUT LE DIRE. Répondre « ce compte
 *    existe » à qui donne une adresse est précisément ce que les routes
 *    publiques du service refusent de faire (l'inscription répond
 *    « vérifiez vos e-mails » même pour une adresse inconnue, et c'est
 *    voulu). Ici on l'assume, parce que la porte est un jeton
 *    d'exploitation — mais ça veut dire que la valeur de ce jeton est
 *    exactement celle de la liste des comptes. D'où : plafond de débit,
 *    cookie `SameSite=Strict`, 8 heures, et jamais dans l'URL.
 *
 * ⛔ L'IDENTIFIANT RENDU EST MASQUÉ. On donne un e-mail, on peut recevoir un
 *    indice de portefeuille ; on donne un portefeuille, on reçoit un indice
 *    d'e-mail. Jamais l'inverse en clair : sinon la recherche devient une
 *    machine à convertir une adresse connue en une adresse nouvelle.
 */
export interface Trouvaille {
  quoi: 'email' | 'portefeuille' | 'inconnu';
  trouve: boolean;

  comptes: {
    /** Référence OPAQUE pour le geste d'abonnement — voir `chercher()`. */
    ref: string;
    site: string; cree_le: string; verifie: boolean; verifie_le: string | null;
    a_un_portefeuille: boolean; indice_email: string | null; indice_wallet: string | null;
    abonne_jusqu_a: string | null; en_grace: string | null;
  }[];
}

/**
 * ⭐ Un portefeuille se montre par ses deux bouts : le début identifie la
 *    chaîne et le préfixe, la fin suffit à reconnaître le sien. Le milieu
 *    n'apprend rien à qui le connaît et tout à qui ne le connaît pas.
 */
export function masquerWallet(w: string | null | undefined): string | null {
  const s = String(w ?? '').trim();
  if (s.length < 12) return null;          // trop court pour masquer utilement
  return `${s.slice(0, 6)}•••${s.slice(-4)}`;
}

export function chercher(terme: string): Trouvaille {
  const t = String(terme ?? '').trim().toLowerCase();
  // ⚠️ On classe par la FORME du terme, jamais en interrogeant les deux
  //    colonnes « au cas où » : une recherche qui tente tout rend un
  //    résultat sur un terme qui n'a de sens dans aucune des deux, et on
  //    croit avoir mesuré.
  const quoi: Trouvaille['quoi'] = t.includes('@') ? 'email'
    : /^0x[0-9a-f]{6,}$/.test(t) ? 'portefeuille' : 'inconnu';
  if (quoi === 'inconnu' || !t) return { quoi: 'inconnu', trouve: false, comptes: [] };

  const lignes = q<{
    id: string;
    site: string; cree_le: string; verifie: number; verifie_le: string | null;
    wallet: string | null; email: string | null; abonne_jusqu_a: string | null;
    supprime_le: string | null;
  }>(
    quoi === 'email'
      ? 'SELECT id, site, cree_le, verifie, verifie_le, wallet, email, abonne_jusqu_a, supprime_le '
        + 'FROM comptes WHERE email=? ORDER BY site'
      : 'SELECT id, site, cree_le, verifie, verifie_le, wallet, email, abonne_jusqu_a, supprime_le '
        + 'FROM comptes WHERE wallet=? ORDER BY site',
    t);

  return {
    quoi,
    trouve: lignes.length > 0,
    comptes: lignes.map((c) => ({
      /**
       * 🔴🔴🔴 LOT 122 — LA RÉFÉRENCE OPAQUE, ET POURQUOI ELLE REMPLACE CE
       * QUE J'AVAIS ÉCRIT D'ABORD.
       * Ma première version renvoyait le TERME cherché, pour que le geste
       * d'abonnement puisse refaire la recherche. `test/admin.test.ts` l'a
       * refusé : « ⛔ ni le terme cherché, qui repartirait dans le HTML ».
       * ⭐⭐⭐ ET LE BANC AVAIT RAISON CONTRE MOI. Je m'étais convaincu que la
       * règle protégeait l'URL, l'historique et le `Referer` — trois endroits
       * qu'un champ caché n'atteint pas. Elle dit autre chose, et elle le dit
       * SUR LA SORTIE : *aucune identité en clair dans le HTML, quel que soit
       * le chemin.* Une règle vérifiée sur la sortie ne se contourne pas par
       * un raisonnement sur l'intention.
       * ⛔ La tentation était d'assouplir le test. On corrige le CODE.
       *
       * ⭐ `id` est un UUID interne : ce n'est ni un e-mail ni un
       *   portefeuille, il n'apprend rien sur personne, il ne vaut rien sans
       *   le cookie d'exploitation, et il ne sert qu'un aller-retour.
       */
      ref: c.id,
      site: c.site,
      cree_le: c.cree_le,
      verifie: c.verifie === 1,
      verifie_le: c.verifie_le,
      a_un_portefeuille: c.wallet != null,
      // ⛔ On ne renvoie l'indice que de l'AUTRE identifiant : celui qu'on a
      //    fourni pour chercher, on le connaît déjà — le réafficher ne
      //    servirait qu'à le déposer une fois de plus dans une page.
      indice_email: quoi === 'portefeuille' ? masquerEmail(c.email) : null,
      indice_wallet: quoi === 'email' ? masquerWallet(c.wallet) : null,
      abonne_jusqu_a: c.abonne_jusqu_a,
      en_grace: c.supprime_le,
    })),
  };
}
