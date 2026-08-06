import { randomUUID } from 'node:crypto';
import { q, q1, run, now } from './db.ts';
import {
  fetchHoldings, fetchEnVente, fetchEscrowDeposits, chaineDisponible, type Holding,
} from './collectchain.ts';

/**
 * ⭐⭐ LA PREUVE DE PROPRIÉTÉ — le ticket d'entrée du jeu.
 *
 * 🔴 LE PROBLÈME : les portefeuilles VeVe sont SOUS GARDE. Le joueur n'a
 *    pas ses clés, il ne peut donc rien signer. Toute la cryptographie
 *    habituelle est hors de portée.
 *
 * ⭐ LA SOLUTION (idée de Preda) : **mettre un collectible en vente est une
 *    action que seul son détenteur réel peut faire**, et elle laisse une
 *    trace publique sur la chaîne. On ne demande pas une signature, on
 *    demande un GESTE.
 *
 * ✅ VALIDÉ EN RÉEL le 18/07/2026 : mise en vente détectée en moins de deux
 *    minutes.
 *
 * 🔴 CE FICHIER A ÉTÉ REMONTÉ DE LOOP VERS LE SERVICE D'IDENTITÉ le 20/07.
 *    Il était écrit DEUX FOIS — dans MightysArena et dans Loop — et allait
 *    l'être une troisième. C'est ici sa place : la propriété d'un
 *    collectible ne dépend d'aucun jeu.
 *    ⛔ Ne jamais le recopier dans un jeu. Un jeu appelle le service.
 *
 * ── Le protocole ───────────────────────────────────────────────────────
 *  1. On vérifie que l'explorateur de chaîne RÉPOND (§ `preparer`).
 *  2. On lit les avoirs, et on ÉCARTE ce qui est déjà en vente.
 *  3. **Le joueur choisit** deux objets parmi les éligibles.
 *  4. Son choix est SCELLÉ. Il liste les deux objets sous 30 minutes, à un
 *     prix compris entre 15 000 et 50 000, puis annule.
 *  5. Les deux dépôts en escrow détectés → liaison définitive.
 */

export const NB_CIBLES = 2;
export const FENETRE_MIN = 30;

/**
 * 🔴 LE PRIX EST UNE CONSIGNE, PAS UNE VÉRIFICATION — et il faut le savoir.
 *
 * Ces bornes protègent le JOUEUR : à 1 $, son collectible peut être acheté
 * pour de bon pendant la vérification, et il l'aurait perdu par notre
 * faute. À 15 000, personne n'achète.
 *
 * ⚠️ MAIS NOUS NE POUVONS PAS LE CONTRÔLER. Le transfert vers l'escrow ne
 *    porte AUCUN montant — revérifié sur la chaîne le 20/07 — et les procs
 *    de listings de StackR répondent vide depuis le 18/07. Le prix d'une
 *    offre en cours n'est pas lisible publiquement.
 *    ⛔ Ne jamais écrire de code qui FAIT SEMBLANT de vérifier le prix.
 *       Un contrôle qui ment est pire que pas de contrôle : on cesserait
 *       d'afficher l'avertissement au joueur, qui est la seule protection
 *       réelle qu'il ait.
 */
export const PRIX_MIN = 15_000;
export const PRIX_MAX = 50_000;

/**
 * ⚠️ LE PLAFOND DE TENTATIVES REMPLACE « le tirage est subi ».
 *
 * Tant que le SERVEUR désignait les objets, l'usurpation par coïncidence
 * était structurellement impossible. Puisque le joueur choisit désormais
 * — et c'est légitime, il ne doit pas être forcé d'exposer une pièce à
 * laquelle il tient — la garantie doit venir d'ailleurs :
 *   · un seul défi actif à la fois ;
 *   · le choix est SCELLÉ dès la validation, il ne se remanie pas ;
 *   · et surtout, un nombre de tentatives borné par jour.
 * Sans ce plafond, un imposteur relancerait indéfiniment en changeant
 * d'objets jusqu'à tomber sur deux pièces que le vrai détenteur met en
 * vente par hasard dans la fenêtre.
 */
export const MAX_TENTATIVES_JOUR = 5;

/** Marge : l'horodatage d'un bloc peut précéder la création du défi. */
const MARGE_MS = 2 * 60_000;

export type EtatDefi = 'en_attente' | 'verifie' | 'expire';

export interface Defi {
  id: string; wallet: string; compte_id: string | null;
  cibles: Holding[]; vus: string[];
  cree: string; expire: string; etat: EtatDefi;
}

