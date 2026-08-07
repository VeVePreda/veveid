import { randomUUID } from 'node:crypto';
import { q, q1, run, now } from './db.ts';
import { normaliserSite } from './sites.ts';
import { fetchAvoirs } from './collectchain.ts';

/**
 * ⭐⭐ LES AVOIRS — les collectibles VeVe réellement détenus par un compte.
 *
 * (C'est ce que j'appelais « roster » par jargon. En clair : la liste des
 * pièces de la collection, celles qui deviennent des héros dans les jeux.)
 *
 * 🔴 POURQUOI C'EST ICI ET PAS DANS CHAQUE JEU. Trois raisons, dans
 *    l'ordre d'importance :
 *
 *  1. **UN SEUL QUOTA.** Chaque lecture tape CollectScan, un service tiers
 *     gratuit. Avec trois jeux qui relisent chacun tous les portefeuilles,
 *     on triple la charge pour obtenir trois fois la même réponse — et on
 *     finit par se faire fermer la porte.
 *  2. **UNE SEULE VÉRITÉ.** Deux jeux qui synchronisent séparément
 *     divergent : l'un voit une revente, l'autre pas encore. Le joueur
 *     constate que son héros existe ici et plus là.
 *  3. **UN SEUL ENDROIT À CORRIGER** le jour où VeVe change son API.
 */

export interface Avoir {
  mint_key: string; nom: string; edition: number;
  rarete: string | null; image: string | null; vu_le: string;
}

/** La clé d'un mint : `nom:edition`. ⛔ Ne jamais la « nettoyer ». */
export const mintKeyDe = (h: { name: string; edition: number | null }) => `${h.name}:${h.edition ?? 0}`;

export const avoirsDe = (compteId: string) =>
  q<Avoir>('SELECT mint_key, nom, edition, rarete, image, vu_le FROM avoirs WHERE compte_id=? ORDER BY nom, edition', compteId);

export const dernierSync = (compteId: string) =>
  q1<{ dernier: string; resultat: string; complet: number }>(
    'SELECT dernier, resultat, complet FROM sync_log WHERE compte_id=?', compteId);

export interface Bilan {
  vus: number; nouveaux: number; partis: number; complet: boolean; erreur?: string;
}

/**
 * Relit la chaîne et met les avoirs à jour.
 *
 * 🔴 UNE VUE PARTIELLE NE RETIRE RIEN. Piège payé sur MightysArena : la
 *    pagination s'arrêtait à trois pages, et un collectionneur de deux
 *    cents pièces voyait cinquante combattants gelés à tort à chaque tour.
 *    Retirer est destructeur, lire ne l'est pas — sans certitude, on ne
 *    retire pas. Le drapeau `complet` est donc porté jusqu'au journal.
 */
export async function synchroniser(
  compteId: string, wallet: string, lire: typeof fetchAvoirs = fetchAvoirs,
): Promise<Bilan> {
  let avoirs;
  try { avoirs = await lire(wallet.toLowerCase()); }
  catch {
    run(
      `INSERT INTO sync_log (compte_id, dernier, resultat, complet) VALUES (?,?,?,0)
       ON CONFLICT(compte_id) DO UPDATE SET dernier=excluded.dernier, resultat=excluded.resultat, complet=0`,
      compteId, now(), 'chaîne injoignable',
    );
    return { vus: 0, nouveaux: 0, partis: 0, complet: false, erreur: 'chaîne injoignable' };
  }

  const vus = new Set<string>();
  let nouveaux = 0;
  for (const h of avoirs.liste) {
    const mk = mintKeyDe(h);
    vus.add(mk);
    const existait = q1('SELECT 1 FROM avoirs WHERE compte_id=? AND mint_key=?', compteId, mk);
    if (!existait) nouveaux++;
    run(
      `INSERT INTO avoirs (compte_id, mint_key, nom, edition, rarete, image, vu_le) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(compte_id, mint_key) DO UPDATE SET
         rarete=excluded.rarete, image=excluded.image, vu_le=excluded.vu_le`,
      compteId, mk, h.name, h.edition ?? 0, h.rarity ?? null, h.image ?? null, now(),
    );
  }

  let partis = 0;
  if (avoirs.complet) {
    for (const a of avoirsDe(compteId)) {
      if (vus.has(a.mint_key)) continue;
      run('DELETE FROM avoirs WHERE compte_id=? AND mint_key=?', compteId, a.mint_key);
      partis++;
    }
  }
  const resultat = `${avoirs.liste.length} vus, ${nouveaux} nouveaux, ${partis} partis`
    + (avoirs.complet ? '' : ' — vue partielle, rien retiré');
  run(
    `INSERT INTO sync_log (compte_id, dernier, resultat, complet) VALUES (?,?,?,?)
     ON CONFLICT(compte_id) DO UPDATE SET dernier=excluded.dernier, resultat=excluded.resultat, complet=excluded.complet`,
    compteId, now(), resultat, avoirs.complet ? 1 : 0,
  );
  return { vus: avoirs.liste.length, nouveaux, partis, complet: avoirs.complet };
}