interface Ligne {
  id: string; wallet: string; compte_id: string | null;
  cibles: string; vus: string; cree: string; expire: string; etat: EtatDefi;
}

const hydrater = (l: Ligne): Defi => ({
  id: l.id, wallet: l.wallet, compte_id: l.compte_id,
  cibles: JSON.parse(l.cibles), vus: JSON.parse(l.vus),
  cree: l.cree, expire: l.expire, etat: l.etat,
});

export const lireDefi = (id: string): Defi | undefined => {
  const l = q1<Ligne>('SELECT * FROM defis WHERE id=?', id);
  return l ? hydrater(l) : undefined;
};

/**
 * ⚠️ LES DÉFIS VIVENT EN BASE, PAS EN MÉMOIRE — différence assumée avec
 * MightysArena. Sur un téléphone, le joueur QUITTE l'onglet pour aller
 * dans l'application VeVe, et il revient trois minutes plus tard. Entre
 * temps le serveur a très bien pu redémarrer. Un défi perdu à ce
 * moment-là, c'est quelqu'un qui a mis deux objets en vente pour rien.
 */
export function defiActif(wallet: string): Defi | undefined {
  const l = q1<Ligne>(
    "SELECT * FROM defis WHERE wallet=? AND etat='en_attente' AND expire > ? ORDER BY cree DESC LIMIT 1",
    wallet.toLowerCase(), now(),
  );
  return l ? hydrater(l) : undefined;
}

/** Tentatives des dernières 24 h, tous états confondus. */
export function tentativesDuJour(wallet: string): number {
  const depuis = new Date(Date.now() - 86_400_000).toISOString();
  return q1<{ n: number }>(
    'SELECT COUNT(*) AS n FROM defis WHERE wallet=? AND cree > ?', wallet.toLowerCase(), depuis,
  )?.n ?? 0;
}

// ═════════════════════════════════════════════════════════════════════════
// Étape 1 — préparer : ce que le joueur peut choisir
// ═════════════════════════════════════════════════════════════════════════

export interface Eligibles {
  liste?: Holding[];
  /** Les objets écartés parce qu'ils sont DÉJÀ en vente. */
  ecartes?: Holding[];
  erreur?: string;
  /** Vrai si l'explorateur de chaîne est en panne — message différent. */
  panne?: boolean;
}

/**
 * ⭐ ON ÉCARTE CE QUI EST DÉJÀ EN VENTE, et ce n'est pas du confort.
 *
 * Un objet déjà déposé en escrow ne produira AUCUN nouveau dépôt quand le
 * joueur croira le lister : il attendrait indéfiniment devant une case qui
 * ne se coche pas, sans comprendre. Pire, un imposteur pourrait choisir
 * exprès des objets que le vrai détenteur a déjà listés et se faire
 * valider par des dépôts anciens — c'est pour cela que `rafraichir`
 * n'accepte que les dépôts POSTÉRIEURS à la création du défi.
 */
export async function preparer(
  wallet: string,
  lireAvoirs: (w: string) => Promise<Holding[]> = fetchHoldings,
  lireEnVente: typeof fetchEnVente = fetchEnVente,
  sante: typeof chaineDisponible = chaineDisponible,
): Promise<Eligibles> {
  const w = wallet.trim().toLowerCase();

  /**
   * ⭐ ON DEMANDE D'ABORD SI L'EXPLORATEUR VA BIEN.
   * Sans ce contrôle, une panne de CollectScan se présente au joueur comme
   * « aucun collectible trouvé » — c'est-à-dire comme SA faute, alors que
   * rien chez lui n'est en cause. Il refait le geste, il échoue encore, et
   * il s'en va. Une panne d'un service tiers est un état PRÉVISIBLE, elle
   * mérite sa propre phrase.
   */
  if (!(await sante())) {
    return {
      panne: true,
      erreur: "L'explorateur de la chaîne (CollectScan) ne répond pas en ce moment. Ce n'est pas vous — vos collectibles ne sont pas en cause. Réessayez dans quelques minutes.",
    };
  }

  let avoirs: Holding[];
  let enVente: Map<string, unknown>;
  try {
    avoirs = await lireAvoirs(w);
    enVente = await lireEnVente(w);
  } catch {
    return { panne: true, erreur: "La lecture de la chaîne a échoué en cours de route. Réessayez dans quelques minutes." };
  }

  const ecartes = avoirs.filter((a) => enVente.has(a.tokenId));
  const liste = avoirs.filter((a) => !enVente.has(a.tokenId));

  if (avoirs.length === 0)
    return { erreur: 'Aucun collectible VeVe trouvé sur ce portefeuille. Il en faut au moins un pour jouer.' };
  if (liste.length < NB_CIBLES)
    return {
      liste, ecartes,
      erreur: `Il faut ${NB_CIBLES} collectibles qui ne soient PAS déjà en vente. ${
        ecartes.length ? `${ecartes.length} des vôtres sont actuellement listés — annulez-en, ou attendez.` : ''}`,
    };
  return { liste, ecartes };
}

// ═════════════════════════════════════════════════════════════════════════
// Étape 2 — sceller le choix du joueur
// ═════════════════════════════════════════════════════════════════════════

export interface Resultat { defi?: Defi; erreur?: string }

export async function creerDefi(
  wallet: string,
  compteId: string | null,
  tokenIds: string[],
  lireAvoirs: (w: string) => Promise<Holding[]> = fetchHoldings,
  lireEnVente: typeof fetchEnVente = fetchEnVente,
  sante: typeof chaineDisponible = chaineDisponible,
): Promise<Resultat> {
  const w = wallet.trim().toLowerCase();

  /**
   * 🔴 UN PORTEFEUILLE = UN COMPTE. Unicité stricte : bien meilleure
   * défense anti multi-comptes qu'une adresse e-mail ou une adresse IP,
   * parce qu'elle coûte cher à contourner — il faut une seconde collection.
   */
  const deja = q1<{ id: string }>('SELECT id FROM comptes WHERE wallet=? AND verifie=1', w);
  if (deja && deja.id !== compteId)
    return { erreur: 'Ce portefeuille est déjà lié à un autre compte.' };

  // 🔴 Le choix est SCELLÉ : tant qu'un défi court, on ne le remanie pas.
  const actif = defiActif(w);
  if (actif) return { defi: actif };

  if (tentativesDuJour(w) >= MAX_TENTATIVES_JOUR)
    return { erreur: `Trop de vérifications tentées aujourd'hui (${MAX_TENTATIVES_JOUR} au maximum). Réessayez demain.` };

  const dispo = await preparer(w, lireAvoirs, lireEnVente, sante);
  if (dispo.erreur) return { erreur: dispo.erreur };
  const eligibles = dispo.liste ?? [];

  const voulus = [...new Set(tokenIds.map((t) => String(t)))];
  if (voulus.length !== NB_CIBLES)
    return { erreur: `Choisissez exactement ${NB_CIBLES} collectibles.` };

  /**
   * 🔴 ON REVÉRIFIE LE CHOIX CONTRE LA CHAÎNE, on ne fait pas confiance au
   * formulaire. Un identifiant venu du navigateur n'est pas une preuve :
   * sans ce contrôle, n'importe qui déclarerait deux objets qu'il a déjà
   * listés depuis un autre portefeuille.
   */
  const parId = new Map(eligibles.map((e) => [e.tokenId, e]));
  const cibles: Holding[] = [];
  for (const t of voulus) {
    const h = parId.get(t);
    if (!h) return { erreur: "Un des objets choisis n'est plus disponible : il a peut-être été vendu ou mis en vente entre-temps. Recommencez." };
    cibles.push(h);
  }

  const cree = new Date();
  const defi: Defi = {
    id: randomUUID(), wallet: w, compte_id: compteId, cibles, vus: [],
    cree: cree.toISOString(), expire: new Date(cree.getTime() + FENETRE_MIN * 60_000).toISOString(),
    etat: 'en_attente',
  };
  run(
    'INSERT INTO defis (id, wallet, compte_id, cibles, vus, cree, expire, etat) VALUES (?,?,?,?,?,?,?,?)',
    defi.id, defi.wallet, defi.compte_id, JSON.stringify(defi.cibles), '[]',
    defi.cree, defi.expire, defi.etat,
  );
  return { defi };
}

// ═════════════════════════════════════════════════════════════════════════
// Étape 3 — constater le geste
// ═════════════════════════════════════════════════════════════════════════

/**
 * Relève la chaîne et met le défi à jour. **Idempotent** : le téléphone
 * l'appelle toutes les dix secondes pendant que le joueur fait son geste.
 *
 * 🔴 SEULS LES DÉPÔTS POSTÉRIEURS AU DÉFI COMPTENT. C'est ce qui empêche
 *    de se faire valider par un dépôt ancien — et c'est indispensable
 *    maintenant que le joueur choisit lui-même ses objets.
 */