// ═════════════════════════════════════════════════════════════════════════
// Le compte
// ═════════════════════════════════════════════════════════════════════════

/**
 * ⭐⭐ UN COMPTE PEUT N'AVOIR QUE L'UN DES DEUX (lot 89).
 *
 *  - `email` sans `wallet`  : le cas le plus courant. Quelqu'un s'inscrit
 *    pour suivre des prix. Il vaut `member`, il n'a rien à prouver.
 *  - `wallet` sans `email`  : les comptes nés avant le lot 89, et le
 *    parcours des jeux, qui part encore du portefeuille.
 *  - les deux              : un membre qui a vérifié sa collection.
 *
 * 🔴 `verifie` NE VEUT PAS DIRE « COMPTE VALIDE ». Il veut dire « LE
 *    PORTEFEUILLE EST PROUVÉ », et rien d'autre. Le lire comme un état du
 *    compte ferait d'un membre parfaitement légitime un compte à moitié
 *    ouvert — c'est précisément le mur qu'on est en train de retirer.
 */
export interface Compte {
  id: string; site: string; wallet: string | null; email: string | null;
  verifie: number; verifie_le: string | null;
  cree_le: string; abonne_jusqu_a: string | null; supprime_le: string | null;
}

/**
 * 🔥 LOT 107 — TOUTES CES LECTURES SONT MAINTENANT PAR SITE.
 * ⛔ Une requête sur `comptes` qui ne filtre pas sur `site` traverse la
 *    cloison. Elle ne lèvera aucune erreur : elle rendra le compte d'un autre
 *    site, avec son portefeuille — c'est-à-dire exactement le lien entre les
 *    sites que Preda a demandé de supprimer.
 * ⚠️ Le site est un paramètre EXPLICITE, jamais deviné à l'intérieur : c'est
 *    l'appelant qui sait d'où vient la personne.
 */
export function creerOuLireCompte(site: string, wallet: string): Compte {
  const s = normaliserSite(site);
  const w = wallet.trim().toLowerCase();
  const existant = q1<Compte>('SELECT * FROM comptes WHERE site=? AND wallet=?', s, w);
  if (existant) return existant;
  const id = randomUUID();
  run('INSERT INTO comptes (id, site, wallet, cree_le) VALUES (?,?,?,?)', id, s, w, now());
  return q1<Compte>('SELECT * FROM comptes WHERE id=?', id)!;
}

/**
 * La porte d'entrée par e-mail. Symétrique de `creerOuLireCompte`, et
 * volontairement aussi bête : on ne crée RIEN d'autre que la ligne.
 *
 * ⚠️ L'appelant a déjà normalisé l'adresse (`lien_magique.normaliser`).
 *    On re-normalise quand même : cette fonction sera un jour appelée
 *    depuis ailleurs, et un compte en double créé par une majuscule est
 *    invisible jusqu'au jour où la personne ne retrouve plus ses données.
 */
export function creerOuLireCompteParEmail(site: string, email: string): Compte {
  const s = normaliserSite(site);
  const e = email.trim().toLowerCase();
  const existant = q1<Compte>('SELECT * FROM comptes WHERE site=? AND email=?', s, e);
  if (existant) return existant;
  const id = randomUUID();
  run('INSERT INTO comptes (id, site, email, cree_le) VALUES (?,?,?,?)', id, s, e, now());
  return q1<Compte>('SELECT * FROM comptes WHERE id=?', id)!;
}

export const lireCompteParEmail = (site: string, email: string) =>
  q1<Compte>('SELECT * FROM comptes WHERE site=? AND email=?',
    normaliserSite(site), email.trim().toLowerCase());

/** ⭐ Le palier, en un seul endroit. Voir `access.mjs` côté veve-sites. */
export const paliDe = (c: Compte | undefined) =>
  !c ? 'visitor' : estAbonne(c) ? 'crevette' : 'member';

export const lireCompte = (id: string) => q1<Compte>('SELECT * FROM comptes WHERE id=?', id);

/**
 * ⭐⭐ « CE PORTEFEUILLE APPARTIENT-IL DÉJÀ À QUELQU'UN ? »
 *
 * ⚠️ « Une ligne existe avec ce portefeuille » et « quelqu'un le détient »
 *    sont DEUX QUESTIONS. L'ancienne porte `/entrer` créait la ligne avant
 *    toute preuve : une adresse tapée puis abandonnée laisse une trace qui
 *    n'appartient à personne. La traiter comme une propriété reviendrait à
 *    laisser n'importe qui réserver le portefeuille d'un autre en le
 *    tapant une fois — et le vrai détenteur serait refusé pour toujours.
 *
 * On répond donc « oui » seulement si l'autre compte a quelque chose à
 * perdre : une preuve faite (`verifie`) ou une adresse e-mail.
 */