export async function rafraichir(
  defi: Defi,
  lireDepots: typeof fetchEscrowDeposits = fetchEscrowDeposits,
): Promise<Defi> {
  if (defi.etat !== 'en_attente') return defi;
  if (new Date() > new Date(defi.expire)) {
    run("UPDATE defis SET etat='expire' WHERE id=?", defi.id);
    return { ...defi, etat: 'expire' };
  }

  const depuis = new Date(new Date(defi.cree).getTime() - MARGE_MS);
  let depots;
  try { depots = await lireDepots(defi.wallet, depuis); }
  catch { return defi; }        // la chaîne ne répond pas : on réessaiera

  const vus = new Set(defi.vus);
  for (const d of depots) {
    if (d.at && new Date(d.at) < depuis) continue;      // ceinture et bretelles
    if (defi.cibles.some((c) => c.tokenId === d.tokenId)) vus.add(d.tokenId);
  }
  const complet = defi.cibles.every((c) => vus.has(c.tokenId));
  const etat: EtatDefi = complet ? 'verifie' : 'en_attente';
  run('UPDATE defis SET vus=?, etat=? WHERE id=?', JSON.stringify([...vus]), etat, defi.id);
  return { ...defi, vus: [...vus], etat };
}

/**
 * Scelle la liaison compte ↔ portefeuille. Séparée de `rafraichir` à
 * dessein : constater et décider sont deux gestes, et seul le second
 * touche au compte.
 */
/**
 * 🔴🔴 CE CONTRÔLE REGARDE **TOUS** LES AUTRES COMPTES, PAS SEULEMENT LES
 *      VÉRIFIÉS (corrigé au lot 89).
 *
 * L'ancienne version ne cherchait que `verifie=1`. Un compte NON vérifié
 * portant déjà ce portefeuille — une tentative abandonnée par l'ancienne
 * porte `/entrer`, qui créait la ligne avant toute preuve — passait donc au
 * travers, et l'UPDATE suivant violait l'unicité de `wallet`. L'erreur
 * remontée était une contrainte SQLite au milieu d'une vérification
 * réussie : le plus mauvais moment possible, juste après que la personne a
 * mis deux collectibles en vente et les a annulés.
 *
 * ⚠️ Ce défaut existait AVANT ce lot (la colonne était `UNIQUE NOT NULL`).
 *    L'index unique partiel ne l'a pas créé, il l'a rendu visible.
 *
 * ⭐ Une trace abandonnée n'est pas un compte : une ligne sans e-mail et
 *    sans preuve ne porte rien que quelqu'un puisse regretter. On l'efface.
 *    Une ligne AVEC e-mail appartient à quelqu'un : on refuse, et on le dit.
 */
export function lier(compteId: string, wallet: string): { ok: boolean; message: string } {
  const w = wallet.toLowerCase();
  const autre = q1<{ id: string; verifie: number; email: string | null }>(
    'SELECT id, verifie, email FROM comptes WHERE wallet=? AND id<>?', w, compteId);
  if (autre && (autre.verifie === 1 || autre.email))
    return { ok: false, message: 'Ce portefeuille est déjà lié à un autre compte.' };
  if (autre) run('UPDATE comptes SET wallet=NULL WHERE id=?', autre.id);
  run('UPDATE comptes SET wallet=?, verifie=1, verifie_le=? WHERE id=?', w, now(), compteId);
  run('UPDATE defis SET compte_id=? WHERE wallet=? AND compte_id IS NULL', compteId, w);
  return { ok: true, message: 'Portefeuille vérifié. Vos collectibles sont à vous, et le jeu le sait.' };
}

export const estVerifie = (compteId: string): boolean =>
  q1<{ verifie: number }>('SELECT verifie FROM comptes WHERE id=?', compteId)?.verifie === 1;

/** Les défis vieux de plus de trois heures n'intéressent plus personne. */
export function purgerDefis(): number {
  const limite = new Date(Date.now() - 3 * 3600_000).toISOString();
  const r = run('DELETE FROM defis WHERE cree < ? AND etat <> ?', limite, 'verifie');
  return Number(r.changes ?? 0);
}

export interface Avancement {
  etat: EtatDefi;
  faits: number;
  total: number;
  restantSec: number;
  cibles: { nom: string; edition: number | null; vu: boolean }[];
}

export function avancement(defi: Defi): Avancement {
  const vus = new Set(defi.vus);
  return {
    etat: defi.etat,
    faits: defi.cibles.filter((c) => vus.has(c.tokenId)).length,
    total: defi.cibles.length,
    restantSec: Math.max(0, Math.round((new Date(defi.expire).getTime() - Date.now()) / 1000)),
    cibles: defi.cibles.map((c) => ({ nom: c.name, edition: c.edition, vu: vus.has(c.tokenId) })),
  };
}