export const portefeuilleOccupe = (site: string, wallet: string, saufCompteId: string): boolean => {
  const autre = q1<{ verifie: number; email: string | null }>(
    'SELECT verifie, email FROM comptes WHERE site=? AND wallet=? AND id<>?',
    normaliserSite(site), wallet.trim().toLowerCase(), saufCompteId);
  return !!autre && (autre.verifie === 1 || !!autre.email);
};

/**
 * Pose le portefeuille sur un compte, AVANT toute preuve. ⛔ Il n'écrit
 * PAS `verifie` : seule la preuve de propriété (`defi.lier`) a le droit de
 * le faire. Un raccourci ici transformerait « j'ai tapé une adresse » en
 * « je la détiens », ce que ce service entier existe pour distinguer.
 */
export function poserPortefeuille(compteId: string, wallet: string): void {
  const w = wallet.trim().toLowerCase();
  // La trace abandonnée d'un compte sans valeur cède la place (voir defi.lier).
  const autre = q1<{ id: string }>(
    'SELECT id FROM comptes WHERE wallet=? AND id<>? AND verifie=0 AND email IS NULL', w, compteId);
  if (autre) run('UPDATE comptes SET wallet=NULL WHERE id=?', autre.id);
  run('UPDATE comptes SET wallet=? WHERE id=?', w, compteId);
}
export const estAbonne = (c: Compte) => !!c.abonne_jusqu_a && c.abonne_jusqu_a > now();

export function accorderAbonnement(compteId: string, jours: number): string {
  const c = lireCompte(compteId);
  if (!c) return 'Compte inconnu.';
  const depuis = estAbonne(c) ? new Date(c.abonne_jusqu_a!) : new Date();
  const fin = new Date(depuis.getTime() + jours * 86_400_000).toISOString();
  run('UPDATE comptes SET abonne_jusqu_a=? WHERE id=?', fin, compteId);
  return `Abonné jusqu’au ${fin.slice(0, 10)}.`;
}

/** Le jeu note son passage — utile au support, à rien d'autre. */
export const noterAcces = (compteId: string, jeu: string) =>
  run('INSERT INTO acces (compte_id, jeu, ts) VALUES (?,?,?)', compteId, jeu, now());

// ═════════════════════════════════════════════════════════════════════════
// 🔴 La suppression de compte
// ═════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ DÉLAI DE GRÂCE DE SEPT JOURS, ET C'EST UN CHOIX.
 *
 * Une suppression immédiate est irréversible : un clic de trop, et des
 * mois de codex disparaissent. Un délai laisse revenir — et il ne coûte
 * rien à personne, puisque le compte est déjà inaccessible pendant ce
 * temps.
 *
 * ⛔ ET UNE CHOSE QUE LA SUPPRESSION NE FAIT PAS : effacer les héros et
 *    les codex dans les jeux. Ceux-là appartiennent au COLLECTIBLE, pas au
 *    compte. Le jour où quelqu'un rachète le mint, il doit retrouver ce
 *    que le mint sait. Chaque jeu efface ce qui lui appartient — la carte,
 *    le camp — et détache le reste.
 */
export const DELAI_GRACE_JOURS = 7;

export function demanderSuppression(compteId: string): { ok: boolean; message: string } {
  const c = lireCompte(compteId);
  if (!c) return { ok: false, message: 'Compte inconnu.' };
  if (c.supprime_le) return { ok: false, message: 'La suppression est déjà demandée.' };
  run('UPDATE comptes SET supprime_le=? WHERE id=?', now(), compteId);
  return {
    ok: true,
    message: `Suppression demandée. Vous avez ${DELAI_GRACE_JOURS} jours pour revenir sur votre décision — après quoi tout sera effacé.`,
  };
}

export function annulerSuppression(compteId: string): { ok: boolean; message: string } {
  const c = lireCompte(compteId);
  if (!c?.supprime_le) return { ok: false, message: 'Aucune suppression en cours.' };
  run('UPDATE comptes SET supprime_le=NULL WHERE id=?', compteId);
  return { ok: true, message: 'Suppression annulée. Votre compte est intact.' };
}

/** Les comptes dont le délai est écoulé — à effacer pour de bon. */
export const aEffacer = () => q<{ id: string }>(
  'SELECT id FROM comptes WHERE supprime_le IS NOT NULL AND supprime_le < ?',
  new Date(Date.now() - DELAI_GRACE_JOURS * 86_400_000).toISOString());

export function effacerDefinitivement(compteId: string): void {
  run('DELETE FROM avoirs WHERE compte_id=?', compteId);
  run('DELETE FROM acces WHERE compte_id=?', compteId);
  run('DELETE FROM sync_log WHERE compte_id=?', compteId);
  run('DELETE FROM defis WHERE compte_id=?', compteId);
  run('DELETE FROM comptes WHERE id=?', compteId);
}

/** Le ménage, appelé par le planificateur. */
export function purgerComptes(): number {
  let n = 0;
  for (const c of aEffacer()) { effacerDefinitivement(c.id); n++; }
  return n;
}
